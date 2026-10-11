import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { cannotPay, payGateForMutation } from "../billing/payGateDb";
import { formatCents } from "../lib/money";
import { syncProposalForPayment } from "../payApps/proposalSync";
import { isCaptureDenied, settleRelease, takeEarlySettlement } from "./captureSettlement";
import { assertPaymentTransition, canTransitionMilestone, canTransitionPayment, type MilestoneStatus } from "./stateMachine";
import { checkCaptureAmount, isValidRequestKey, remainingAuthorizedCents } from "./payoutMath";

export const APPROVED_PAY_APP_REQUIRED_MESSAGE =
  "An approved pay app is required: money moves only from an approved pay app's Payment panel. Nothing was captured or paid.";

export function approvedPayAppRequired(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "APPROVED_PAY_APP_REQUIRED", message: APPROVED_PAY_APP_REQUIRED_MESSAGE });
}

/**
 * Database side of "Release & pay" (architecture §4 steps 2–3): one payout payment per release,
 * captures recorded on the funding payment, and the void that closes a partially captured milestone.
 * PayPal calls live in captures.ts and payouts.ts.
 */

const CAPTURABLE: readonly string[] = ["authorized", "partially_captured"];
/** Release states during which money may still move for the release; closing the milestone waits for them. */
const IN_FLIGHT_RELEASE: readonly string[] = ["created", "capture_pending"];

const CLOSING_MESSAGE =
  "This milestone is being closed (its uncaptured remainder is being voided), so no new release can start. Retry Close milestone if it did not finish.";

function notCapturableMessage(funding: Doc<"payments">): string {
  if (funding.status === "expired") {
    return "The milestone's PayPal authorization expired, so nothing can be captured from it. Fund the milestone again before releasing payment.";
  }
  return `The milestone's authorization is ${funding.status}; nothing more can be released.`;
}

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

    const inFlight = (await milestonePayouts(ctx, milestone._id)).find((p) => IN_FLIGHT_RELEASE.includes(p.status));
    if (inFlight) return { state: "busy", paymentId: inFlight._id, actor: args.actor };

    if (args.payAppId === undefined) throw approvedPayAppRequired();
    const payApp = await ctx.db.get(args.payAppId);
    if (payApp === null || payApp.agreementId !== agreement._id) throw approvedPayAppRequired();
    const gate = await payGateForMutation(ctx, payApp, agreement);
    if (!gate.ok || gate.figures === null || gate.payeeEmail === null) throw cannotPay(gate.reasons);
    if (gate.figures.grossCents !== args.amountCents) {
      throw new ConvexError({
        code: "CONFLICT",
        message: `The approved amount is ${formatCents(gate.figures.grossCents)}, not ${formatCents(args.amountCents)}; nothing was captured or paid.`,
      });
    }

    const funding = await fundedPaymentFor(ctx, milestone._id);
    if (funding === null || !CAPTURABLE.includes(funding.status)) {
      throw new ConvexError({
        code: "NOT_RELEASABLE",
        message:
          funding === null
            ? "This tranche is not funded. Fund it before paying."
            : notCapturableMessage(funding),
      });
    }
    if (funding.closingAt !== undefined) throw new ConvexError({ code: "CLOSING", message: CLOSING_MESSAGE });
    const check = checkCaptureAmount(args.amountCents, remainingAuthorizedCents(funding));
    if (!check.ok) throw new ConvexError({ code: "INVALID_AMOUNT", message: check.message });

    const receiverEmail = gate.payeeEmail;
    const split = gate.figures;
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
    if (p === null || (p.kind !== "payout" && p.kind !== "retainage_release")) return null;
    return {
      paymentId: p._id,
      kind: p.kind,
      status: p.status,
      grossCents: p.grossCents,
      idempotencyKey: p.idempotencyKey,
      fundingPaymentId: p.fundingPaymentId ?? null,
      milestoneId: p.milestoneId ?? null,
      retryOfPaymentId: p.retryOfPaymentId ?? null,
      paypalPayoutBatchId: p.paypalPayoutBatchId ?? null,
      error: p.error ?? null,
    };
  },
});

/**
 * The durable capture gate, called right before the capture POST once OAuth has succeeded. From here on
 * PayPal may hold the capture, so a resume only reconciles it under the same PayPal-Request-Id; before
 * it, a resume is a new capture and must pass canPay again (resumeDb.continueRelease).
 */
export const markCaptureSending = internalMutation({
  args: { releasePaymentId: v.id("payments") },
  returns: v.union(v.object({ state: v.literal("ready") }), v.object({ state: v.literal("closed"), status: v.string(), error: v.optional(v.string()) })),
  handler: async (ctx, { releasePaymentId }) => {
    const release = await ctx.db.get(releasePaymentId);
    if (release === null || release.kind !== "payout") throw new ConvexError({ code: "NOT_FOUND", message: "Release not found." });
    if (release.status !== "created") return { state: "closed" as const, status: release.status, error: release.error };
    if (release.captureSubmittedAt === undefined) await ctx.db.patch(release._id, { captureSubmittedAt: Date.now() });
    return { state: "ready" as const };
  },
});

const beginCaptureResult = v.union(
  v.object({ state: v.literal("done"), captureId: v.string(), finalCapture: v.boolean(), captureStatus: v.string() }),
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
    if (prior) return { state: "done", captureId: prior.captureId, finalCapture: prior.finalCapture, captureStatus: prior.status };
    if (!funding.paypalAuthorizationId || !CAPTURABLE.includes(funding.status)) {
      throw new ConvexError({
        code: "NOT_CAPTURABLE",
        message: notCapturableMessage(funding),
      });
    }
    if (funding.closingAt !== undefined) throw new ConvexError({ code: "CLOSING", message: CLOSING_MESSAGE });
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

/**
 * Stores a capture PayPal returned. A settlement webhook that arrived first decides its status. A PENDING
 * capture parks the release in capture_pending; a denied one fails it. Returns the stored capture status.
 */
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
  returns: v.object({ captureStatus: v.string() }),
  handler: async (ctx, args) => {
    const funding = await ctx.db.get(args.fundingPaymentId);
    if (funding === null) throw new ConvexError({ code: "NOT_FOUND", message: "Funding payment not found." });
    const captures = funding.captures ?? [];
    const stored = captures.find((c) => c.requestKey === args.requestKey || c.captureId === args.captureId);
    if (stored) return { captureStatus: stored.status };
    const to = args.finalCapture ? "captured" : "partially_captured";
    // PayPal applied this capture, so it is recorded even if the authorization was voided or expired meanwhile.
    const closedMeanwhile = !canTransitionPayment("funding", funding.status, to) && (funding.status === "voided" || funding.status === "expired");
    if (!closedMeanwhile) assertPaymentTransition("funding", funding.status, to);
    const captureStatus = (await takeEarlySettlement(ctx, args.captureId)) ?? args.captureStatus;
    await ctx.db.patch(funding._id, {
      ...(closedMeanwhile ? {} : { status: to }),
      paypalCaptureId: args.captureId,
      capturedCents: (funding.capturedCents ?? 0) + args.amountCents,
      captures: [
        ...captures,
        {
          captureId: args.captureId,
          amountCents: args.amountCents,
          requestKey: args.requestKey,
          finalCapture: args.finalCapture,
          status: captureStatus,
          releasePaymentId: args.releasePaymentId,
          capturedAt: Date.now(),
        },
      ],
      error: isCaptureDenied(captureStatus) ? `PayPal denied capture ${args.captureId}.` : undefined,
      auditRecorded: funding.auditRecorded === false ? false : args.auditRecorded,
      updatedAt: Date.now(),
    });
    // Fully captured: nothing more can be released, so the milestone's money is complete.
    if (!closedMeanwhile) await moveMilestone(ctx, funding.milestoneId, args.finalCapture ? "complete" : "in_progress");
    if (captureStatus === "PENDING" && args.releasePaymentId) {
      const release = await ctx.db.get(args.releasePaymentId);
      if (release !== null && release.kind === "payout" && release.status === "created") {
        assertPaymentTransition("payout", "created", "capture_pending");
        await ctx.db.patch(release._id, {
          status: "capture_pending",
          error: undefined,
          updatedAt: Date.now(),
        });
      }
    } else {
      await settleRelease(ctx, args.releasePaymentId, args.captureId, captureStatus);
    }
    return { captureStatus };
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
        await syncProposalForPayment(ctx, release._id);
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
    if ((await milestonePayouts(ctx, milestoneId)).some((p) => IN_FLIGHT_RELEASE.includes(p.status))) {
      throw new ConvexError({ code: "RELEASE_IN_PROGRESS", message: "A release is still being processed. Try again when it finishes." });
    }
    const agreement = await ctx.db.get(funding.agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });
    await ctx.db.patch(funding._id, { closingAt: Date.now(), updatedAt: Date.now() });
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
    // PayPal rejected the void, so the authorization is still open and releases may continue.
    if (funding !== null) await ctx.db.patch(funding._id, { error, closingAt: undefined, updatedAt: Date.now() });
    return null;
  },
});
