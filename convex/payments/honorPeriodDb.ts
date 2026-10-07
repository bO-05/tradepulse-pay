import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { REAUTHORIZE_RETRY_MS, decideHonorPeriodAction, reauthorizeRequestId } from "./honorPeriodMath";
import { moveMilestone } from "./releaseDb";
import { assertPaymentTransition } from "./stateMachine";

/**
 * Database side of the honor-period watcher (honorPeriod.ts runs the PayPal calls). Every decision is
 * re-checked inside the mutation that acts on it, so a concurrent capture, void or second watcher run
 * cannot reauthorize or expire a row that changed in the meantime.
 */

const ACTOR = "TradePulse Pay honor-period watcher";

async function auditWatcher(
  ctx: MutationCtx,
  p: Doc<"payments">,
  entry: { title: string; description: string; operation: string; paypalResourceId?: string; httpStatus?: number },
) {
  const agreement = await ctx.db.get(p.agreementId);
  await ctx.db.insert("auditLogs", {
    projectId: agreement?.projectId,
    tradePackageId: agreement?.tradePackageId,
    agreementId: p.agreementId,
    eventType: "cron_executed",
    title: entry.title,
    description: entry.description,
    actor: ACTOR,
    timestamp: Date.now(),
    operation: entry.operation,
    paypalResourceId: entry.paypalResourceId,
    httpStatus: entry.httpStatus,
  });
}

/** Funding rows the watcher looks at: one row when `paymentId` is given, else every open authorization. */
export const listWatched = internalQuery({
  args: { paymentId: v.optional(v.id("payments")) },
  returns: v.array(v.id("payments")),
  handler: async (ctx, { paymentId }) => {
    if (paymentId !== undefined) return (await ctx.db.get(paymentId)) === null ? [] : [paymentId];
    const ids: Id<"payments">[] = [];
    for (const status of ["authorized", "partially_captured"] as const) {
      const rows = await ctx.db
        .query("payments")
        .withIndex("by_kind_and_status", (q) => q.eq("kind", "funding").eq("status", status))
        .take(500);
      ids.push(...rows.map((r) => r._id));
    }
    return ids;
  },
});

const beginResult = v.union(
  v.object({ state: v.literal("skip"), reason: v.string(), status: v.string() }),
  v.object({ state: v.literal("expired"), status: v.string(), milestoneStatus: v.optional(v.string()) }),
  v.object({
    state: v.literal("reauthorize"),
    authorizationId: v.string(),
    requestId: v.string(),
    amountCents: v.number(),
    agreementId: v.id("agreements"),
    projectId: v.optional(v.id("projects")),
  }),
);
export type BeginWatch = Infer<typeof beginResult>;

/**
 * Decides what to do with one funding row now. An expired authorization is closed here (payment →
 * expired, milestone → funding_expired, or complete when part of it was captured) with no PayPal call.
 */
export const beginWatch = internalMutation({
  args: { paymentId: v.id("payments"), now: v.number() },
  returns: beginResult,
  handler: async (ctx, { paymentId, now }): Promise<BeginWatch> => {
    const p = await ctx.db.get(paymentId);
    if (p === null) return { state: "skip", reason: "payment not found", status: "missing" };
    const decision = decideHonorPeriodAction(p, now);
    if (decision.action === "skip") return { state: "skip", reason: decision.reason, status: p.status };

    if (decision.action === "expire") {
      const wasPartlyCaptured = p.status === "partially_captured";
      assertPaymentTransition("funding", p.status, "expired");
      const message = wasPartlyCaptured
        ? `The authorization expired with ${formatCents(p.grossCents - (p.capturedCents ?? 0))} uncaptured; that remainder was released by PayPal and cannot be captured.`
        : "Funding expired: the PayPal authorization passed its expiry before it was captured. Nothing can be captured from it; fund the milestone again.";
      await ctx.db.patch(p._id, { status: "expired", expiredAt: now, error: message, updatedAt: now });
      await moveMilestone(ctx, p.milestoneId, wasPartlyCaptured ? "complete" : "funding_expired");
      await auditWatcher(ctx, p, {
        title: "Authorization expired",
        description: `Authorization ${p.paypalAuthorizationId} (${formatCents(p.grossCents)}) reached its expiry; the payment was marked expired without a PayPal call. ${message}`,
        operation: "honor_period.expire",
        paypalResourceId: p.paypalAuthorizationId,
      });
      const milestone = p.milestoneId ? await ctx.db.get(p.milestoneId) : null;
      return { state: "expired", status: "expired", milestoneStatus: milestone?.status };
    }

    // Only a rejection advances the attempt number, so after a network error the same request id is retried.
    const attempt = (p.reauthorizeAttempts ?? 0) + 1;
    const agreement = await ctx.db.get(p.agreementId);
    return {
      state: "reauthorize",
      authorizationId: p.paypalAuthorizationId!,
      requestId: reauthorizeRequestId(p.idempotencyKey, attempt),
      amountCents: p.grossCents - (p.capturedCents ?? 0),
      agreementId: p.agreementId,
      projectId: agreement?.projectId,
    };
  },
});

/** Stores the new authorization id and its fresh 3-day honor period; the old id is kept for history. */
export const recordReauthorization = internalMutation({
  args: {
    paymentId: v.id("payments"),
    previousAuthorizationId: v.string(),
    newAuthorizationId: v.string(),
    paypalStatus: v.optional(v.string()),
    honorPeriodEndsAt: v.number(),
    authorizationExpiresAt: v.optional(v.number()),
    auditRecorded: v.boolean(),
  },
  returns: v.object({ applied: v.boolean() }),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.paymentId);
    if (p === null) return { applied: false };
    if (p.paypalAuthorizationId === args.newAuthorizationId) return { applied: false };
    if (p.paypalAuthorizationId !== args.previousAuthorizationId || p.status !== "authorized") {
      // The row moved on (captured, voided, expired) while PayPal answered; keep the new id on record only.
      await ctx.db.patch(p._id, {
        previousAuthorizationIds: [...(p.previousAuthorizationIds ?? []), args.newAuthorizationId],
        updatedAt: Date.now(),
      });
      return { applied: false };
    }
    const now = Date.now();
    await ctx.db.patch(p._id, {
      paypalAuthorizationId: args.newAuthorizationId,
      previousAuthorizationIds: [...(p.previousAuthorizationIds ?? []), args.previousAuthorizationId],
      honorPeriodEndsAt: args.honorPeriodEndsAt,
      ...(args.authorizationExpiresAt !== undefined ? { authorizationExpiresAt: args.authorizationExpiresAt } : {}),
      reauthorizationCount: (p.reauthorizationCount ?? 0) + 1,
      reauthorizedAt: now,
      reauthorizeError: undefined,
      reauthorizeRetryAfter: undefined,
      auditRecorded: p.auditRecorded === false ? false : args.auditRecorded,
      updatedAt: now,
    });
    await auditWatcher(ctx, p, {
      title: "Authorization reauthorized",
      description: `Honor period of authorization ${args.previousAuthorizationId} ended; PayPal reauthorized ${formatCents(p.grossCents)} as ${args.newAuthorizationId} (${args.paypalStatus ?? "status not returned"}). New honor period ends ${new Date(args.honorPeriodEndsAt).toISOString()}.`,
      operation: "honor_period.reauthorize",
      paypalResourceId: args.newAuthorizationId,
    });
    return { applied: true };
  },
});

/** PayPal refused the reauthorization: the original authorization stays as it was, and the refusal is logged. */
export const recordReauthorizeRejected = internalMutation({
  args: {
    paymentId: v.id("payments"),
    authorizationId: v.string(),
    httpStatus: v.number(),
    paypalName: v.optional(v.string()),
    issues: v.array(v.string()),
    message: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.paymentId);
    if (p === null) return null;
    const now = Date.now();
    const codes = args.issues.length > 0 ? args.issues.join(", ") : (args.paypalName ?? "no issue code");
    const note = `PayPal rejected the reauthorization (HTTP ${args.httpStatus}, ${codes}). The original authorization ${args.authorizationId} is unchanged and can still be captured until it expires.`;
    await ctx.db.patch(p._id, {
      reauthorizeError: `${note} ${args.message}`.slice(0, 1000),
      reauthorizeRetryAfter: now + REAUTHORIZE_RETRY_MS,
      reauthorizeAttempts: (p.reauthorizeAttempts ?? 0) + 1,
      updatedAt: now,
    });
    await auditWatcher(ctx, p, {
      title: "Reauthorization rejected",
      description: `${note} PayPal said: ${args.message}`.slice(0, 2000),
      operation: "honor_period.reauthorize_rejected",
      paypalResourceId: args.authorizationId,
      httpStatus: args.httpStatus,
    });
    return null;
  },
});
