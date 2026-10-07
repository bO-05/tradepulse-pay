import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { env, internalAction, type ActionCtx } from "../_generated/server";
import { toPayPalString } from "../lib/money";
import { paypalErrorData } from "./captures";
import type { BeginPayout } from "./payoutDb";
import { batchIdFromLinks, isDuplicateBatchError, payoutStatusFromPayPal } from "./payoutMath";
import { payPalClientForAction } from "./paypalClient";

/**
 * Sub payouts through REST /v1/payments/payouts (architecture §4 step 3). sender_batch_id is the payout
 * payment's idempotencyKey, so a repeated POST gets PayPal's duplicate-batch 400, which resolves to the
 * existing batch instead of paying twice. After create, the batch is polled a bounded number of times
 * until the item settles; later changes (e.g. an unclaimed item being claimed) arrive by webhook.
 */

/** Delays between batch polls; sandbox items usually settle in 10–30 s. */
export const POLL_DELAYS_MS: readonly number[] = [10_000, 15_000, 30_000, 60_000];

/**
 * Seen live: a payout sent seconds after the capture that funds it can get 422 INSUFFICIENT_FUNDS while
 * the captured funds settle into the sender balance. The same sender_batch_id is retried on this schedule.
 */
export const FUNDS_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000];

export type PayoutResult = { batchId?: string; status: string; duplicate: boolean; alreadySent: boolean; deferred?: boolean };

type PayoutBatch = {
  batch_header?: { payout_batch_id?: string; batch_status?: string };
  items?: Array<{
    payout_item_id?: string;
    transaction_status?: string;
    payout_item?: { sender_item_id?: string };
    errors?: { name?: string };
  }>;
};

export async function payoutSub(
  ctx: ActionCtx,
  args: { paymentId: Id<"payments">; actor: string; fundsRetry?: number },
): Promise<PayoutResult> {
  const begun: BeginPayout = await ctx.runMutation(internal.payments.payoutDb.beginPayout, { paymentId: args.paymentId });
  if (begun.state === "done") return { batchId: begun.batchId, status: begun.status, duplicate: false, alreadySent: true };
  if (begun.state === "closed") {
    throw new ConvexError({
      code: "PAYOUT_CLOSED",
      message: begun.error ?? `This payout is ${begun.status} and cannot be sent again.`,
    });
  }

  const paypal = payPalClientForAction(ctx, env, {
    actor: args.actor,
    projectId: begun.projectId,
    agreementId: begun.agreementId,
  });
  let batchId: string | undefined;
  let auditRecorded = true;
  let duplicate = false;
  try {
    const out = await paypal.request<PayoutBatch>({
      method: "POST",
      path: "/v1/payments/payouts",
      requestId: begun.idempotencyKey,
      body: {
        sender_batch_header: {
          sender_batch_id: begun.idempotencyKey,
          email_subject: "TradePulse Pay: progress payment",
          email_message: begun.note,
        },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value: toPayPalString(begun.netCents), currency: "USD" },
            receiver: begun.receiverEmail,
            note: begun.note,
            sender_item_id: args.paymentId,
          },
        ],
      },
    });
    batchId = out.data?.batch_header?.payout_batch_id;
    auditRecorded = out.auditRecorded ?? false;
  } catch (e) {
    const data = paypalErrorData(e);
    if (data !== null && isDuplicateBatchError(data)) {
      batchId = batchIdFromLinks(data.links);
      duplicate = true;
      auditRecorded = data.auditRecorded ?? false;
      if (!batchId) {
        throw new ConvexError({
          code: "PAYOUT_DUPLICATE_UNRESOLVED",
          message: "PayPal reports this payout batch was already sent but did not return its id. Nothing was paid twice; refresh later.",
        });
      }
    } else if (data !== null && isInsufficientFunds(data) && (args.fundsRetry ?? 0) < FUNDS_RETRY_DELAYS_MS.length) {
      const attempt = args.fundsRetry ?? 0;
      const delay = FUNDS_RETRY_DELAYS_MS[attempt];
      await ctx.runMutation(internal.payments.payoutDb.recordPayoutDeferred, {
        paymentId: args.paymentId,
        note: `Waiting for PayPal funds: the payout was rejected with INSUFFICIENT_FUNDS; retrying the same batch in ${delay / 1000} s (retry ${attempt + 1} of ${FUNDS_RETRY_DELAYS_MS.length}).`,
      });
      await ctx.scheduler.runAfter(delay, internal.payments.payouts.retryPayoutForFunds, {
        paymentId: args.paymentId,
        actor: args.actor,
        fundsRetry: attempt + 1,
      });
      return { status: "created", duplicate: false, alreadySent: false, deferred: true };
    } else if (data !== null && data.status < 500) {
      const message = `Payout rejected by PayPal: ${data.message} The sub was not paid; the captured amount stays in the platform account.`;
      await ctx.runMutation(internal.payments.payoutDb.recordPayoutFailure, { paymentId: args.paymentId, error: message });
      throw new ConvexError({ code: "PAYOUT_FAILED", message, paypalName: data.name, issues: data.issues });
    } else {
      throw e;
    }
  }
  if (!batchId) {
    throw new ConvexError({ code: "PAYOUT_UNKNOWN", message: "PayPal did not return a payout batch id. Refresh the payout status." });
  }
  await ctx.runMutation(internal.payments.payoutDb.recordPayoutCreated, {
    paymentId: args.paymentId,
    batchId,
    auditRecorded,
    duplicate,
  });
  await ctx.scheduler.runAfter(POLL_DELAYS_MS[0], internal.payments.payouts.pollPayoutBatch, {
    paymentId: args.paymentId,
    attempt: 0,
  });
  return { batchId, status: "pending", duplicate, alreadySent: false };
}

/** GETs the batch once and applies the item status. Returns the payment status after applying it. */
export async function refreshPayout(ctx: ActionCtx, paymentId: Id<"payments">): Promise<{ status: string; settled: boolean }> {
  const row = await ctx.runQuery(internal.payments.releaseDb.releaseRow, { paymentId });
  if (row === null || !row.paypalPayoutBatchId) return { status: row?.status ?? "missing", settled: true };
  const paypal = payPalClientForAction(ctx, env, { actor: "system:payout-poll" });
  const { data } = await paypal.request<PayoutBatch>({
    method: "GET",
    path: `/v1/payments/payouts/${encodeURIComponent(row.paypalPayoutBatchId)}`,
  });
  const items = data?.items ?? [];
  const item = items.find((i) => i.payout_item?.sender_item_id === paymentId) ?? items[0];
  const status = payoutStatusFromPayPal(item?.transaction_status, data?.batch_header?.batch_status);
  const applied = await ctx.runMutation(internal.payments.payoutDb.applyPayoutStatus, {
    paymentId,
    status: status ?? undefined,
    itemId: item?.payout_item_id,
    itemStatus: item?.transaction_status,
    errorName: item?.errors?.name,
  });
  return { status: applied.status, settled: status !== null };
}

function isInsufficientFunds(data: { name?: string; issues?: string[] }): boolean {
  return data.name === "INSUFFICIENT_FUNDS" || (data.issues ?? []).includes("INSUFFICIENT_FUNDS");
}

export const retryPayoutForFunds = internalAction({
  args: { paymentId: v.id("payments"), actor: v.string(), fundsRetry: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await payoutSub(ctx, args);
    } catch (e) {
      console.error(`Payout retry failed for ${args.paymentId}: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    return null;
  },
});

export const pollPayoutBatch = internalAction({
  args: { paymentId: v.id("payments"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { paymentId, attempt }) => {
    let settled = false;
    try {
      settled = (await refreshPayout(ctx, paymentId)).settled;
    } catch (e) {
      console.error(`Payout poll failed for ${paymentId}: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    const next = attempt + 1;
    if (!settled && next < POLL_DELAYS_MS.length) {
      await ctx.scheduler.runAfter(POLL_DELAYS_MS[next], internal.payments.payouts.pollPayoutBatch, { paymentId, attempt: next });
    }
    return null;
  },
});

/** CLI / scheduler entry point for payoutSub, e.g. to retry the same payout and observe the duplicate-batch path. */
export const payoutSubInternal = internalAction({
  args: { paymentId: v.id("payments"), actor: v.optional(v.string()) },
  returns: v.object({
    batchId: v.optional(v.string()),
    status: v.string(),
    duplicate: v.boolean(),
    alreadySent: v.boolean(),
    deferred: v.optional(v.boolean()),
  }),
  handler: async (ctx, args): Promise<PayoutResult> => await payoutSub(ctx, { ...args, actor: args.actor ?? "system:internal" }),
});

