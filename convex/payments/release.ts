import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, env, internalAction, internalQuery, type ActionCtx } from "../_generated/server";
import { requireRoleInAction } from "../lib/roles";
import { captureApproved, voidRemainder } from "./captures";
import { payoutSub, refreshPayout } from "./payouts";
import { payPalClientForAction } from "./paypalClient";
import type { BeginRelease } from "./releaseDb";

/**
 * "Release & pay" (architecture §4 steps 2–3): capture the released amount from the milestone's
 * authorization, then pay the sub the net of retainage. GC only. Each release has one payout payment
 * keyed by the client's requestKey, so retries and double clicks reuse it instead of paying twice.
 */

const releaseResult = v.object({
  state: v.union(v.literal("paid"), v.literal("pending"), v.literal("already_processed"), v.literal("busy")),
  paymentId: v.id("payments"),
  status: v.string(),
  message: v.optional(v.string()),
  captureId: v.optional(v.string()),
  batchId: v.optional(v.string()),
});
type ReleaseResult = Infer<typeof releaseResult>;

export const actorForUser = internalQuery({
  args: { userId: v.id("users") },
  returns: v.string(),
  handler: async (ctx, { userId }) => (await ctx.db.get(userId))?.email ?? `user:${userId}`,
});

/** Runs (or resumes) the capture and payout for an existing release payment. */
async function executeRelease(ctx: ActionCtx, paymentId: Id<"payments">, actor: string): Promise<ReleaseResult> {
  const row = await ctx.runQuery(internal.payments.releaseDb.releaseRow, { paymentId });
  if (row === null || row.kind !== "payout") throw new ConvexError({ code: "NOT_FOUND", message: "Release not found." });
  if (row.status !== "created") {
    return {
      state: "already_processed",
      paymentId,
      status: row.status,
      message: row.error ?? "This release was already processed.",
      batchId: row.paypalPayoutBatchId ?? undefined,
    };
  }
  if (row.fundingPaymentId === null) throw new ConvexError({ code: "INVALID_STATE", message: "This release has no funding authorization." });
  const capture = await captureApproved(ctx, {
    paymentId: row.fundingPaymentId,
    amountCents: row.grossCents,
    requestKey: row.idempotencyKey,
    actor,
    releasePaymentId: paymentId,
  });
  if (capture.captureStatus === "PENDING") {
    return {
      state: "pending",
      paymentId,
      status: "capture_pending",
      captureId: capture.captureId,
      message:
        "Capture pending: PayPal has not completed the capture yet, so the sub was not paid. The payout is sent automatically when PayPal completes it; use Refresh status to check.",
    };
  }
  const payout = await payoutSub(ctx, { paymentId, actor });
  if (payout.deferred) {
    return {
      state: "pending",
      paymentId,
      status: payout.status,
      captureId: capture.captureId,
      message: "Captured. PayPal reported insufficient funds for the payout right away; it is retried automatically.",
    };
  }
  return {
    state: payout.status === "success" ? "paid" : "pending",
    paymentId,
    status: payout.status,
    captureId: capture.captureId,
    batchId: payout.batchId,
    ...(payout.duplicate ? { message: "PayPal already had this payout batch; it was not sent twice." } : {}),
  };
}

async function startRelease(
  ctx: ActionCtx,
  args: {
    milestoneId: Id<"milestones">;
    amountCents: number;
    requestKey: string;
    actor: string;
    payAppId?: Id<"payApplications">;
    proposalId?: Id<"agentProposals">;
  },
): Promise<ReleaseResult> {
  const begun: BeginRelease = await ctx.runMutation(internal.payments.releaseDb.beginRelease, args);
  if (begun.state === "busy" || (begun.state === "existing" && begun.status === "created")) {
    return {
      state: "busy",
      paymentId: begun.paymentId,
      status: "created",
      message: "This release is already being processed.",
    };
  }
  if (begun.state === "existing") {
    return { state: "already_processed", paymentId: begun.paymentId, status: begun.status, message: "This release was already processed." };
  }
  return await executeRelease(ctx, begun.paymentId, begun.actor);
}

export const releaseAndPay = action({
  args: { milestoneId: v.id("milestones"), amountCents: v.number(), requestKey: v.string() },
  returns: releaseResult,
  handler: async (ctx, args): Promise<ReleaseResult> => {
    const viewer = await requireRoleInAction(ctx, ["gc"]);
    const actor: string = await ctx.runQuery(internal.payments.release.actorForUser, { userId: viewer.userId });
    return await startRelease(ctx, { ...args, actor });
  },
});

/** Retries a release whose capture or payout did not finish (e.g. after a network error). */
export const resumeRelease = action({
  args: { paymentId: v.id("payments") },
  returns: releaseResult,
  handler: async (ctx, { paymentId }): Promise<ReleaseResult> => {
    const viewer = await requireRoleInAction(ctx, ["gc"]);
    const actor: string = await ctx.runQuery(internal.payments.release.actorForUser, { userId: viewer.userId });
    return await executeRelease(ctx, paymentId, actor);
  },
});

/** Closes a partially captured milestone by voiding the uncaptured remainder of its authorization. */
export const closeMilestone = action({
  args: { milestoneId: v.id("milestones") },
  returns: v.object({ voided: v.boolean(), alreadyVoided: v.boolean() }),
  handler: async (ctx, { milestoneId }) => {
    const viewer = await requireRoleInAction(ctx, ["gc"]);
    const actor: string = await ctx.runQuery(internal.payments.release.actorForUser, { userId: viewer.userId });
    return await voidRemainder(ctx, { milestoneId, actor });
  },
});

/** GETs the capture behind a capture_pending release and applies it: COMPLETED sends the payout, DENIED fails it. */
export const refreshCaptureStatus = action({
  args: { paymentId: v.id("payments") },
  returns: v.object({ captureStatus: v.string(), status: v.string() }),
  handler: async (ctx, { paymentId }): Promise<{ captureStatus: string; status: string }> => {
    await requireRoleInAction(ctx, ["gc"]);
    const found = await ctx.runQuery(internal.payments.captureSettlement.captureForRelease, { paymentId });
    if (found === null) throw new ConvexError({ code: "NOT_FOUND", message: "This release has no stored capture yet." });
    const paypal = payPalClientForAction(ctx, env, { actor: "system:capture-refresh" });
    const { data } = await paypal.request<{ status?: string }>({
      method: "GET",
      path: `/v2/payments/captures/${encodeURIComponent(found.captureId)}`,
    });
    const captureStatus = data?.status ?? found.captureStatus;
    await ctx.runMutation(internal.payments.captureSettlement.applyCaptureSettlement, {
      fundingPaymentId: found.fundingPaymentId,
      captureId: found.captureId,
      status: captureStatus,
    });
    const row = await ctx.runQuery(internal.payments.releaseDb.releaseRow, { paymentId });
    return { captureStatus, status: row?.status ?? found.releaseStatus };
  },
});

export const refreshPayoutStatus = action({
  args: { paymentId: v.id("payments") },
  returns: v.object({ status: v.string(), settled: v.boolean() }),
  handler: async (ctx, { paymentId }) => {
    await requireRoleInAction(ctx, ["gc"]);
    return await refreshPayout(ctx, paymentId);
  },
});

/** CLI entry point (`npx convex run payments/release:releaseAndPayInternal`), e.g. for odd-cent amounts. */
export const releaseAndPayInternal = internalAction({
  args: {
    milestoneId: v.id("milestones"),
    amountCents: v.number(),
    requestKey: v.string(),
    actor: v.optional(v.string()),
    payAppId: v.optional(v.id("payApplications")),
    proposalId: v.optional(v.id("agentProposals")),
  },
  returns: releaseResult,
  handler: async (ctx, args): Promise<ReleaseResult> => await startRelease(ctx, { ...args, actor: args.actor ?? "system:internal" }),
});
