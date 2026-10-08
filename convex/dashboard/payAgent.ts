import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { formatCents, sumCents } from "../lib/money";
import { requireRole } from "../lib/roles";
import { gcAgreementsAndOwnerProjects } from "../lib/agreementScope";
import {
  createReadBudget,
  hasFinancialHistory,
  loadAgreementFinancials,
  loadAgreementPayApps,
  type ReadBudget,
} from "../payments/agreementHistory";
import { retainagePercentFor } from "../payments/payoutMath";
import { DASHBOARD_MAX_AGREEMENTS, DASHBOARD_READ_BUDGET } from "./queries";

async function agreementPayRow(ctx: QueryCtx, a: Doc<"agreements">, budget: ReadBudget) {
  const fin = await loadAgreementFinancials(ctx, a, budget);
  const apps = await loadAgreementPayApps(ctx, a._id, budget);
  const truncated = fin.truncated || apps.truncated;
  if (a.status === "superseded" && !truncated && !hasFinancialHistory(fin.history, apps.rows.length)) return null;
  const { totals } = fin;
  return {
    truncated,
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

type PayRow = NonNullable<Awaited<ReturnType<typeof agreementPayRow>>>;

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
 * Ledger totals per agreement and per subcontractor for the Studio "TradePulse pay agent", limited
 * to projects where the caller is the GC (one project when `projectId` is given; owners get no
 * subcontract rows). Voided
 * agreements stay in when they carry money history. Each amount is the same computeLedgerTotals figure the agreement ledger view shows, summed in
 * integer cents and pre-formatted so the model quotes Convex numbers instead of doing arithmetic.
 */
export const getPaySummary = query({
  args: { projectId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc", "owner"]);
    // Subcontract ledgers are GC data: owner projects contribute nothing here.
    const scoped = await gcAgreementsAndOwnerProjects(ctx, { projectId: args.projectId, limit: DASHBOARD_MAX_AGREEMENTS });
    const agreementsTruncated = scoped.truncated;
    const all = scoped.rows.map((r) => r.agreement);
    const budget = createReadBudget(DASHBOARD_READ_BUDGET - all.length);
    const rows: PayRow[] = [];
    for (const a of all) {
      const row = await agreementPayRow(ctx, a, budget);
      if (row !== null) rows.push(row);
    }
    const bySub = new Map<string, PayRow[]>();
    for (const r of rows) bySub.set(r.subcontractor, [...(bySub.get(r.subcontractor) ?? []), r]);
    const subcontractors = [...bySub.entries()].map(([name, list]) => subcontractorTotals(name, list));
    return {
      generatedAt: Date.now(),
      incomplete: agreementsTruncated || rows.some((r) => r.truncated),
      subcontractors,
      agreements: rows,
    };
  },
});
