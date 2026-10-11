import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, env, internalAction, type ActionCtx } from "../_generated/server";
import { toPayPalString } from "../lib/money";
import { invoiceFailureMessage, payPalDebugIdOf } from "../payments/invoiceSendError";
import { requireProjectScopeInAction } from "../lib/tenancyAction";
import { invoiceIdFromCreateResponse, payerViewUrlFor, type PayPalInvoice } from "../payments/changeOrderMath";
import { payPalClientForAction, type PayPalClient } from "../payments/paypalClient";
import { buildOwnerInvoiceBody } from "./ownerBillingMath";
import type { BeginOwnerInvoice } from "./ownerPayAppDb";

/**
 * Owner approval of an owner pay app and its PayPal invoice (architecture §16): approving records the
 * owner's decision, then creates an Invoicing v2 invoice for the current payment due to the project
 * owner company's billing email and sends it. The sandbox sends no email; the stored payer-view URL is
 * how the owner reaches it. Paid status comes from "Refresh status" or the INVOICING.INVOICE.PAID webhook.
 *
 * PayPal-Request-Id keys: create `opa_<id>_create`, send `opa_<id>_send`, record payment
 * `opa_<id>_payment`, so a double click, retry or resumed call never creates a second invoice.
 */

const invoiceResult = v.object({
  ownerPayAppId: v.id("ownerPayApps"),
  status: v.string(),
  paypalInvoiceId: v.optional(v.string()),
  payerViewUrl: v.optional(v.string()),
  alreadyInvoiced: v.boolean(),
});
type InvoiceResult = Infer<typeof invoiceResult>;

const refreshResult = v.object({
  ownerPayAppId: v.id("ownerPayApps"),
  status: v.string(),
  paypalInvoiceStatus: v.union(v.string(), v.null()),
  changed: v.boolean(),
});
type RefreshResult = Infer<typeof refreshResult>;

async function getInvoice(paypal: PayPalClient, invoiceId: string): Promise<PayPalInvoice> {
  const { data } = await paypal.request<PayPalInvoice>({ method: "GET", path: `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}` });
  return data ?? {};
}

async function invoiceOwnerPayApp(ctx: ActionCtx, ownerPayAppId: Id<"ownerPayApps">, actor: string): Promise<InvoiceResult> {
  const begun: BeginOwnerInvoice = await ctx.runMutation(internal.billing.ownerPayAppDb.beginInvoice, { ownerPayAppId });
  if (begun.state === "done") {
    return { ownerPayAppId, status: begun.status, paypalInvoiceId: begun.paypalInvoiceId, payerViewUrl: begun.payerViewUrl, alreadyInvoiced: true };
  }
  const paypal = payPalClientForAction(ctx, env, { actor, projectId: begun.projectId });
  let invoiceId = begun.paypalInvoiceId;
  let auditRecorded = true;
  try {
    if (!invoiceId) {
      const created = await paypal.request<unknown>({
        method: "POST",
        path: "/v2/invoicing/invoices",
        requestId: `opa_${ownerPayAppId}_create`,
        body: buildOwnerInvoiceBody(begun.input),
      });
      auditRecorded &&= created.auditRecorded ?? false;
      invoiceId = invoiceIdFromCreateResponse(created.data) ?? undefined;
      if (!invoiceId) {
        throw new ConvexError({ code: "INVOICE_UNKNOWN", message: "PayPal created the invoice but did not return its id. Nothing was sent; try again." });
      }
      await ctx.runMutation(internal.billing.ownerPayAppDb.recordInvoiceCreated, { ownerPayAppId, paypalInvoiceId: invoiceId, auditRecorded });
    }
    let invoice = await getInvoice(paypal, invoiceId);
    let sendHref: string | undefined;
    if (invoice.status === undefined || invoice.status === "DRAFT") {
      const sent = await paypal.request<{ href?: string }>({
        method: "POST",
        path: `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`,
        requestId: `opa_${ownerPayAppId}_send`,
        body: { send_to_recipient: true, send_to_invoicer: false },
      });
      auditRecorded &&= sent.auditRecorded ?? false;
      sendHref = sent.data?.href;
      invoice = await getInvoice(paypal, invoiceId);
    }
    const payerViewUrl = payerViewUrlFor(invoiceId, invoice.detail?.metadata?.recipient_view_url ?? sendHref);
    const recorded: { status: string } = await ctx.runMutation(internal.billing.ownerPayAppDb.recordInvoiceSent, {
      ownerPayAppId,
      payerViewUrl,
      paypalInvoiceStatus: invoice.status ?? "SENT",
      auditRecorded,
    });
    return { ownerPayAppId, status: recorded.status, paypalInvoiceId: invoiceId, payerViewUrl, alreadyInvoiced: false };
  } catch (e) {
    const message = invoiceFailureMessage(e);
    await ctx.runMutation(internal.billing.ownerPayAppDb.recordInvoiceError, { ownerPayAppId, error: message });
    throw new ConvexError({ code: "INVOICE_FAILED", message, paypalInvoiceId: invoiceId ?? null, paypalDebugId: payPalDebugIdOf(e) });
  }
}

async function refreshOwnerPayApp(ctx: ActionCtx, ownerPayAppId: Id<"ownerPayApps">, actor: string): Promise<RefreshResult> {
  const row = await ctx.runQuery(internal.billing.ownerPayAppDb.ownerPayAppRow, { ownerPayAppId });
  if (row === null) throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });
  if (!row.paypalInvoiceId) return { ownerPayAppId, status: row.status, paypalInvoiceStatus: null, changed: false };
  const paypal = payPalClientForAction(ctx, env, { actor, projectId: row.projectId });
  const invoice = await getInvoice(paypal, row.paypalInvoiceId);
  if (!invoice.status) return { ownerPayAppId, status: row.status, paypalInvoiceStatus: null, changed: false };
  const applied: { status: string | null; changed: boolean } = await ctx.runMutation(internal.billing.ownerPayAppDb.applyInvoiceStatus, {
    ownerPayAppId,
    paypalInvoiceStatus: invoice.status,
  });
  return { ownerPayAppId, status: applied.status ?? row.status, paypalInvoiceStatus: invoice.status, changed: applied.changed };
}

/**
 * Owner of the project only: approves a submitted owner pay app and invoices its current payment due
 * to the owner company's billing email. Calling it again resumes or returns the same invoice.
 */
export const approveOwnerPayApp = action({
  args: { ownerPayAppId: v.id("ownerPayApps") },
  returns: invoiceResult,
  handler: async (ctx, { ownerPayAppId }): Promise<InvoiceResult> => {
    const scope = await requireProjectScopeInAction(ctx, { docs: [{ table: "ownerPayApps", id: ownerPayAppId }] }, { roles: ["owner"], write: true });
    const row = await ctx.runQuery(internal.billing.ownerPayAppDb.ownerPayAppRow, { ownerPayAppId });
    // The GC's unsubmitted drafts are not visible to the owner.
    if (row === null || row.status === "draft") throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });
    await ctx.runMutation(internal.billing.ownerPayAppDb.markApproved, { ownerPayAppId, userId: scope.userId, actor: scope.actor });
    return await invoiceOwnerPayApp(ctx, ownerPayAppId, scope.actor);
  },
});

/** GC of the project: resumes the invoice of an owner-approved owner pay app whose create or send did not finish. */
export const sendOwnerPayAppInvoice = action({
  args: { ownerPayAppId: v.id("ownerPayApps") },
  returns: invoiceResult,
  handler: async (ctx, { ownerPayAppId }): Promise<InvoiceResult> => {
    const scope = await requireProjectScopeInAction(ctx, { docs: [{ table: "ownerPayApps", id: ownerPayAppId }] }, { roles: ["gc"], write: true });
    return await invoiceOwnerPayApp(ctx, ownerPayAppId, scope.actor);
  },
});

/** GC or owner: reads the invoice from PayPal and applies its status (PAID → Paid). Read only at PayPal. */
export const refreshOwnerPayAppStatus = action({
  args: { ownerPayAppId: v.id("ownerPayApps") },
  returns: refreshResult,
  handler: async (ctx, { ownerPayAppId }): Promise<RefreshResult> => {
    const scope = await requireProjectScopeInAction(ctx, { docs: [{ table: "ownerPayApps", id: ownerPayAppId }] }, { roles: ["gc", "owner"] });
    return await refreshOwnerPayApp(ctx, ownerPayAppId, scope.actor);
  },
});

/**
 * Sandbox fallback when the payer page will not take a guest payment: records an external payment of
 * the full amount (status becomes MARKED_AS_PAID), then refreshes the owner pay app.
 *   npx convex run billing/ownerInvoices:recordOwnerInvoicePaymentInternal '{"ownerPayAppId":"..."}'
 */
export const recordOwnerInvoicePaymentInternal = internalAction({
  args: { ownerPayAppId: v.id("ownerPayApps") },
  returns: refreshResult,
  handler: async (ctx, { ownerPayAppId }): Promise<RefreshResult> => {
    const row = await ctx.runQuery(internal.billing.ownerPayAppDb.ownerPayAppRow, { ownerPayAppId });
    if (row === null || !row.paypalInvoiceId) throw new ConvexError({ code: "NOT_FOUND", message: "This owner pay app has no PayPal invoice." });
    const paypal = payPalClientForAction(ctx, env, { actor: "system:internal", projectId: row.projectId });
    await paypal.request({
      method: "POST",
      path: `/v2/invoicing/invoices/${encodeURIComponent(row.paypalInvoiceId)}/payments`,
      requestId: `opa_${ownerPayAppId}_payment`,
      body: {
        method: "BANK_TRANSFER",
        payment_date: new Date().toISOString().slice(0, 10),
        amount: { currency_code: "USD", value: toPayPalString(row.amountCents) },
        note: `Sandbox record-payment for owner pay app #${row.applicationNo}.`,
      },
    });
    return await refreshOwnerPayApp(ctx, ownerPayAppId, "system:internal");
  },
});
