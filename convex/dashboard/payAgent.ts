import type { Doc } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { formatCents, sumCents } from "../lib/money";
import { requireRole } from "../lib/roles";
import { loadBillingHistory } from "../payApps/billingHistory";
import { computeLedgerTotals } from "../payments/ledgerTotals";
import { retainagePercentFor } from "../payments/payoutMath";
import { agreementContractSumCents } from "../payments/sov";

const MAX_AGREEMENTS = 200;

async function agreementPayRow(ctx: QueryCtx, a: Doc<"agreements">) {
  const [payments, retainage, changeOrders, billing] = await Promise.all([
    ctx.db.query("payments").withIndex("by_agreementId", (q) => q.eq("agreementId", a._id)).take(500),
    ctx.db.query("retainageLedger").withIndex("by_agreementId", (q) => q.eq("agreementId", a._id)).take(1000),
    ctx.db
      .query("changeOrders")
      .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", a._id))
      .take(500),
    loadBillingHistory(ctx, a._id),
  ]);
  const totals = computeLedgerTotals({
    contractSumCents: agreementContractSumCents(a),
    payApps: billing.rows,
    payments,
    retainage,
    changeOrders,
  });
  return {
    agreementId: a._id,
    agreementNumber: a.agreementNumber,
    subcontractor: a.subcontractorName,
    trade: a.tradeName,
    project: a.projectTitle,
    status: a.status,
    retainagePercent: retainagePercentFor(a),
    totalsCents: totals,
    formatted: {
      contractSum: formatCents(totals.contractSumCents),
      billed: formatCents(totals.billedCents),
      funded: formatCents(totals.fundedCents),
      captured: formatCents(totals.capturedCents),
      paid: formatCents(totals.paidCents),
      retainageHeld: formatCents(totals.retainageHeldCents),
      retainageReleased: formatCents(totals.retainageReleasedCents),
      balance: formatCents(totals.balanceCents),
    },
  };
}

type PayRow = Awaited<ReturnType<typeof agreementPayRow>>;

function subcontractorTotals(subcontractor: string, list: PayRow[]) {
  const sum = (pick: (t: PayRow["totalsCents"]) => number) => sumCents(list.map((r) => pick(r.totalsCents)));
  const retainageHeldCents = sum((t) => t.retainageHeldCents);
  const retainageReleasedCents = sum((t) => t.retainageReleasedCents);
  const paidCents = sum((t) => t.paidCents);
  const billedCents = sum((t) => t.billedCents);
  return {
    subcontractor,
    agreementCount: list.length,
    retainageHeldCents,
    retainageReleasedCents,
    paidCents,
    billedCents,
    formatted: {
      retainageHeld: formatCents(retainageHeldCents),
      retainageReleased: formatCents(retainageReleasedCents),
      paid: formatCents(paidCents),
      billed: formatCents(billedCents),
    },
  };
}

/**
 * Ledger totals per live agreement and per subcontractor for the Studio "TradePulse pay agent".
 * Each amount is the same computeLedgerTotals figure the agreement ledger view shows, summed in
 * integer cents and pre-formatted so the model quotes Convex numbers instead of doing arithmetic.
 */
export const getPaySummary = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc", "owner"]);
    const all = await ctx.db.query("agreements").order("desc").take(MAX_AGREEMENTS);
    const rows: PayRow[] = [];
    for (const a of all) {
      if (a.status !== "superseded") rows.push(await agreementPayRow(ctx, a));
    }
    const bySub = new Map<string, PayRow[]>();
    for (const r of rows) bySub.set(r.subcontractor, [...(bySub.get(r.subcontractor) ?? []), r]);
    const subcontractors = [...bySub.entries()].map(([name, list]) => subcontractorTotals(name, list));
    return { generatedAt: Date.now(), subcontractors, agreements: rows };
  },
});
