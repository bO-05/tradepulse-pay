import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { requireRole } from "./lib/roles";
import { callerProjects, findSubcontractDocScope, requireDocScope, subContractorScope } from "./lib/projectScope";
import { primeChangeOrders, primeContractSum, recipientFor, rowViews } from "./billing/changeOrderView";
import { loadMilestoneFunding } from "./payments/milestoneFundingState";
import { agreementContractSumCents } from "./payments/sov";
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

/** Agreements of the caller's own vendor records, on projects their company is a member of. */
async function subAgreements(
  ctx: QueryCtx,
  scope: { contractorIds: Id<"contractors">[]; projectIds: Set<Id<"projects">> },
) {
  const out: Doc<"agreements">[] = [];
  for (const contractorId of scope.contractorIds) {
    const rows = await ctx.db
      .query("agreements")
      .withIndex("by_contractorId", (q) => q.eq("contractorId", contractorId))
      .take(100);
    for (const a of rows) if (a.status !== "superseded" && scope.projectIds.has(a.projectId)) out.push(a);
  }
  return out;
}

/** The sub company's payout PayPal email (Company settings); profile-level emails are no longer used for payouts. */
async function subPayoutEmail(ctx: QueryCtx, companyId: Id<"companies"> | undefined): Promise<string | null> {
  const company = companyId ? await ctx.db.get(companyId) : null;
  return company?.payoutPaypalEmail ?? null;
}

/** Sub portal: the caller's own contractor and agreements. Pay apps are paged by mySubPayApps. */
export const mySubPortal = query({
  args: {},
  handler: async (ctx) => {
    const scope = await subContractorScope(ctx, { includeArchived: true });
    const viewer = scope.viewer;
    const contractorId = scope.contractorIds.includes(viewer.profile.contractorId as Id<"contractors">)
      ? viewer.profile.contractorId
      : scope.contractorIds[0];
    const contractor = contractorId ? await ctx.db.get(contractorId) : null;
    const visible = await subAgreements(ctx, scope);
    const milestoneFunding = [];
    const executedNewestFirst = visible
      .filter((a) => a.status === "executed")
      .sort((x, y) => (y.executedAt ?? y.createdAt) - (x.executedAt ?? x.createdAt));
    for (const a of executedNewestFirst) {
      milestoneFunding.push({
        agreementId: a._id,
        agreementNumber: a.agreementNumber,
        projectTitle: a.projectTitle,
        milestones: await loadMilestoneFunding(ctx, a._id),
      });
    }
    return {
      displayName: viewer.profile.displayName,
      contractorName: contractor?.companyName ?? null,
      paypalEmail: await subPayoutEmail(ctx, viewer.profile.companyId),
      agreements: visible.map(agreementSummary),
      milestoneFunding,
    };
  },
});

/**
 * The caller's pay applications across all its contractor relationships and agreements, newest
 * first, one cursor page at a time. Listed per sub company (a billing agent: per contractor), not
 * per submitter, so pay apps filed by a linked billing agent show up too. Rows on superseded
 * agreements or removed relationships are left out.
 */
export const mySubPayApps = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const scope = await subContractorScope(ctx, { includeArchived: true });
    if (scope.contractorIds.length === 0) return { page: [], isDone: true, continueCursor: "" };
    const agreements = new Map((await subAgreements(ctx, scope)).map((a) => [a._id as string, a]));
    const companyId = scope.subCompanyId;
    // Native pagination keeps each loaded page's range stable as rows are added or hidden.
    const result =
      companyId !== null
        ? await ctx.db
            .query("payApplications")
            .withIndex("by_subCompanyId", (q) => q.eq("subCompanyId", companyId))
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("payApplications")
            .withIndex("by_contractorId", (q) => q.eq("contractorId", scope.contractorIds[0]))
            .order("desc")
            .paginate(args.paginationOpts);
    const page = [];
    // Rows of removed relationships and superseded agreements stay out of the page.
    for (const p of result.page.filter((row) => agreements.has(row.agreementId))) {
      const agreement = agreements.get(p.agreementId)!;
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
    const scope = await findSubcontractDocScope(ctx, "agreements", args.agreementId);
    if (scope === null) return null;
    const agreement = scope.doc;
    return {
      ...agreementSummary(agreement),
      contractSumCents: agreementContractSumCents(agreement),
      baseBidCents: agreement.baseBidCents ?? null,
      acceptedAlternates: agreement.acceptedAlternates ?? [],
      declinedAlternates: agreement.declinedAlternates ?? [],
      veDeducts: agreement.veDeducts ?? [],
      excludedScopeNotes: agreement.excludedScopeNotes ?? [],
      milestones: await loadMilestoneFunding(ctx, agreement._id),
    };
  },
});

/** Owner portal: projects with their prime change orders (and, for the GC, the subcontract agreements). */
export const ownerOverview = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["owner", "gc"]);
    const result = [];
    for (const project of (await callerProjects(ctx)).slice(0, 50)) {
      const access = await requireDocScope(ctx, "projects", project._id, { roles: ["owner", "gc"] }).catch(() => null);
      if (access === null) continue;
      const party = access.partyRole === "owner" ? "owner" : "gc";
      const changeOrders = await rowViews(ctx, await primeChangeOrders(ctx, project._id), {
        party,
        recipient: await recipientFor(ctx, project._id, party),
      });
      // Subcontract agreements (sums, subcontractors) are GC data; the owner gets the project summary only.
      const agreements =
        access.partyRole === "gc"
          ? (
              await ctx.db
                .query("agreements")
                .withIndex("by_project", (q) => q.eq("projectId", project._id))
                .take(100)
            ).filter((a) => a.status !== "superseded")
          : [];
      result.push({
        _id: project._id,
        title: project.title,
        location: project.location,
        projectType: project.projectType,
        estBudget: project.estBudget,
        isDemoProject: project.isDemoProject,
        partyRole: access.partyRole,
        agreements: agreements.map(agreementSummary),
        primeContractSum: await primeContractSum(ctx, project),
        changeOrders,
      });
    }
    return result;
  },
});
