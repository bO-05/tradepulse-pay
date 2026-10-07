import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { canViewAgreement, requireRole } from "../lib/roles";
import { computeLedgerTotals } from "./ledgerTotals";
import { agreementContractSumCents } from "./sov";

function ledgerAgreementSummary(a: Doc<"agreements">) {
  return {
    _id: a._id,
    agreementNumber: a.agreementNumber,
    projectId: a.projectId,
    projectTitle: a.projectTitle,
    subcontractorName: a.subcontractorName,
    csiDivision: a.csiDivision,
    tradeName: a.tradeName,
    status: a.status,
    retainagePercent: a.retainagePercent,
    contractSumCents: agreementContractSumCents(a),
    executedAt: a.executedAt ?? null,
  };
}

function fundingSummary(p: Doc<"payments"> | undefined) {
  if (p === undefined) return null;
  return {
    paymentId: p._id,
    status: p.status,
    grossCents: p.grossCents,
    paypalOrderId: p.paypalOrderId ?? null,
    paypalAuthorizationId: p.paypalAuthorizationId ?? null,
    authorizationExpiresAt: p.authorizationExpiresAt ?? null,
    honorPeriodEndsAt: p.honorPeriodEndsAt ?? null,
    error: p.error ?? null,
  };
}

/** Payments workspace list: GC sees every live agreement, a sub only its own contractor's. */
export const listLedgerAgreements = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireRole(ctx, ["gc", "sub"]);
    let agreements: Doc<"agreements">[];
    if (viewer.role === "gc") {
      agreements = await ctx.db.query("agreements").order("desc").take(200);
    } else {
      const contractorId = viewer.profile.contractorId;
      agreements = contractorId
        ? await ctx.db
            .query("agreements")
            .withIndex("by_contractorId", (q) => q.eq("contractorId", contractorId))
            .take(100)
        : [];
    }
    return agreements
      .filter((a) => a.status !== "superseded" && canViewAgreement(viewer, a))
      .map(ledgerAgreementSummary);
  },
});

/**
 * One agreement's ledger. Returns null both when the agreement does not exist
 * and when the caller may not see it, so a sub cannot probe other agreements.
 */
export const getAgreementLedger = query({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["gc", "sub", "owner"]);
    const id = ctx.db.normalizeId("agreements", args.agreementId);
    if (id === null) return null;
    const agreement = await ctx.db.get(id);
    if (agreement === null || !canViewAgreement(viewer, agreement)) return null;

    const sov = await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", id))
      .take(500);
    const milestones = await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", id))
      .take(50);
    const payApps = await ctx.db
      .query("payApplications")
      .withIndex("by_agreementId", (q) => q.eq("agreementId", id))
      .take(500);
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_agreementId", (q) => q.eq("agreementId", id))
      .take(500);
    const retainage = await ctx.db
      .query("retainageLedger")
      .withIndex("by_agreementId", (q) => q.eq("agreementId", id))
      .take(1000);

    const summary = ledgerAgreementSummary(agreement);
    // Latest funding attempt per milestone (payments come back in creation order).
    const latestFunding = new Map<string, Doc<"payments">>();
    for (const p of payments) if (p.kind === "funding" && p.milestoneId) latestFunding.set(p.milestoneId, p);
    return {
      agreement: summary,
      canFund: viewer.role === "gc",
      sov: sov.map((line) => ({
        _id: line._id,
        lineNo: line.lineNo,
        description: line.description,
        csiCode: line.csiCode ?? null,
        scheduledValueCents: line.scheduledValueCents,
        excludedScope: line.excludedScope,
      })),
      sovTotalCents: sov.reduce((acc, line) => acc + line.scheduledValueCents, 0),
      milestones: milestones.map((m) => ({
        _id: m._id,
        name: m.name,
        order: m.order,
        plannedDate: m.plannedDate,
        amountCents: m.amountCents,
        status: m.status,
        funding: fundingSummary(latestFunding.get(m._id)),
      })),
      totals: computeLedgerTotals({
        contractSumCents: summary.contractSumCents,
        payApps,
        payments,
        retainage,
      }),
    };
  },
});
