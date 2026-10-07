import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { assertPaymentTransition, canTransitionMilestone, type MilestoneStatus } from "./stateMachine";
import {
  checkCaptureAmount,
  computePayoutSplit,
  isValidRequestKey,
  remainingAuthorizedCents,
  retainagePercentFor,
} from "./payoutMath";

/**
 * Database side of "Release & pay" (architecture §4 steps 2–3): one payout payment per release,
 * captures recorded on the funding payment, and the void that closes a partially captured milestone.
 * PayPal calls live in captures.ts and payouts.ts.
 */

const CAPTURABLE: readonly string[] = ["authorized", "partially_captured"];

export async function moveMilestone(ctx: MutationCtx, milestoneId: Id<"milestones"> | undefined, to: MilestoneStatus) {
  if (!milestoneId) return;
  const m = await ctx.db.get(milestoneId);
  if (m === null || m.status === to || !canTransitionMilestone(m.status, to)) return;
  await ctx.db.patch(milestoneId, { status: to });
}

/** The milestone's funded authorization (latest funding attempt that reached authorized or later). */
async function fundedPaymentFor(ctx: MutationCtx, milestoneId: Id<"milestones">): Promise<Doc<"payments"> | null> {
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_milestoneId", (q) => q.eq("milestoneId", milestoneId))
    .take(200);
  const funded = rows.filter((p) => p.kind === "funding" && p.paypalAuthorizationId !== undefined);
  return funded.length > 0 ? funded[funded.length - 1] : null;
}

async function milestonePayouts(ctx: MutationCtx, milestoneId: Id<"milestones">): Promise<Doc<"payments">[]> {
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_milestoneId", (q) => q.eq("milestoneId", milestoneId))
    .take(200);
  return rows.filter((p) => p.kind === "payout");
}

/** The sub's payout address: the human sub profile linked to the agreement's contractor. */
async function receiverFor(ctx: MutationCtx, contractorId: Id<"contractors">): Promise<string | undefined> {
  const profiles = await ctx.db
    .query("userProfiles")
    .withIndex("by_contractorId", (q) => q.eq("contractorId", contractorId))
    .take(50);
  const sub = profiles.find((p) => p.role === "sub" && p.actorType !== "agent" && p.paypalEmail);
  return sub?.paypalEmail?.trim() || undefined;
}

const beginReleaseResult = v.union(
  v.object({ state: v.literal("new"), paymentId: v.id("payments"), actor: v.string() }),
  v.object({ state: v.literal("existing"), paymentId: v.id("payments"), status: v.string(), actor: v.string() }),
  v.object({ state: v.literal("busy"), paymentId: v.id("payments"), actor: v.string() }),
);
export type BeginRelease = Infer<typeof beginReleaseResult>;

/**
 * Creates the payout payment for one release, or returns the one already created for `requestKey`.
 * Only one release per milestone can be in flight, so a double click with a fresh key is also refused.
 */
export const beginRelease = internalMutation({
  args: {
    milestoneId: v.id("milestones"),
    amountCents: v.number(),
    requestKey: v.string(),
    actor: v.string(),
    payAppId: v.optional(v.id("payApplications")),
    proposalId: v.optional(v.id("agentProposals")),
  },
  returns: beginReleaseResult,
  handler: async (ctx, args): Promise<BeginRelease> => {
    if (!isValidRequestKey(args.requestKey)) {
      throw new ConvexError({ code: "INVALID_REQUEST", message: "Invalid release request key." });
    }
    const idempotencyKey = `pay_${args.requestKey}`;
    const existing = await ctx.db
      .query("payments")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", idempotencyKey))
      .first();
    if (existing !== null) {
      if (existing.milestoneId !== args.milestoneId) {
        throw new ConvexError({ code: "CONFLICT", message: "This release request belongs to another milestone." });
      }
      return { state: "existing", paymentId: existing._id, status: existing.status, actor: args.actor };
    }

    const milestone = await ctx.db.get(args.milestoneId);
    if (milestone === null) throw new ConvexError({ code: "NOT_FOUND", message: "Milestone not found." });
    const agreement = await ctx.db.get(milestone.agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });

    const inFlight = (await milestonePayouts(ctx, milestone._id)).find((p) => p.status === "created");
    if (inFlight) return { state: "busy", paymentId: inFlight._id, actor: args.actor };

    const funding = await fundedPaymentFor(ctx, milestone._id);
    if (funding === null || !CAPTURABLE.includes(funding.status)) {
      throw new ConvexError({
        code: "NOT_RELEASABLE",
        message:
          funding === null
            ? "This milestone is not funded. Fund it before releasing payment."
            : `The milestone's authorization is ${funding.status}; nothing more can be released.`,
      });
    }
    const check = checkCaptureAmount(args.amountCents, remainingAuthorizedCents(funding));
    if (!check.ok) throw new ConvexError({ code: "INVALID_AMOUNT", message: check.message });

    const receiverEmail = await receiverFor(ctx, agreement.contractorId);
    if (!receiverEmail) {
      throw new ConvexError({
        code: "NO_PAYOUT_ACCOUNT",
        message: `${agreement.subcontractorName} has no PayPal payout email on file. Nothing was captured or paid.`,
      });
    }
    const split = computePayoutSplit(args.amountCents, retainagePercentFor(agreement));
    const paymentId = await ctx.db.insert("payments", {
      agreementId: agreement._id,
      milestoneId: milestone._id,
      payAppId: args.payAppId,
      proposalId: args.proposalId,
      kind: "payout",
      status: "created",
      ...split,
      fundingPaymentId: funding._id,
      receiverEmail,
      idempotencyKey,
      createdAt: Date.now(),
    });
    return { state: "new", paymentId, actor: args.actor };
  },
});

export const releaseRow = internalQuery({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, { paymentId }) => {
    const p = await ctx.db.get(paymentId);
    if (p === null || p.kind !== "payout") return null;
    return {
      paymentId: p._id,
      status: p.status,
      grossCents: p.grossCents,
      idempotencyKey: p.idempotencyKey,
      fundingPaymentId: p.fundingPaymentId ?? null,
      milestoneId: p.milestoneId ?? null,
      paypalPayoutBatchId: p.paypalPayoutBatchId ?? null,
      error: p.error ?? null,
    };
  },
});

const beginCaptureResult = v.union(
  v.object({ state: v.literal("done"), captureId: v.string(), finalCapture: v.boolean() }),
  v.object({
    state: v.literal("capture"),
    authorizationId: v.string(),
    finalCapture: v.boolean(),
    agreementId: v.id("agreements"),
    projectId: v.id("projects"),
  }),
);
export type BeginCapture = Infer<typeof beginCaptureResult>;

/** Checks a capture against the funding authorization; a repeated `requestKey` returns the stored capture. */
export const beginCapture = internalMutation({
  args: {
    fundingPaymentId: v.id("payments"),
    amountCents: v.number(),
    requestKey: v.string(),
  },
  returns: beginCaptureResult,
  handler: async (ctx, args): Promise<BeginCapture> => {
    const funding = await ctx.db.get(args.fundingPaymentId);
    if (funding === null || funding.kind !== "funding") {
      throw new ConvexError({ code: "NOT_FOUND", message: "Funding payment not found." });
    }
    const prior = (funding.captures ?? []).find((c) => c.requestKey === args.requestKey);
    if (prior) return { state: "done", captureId: prior.captureId, finalCapture: prior.finalCapture };
    if (!funding.paypalAuthorizationId || !CAPTURABLE.includes(funding.status)) {
      throw new ConvexError({
        code: "NOT_CAPTURABLE",
        message: `The authorization is ${funding.status}; it cannot be captured.`,
      });
    }
    const check = checkCaptureAmount(args.amountCents, remainingAuthorizedCents(funding));
    if (!check.ok) throw new ConvexError({ code: "INVALID_AMOUNT", message: check.message });
    const agreement = await ctx.db.get(funding.agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });
    return {
      state: "capture",
      authorizationId: funding.paypalAuthorizationId,
      finalCapture: check.finalCapture,
      agreementId: agreement._id,
      projectId: agreement.projectId,
    };
  },
});

export const recordCapture = internalMutation({
  args: {
    fundingPaymentId: v.id("payments"),
    captureId: v.string(),
    captureStatus: v.string(),
    amountCents: v.number(),
    requestKey: v.string(),
    finalCapture: v.boolean(),
    releasePaymentId: v.optional(v.id("payments")),
    auditRecorded: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const funding = await ctx.db.get(args.fundingPaymentId);
    if (funding === null) throw new ConvexError({ code: "NOT_FOUND", message: "Funding payment not found." });
    const captures = funding.captures ?? [];
    if (captures.some((c) => c.requestKey === args.requestKey || c.captureId === args.captureId)) return null;
    const to = args.finalCapture ? "captured" : "partially_captured";
    assertPaymentTransition("funding", funding.status, to);
    await ctx.db.patch(funding._id, {
      status: to,
      paypalCaptureId: args.captureId,
      capturedCents: (funding.capturedCents ?? 0) + args.amountCents,
      captures: [
        ...captures,
        {
          captureId: args.captureId,
          amountCents: args.amountCents,
          requestKey: args.requestKey,
          finalCapture: args.finalCapture,
          status: args.captureStatus,
          releasePaymentId: args.releasePaymentId,
          capturedAt: Date.now(),
        },
      ],
      error: undefined,
      auditRecorded: funding.auditRecorded === false ? false : args.auditRecorded,
      updatedAt: Date.now(),
    });
    // Fully captured: nothing more can be released, so the milestone's money is complete.
    await moveMilestone(ctx, funding.milestoneId, args.finalCapture ? "complete" : "in_progress");
    return null;
  },
});

/** A rejected capture: the error is stored on the funding row and the release; no capture is recorded. */
export const recordCaptureFailure = internalMutation({
  args: {
    fundingPaymentId: v.id("payments"),
    error: v.string(),
    releasePaymentId: v.optional(v.id("payments")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const funding = await ctx.db.get(args.fundingPaymentId);
    if (funding !== null) await ctx.db.patch(funding._id, { error: args.error, updatedAt: now });
    if (args.releasePaymentId) {
      const release = await ctx.db.get(args.releasePaymentId);
      if (release !== null && release.status === "created") {
        assertPaymentTransition("payout", "created", "failed");
        await ctx.db.patch(release._id, { status: "failed", error: args.error, updatedAt: now });
      }
    }
    return null;
  },
});

const beginVoidResult = v.union(
  v.object({ state: v.literal("done") }),
  v.object({
    state: v.literal("void"),
    fundingPaymentId: v.id("payments"),
    authorizationId: v.string(),
    idempotencyKey: v.string(),
    agreementId: v.id("agreements"),
    projectId: v.id("projects"),
  }),
);
export type BeginVoid = Infer<typeof beginVoidResult>;

/** Closing a partially captured milestone voids the uncaptured remainder of its authorization. */
export const beginVoid = internalMutation({
  args: { milestoneId: v.id("milestones") },
  returns: beginVoidResult,
  handler: async (ctx, { milestoneId }): Promise<BeginVoid> => {
    const funding = await fundedPaymentFor(ctx, milestoneId);
    if (funding === null) throw new ConvexError({ code: "NOT_FOUND", message: "This milestone has no funded authorization." });
    if (funding.status === "voided") return { state: "done" };
    if (funding.status !== "partially_captured") {
      throw new ConvexError({
        code: "NOT_VOIDABLE",
        message:
          funding.status === "captured"
            ? "The authorization was fully captured; there is no remainder to void."
            : `Only a partially captured authorization can be closed (this one is ${funding.status}).`,
      });
    }
    if ((await milestonePayouts(ctx, milestoneId)).some((p) => p.status === "created")) {
      throw new ConvexError({ code: "RELEASE_IN_PROGRESS", message: "A release is still being processed. Try again when it finishes." });
    }
    const agreement = await ctx.db.get(funding.agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });
    return {
      state: "void",
      fundingPaymentId: funding._id,
      authorizationId: funding.paypalAuthorizationId!,
      idempotencyKey: `${funding.idempotencyKey}_void`,
      agreementId: agreement._id,
      projectId: agreement.projectId,
    };
  },
});

export const recordVoid = internalMutation({
  args: { fundingPaymentId: v.id("payments"), auditRecorded: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { fundingPaymentId, auditRecorded }) => {
    const funding = await ctx.db.get(fundingPaymentId);
    if (funding === null || funding.status === "voided") return null;
    assertPaymentTransition("funding", funding.status, "voided");
    await ctx.db.patch(funding._id, {
      status: "voided",
      error: undefined,
      auditRecorded: funding.auditRecorded === false ? false : auditRecorded,
      updatedAt: Date.now(),
    });
    await moveMilestone(ctx, funding.milestoneId, "complete");
    return null;
  },
});

export const recordVoidFailure = internalMutation({
  args: { fundingPaymentId: v.id("payments"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { fundingPaymentId, error }) => {
    const funding = await ctx.db.get(fundingPaymentId);
    if (funding !== null) await ctx.db.patch(funding._id, { error, updatedAt: Date.now() });
    return null;
  },
});
