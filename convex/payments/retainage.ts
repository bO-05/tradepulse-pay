import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import { requireRoleInAction } from "../lib/roles";
import { formatCents } from "../lib/money";
import { payoutSub } from "./payouts";
import type { BeginRetainageRelease } from "./retainageDb";

/**
 * "Release retainage" at closeout (architecture §4 step 4), GC only: pays the sub the agreement's
 * retainage ledger balance as one PayPal payout, reusing the sub payout path (sender_batch_id =
 * the payment's idempotencyKey, polling, webhook status). With a zero balance nothing is sent.
 */

const retainageResult = v.object({
  state: v.union(v.literal("nothing_to_release"), v.literal("pending"), v.literal("paid")),
  paymentId: v.optional(v.id("payments")),
  amountCents: v.number(),
  status: v.optional(v.string()),
  batchId: v.optional(v.string()),
  message: v.string(),
});
type RetainageResult = Infer<typeof retainageResult>;

async function releaseRetainageFor(ctx: ActionCtx, agreementId: Id<"agreements">, actor: string): Promise<RetainageResult> {
  const begun: BeginRetainageRelease = await ctx.runMutation(internal.payments.retainageDb.beginRetainageRelease, { agreementId });
  if (begun.state === "nothing_to_release") {
    return { state: "nothing_to_release", amountCents: 0, message: "No retainage is held on this agreement; nothing was sent to PayPal." };
  }
  const payout = await payoutSub(ctx, { paymentId: begun.paymentId, actor });
  const amount = formatCents(begun.amountCents);
  if (payout.deferred) {
    return {
      state: "pending",
      paymentId: begun.paymentId,
      amountCents: begun.amountCents,
      status: payout.status,
      message: `PayPal reported insufficient funds for the ${amount} retainage release; it is retried automatically.`,
    };
  }
  return {
    state: payout.status === "success" ? "paid" : "pending",
    paymentId: begun.paymentId,
    amountCents: begun.amountCents,
    status: payout.status,
    batchId: payout.batchId,
    message:
      payout.duplicate || payout.alreadySent
        ? `This ${amount} retainage release was already sent to PayPal; it was not sent twice.`
        : `Sent ${amount} of retainage to PayPal. The status updates here when PayPal settles the payout.`,
  };
}

export const releaseRetainage = action({
  args: { agreementId: v.id("agreements") },
  returns: retainageResult,
  handler: async (ctx, { agreementId }): Promise<RetainageResult> => {
    const viewer = await requireRoleInAction(ctx, ["gc"]);
    const actor: string = await ctx.runQuery(internal.payments.release.actorForUser, { userId: viewer.userId });
    return await releaseRetainageFor(ctx, agreementId, actor);
  },
});

/** CLI entry point (`npx convex run payments/retainage:releaseRetainageInternal`). */
export const releaseRetainageInternal = internalAction({
  args: { agreementId: v.id("agreements"), actor: v.optional(v.string()) },
  returns: retainageResult,
  handler: async (ctx, args): Promise<RetainageResult> =>
    await releaseRetainageFor(ctx, args.agreementId, args.actor ?? "system:internal"),
});
