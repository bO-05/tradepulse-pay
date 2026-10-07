import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
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

/**
 * What the sub was approved and paid on one pay app, from its newest payout attempt (failed retries
 * included): the approved gross and net, that attempt's real status, and the retainage the ledger
 * holds across all of the pay app's payout attempts (null before any ledger credit; zero once a
 * FAILED or RETURNED payout reversed it).
 */
async function payAppOutcome(ctx: QueryCtx, payments: Doc<"payments">[]) {
  const payouts = payments
    .filter((x) => x.kind === "payout")
    .sort((a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime);
  const payout = payouts[0];
  if (payout === undefined) {
    return {
      approvedGrossCents: null,
      retainageHeldCents: null,
      retainageWithheldCents: null,
      netCents: null,
      netPaid: false,
      payoutStatus: null,
      paypalItemStatus: null,
    };
  }
  let credited = false;
  let heldCents = 0;
  for (const attempt of payouts) {
    const ledger = await ctx.db
      .query("retainageLedger")
      .withIndex("by_paymentId", (q) => q.eq("paymentId", attempt._id))
      .take(10);
    if (ledger.length > 0) credited = true;
    heldCents += ledger.reduce((a, r) => a + r.deltaCents, 0);
  }
  return {
    approvedGrossCents: payout.grossCents,
    retainageHeldCents: credited ? heldCents : null,
    retainageWithheldCents: payout.retainageCents,
    netCents: payout.netCents,
    netPaid: payout.status === "success",
    payoutStatus: payout.status as string,
    paypalItemStatus: payout.paypalItemStatus ?? null,
  };
}

async function subAgreements(ctx: QueryCtx, contractorId: Id<"contractors"> | undefined) {
  const agreements = contractorId
    ? await ctx.db
        .query("agreements")
        .withIndex("by_contractorId", (q) => q.eq("contractorId", contractorId))
        .take(100)
    : [];
  return agreements.filter((a) => a.status !== "superseded");
}

/** Sub portal: the caller's own contractor and agreements. Pay apps are paged by mySubPayApps. */
export const mySubPortal = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireRole(ctx, ["sub"]);
    const contractorId = viewer.profile.contractorId;
    const contractor = contractorId ? await ctx.db.get(contractorId) : null;
    const visible = await subAgreements(ctx, contractorId);
    return {
      displayName: viewer.profile.displayName,
      contractorName: contractor?.companyName ?? null,
      paypalEmail: viewer.profile.paypalEmail ?? null,
      agreements: visible.map(agreementSummary),
    };
  },
});

/**
 * The caller's contractor's pay applications across all its agreements, newest first, one cursor
 * page at a time. Listed per contractor (not per submitter) so pay apps filed by a linked billing
 * agent show up too. Rows on superseded agreements are dropped, so a page can be shorter than asked.
 */
export const mySubPayApps = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["sub"]);
    const contractorId = viewer.profile.contractorId;
    if (contractorId === undefined) return { page: [], isDone: true, continueCursor: "" };
    const agreements = new Map((await subAgreements(ctx, contractorId)).map((a) => [a._id as string, a]));
    const result = await ctx.db
      .query("payApplications")
      .withIndex("by_contractorId", (q) => q.eq("contractorId", contractorId))
      .order("desc")
      .paginate(args.paginationOpts);
    const page = [];
    for (const p of result.page) {
      const agreement = agreements.get(p.agreementId);
      if (agreement === undefined) continue;
      const payments = await ctx.db
        .query("payments")
        .withIndex("by_payAppId", (q) => q.eq("payAppId", p._id))
        .take(50);
      page.push({
        _id: p._id,
        agreementId: p.agreementId,
        agreementNumber: agreement.agreementNumber,
        periodLabel: p.periodLabel,
        requestedTotalCents: p.requestedTotalCents,
        lienWaiver: p.lienWaiver,
        status: p.status,
        submittedBy: {
          actorType: p.submittedBy.actorType,
          agentEmail: p.submittedBy.agentEmail ?? null,
          onBehalfOf: p.submittedBy.ownerName ?? p.submittedBy.ownerEmail ?? null,
        },
        judgeDemoFiledBy: p.judgeDemo?.filedBy ?? null,
        outcome: await payAppOutcome(ctx, payments),
        canWithdraw: WITHDRAWABLE_PAY_APP_STATUSES.has(p.status),
        withdrawnAt: p.withdrawnAt ?? null,
        rejectedAt: p.rejectedAt ?? null,
        rejectionReason: p.status === "rejected" ? (p.rejectionReason ?? null) : null,
        createdAt: p.createdAt,
      });
    }
    return { ...result, page };
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
