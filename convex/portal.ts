import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { canViewAgreement, requireRole } from "./lib/roles";
import { changeOrderView } from "./payments/changeOrderDb";

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

/** Sub portal: the caller's own contractor, agreements and pay applications. */
export const mySubPortal = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireRole(ctx, ["sub"]);
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
    const payApps: Doc<"payApplications">[] = [];
    for (const agreement of visible) {
      const rows = await ctx.db
        .query("payApplications")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreement._id))
        .take(100);
      payApps.push(...rows);
    }
    payApps.sort((a, b) => b.createdAt - a.createdAt);
    return {
      displayName: viewer.profile.displayName,
      contractorName: contractor?.companyName ?? null,
      paypalEmail: viewer.profile.paypalEmail ?? null,
      agreements: visible.map(agreementSummary),
      payApplications: payApps.map((p) => ({
        _id: p._id,
        agreementId: p.agreementId,
        periodLabel: p.periodLabel,
        requestedTotalCents: p.requestedTotalCents,
        status: p.status,
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
