import type { Doc } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireRole } from "../lib/roles";
import { retainagePercentFor } from "../payments/payoutMath";
import { agreementContractSumCents } from "../payments/sov";
import { percentageOfCents } from "../lib/money";

const MAX_AGREEMENTS = 200;
const MAX_ROWS_PER_AGREEMENT = 500;

async function agreementRows(ctx: QueryCtx, agreement: Doc<"agreements">) {
  const id = agreement._id;
  const [payments, payApps, retainage, changeOrders, milestones] = await Promise.all([
    ctx.db
      .query("payments")
      .withIndex("by_agreementId", (q) => q.eq("agreementId", id))
      .take(MAX_ROWS_PER_AGREEMENT),
    ctx.db
      .query("payApplications")
      .withIndex("by_agreementId", (q) => q.eq("agreementId", id))
      .take(MAX_ROWS_PER_AGREEMENT),
    ctx.db
      .query("retainageLedger")
      .withIndex("by_agreementId", (q) => q.eq("agreementId", id))
      .take(MAX_ROWS_PER_AGREEMENT * 2),
    ctx.db
      .query("changeOrders")
      .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", id))
      .take(MAX_ROWS_PER_AGREEMENT),
    ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", id))
      .take(100),
  ]);
  return { payments, payApps, retainage, changeOrders, milestones };
}

/**
 * Flat rows for the AG Studio payments dashboard, all amounts in integer cents.
 * GC and owner see every live agreement (single-GC demo tenancy); subs and billing agents
 * have no dashboard access, so a sub can never read another contractor's rows here.
 */
export const getDashboardData = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireRole(ctx, ["gc", "owner"]);
    const all = await ctx.db.query("agreements").order("desc").take(MAX_AGREEMENTS);
    const live = all.filter((a) => a.status !== "superseded");

    const agreements = [];
    const payments = [];
    const payApps = [];
    const retainage = [];
    const changeOrders = [];
    const milestones = [];

    for (const a of live) {
      const contractSumCents = agreementContractSumCents(a);
      const retainagePercent = retainagePercentFor(a);
      agreements.push({
        agreementId: a._id,
        agreementNumber: a.agreementNumber,
        subcontractor: a.subcontractorName,
        trade: a.tradeName,
        project: a.projectTitle,
        status: a.status,
        contractSumCents,
        retainagePercent,
        retainageCapCents: percentageOfCents(contractSumCents, retainagePercent),
      });
      const rows = await agreementRows(ctx, a);
      for (const p of rows.payments) {
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
      for (const app of rows.payApps) {
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
      for (const r of rows.retainage) {
        retainage.push({
          entryId: r._id,
          agreementId: a._id,
          paymentId: r.paymentId ?? null,
          deltaCents: r.deltaCents,
          reason: r.reason,
          createdAt: r.createdAt,
        });
      }
      for (const co of rows.changeOrders) {
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
      for (const m of rows.milestones) {
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

    return {
      role: viewer.role,
      readOnly: viewer.role !== "gc",
      agreements,
      payments,
      payApps,
      retainage,
      changeOrders,
      milestones,
    };
  },
});
