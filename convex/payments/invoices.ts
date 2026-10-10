import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, env, internalAction, type ActionCtx } from "../_generated/server";
import { toPayPalString } from "../lib/money";
import { requireProjectScopeInAction } from "../lib/tenancyAction";
import { buildInvoiceBody, invoiceIdFromCreateResponse, payerViewUrlFor, type PayPalInvoice } from "./changeOrderMath";
import type { BeginInvoice } from "./changeOrderDb";
import { payPalClientForAction, type PayPalClient } from "./paypalClient";

/**
 * Change-order invoices (architecture §4 step 5, §16): once the owner approves a prime change order, the
 * GC's "Invoice now" makes it an Invoicing v2 invoice to the owner's billing email (create draft → send). The sandbox sends no email,
 * so the stored payer-view URL shown in the app is how the Owner reaches the invoice. Paid status
 * comes from "Refresh status" (GET) or the INVOICING.INVOICE.PAID webhook.
 *
 * PayPal-Request-Id keys: create `co_<id>_create`, send `co_<id>_send`, record payment `co_<id>_payment`,
 * so a retried or resumed call never creates or sends a second invoice.
 */

const invoiceResult = v.object({
  changeOrderId: v.id("changeOrders"),
  status: v.string(),
  paypalInvoiceId: v.optional(v.string()),
  payerViewUrl: v.optional(v.string()),
  alreadyInvoiced: v.boolean(),
});
type InvoiceResult = Infer<typeof invoiceResult>;

const refreshResult = v.object({
  changeOrderId: v.id("changeOrders"),
  status: v.string(),
  paypalInvoiceStatus: v.union(v.string(), v.null()),
  changed: v.boolean(),
});
type RefreshResult = Infer<typeof refreshResult>;

function errorMessage(e: unknown): string {
  if (e instanceof ConvexError && typeof e.data === "object" && e.data !== null && typeof e.data.message === "string") {
    return e.data.message;
  }
  return e instanceof Error ? e.message : "Unknown error.";
}

async function getInvoice(paypal: PayPalClient, invoiceId: string): Promise<PayPalInvoice> {
  const { data } = await paypal.request<PayPalInvoice>({
    method: "GET",
    path: `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`,
  });
  return data ?? {};
}

async function invoiceChangeOrder(ctx: ActionCtx, changeOrderId: Id<"changeOrders">, actor: string): Promise<InvoiceResult> {
  const begun: BeginInvoice = await ctx.runMutation(internal.payments.changeOrderDb.beginInvoice, { changeOrderId });
  if (begun.state === "done") {
    return {
      changeOrderId,
      status: begun.status,
      paypalInvoiceId: begun.paypalInvoiceId,
      payerViewUrl: begun.payerViewUrl,
      alreadyInvoiced: true,
    };
  }
  const paypal = payPalClientForAction(ctx, env, {
    actor,
    projectId: begun.projectId,
    ...(begun.agreementId !== null ? { agreementId: begun.agreementId } : {}),
  });
  let invoiceId = begun.paypalInvoiceId;
  let auditRecorded = true;
  try {
    if (!invoiceId) {
      const created = await paypal.request<unknown>({
        method: "POST",
        path: "/v2/invoicing/invoices",
        requestId: `co_${changeOrderId}_create${begun.createRequestSuffix}`,
        body: buildInvoiceBody(begun.input),
      });
      auditRecorded &&= created.auditRecorded ?? false;
      invoiceId = invoiceIdFromCreateResponse(created.data) ?? undefined;
      if (!invoiceId) {
        throw new ConvexError({
          code: "INVOICE_UNKNOWN",
          message: "PayPal created the invoice but did not return its id. Nothing was sent; try again.",
        });
      }
      await ctx.runMutation(internal.payments.changeOrderDb.recordInvoiceCreated, { changeOrderId, paypalInvoiceId: invoiceId, auditRecorded });
    }

    let invoice = await getInvoice(paypal, invoiceId);
    let sendHref: string | undefined;
    if (invoice.status === undefined || invoice.status === "DRAFT") {
      const sent = await paypal.request<{ href?: string }>({
        method: "POST",
        path: `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`,
        requestId: `co_${changeOrderId}_send`,
        body: { send_to_recipient: true, send_to_invoicer: false },
      });
      auditRecorded &&= sent.auditRecorded ?? false;
      sendHref = sent.data?.href;
      invoice = await getInvoice(paypal, invoiceId);
    }
    const payerViewUrl = payerViewUrlFor(invoiceId, invoice.detail?.metadata?.recipient_view_url ?? sendHref);
    const recorded: { status: string } = await ctx.runMutation(internal.payments.changeOrderDb.recordInvoiceSent, {
      changeOrderId,
      payerViewUrl,
      paypalInvoiceStatus: invoice.status ?? "SENT",
      auditRecorded,
    });
    return { changeOrderId, status: recorded.status, paypalInvoiceId: invoiceId, payerViewUrl, alreadyInvoiced: false };
  } catch (e) {
    const message = `Invoice not sent: ${errorMessage(e)}`;
    await ctx.runMutation(internal.payments.changeOrderDb.recordInvoiceError, { changeOrderId, error: message });
    throw new ConvexError({ code: "INVOICE_FAILED", message, paypalInvoiceId: invoiceId ?? null });
  }
}

async function refreshChangeOrder(ctx: ActionCtx, changeOrderId: Id<"changeOrders">, actor: string): Promise<RefreshResult> {
  const row = await ctx.runQuery(internal.payments.changeOrderDb.changeOrderRow, { changeOrderId });
  if (row === null) throw new ConvexError({ code: "NOT_FOUND", message: "Change order not found." });
  if (!row.paypalInvoiceId) return { changeOrderId, status: row.status, paypalInvoiceStatus: null, changed: false };
  const paypal = payPalClientForAction(ctx, env, { actor });
  const invoice = await getInvoice(paypal, row.paypalInvoiceId);
  if (!invoice.status) return { changeOrderId, status: row.status, paypalInvoiceStatus: null, changed: false };
  const applied: { status: string | null; changed: boolean } = await ctx.runMutation(
    internal.payments.changeOrderDb.applyInvoiceStatus,
    { changeOrderId, paypalInvoiceStatus: invoice.status },
  );
  return { changeOrderId, status: applied.status ?? row.status, paypalInvoiceStatus: invoice.status, changed: applied.changed };
}

/**
 * "Invoice now", GC of the project only: invoices an owner-approved prime change order to the project
 * owner's billing email (create draft → send), or resumes one whose create or send did not finish.
 * Unapproved and subcontract change orders are refused before PayPal is called.
 */
export const sendChangeOrderInvoice = action({
  args: { changeOrderId: v.id("changeOrders") },
  returns: invoiceResult,
  handler: async (ctx, { changeOrderId }): Promise<InvoiceResult> => {
    const scope = await requireProjectScopeInAction(ctx, { docs: [{ table: "changeOrders", id: changeOrderId }] }, { roles: ["gc"], write: true });
    return await invoiceChangeOrder(ctx, changeOrderId, scope.actor);
  },
});

/** GC or owner of the project: reads the invoice from PayPal and applies its status (e.g. PAID → paid). Read only at PayPal. */
export const refreshChangeOrderStatus = action({
  args: { changeOrderId: v.id("changeOrders") },
  returns: refreshResult,
  handler: async (ctx, { changeOrderId }): Promise<RefreshResult> => {
    const scope = await requireProjectScopeInAction(ctx, { docs: [{ table: "changeOrders", id: changeOrderId }] }, { roles: ["gc", "owner"] });
    return await refreshChangeOrder(ctx, changeOrderId, scope.actor);
  },
});

export const refreshChangeOrderStatusInternal = internalAction({
  args: { changeOrderId: v.id("changeOrders") },
  returns: refreshResult,
  handler: async (ctx, { changeOrderId }): Promise<RefreshResult> => await refreshChangeOrder(ctx, changeOrderId, "system:internal"),
});

/**
 * Sandbox fallback when the payer page will not take a guest payment: records an external payment
 * of the full amount on the invoice (status becomes MARKED_AS_PAID), then refreshes the change order.
 *   npx convex run payments/invoices:recordInvoicePaymentInternal '{"changeOrderId":"..."}'
 */
export const recordInvoicePaymentInternal = internalAction({
  args: { changeOrderId: v.id("changeOrders") },
  returns: refreshResult,
  handler: async (ctx, { changeOrderId }): Promise<RefreshResult> => {
    const row = await ctx.runQuery(internal.payments.changeOrderDb.changeOrderRow, { changeOrderId });
    if (row === null || !row.paypalInvoiceId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "This change order has no PayPal invoice." });
    }
    const paypal = payPalClientForAction(ctx, env, {
      actor: "system:internal",
      projectId: row.projectId ?? undefined,
      agreementId: row.agreementId ?? undefined,
    });
    await paypal.request({
      method: "POST",
      path: `/v2/invoicing/invoices/${encodeURIComponent(row.paypalInvoiceId)}/payments`,
      requestId: `co_${changeOrderId}_payment`,
      body: {
        method: "BANK_TRANSFER",
        payment_date: new Date().toISOString().slice(0, 10),
        amount: { currency_code: "USD", value: toPayPalString(row.amountCents) },
        note: `Sandbox record-payment for ${row.label}.`,
      },
    });
    return await refreshChangeOrder(ctx, changeOrderId, "system:internal");
  },
});
