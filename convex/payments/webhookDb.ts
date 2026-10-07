import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { applyInvoiceStatusTo } from "./changeOrderDb";
import { applyPayoutStatusTo } from "./payoutDb";
import { payoutStatusFromPayPal } from "./payoutMath";
import { moveMilestone } from "./releaseDb";
import { canTransitionPayment } from "./stateMachine";
import { isHandledEventType, parseWebhookEvent, type ParsedWebhookEvent } from "./webhookEvents";

/**
 * Database side of POST /paypal/webhook. Each verified event is deduplicated by PayPal event id and
 * dispatched in the same transaction, so a redelivery can never apply a transition twice.
 * Our own actions already record most outcomes synchronously; webhooks confirm them, and move state
 * only for changes PayPal reports later (payout item settlement, invoice payment, voids, denials).
 */

type DispatchOutcome = { changed: boolean; error?: string };

async function eventRow(ctx: MutationCtx, eventId: string): Promise<Doc<"paypalEvents"> | null> {
  return await ctx.db
    .query("paypalEvents")
    .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
    .first();
}

type PaymentIdField = "paypalOrderId" | "paypalAuthorizationId" | "paypalCaptureId" | "paypalPayoutItemId";

async function paymentBy(ctx: MutationCtx, field: PaymentIdField, id: string | undefined): Promise<Doc<"payments"> | null> {
  if (!id) return null;
  const q = ctx.db.query("payments");
  switch (field) {
    case "paypalOrderId":
      return await q.withIndex("by_paypalOrderId", (i) => i.eq("paypalOrderId", id)).first();
    case "paypalAuthorizationId":
      return await q.withIndex("by_paypalAuthorizationId", (i) => i.eq("paypalAuthorizationId", id)).first();
    case "paypalCaptureId":
      return await q.withIndex("by_paypalCaptureId", (i) => i.eq("paypalCaptureId", id)).first();
    case "paypalPayoutItemId":
      return await q.withIndex("by_paypalPayoutItemId", (i) => i.eq("paypalPayoutItemId", id)).first();
  }
}

function unmatched(e: ParsedWebhookEvent): DispatchOutcome {
  return { changed: false, error: `No stored record matches ${e.eventType} resource ${e.resourceId ?? "(none)"}.` };
}

async function fundingForCapture(ctx: MutationCtx, e: ParsedWebhookEvent): Promise<Doc<"payments"> | null> {
  const byAuth = await paymentBy(ctx, "paypalAuthorizationId", e.authorizationId);
  if (byAuth !== null) return byAuth;
  return await paymentBy(ctx, "paypalCaptureId", e.captureId);
}

async function onAuthorization(ctx: MutationCtx, e: ParsedWebhookEvent): Promise<DispatchOutcome> {
  const p =
    (await paymentBy(ctx, "paypalAuthorizationId", e.authorizationId)) ??
    (await paymentBy(ctx, "paypalOrderId", e.orderId));
  if (p === null || p.kind !== "funding") return unmatched(e);
  if (e.eventType !== "PAYMENT.AUTHORIZATION.VOIDED") return { changed: false };
  // A voided authorization on a different (older) id must not void the current one.
  if (p.paypalAuthorizationId !== e.authorizationId) return { changed: false };
  if (!canTransitionPayment("funding", p.status, "voided")) return { changed: false };
  const drawn = p.status === "partially_captured";
  await ctx.db.patch(p._id, { status: "voided", updatedAt: Date.now() });
  // A remainder void closes a drawn milestone; voiding an untouched authorization leaves it unfunded.
  await moveMilestone(ctx, p.milestoneId, drawn ? "complete" : "funding_expired");
  return { changed: true };
}

async function onCapture(ctx: MutationCtx, e: ParsedWebhookEvent): Promise<DispatchOutcome> {
  const funding = await fundingForCapture(ctx, e);
  if (funding === null || funding.kind !== "funding") return unmatched(e);
  const captures = funding.captures ?? [];
  const i = captures.findIndex((c) => c.captureId === e.captureId);
  // The webhook can beat the capture action's own write; that write records the capture.
  if (i < 0) return { changed: false };
  const status = e.resourceStatus ?? (e.eventType === "PAYMENT.CAPTURE.DENIED" ? "DENIED" : "COMPLETED");
  if (captures[i].status === status) return { changed: false };
  const next = captures.map((c, j) => (j === i ? { ...c, status } : c));
  const error =
    e.eventType === "PAYMENT.CAPTURE.DENIED"
      ? `PayPal denied capture ${e.captureId}.`
      : e.eventType === "PAYMENT.CAPTURE.REFUNDED"
        ? `PayPal reported capture ${e.captureId} as refunded.`
        : funding.error;
  await ctx.db.patch(funding._id, { captures: next, error, updatedAt: Date.now() });
  return { changed: true };
}

async function onPayoutItem(ctx: MutationCtx, e: ParsedWebhookEvent): Promise<DispatchOutcome> {
  let p = await paymentBy(ctx, "paypalPayoutItemId", e.payoutItemId);
  if (p === null && e.senderItemId) {
    const id = ctx.db.normalizeId("payments", e.senderItemId);
    const row = id ? await ctx.db.get(id) : null;
    if (row !== null && (!e.payoutBatchId || row.paypalPayoutBatchId === e.payoutBatchId)) p = row;
  }
  if (p === null && e.payoutBatchId) {
    const batchId = e.payoutBatchId;
    const inBatch = await ctx.db
      .query("payments")
      .withIndex("by_paypalPayoutBatchId", (q) => q.eq("paypalPayoutBatchId", batchId))
      .take(2);
    // Our batches carry one item each; only an unambiguous single row is matched by batch id.
    if (inBatch.length === 1) p = inBatch[0];
  }
  if (p === null || p.kind === "funding") return unmatched(e);
  const status = payoutStatusFromPayPal(e.resourceStatus);
  const out = await applyPayoutStatusTo(ctx, p, {
    status: status ?? undefined,
    itemId: e.payoutItemId,
    itemStatus: e.resourceStatus,
    errorName: e.payoutErrorName,
  });
  return { changed: out.applied };
}

async function onPayoutBatch(ctx: MutationCtx, e: ParsedWebhookEvent): Promise<DispatchOutcome> {
  const batchId = e.payoutBatchId;
  if (!batchId) return unmatched(e);
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_paypalPayoutBatchId", (q) => q.eq("paypalPayoutBatchId", batchId))
    .take(50);
  if (rows.length === 0) return unmatched(e);
  // A SUCCESS batch says nothing about each item (an item can still be UNCLAIMED), so only DENIED moves state.
  const status = payoutStatusFromPayPal(undefined, e.resourceStatus);
  if (status === null) return { changed: false };
  let changed = false;
  for (const p of rows) {
    if (p.kind === "funding") continue;
    const out = await applyPayoutStatusTo(ctx, p, { status, itemStatus: undefined, errorName: e.resourceStatus });
    changed = changed || out.applied;
  }
  return { changed };
}

async function onInvoice(ctx: MutationCtx, e: ParsedWebhookEvent): Promise<DispatchOutcome> {
  const invoiceId = e.invoiceId;
  if (!invoiceId) return unmatched(e);
  const co = await ctx.db
    .query("changeOrders")
    .withIndex("by_paypalInvoiceId", (q) => q.eq("paypalInvoiceId", invoiceId))
    .first();
  if (co === null) return unmatched(e);
  const status = e.resourceStatus ?? (e.eventType === "INVOICING.INVOICE.PAID" ? "PAID" : "CANCELLED");
  const out = await applyInvoiceStatusTo(ctx, co, status);
  return { changed: out.changed };
}

async function onOrder(ctx: MutationCtx, e: ParsedWebhookEvent): Promise<DispatchOutcome> {
  // Approval is driven by the buyer's onApprove → authorizeFundingOrder; the webhook only confirms it.
  const p = await paymentBy(ctx, "paypalOrderId", e.orderId);
  return p === null ? unmatched(e) : { changed: false };
}

/** Applies one verified event to payments, milestones and change orders. Unhandled types change nothing. */
export async function dispatchWebhookEvent(ctx: MutationCtx, e: ParsedWebhookEvent): Promise<DispatchOutcome> {
  if (!isHandledEventType(e.eventType)) return { changed: false };
  if (e.eventType.startsWith("PAYMENT.AUTHORIZATION.")) return await onAuthorization(ctx, e);
  if (e.eventType.startsWith("PAYMENT.CAPTURE.")) return await onCapture(ctx, e);
  if (e.eventType.startsWith("PAYMENT.PAYOUTS-ITEM.")) return await onPayoutItem(ctx, e);
  if (e.eventType.startsWith("PAYMENT.PAYOUTSBATCH.")) return await onPayoutBatch(ctx, e);
  if (e.eventType.startsWith("INVOICING.INVOICE.")) return await onInvoice(ctx, e);
  return await onOrder(ctx, e);
}

const processResult = v.object({
  duplicate: v.boolean(),
  eventId: v.union(v.string(), v.null()),
  changed: v.boolean(),
  error: v.optional(v.string()),
});

/** Records and dispatches a verified event once; a repeat of a processed event id is a no-op. */
export const processVerifiedEvent = internalMutation({
  args: { event: v.any() },
  returns: processResult,
  handler: async (ctx, { event }) => {
    const parsed = parseWebhookEvent(event);
    if (parsed === null) {
      return { duplicate: false, eventId: null, changed: false, error: "Not a PayPal event (missing id or event_type)." };
    }
    const existing = await eventRow(ctx, parsed.eventId);
    if (existing !== null && existing.verified && existing.processed) {
      return { duplicate: true, eventId: parsed.eventId, changed: false };
    }
    const out = await dispatchWebhookEvent(ctx, parsed);
    const row = {
      eventId: parsed.eventId,
      eventType: parsed.eventType,
      resourceId: parsed.resourceId,
      verified: true,
      processed: true,
      error: out.error,
    };
    // A row left by an earlier unverified or failed delivery of the same id is upgraded, keeping one row per id.
    if (existing !== null) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("paypalEvents", { ...row, receivedAt: Date.now() });
    return { duplicate: false, eventId: parsed.eventId, changed: out.changed, ...(out.error ? { error: out.error } : {}) };
  },
});

/** Records a delivery that failed verification. It never touches an existing row for the same event id. */
export const recordUnverifiedEvent = internalMutation({
  args: { eventId: v.string(), eventType: v.string(), resourceId: v.optional(v.string()), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if ((await eventRow(ctx, args.eventId)) !== null) return null;
    await ctx.db.insert("paypalEvents", { ...args, receivedAt: Date.now(), verified: false, processed: false });
    return null;
  },
});

/** Records a verified event whose dispatch threw, so PayPal's retry is reprocessed rather than deduplicated. */
export const recordProcessingFailure = internalMutation({
  args: { eventId: v.string(), eventType: v.string(), resourceId: v.optional(v.string()), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await eventRow(ctx, args.eventId);
    if (existing !== null && existing.processed) return null;
    const row = { ...args, verified: true, processed: false };
    if (existing !== null) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("paypalEvents", { ...row, receivedAt: Date.now() });
    return null;
  },
});

/** Recent webhook deliveries (CLI: `npx convex run payments/webhookDb:recentEvents '{}'`). */
export const recentEvents = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query("paypalEvents")
      .withIndex("by_receivedAt")
      .order("desc")
      .take(Math.min(Math.max(limit ?? 25, 1), 200));
  },
});
