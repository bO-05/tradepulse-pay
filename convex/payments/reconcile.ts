import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { env, internalAction, internalQuery } from "../_generated/server";
import { fromPayPalString } from "../lib/money";
import { loadBillingHistory, unresolvedApprovalMessage } from "../payApps/billingHistory";
import { APPROVED_PAY_APP_STATUSES, approvedTotalFor } from "../payApps/validation";
import { changeOrderStatusFromInvoice } from "./changeOrderMath";
import { computeLedgerTotals, type LedgerTotals } from "./ledgerTotals";
import { payoutStatusFromPayPal } from "./payoutMath";
import { payPalClientForAction } from "./paypalClient";
import { agreementContractSumCents } from "./sov";

/**
 * Ledger reconciliation for validators and operators (read-only):
 *   npx convex run payments/reconcile:ledgerReconciliation '{"agreementId":"<id>"}'   (Convex sums)
 *   npx convex run payments/reconcile:reconcileWithPayPal '{"agreementId":"<id>"}'    (+ PayPal GETs)
 * The first recomputes every ledger total straight from the stored rows, independently of
 * computeLedgerTotals, and lists any difference. The second GETs every stored PayPal id.
 */

type Rows = {
  agreement: Doc<"agreements">;
  sov: Doc<"scheduleOfValues">[];
  payments: Doc<"payments">[];
  retainage: Doc<"retainageLedger">[];
  payApps: Doc<"payApplications">[];
  changeOrders: Doc<"changeOrders">[];
};

function rawSums(rows: Rows) {
  let funded = 0;
  let captured = 0;
  let capturedNotPaid = 0;
  let paid = 0;
  let held = 0;
  let released = 0;
  let billed = 0;
  let coInvoiced = 0;
  let coPaid = 0;
  const paidReleaseRoots = new Set<string>();
  for (const p of rows.payments) {
    if (p.kind === "payout" && p.status === "success") paidReleaseRoots.add(p.retryOfPaymentId ?? p._id);
  }
  const releaseIds = new Set<string>();
  for (const p of rows.payments) {
    if (p.kind === "funding") {
      if (p.status === "authorized" || p.status === "partially_captured") funded += p.grossCents - (p.capturedCents ?? 0);
      for (const c of p.captures ?? []) {
        if (c.status === "DENIED" || c.status === "DECLINED" || c.status === "FAILED") continue;
        captured += c.amountCents;
        if (!c.releasePaymentId || !paidReleaseRoots.has(c.releasePaymentId)) capturedNotPaid += c.amountCents;
      }
    } else if (p.status === "success") {
      paid += p.netCents;
    }
    if (p.kind === "retainage_release") releaseIds.add(p._id);
  }
  for (const r of rows.retainage) {
    held += r.deltaCents;
    if (r.paymentId && releaseIds.has(r.paymentId)) released -= r.deltaCents;
  }
  for (const a of rows.payApps) {
    if (APPROVED_PAY_APP_STATUSES.has(a.status)) billed += approvedTotalFor(a);
  }
  for (const c of rows.changeOrders) {
    if (c.status === "invoiced") coInvoiced += c.amountCents;
    if (c.status === "paid") coPaid += c.amountCents;
  }
  const contractSum = agreementContractSumCents(rows.agreement);
  return {
    contractSumCents: contractSum,
    billedCents: billed,
    fundedCents: funded,
    capturedCents: captured,
    capturedNotPaidCents: capturedNotPaid,
    paidCents: paid,
    retainageHeldCents: held,
    retainageReleasedCents: released === 0 ? 0 : released,
    changeOrdersInvoicedCents: coInvoiced,
    changeOrdersPaidCents: coPaid,
    balanceCents: contractSum - (paid + held),
  } satisfies LedgerTotals;
}

const reconciliationValidator = v.union(
  v.null(),
  v.object({
    agreementNumber: v.string(),
    sovTotalCents: v.number(),
    sovMatchesContractSum: v.boolean(),
    totals: v.record(v.string(), v.number()),
    rawSums: v.record(v.string(), v.number()),
    mismatches: v.array(v.string()),
    /** Approved pay apps left out of billed because their final approved amount is unknown. */
    needsAttention: v.array(v.object({ payAppId: v.id("payApplications"), periodLabel: v.string(), message: v.string() })),
    paypalIds: v.object({
      authorizations: v.array(v.string()),
      captures: v.array(v.string()),
      payoutBatches: v.array(v.string()),
      invoices: v.array(v.string()),
    }),
  }),
);

export const ledgerReconciliation = internalQuery({
  args: { agreementId: v.id("agreements") },
  returns: reconciliationValidator,
  handler: async (ctx, { agreementId }) => {
    const agreement = await ctx.db.get(agreementId);
    if (agreement === null) return null;
    const billing = await loadBillingHistory(ctx, agreementId);
    const rows: Rows = {
      agreement,
      sov: await ctx.db
        .query("scheduleOfValues")
        .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
        .take(500),
      payments: await ctx.db.query("payments").withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId)).take(500),
      retainage: await ctx.db
        .query("retainageLedger")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
        .take(1000),
      payApps: billing.rows,
      changeOrders: await ctx.db
        .query("changeOrders")
        .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", agreementId))
        .take(500),
    };
    const totals = computeLedgerTotals({
      contractSumCents: agreementContractSumCents(agreement),
      payApps: rows.payApps,
      payments: rows.payments,
      retainage: rows.retainage,
      changeOrders: rows.changeOrders,
    });
    const raw = rawSums(rows);
    const mismatches = (Object.keys(raw) as (keyof LedgerTotals)[])
      .filter((k) => raw[k] !== totals[k])
      .map((k) => `${k}: ledger ${totals[k]} vs rows ${raw[k]}`);
    const sovTotalCents = rows.sov.reduce((a, l) => a + l.scheduledValueCents, 0);
    if (rows.sov.length > 0 && sovTotalCents !== totals.contractSumCents) {
      mismatches.push(`sov: ${sovTotalCents} vs contract sum ${totals.contractSumCents}`);
    }
    if (totals.capturedCents !== totals.capturedNotPaidCents + paidReleaseGross(rows.payments)) {
      mismatches.push("captured ≠ captured-not-paid + gross of paid releases");
    }
    const needsAttention = billing.unresolved.map((u) => ({
      payAppId: u.payAppId,
      periodLabel: u.periodLabel,
      message: unresolvedApprovalMessage(u),
    }));
    for (const u of needsAttention) mismatches.push(`billed: pay application ${u.payAppId} needs attention: ${u.message}`);
    const funding = rows.payments.filter((p) => p.kind === "funding");
    return {
      agreementNumber: agreement.agreementNumber,
      sovTotalCents,
      sovMatchesContractSum: rows.sov.length === 0 || sovTotalCents === totals.contractSumCents,
      totals,
      rawSums: raw,
      mismatches,
      needsAttention,
      paypalIds: {
        authorizations: funding.flatMap((p) => (p.paypalAuthorizationId ? [p.paypalAuthorizationId] : [])),
        captures: funding.flatMap((p) => (p.captures ?? []).map((c) => c.captureId)),
        payoutBatches: rows.payments.flatMap((p) => (p.kind !== "funding" && p.paypalPayoutBatchId ? [p.paypalPayoutBatchId] : [])),
        invoices: rows.changeOrders.flatMap((c) => (c.paypalInvoiceId ? [c.paypalInvoiceId] : [])),
      },
    };
  },
});

/** Gross of payouts that succeeded, counting each release once (a retry replaces its failed original). */
function paidReleaseGross(payments: Doc<"payments">[]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const p of payments) {
    if (p.kind !== "payout" || p.status !== "success") continue;
    const root = p.retryOfPaymentId ?? p._id;
    if (seen.has(root)) continue;
    seen.add(root);
    total += p.grossCents;
  }
  return total;
}

export const storedPayPalRecords = internalQuery({
  args: { agreementId: v.id("agreements") },
  handler: async (ctx, { agreementId }) => {
    const payments = await ctx.db.query("payments").withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId)).take(500);
    const changeOrders = await ctx.db
      .query("changeOrders")
      .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", agreementId))
      .take(500);
    return {
      funding: payments
        .filter((p) => p.kind === "funding" && p.paypalAuthorizationId)
        .map((p) => ({
          paymentId: p._id,
          status: p.status,
          authorizationId: p.paypalAuthorizationId!,
          grossCents: p.grossCents,
          captures: (p.captures ?? []).map((c) => ({ captureId: c.captureId, amountCents: c.amountCents, status: c.status })),
        })),
      payouts: payments
        .filter((p) => p.kind !== "funding" && p.paypalPayoutBatchId)
        .map((p) => ({ paymentId: p._id, kind: p.kind, status: p.status, batchId: p.paypalPayoutBatchId!, netCents: p.netCents })),
      changeOrders: changeOrders
        .filter((c) => c.paypalInvoiceId)
        .map((c) => ({ changeOrderId: c._id, status: c.status, invoiceId: c.paypalInvoiceId!, amountCents: c.amountCents })),
    };
  },
});

const FUNDING_TO_PAYPAL: Record<string, string[]> = {
  authorized: ["CREATED", "PENDING"],
  partially_captured: ["PARTIALLY_CAPTURED"],
  captured: ["CAPTURED"],
  voided: ["VOIDED"],
  expired: ["EXPIRED"],
};

type Check = { kind: string; id: string; stored: string; paypal: string; match: boolean; note?: string };
type Reconciliation = Infer<typeof reconciliationValidator>;
type StoredRecords = {
  funding: { paymentId: string; status: string; authorizationId: string; grossCents: number; captures: { captureId: string; amountCents: number; status: string }[] }[];
  payouts: { paymentId: string; kind: string; status: string; batchId: string; netCents: number }[];
  changeOrders: { changeOrderId: string; status: string; invoiceId: string; amountCents: number }[];
};

function cents(value: string | undefined): number | null {
  if (!value) return null;
  try {
    return fromPayPalString(value);
  } catch {
    return null;
  }
}

export const reconcileWithPayPal = internalAction({
  args: { agreementId: v.id("agreements") },
  handler: async (ctx, { agreementId }): Promise<{ ledger: Reconciliation; checks: Check[]; allMatch: boolean }> => {
    const ledger: Reconciliation = await ctx.runQuery(internal.payments.reconcile.ledgerReconciliation, { agreementId });
    const stored: StoredRecords = await ctx.runQuery(internal.payments.reconcile.storedPayPalRecords, { agreementId });
    const paypal = payPalClientForAction(ctx, env, { actor: "system:reconcile" });
    const checks: Check[] = [];
    const get = async <T>(path: string): Promise<T | null> => {
      try {
        return (await paypal.request<T>({ method: "GET", path })).data ?? null;
      } catch (e) {
        checks.push({ kind: "error", id: path, stored: "", paypal: e instanceof Error ? e.message : "GET failed", match: false });
        return null;
      }
    };

    for (const f of stored.funding) {
      const auth = await get<{ status?: string; amount?: { value?: string } }>(
        `/v2/payments/authorizations/${encodeURIComponent(f.authorizationId)}`,
      );
      if (auth) {
        const ok = (FUNDING_TO_PAYPAL[f.status] ?? []).includes(auth.status ?? "") && cents(auth.amount?.value) === f.grossCents;
        checks.push({
          kind: "authorization",
          id: f.authorizationId,
          stored: `${f.status} ${f.grossCents}`,
          paypal: `${auth.status} ${auth.amount?.value}`,
          match: ok,
          ...(f.status === "expired" && auth.status !== "EXPIRED"
            ? { note: "Marked expired by the watcher from the stored expiry; PayPal has not expired it yet." }
            : {}),
        });
      }
      for (const c of f.captures) {
        const cap = await get<{ status?: string; amount?: { value?: string } }>(`/v2/payments/captures/${encodeURIComponent(c.captureId)}`);
        if (cap) {
          checks.push({
            kind: "capture",
            id: c.captureId,
            stored: `${c.status} ${c.amountCents}`,
            paypal: `${cap.status} ${cap.amount?.value}`,
            match: cap.status === c.status && cents(cap.amount?.value) === c.amountCents,
          });
        }
      }
    }
    for (const p of stored.payouts) {
      const batch = await get<{
        batch_header?: { batch_status?: string };
        items?: { transaction_status?: string; payout_item?: { sender_item_id?: string; amount?: { value?: string } } }[];
      }>(`/v1/payments/payouts/${encodeURIComponent(p.batchId)}`);
      if (batch) {
        const item = batch.items?.find((i) => i.payout_item?.sender_item_id === p.paymentId) ?? batch.items?.[0];
        const mapped = payoutStatusFromPayPal(item?.transaction_status, batch.batch_header?.batch_status) ?? "pending";
        checks.push({
          kind: p.kind,
          id: p.batchId,
          stored: `${p.status} ${p.netCents}`,
          paypal: `${item?.transaction_status ?? batch.batch_header?.batch_status} ${item?.payout_item?.amount?.value}`,
          match: mapped === p.status && cents(item?.payout_item?.amount?.value) === p.netCents,
        });
      }
    }
    for (const c of stored.changeOrders) {
      const inv = await get<{ status?: string; amount?: { value?: string } }>(`/v2/invoicing/invoices/${encodeURIComponent(c.invoiceId)}`);
      if (inv) {
        checks.push({
          kind: "invoice",
          id: c.invoiceId,
          stored: `${c.status} ${c.amountCents}`,
          paypal: `${inv.status} ${inv.amount?.value}`,
          match: changeOrderStatusFromInvoice(inv.status) === c.status && cents(inv.amount?.value) === c.amountCents,
        });
      }
    }
    return { ledger, checks, allMatch: (ledger?.mismatches.length ?? 1) === 0 && checks.every((c) => c.match) };
  },
});
