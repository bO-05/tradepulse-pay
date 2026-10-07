import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { canViewAgreement, requireRole } from "./lib/roles";
import { changeOrderView } from "./payments/changeOrderDb";
import { WITHDRAWABLE_PAY_APP_STATUSES } from "./payApps/validation";

function agreementSummary(a: Doc<"agreements">) {
  return {
    _id: a._id,
    agreementNumber: a.agreementNumber,
    projectId: a.projectId,
    projectTitle: a.projectTitle,
    subcontractorName: a.subcontractorName,
    contractorId: a.contractorId,
    csiDivision: a.csiDivision,
    tradeName: a.tradeName,
    contractSum: a.contractSum,
    retainagePercent: a.retainagePercent,
    status: a.status,
    executedAt: a.executedAt ?? null,
    createdAt: a.createdAt,
  };
}

const SUB_PORTAL_PAGE_SIZE = 25;
const SUB_PORTAL_MAX_LIMIT = 500;

/**
 * What the sub was approved and paid on one pay app: the GC-approved gross and net from its latest
 * payout payment, its payout status, and the retainage the ledger currently holds for that payout
 * (null before the ledger is credited; zero once a FAILED or RETURNED payout reversed the credit).
 */
async function payAppOutcome(ctx: QueryCtx, payments: Doc<"payments">[]) {
  const payout = payments
    .filter((x) => x.kind === "payout" && x.status !== "failed")
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (payout) {
    const ledger = await ctx.db
      .query("retainageLedger")
      .withIndex("by_paymentId", (q) => q.eq("paymentId", payout._id))
      .take(10);
    return {
      approvedGrossCents: payout.grossCents,
      retainageHeldCents: ledger.length > 0 ? ledger.reduce((a, r) => a + r.deltaCents, 0) : null,
      retainageWithheldCents: payout.retainageCents,
      netCents: payout.netCents,
      netPaid: payout.status === "success",
      payoutStatus: payout.status as string,
      paypalItemStatus: payout.paypalItemStatus ?? null,
    };
  }
  const failed = payments.find((x) => x.kind === "payout" && x.status === "failed");
  return {
    approvedGrossCents: null,
    retainageHeldCents: null,
    retainageWithheldCents: null,
    netCents: null,
    netPaid: false,
    payoutStatus: failed ? "failed" : null,
    paypalItemStatus: failed?.paypalItemStatus ?? null,
  };
}

/**
 * Sub portal: the caller's own contractor, agreements and the newest `limit` pay applications
 * across them; `hasMore` says older ones exist and can be loaded with a larger limit.
 */
export const mySubPortal = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["sub"]);
    const limit = Math.min(
      SUB_PORTAL_MAX_LIMIT,
      Math.max(1, Math.floor(Number.isFinite(args.limit) ? args.limit! : SUB_PORTAL_PAGE_SIZE)),
    );
    const contractorId = viewer.profile.contractorId;
    const contractor = contractorId ? await ctx.db.get(contractorId) : null;
    const agreements = contractorId
      ? await ctx.db
          .query("agreements")
          .withIndex("by_contractorId", (q) => q.eq("contractorId", contractorId))
          .take(100)
      : [];
    const visible = agreements.filter((a) => a.status !== "superseded");
    // Listed per agreement (not per submitter) so pay apps filed by a linked
    // billing agent for this contractor show up too.
    // The overall newest `limit` rows are always within each agreement's newest `limit` rows, so
    // reading limit + 1 per agreement (newest first) is enough to page and to detect older rows.
    const candidates: Doc<"payApplications">[] = [];
    for (const agreement of visible) {
      const rows = await ctx.db
        .query("payApplications")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreement._id))
        .order("desc")
        .take(limit + 1);
      candidates.push(...rows);
    }
    candidates.sort((a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime);
    const payApps = candidates.slice(0, limit);
    const outcomes = new Map<string, Awaited<ReturnType<typeof payAppOutcome>>>();
    for (const p of payApps) {
      const payments = await ctx.db
        .query("payments")
        .withIndex("by_payAppId", (q) => q.eq("payAppId", p._id))
        .take(50);
      outcomes.set(p._id, await payAppOutcome(ctx, payments));
    }
    return {
      displayName: viewer.profile.displayName,
      contractorName: contractor?.companyName ?? null,
      paypalEmail: viewer.profile.paypalEmail ?? null,
      agreements: visible.map(agreementSummary),
      hasMore: candidates.length > limit,
      limit,
      payApplications: payApps.map((p) => ({
        _id: p._id,
        agreementId: p.agreementId,
        agreementNumber: visible.find((a) => a._id === p.agreementId)?.agreementNumber ?? "",
        periodLabel: p.periodLabel,
        requestedTotalCents: p.requestedTotalCents,
        lienWaiver: p.lienWaiver,
        status: p.status,
        submittedBy: {
          actorType: p.submittedBy.actorType,
          agentEmail: p.submittedBy.agentEmail ?? null,
          onBehalfOf: p.submittedBy.ownerName ?? p.submittedBy.ownerEmail ?? null,
        },
        outcome: outcomes.get(p._id) ?? null,
        canWithdraw: WITHDRAWABLE_PAY_APP_STATUSES.has(p.status),
        withdrawnAt: p.withdrawnAt ?? null,
        rejectedAt: p.rejectedAt ?? null,
        rejectionReason: p.status === "rejected" ? (p.rejectionReason ?? null) : null,
        createdAt: p.createdAt,
      })),
    };
  },
});

/**
 * One agreement for any role. Returns null both when it does not exist and when
 * the caller may not see it, so a sub cannot tell the two apart.
 */
export const getAgreementSummary = query({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["gc", "sub", "owner"]);
    const id = ctx.db.normalizeId("agreements", args.agreementId);
    if (id === null) return null;
    const agreement = await ctx.db.get(id);
    if (agreement === null || !canViewAgreement(viewer, agreement)) return null;
    return agreementSummary(agreement);
  },
});

/** Owner portal: read-only projects with their agreements and change-order invoices. */
export const ownerOverview = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["owner", "gc"]);
    const projects = await ctx.db.query("projects").order("desc").take(50);
    const result = [];
    for (const project of projects) {
      const agreements = await ctx.db
        .query("agreements")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .take(100);
      const visible = agreements.filter((a) => a.status !== "superseded");
      const changeOrders = [];
      for (const agreement of visible) {
        const cos = await ctx.db
          .query("changeOrders")
          .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", agreement._id))
          .take(100);
        for (const co of cos) {
          if (co.status === "draft") continue;
          changeOrders.push(changeOrderView(co, agreement));
        }
      }
      result.push({
        _id: project._id,
        title: project.title,
        location: project.location,
        projectType: project.projectType,
        estBudget: project.estBudget,
        isDemoProject: project.isDemoProject,
        agreements: visible.map(agreementSummary),
        changeOrders,
      });
    }
    return result;
  },
});
