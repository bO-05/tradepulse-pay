import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { requireProjectScopeInAction } from "../lib/tenancyAction";
import { payoutSub } from "./payouts";

/**
 * GC "Retry payout" for a release whose capture succeeded but whose payout failed or was returned.
 * Sends a new batch (`<original key>_r<n>`) for the same captured amount; refused while any payout
 * for that release is created, pending, unclaimed or paid (payoutRetryMath.ts).
 */

const retryResult = v.object({
  paymentId: v.id("payments"),
  idempotencyKey: v.string(),
  status: v.string(),
  batchId: v.optional(v.string()),
  deferred: v.boolean(),
});
type RetryResult = Infer<typeof retryResult>;

async function retry(ctx: ActionCtx, paymentId: Id<"payments">, actor: string): Promise<RetryResult> {
  const begun: { retryPaymentId: Id<"payments">; idempotencyKey: string; n: number } = await ctx.runMutation(
    internal.payments.payoutRetryDb.beginPayoutRetry,
    { paymentId, actor },
  );
  const out = await payoutSub(ctx, { paymentId: begun.retryPaymentId, actor });
  return {
    paymentId: begun.retryPaymentId,
    idempotencyKey: begun.idempotencyKey,
    status: out.status,
    batchId: out.batchId,
    deferred: out.deferred ?? false,
  };
}

export const retryPayout = action({
  args: { paymentId: v.id("payments") },
  returns: retryResult,
  handler: async (ctx, { paymentId }): Promise<RetryResult> => {
    const scope = await requireProjectScopeInAction(ctx, { docs: [{ table: "payments", id: paymentId }] }, { roles: ["gc"], write: true });
    return await retry(ctx, paymentId, scope.actor);
  },
});

/** CLI twin: `npx convex run payments/payoutRetry:retryPayoutInternal '{"paymentId":"<failed release id>"}'`. */
export const retryPayoutInternal = internalAction({
  args: { paymentId: v.id("payments"), actor: v.optional(v.string()) },
  returns: retryResult,
  handler: async (ctx, args): Promise<RetryResult> => await retry(ctx, args.paymentId, args.actor ?? "system:internal"),
});
