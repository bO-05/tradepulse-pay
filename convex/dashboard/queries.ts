import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireRole } from "../lib/roles";
import { percentageOfCents, sumCents } from "../lib/money";
import {
  createReadBudget,
  hasFinancialHistory,
  loadAgreementFinancials,
  loadAgreementPayApps,
} from "../payments/agreementHistory";
import { retainageReleaseIds, retainageReleasedCentsOf, type LedgerTotals } from "../payments/ledgerTotals";
import { retainagePercentFor } from "../payments/payoutMath";

/** Agreements read per dashboard query (newest first); more than this sets `incomplete.truncated`. */
export const DASHBOARD_MAX_AGREEMENTS = 500;
/**
 * Documents the dashboard may read across all agreements' money history. Convex caps a query at
 * about 16k documents read, so this leaves headroom for agreements, milestones and approval rebuilds.
 */
export const DASHBOARD_READ_BUDGET = 12_000;
const MAX_MILESTONES_PER_AGREEMENT = 100;

/** Pay applications still waiting on a GC decision. */
export const PENDING_PAY_APP_STATUSES = new Set(["submitted", "under_review", "reviewed"]);

const TOTAL_KEYS = [
  "contractSumCents",
  "billedCents",
  "fundedCents",
  "capturedCents",
  "capturedNotPaidCents",
  "paidCents",
  "retainageHeldCents",
  "retainageReleasedCents",
  "changeOrdersInvoicedCents",
  "changeOrdersPaidCents",
  "balanceCents",
] as const satisfies readonly (keyof LedgerTotals)[];

function sumTotals(list: LedgerTotals[]): LedgerTotals {
  const out = {} as LedgerTotals;
  for (const key of TOTAL_KEYS) out[key] = sumCents(list.map((t) => t[key]));
  return out;
}

/**
 * Flat rows for the AG Studio payments dashboard, all amounts in integer cents, plus server-side
 * KPI totals that are the sum of each agreement's ledger totals (computeLedgerTotals), so the
 * dashboard and the agreement ledger always agree. Voided (superseded) agreements stay in when
 * they carry money history, with their real status. GC and owner see every agreement (single-GC
 * demo tenancy); subs and billing agents have no dashboard access.
 */
export const getDashboardData = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireRole(ctx, ["gc", "owner"]);
    const newest = await ctx.db.query("agreements").order("desc").take(DASHBOARD_MAX_AGREEMENTS + 1);
    const agreementsTruncated = newest.length > DASHBOARD_MAX_AGREEMENTS;
    const all = newest.slice(0, DASHBOARD_MAX_AGREEMENTS);
    const budget = createReadBudget(DASHBOARD_READ_BUDGET - all.length);

    const agreements = [];
    const payments = [];
    const payApps = [];
    const retainage = [];
    const changeOrders = [];
    const milestones = [];
    const perAgreementTotals: LedgerTotals[] = [];
    const incompleteAgreements: string[] = [];

    for (const a of all) {
      const fin = await loadAgreementFinancials(ctx, a, budget);
      const apps = await loadAgreementPayApps(ctx, a._id, budget);
      const truncated = fin.truncated || apps.truncated;
      if (a.status === "superseded" && !truncated && !hasFinancialHistory(fin.history, apps.rows.length)) continue;
      if (truncated) incompleteAgreements.push(a.agreementNumber);

      const { totals } = fin;
      perAgreementTotals.push(totals);
      const retainagePercent = retainagePercentFor(a);
      agreements.push({
        agreementId: a._id,
        agreementNumber: a.agreementNumber,
        subcontractor: a.subcontractorName,
        trade: a.tradeName,
        project: a.projectTitle,
        status: a.status,
        contractSumCents: totals.contractSumCents,
        retainagePercent,
        retainageCapCents: percentageOfCents(totals.contractSumCents, retainagePercent),
        totals,
      });

      for (const p of fin.history.payments) {
        payments.push({
          paymentId: p._id,
          agreementId: a._id,
          kind: p.kind,
          status: p.status,
          grossCents: p.grossCents,
          retainageCents: p.retainageCents,
          netCents: p.netCents,
          capturedCents: p.capturedCents ?? 0,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt ?? p.createdAt,
        });
      }

      // Billing rows carry rebuilt final approvals for legacy approved pay apps.
      const billed = new Map(fin.billing.rows.map((b) => [b._id as string, b]));
      for (const raw of apps.rows) {
        const app: Doc<"payApplications"> = billed.get(raw._id) ?? raw;
        const verdicts = app.review?.lines.map((l) => l.verdict) ?? [];
        payApps.push({
          payAppId: app._id,
          agreementId: a._id,
          periodLabel: app.periodLabel,
          status: app.status,
          requestedCents: app.requestedTotalCents,
          aiRecommendedCents: app.review?.approvedTotalCents ?? null,
          finalApprovedCents: app.finalApproval?.totalCents ?? null,
          reviewEngine: app.review?.engine ?? null,
          overbilledLines: verdicts.filter((v) => v === "overbilled").length,
          excludedScopeLines: verdicts.filter((v) => v === "excluded_scope").length,
          frontLoadedLines: verdicts.filter((v) => v === "front_loaded").length,
          outOfSequenceLines: verdicts.filter((v) => v === "out_of_sequence").length,
          lienWaiverMissing: app.review?.flags.lienWaiverMissing ?? !app.lienWaiver,
          licenseIssue: app.review?.flags.licenseIssue ?? false,
          createdAt: app.createdAt,
        });
      }

      const releaseIds = retainageReleaseIds(fin.history.payments);
      const kindById = new Map(fin.history.payments.map((p) => [p._id as string, p.kind]));
      for (const r of fin.history.retainage) {
        const releasedCents = retainageReleasedCentsOf(r, releaseIds);
        retainage.push({
          entryId: r._id,
          agreementId: a._id,
          paymentId: r.paymentId ?? null,
          paymentKind: r.paymentId ? (kindById.get(r.paymentId) ?? null) : null,
          deltaCents: r.deltaCents,
          releasedCents,
          // Withheld net of payout reversals: held = withheld − released for every entry.
          withheldCents: r.deltaCents + releasedCents,
          reason: r.reason,
          createdAt: r.createdAt,
        });
      }

      for (const co of fin.history.changeOrders) {
        changeOrders.push({
          changeOrderId: co._id,
          agreementId: a._id,
          number: co.number,
          description: co.description,
          status: co.status,
          amountCents: co.amountCents,
          createdAt: co.createdAt,
          invoicedAt: co.invoicedAt ?? null,
          paidAt: co.paidAt ?? null,
        });
      }

      const ms = await ctx.db
        .query("milestones")
        .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", a._id))
        .take(MAX_MILESTONES_PER_AGREEMENT);
      for (const m of ms) {
        milestones.push({
          milestoneId: m._id,
          agreementId: a._id,
          name: m.name,
          order: m.order,
          status: m.status,
          amountCents: m.amountCents,
          plannedDate: m.plannedDate,
        });
      }
    }

    const totals = {
      ...sumTotals(perAgreementTotals),
      pendingPayAppCents: sumCents(
        payApps.filter((p) => PENDING_PAY_APP_STATUSES.has(p.status)).map((p) => p.requestedCents),
      ),
    };

    return {
      role: viewer.role,
      readOnly: viewer.role !== "gc",
      totals,
      incomplete: {
        truncated: agreementsTruncated || incompleteAgreements.length > 0,
        agreementsTruncated,
        agreementNumbers: incompleteAgreements,
      },
      agreements,
      payments,
      payApps,
      retainage,
      changeOrders,
      milestones,
    };
  },
});
