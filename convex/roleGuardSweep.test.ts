/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { agentIdProfile, syncAgentProfile } from "./lib/agentAccess";
import { withSession, signInAs } from "./lib/testIdentity";
import { projectSetupArgs } from "./lib/projectSetupFixture";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Caller = Pick<T, "query" | "mutation" | "action">;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRef = FunctionReference<any, "public", any, any>;

const TABLES = Object.keys(schema.tables) as (keyof typeof schema.tables)[];
const DENIED = /Not authenticated|Forbidden|Not found/;
const LINKED_AGENT_EMAIL = "boldlevel182@agentmail.to";
const SECRET_CO_DESCRIPTION = "Sweep fixture change order";

async function snapshot(t: T): Promise<string> {
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) out[table] = await ctx.db.query(table).collect();
    return JSON.stringify(out);
  });
}

async function signInAgent(t: T, email: string, sub: string) {
  const userId = await t.run(async (ctx) => {
    const { id, ...fields } = agentIdProfile({ sub, email, name: "Agent" });
    const userId = await ctx.db.insert("users", fields);
    await syncAgentProfile(ctx, userId, { duringAgentIdSignIn: true });
    await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: id });
    return userId;
  });
  return await withSession(t, userId, email);
}

/** Executed agreement with a funded milestone, a payout, retainage, a pending proposal, a change order and an agent link. */
async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  const base = await t.run(async (ctx) => {
    const agreement = (await ctx.db.query("agreements").first())!;
    const bid = (await ctx.db.get(agreement.bidId))!;
    const others = (await ctx.db.query("contractors").collect()).filter((c) => c._id !== agreement.contractorId);
    return { agreement, bid, otherContractorId: others[0]._id };
  });
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: base.agreement._id });
  const agreementId = base.agreement._id;
  const contractorId = base.agreement.contractorId!;
  const sub1 = await signInAs(t, "sub", { email: "sub1@test.tradepulse", contractorId });
  await gc.as.mutation(api.agentLinks.addAgentLink, { agentEmail: LINKED_AGENT_EMAIL, contractorId });

  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const milestone = (await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId))
      .first())!;
    await ctx.db.patch(milestone._id, { status: "funded" });
    const sov = (await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
      .first())!;
    const fundingId = await ctx.db.insert("payments", {
      agreementId,
      milestoneId: milestone._id,
      kind: "funding",
      status: "authorized",
      paypalOrderId: "SWEEP-ORDER-1",
      paypalAuthorizationId: "SWEEP-AUTH-1",
      authorizationExpiresAt: now + 29 * 86_400_000,
      honorPeriodEndsAt: now + 3 * 86_400_000,
      grossCents: milestone.amountCents,
      retainageCents: 0,
      netCents: milestone.amountCents,
      idempotencyKey: "sweep-funding",
      createdAt: now,
    });
    const payoutId = await ctx.db.insert("payments", {
      agreementId,
      milestoneId: milestone._id,
      kind: "payout",
      status: "failed",
      paypalCaptureId: "SWEEP-CAPTURE-1",
      fundingPaymentId: fundingId,
      grossCents: 10_000,
      retainageCents: 1_000,
      netCents: 9_000,
      idempotencyKey: "sweep-payout",
      createdAt: now,
    });
    const retainageId = await ctx.db.insert("payments", {
      agreementId,
      kind: "retainage_release",
      status: "failed",
      grossCents: 1_000,
      retainageCents: 0,
      netCents: 1_000,
      idempotencyKey: "sweep-retainage",
      createdAt: now,
    });
    await ctx.db.insert("retainageLedger", { agreementId, paymentId: payoutId, deltaCents: 1_000, reason: "held", createdAt: now });
    const payAppId = await ctx.db.insert("payApplications", {
      agreementId,
      contractorId,
      subUserId: sub1.userId,
      periodLabel: "Sweep pay app",
      lines: [{ sovLineId: sov._id, pctCompleteThisPeriod: 1, pctCompleteToDate: 1, requestedCents: 10_000 }],
      requestedTotalCents: 10_000,
      notes: "",
      lienWaiver: true,
      status: "reviewed",
      submittedBy: { userId: sub1.userId, actorType: "human" },
      createdAt: now,
    });
    const proposalId = await ctx.db.insert("agentProposals", {
      payAppId,
      agreementId,
      milestoneId: milestone._id,
      kind: "payout",
      amountCents: 10_000,
      rationale: "Sweep fixture",
      flags: [],
      status: "pending",
      source: "agent",
      createdAt: now,
    });
    const changeOrderId = await ctx.db.insert("changeOrders", {
      agreementId,
      number: 1,
      description: SECRET_CO_DESCRIPTION,
      amountCents: 50_000,
      status: "draft",
      createdAt: now,
    });
    const linkId = (await ctx.db.query("agentLinks").first())!._id;
    return {
      milestoneId: milestone._id,
      fundingId,
      payoutId,
      retainageId,
      payAppId,
      proposalId,
      changeOrderId,
      linkId,
    };
  });

  const wrongRole: Record<string, Caller> = {
    unauthenticated: t,
    "sub (own contractor)": sub1.as,
    "sub (other contractor)": (await signInAs(t, "sub", { email: "sub2@test.tradepulse", contractorId: base.otherContractorId })).as,
    owner: (await signInAs(t, "owner", { email: "owner@test.tradepulse" })).as,
    "unlinked agent": await signInAgent(t, "dullstreet57@agentmail.to", "unlinked-agent-sub"),
    "linked billing agent": await signInAgent(t, LINKED_AGENT_EMAIL, "linked-agent-sub"),
  };
  return {
    t,
    gc: gc.as,
    wrongRole,
    ids: {
      ...ids,
      agreementId,
      contractorId,
      otherContractorId: base.otherContractorId,
      bidId: base.bid._id,
      tradePackageId: base.bid.tradePackageId,
      projectId: base.agreement.projectId,
    },
  };
}

type Ids = Awaited<ReturnType<typeof setup>>["ids"];
type Case = { name: string; kind: "mutation" | "action"; fn: AnyRef; args: (i: Ids) => Record<string, unknown> };
const m = (name: string, fn: AnyRef, args: Case["args"]): Case => ({ name, kind: "mutation", fn, args });
const a = (name: string, fn: AnyRef, args: Case["args"]): Case => ({ name, kind: "action", fn, args });

/** Every state-changing GC-only function: award, execute, reset, fund, capture, void, payout, retainage, change orders, agent links, proposals. */
const GC_ONLY: Case[] = [
  m("bids:awardContract (award)", api.bids.awardContract, (i) => ({ bidId: i.bidId, tradePackageId: i.tradePackageId })),
  m("agreements:executeAgreement (execute)", api.agreements.executeAgreement, (i) => ({ agreementId: i.agreementId })),
  m("agreementTerms:updateAgreementTerms", api.agreementTerms.updateAgreementTerms, (i) => ({
    agreementId: i.agreementId,
    terms: {
      retainageBps: 500,
      paymentTerms: { type: "net", days: 30 },
      insurance: {
        glEachOccurrenceCents: 100_000_000,
        glAggregateCents: 200_000_000,
        autoCents: 100_000_000,
        umbrellaCents: 500_000_000,
        workersComp: true,
        additionalInsured: true,
      },
      warrantyMonths: 12,
      governingState: "TX",
    },
  })),
  m("projects:seedInitialData (reset/seed)", api.projects.seedInitialData, () => ({ force: true })),
  m("projects:updateProject (settings)", api.projects.updateProject, (i) => ({ projectId: i.projectId, ...projectSetupArgs() })),
  m("projects:archiveProject", api.projects.archiveProject, (i) => ({ projectId: i.projectId })),
  m("projects:restoreProject", api.projects.restoreProject, (i) => ({ projectId: i.projectId })),
  a("payments/orders:createFundingOrder (fund)", api.payments.orders.createFundingOrder, (i) => ({ milestoneId: i.milestoneId })),
  a("payments/orders:authorizeFundingOrder (fund)", api.payments.orders.authorizeFundingOrder, () => ({ orderId: "SWEEP-ORDER-1" })),
  a("payments/release:releaseAndPay (capture + payout)", api.payments.release.releaseAndPay, (i) => ({
    milestoneId: i.milestoneId,
    amountCents: 10_000,
    requestKey: "sweep-release",
  })),
  a("payments/release:resumeRelease (capture + payout)", api.payments.release.resumeRelease, (i) => ({ paymentId: i.payoutId })),
  a("payments/release:closeMilestone (void)", api.payments.release.closeMilestone, (i) => ({ milestoneId: i.milestoneId })),
  a("payments/release:refreshCaptureStatus", api.payments.release.refreshCaptureStatus, (i) => ({ paymentId: i.payoutId })),
  a("payments/release:refreshPayoutStatus", api.payments.release.refreshPayoutStatus, (i) => ({ paymentId: i.payoutId })),
  a("payments/payoutRetry:retryPayout (payout)", api.payments.payoutRetry.retryPayout, (i) => ({ paymentId: i.payoutId })),
  a("payments/retainage:releaseRetainage (retainage release)", api.payments.retainage.releaseRetainage, (i) => ({
    agreementId: i.agreementId,
  })),
  a("payments/retainage:resumeRetainageRelease", api.payments.retainage.resumeRetainageRelease, (i) => ({ paymentId: i.retainageId })),
  a("payments/invoices:createChangeOrder (change-order create)", api.payments.invoices.createChangeOrder, (i) => ({
    agreementId: i.agreementId,
    description: "Forged change order",
    amountCents: 12_345,
  })),
  a("payments/invoices:sendChangeOrderInvoice", api.payments.invoices.sendChangeOrderInvoice, (i) => ({ changeOrderId: i.changeOrderId })),
  m("agentLinks:addAgentLink", api.agentLinks.addAgentLink, (i) => ({ agentEmail: "forged@agentmail.to", contractorId: i.contractorId })),
  m("agentLinks:revokeAgentLink", api.agentLinks.revokeAgentLink, (i) => ({ linkId: i.linkId })),
  m("payApps/proposals:approveProposal", api.payApps.proposals.approveProposal, (i) => ({ proposalId: i.proposalId })),
  m("payApps/proposals:approveProposal (license override)", api.payApps.proposals.approveProposal, (i) => ({
    proposalId: i.proposalId,
    overrideLicenseHold: true,
  })),
  m("payApps/proposals:editProposal", api.payApps.proposals.editProposal, (i) => ({ proposalId: i.proposalId, amountCents: 5_000 })),
  m("payApps/proposals:rejectProposal", api.payApps.proposals.rejectProposal, (i) => ({ proposalId: i.proposalId })),
  m("payApps/proposals:rejectPayApp", api.payApps.proposals.rejectPayApp, (i) => ({ payAppId: i.payAppId })),
  a("payApps/review:rerunPayAppReview", api.payApps.review.rerunPayAppReview, (i) => ({ payAppId: i.payAppId })),
  a("payApps/reviewEvals:executePayAppReviewEvalSuite", api.payApps.reviewEvals.executePayAppReviewEvalSuite, () => ({})),
  m("billing/tranches:createTranche", api.billing.tranches.createTranche, (i) => ({ agreementId: i.agreementId, name: "Forged", amountCents: 100 })),
  m("billing/tranches:updateTranche", api.billing.tranches.updateTranche, (i) => ({ trancheId: i.milestoneId, amountCents: 100 })),
  m("billing/tranches:deleteTranche", api.billing.tranches.deleteTranche, (i) => ({ trancheId: i.milestoneId })),
  m("billing/tranches:moveTranche", api.billing.tranches.moveTranche, (i) => ({ trancheId: i.milestoneId, direction: "down" })),
  a("billing/pay:payPayApp (capture + payout)", api.billing.pay.payPayApp, (i) => ({ payAppId: i.payAppId })),
  m("kernel/licenseChecks:requestLicenseCheck", api.kernel.licenseChecks.requestLicenseCheck, (i) => ({ contractorId: i.contractorId })),
];

/** Read-only at PayPal; the owner may refresh the invoice it pays. Everyone else is refused. */
const GC_OR_OWNER: Case[] = [
  a("payments/invoices:refreshChangeOrderStatus", api.payments.invoices.refreshChangeOrderStatus, (i) => ({
    changeOrderId: i.changeOrderId,
  })),
];

const fetchSpy = vi.fn(async () => {
  throw new Error("network disabled in tests");
});
beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GC-only money and admin functions reject every other caller", () => {
  test.each(GC_ONLY)("$name", async (c) => {
    const { t, ids, wrongRole } = await setup();
    const before = await snapshot(t);
    for (const [label, caller] of Object.entries(wrongRole)) {
      const call = c.kind === "mutation" ? caller.mutation(c.fn, c.args(ids)) : caller.action(c.fn, c.args(ids));
      await expect(call, `${c.name} as ${label}`).rejects.toThrow(label === "unauthenticated" ? /Not authenticated/ : /Forbidden|Not found/);
    }
    expect(await snapshot(t)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each(GC_OR_OWNER)("$name (GC or owner)", async (c) => {
    const { t, ids, wrongRole } = await setup();
    const before = await snapshot(t);
    for (const [label, caller] of Object.entries(wrongRole)) {
      if (label === "owner") continue;
      const call = c.kind === "mutation" ? caller.mutation(c.fn, c.args(ids)) : caller.action(c.fn, c.args(ids));
      await expect(call, `${c.name} as ${label}`).rejects.toThrow(label === "unauthenticated" ? /Not authenticated/ : /Forbidden|Not found/);
    }
    expect(await snapshot(t)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("the fixture arguments are valid: a GC passes the guard on the same calls", async () => {
    const { t, gc, ids } = await setup();
    await gc.mutation(api.payApps.proposals.editProposal, { proposalId: ids.proposalId, amountCents: 5_000 });
    expect((await t.run((ctx) => ctx.db.get(ids.proposalId)))!.editedAmountCents).toBe(5_000);
    await gc.mutation(api.agentLinks.revokeAgentLink, { linkId: ids.linkId });
    expect((await t.run((ctx) => ctx.db.get(ids.linkId)))!.status).toBe("revoked");
    await gc.mutation(api.payApps.proposals.rejectProposal, { proposalId: ids.proposalId });
    expect((await t.run((ctx) => ctx.db.get(ids.proposalId)))!.status).toBe("rejected");
  });
});

describe("agreement ledger and payment reads", () => {
  type ReadCase = { name: string; fn: AnyRef; args: (i: Ids) => Record<string, unknown> };
  const READS: ReadCase[] = [
    { name: "payments/ledger:getAgreementLedger", fn: api.payments.ledger.getAgreementLedger, args: (i) => ({ agreementId: i.agreementId }) },
    { name: "payments/ledger:listLedgerAgreements", fn: api.payments.ledger.listLedgerAgreements, args: () => ({}) },
    { name: "payments/changeOrderDb:listForAgreement", fn: api.payments.changeOrderDb.listForAgreement, args: (i) => ({ agreementId: i.agreementId }) },
    { name: "payApps/review:listAgreementPayApps", fn: api.payApps.review.listAgreementPayApps, args: (i) => ({ agreementId: i.agreementId }) },
    { name: "payApps/submit:payAppFormContext", fn: api.payApps.submit.payAppFormContext, args: (i) => ({ agreementId: i.agreementId }) },
    { name: "payApps/proposals:listInbox", fn: api.payApps.proposals.listInbox, args: () => ({}) },
    { name: "payApps/proposals:getAgentTrace", fn: api.payApps.proposals.getAgentTrace, args: (i) => ({ payAppId: i.payAppId }) },
    { name: "portal:getAgreementSummary", fn: api.portal.getAgreementSummary, args: (i) => ({ agreementId: i.agreementId }) },
    { name: "agreementTerms:getAgreementTerms", fn: api.agreementTerms.getAgreementTerms, args: (i) => ({ agreementId: i.agreementId }) },
    { name: "portal:mySubPortal", fn: api.portal.mySubPortal, args: () => ({}) },
    { name: "portal:mySubPayApps", fn: api.portal.mySubPayApps, args: () => ({ paginationOpts: { numItems: 50, cursor: null } }) },
    { name: "payApps/g703:getPayApp", fn: api.payApps.g703.getPayApp, args: (i) => ({ payAppId: i.payAppId }) },
    { name: "payApps/g703:payAppLines", fn: api.payApps.g703.payAppLines, args: (i) => ({ payAppId: i.payAppId }) },
    { name: "payApps/g703:mySubPayAppAgreements", fn: api.payApps.g703.mySubPayAppAgreements, args: () => ({}) },
    { name: "payApps/g703:gcBillingWorklist", fn: api.payApps.g703.gcBillingWorklist, args: () => ({}) },
    { name: "billing/canPay:canPay", fn: api.billing.canPay.canPay, args: (i) => ({ payAppId: i.payAppId }) },
    { name: "billing/canPay:paymentPanel", fn: api.billing.canPay.paymentPanel, args: (i) => ({ payAppId: i.payAppId }) },
    { name: "billing/tranches:listTranches", fn: api.billing.tranches.listTranches, args: (i) => ({ agreementId: i.agreementId }) },
    { name: "billing/tranches:ownerProjectTranches", fn: api.billing.tranches.ownerProjectTranches, args: (i) => ({ projectId: i.projectId }) },
    { name: "billing/retainage:projectRetainage", fn: api.billing.retainage.projectRetainage, args: () => ({}) },
    { name: "kernel/licenseChecks:getContractorLicense", fn: api.kernel.licenseChecks.getContractorLicense, args: (i) => ({ contractorId: i.contractorId }) },
  ];

  function leaks(result: unknown, ids: Ids): boolean {
    if (result === null || result === undefined) return false;
    const text = JSON.stringify(result);
    return [ids.agreementId, ids.fundingId, ids.payoutId, ids.payAppId, ids.proposalId, SECRET_CO_DESCRIPTION, "SWEEP-"].some((s) =>
      text.includes(s),
    );
  }

  test.each(READS)("$name: unauthenticated callers are rejected", async (c) => {
    const { t, ids } = await setup();
    await expect(t.query(c.fn, c.args(ids))).rejects.toThrow(/Not authenticated/);
  });

  test.each(READS)("$name: another contractor's sub and an unlinked agent get no data for the agreement", async (c) => {
    const { ids, wrongRole } = await setup();
    for (const label of ["sub (other contractor)", "unlinked agent"]) {
      let result: unknown = null;
      try {
        result = await wrongRole[label].query(c.fn, c.args(ids));
      } catch (err) {
        expect(String(err), `${c.name} as ${label}`).toMatch(/Forbidden|not found/i);
        continue;
      }
      expect(leaks(result, ids), `${c.name} as ${label} returned ${JSON.stringify(result)}`).toBe(false);
    }
  });

  test("the GC sees the same agreement's ledger, so the denial above is not an empty fixture", async () => {
    const { gc, ids } = await setup();
    const ledger = await gc.query(api.payments.ledger.getAgreementLedger, { agreementId: ids.agreementId });
    expect(leaks(ledger, ids)).toBe(true);
  });
});

describe("procurement reads admit only the parties allowed on the project", () => {
  type Label = "gc" | "unauthenticated" | "sub (own contractor)" | "sub (other contractor)" | "owner" | "unlinked agent" | "linked billing agent";
  type ReadCase = { name: string; fn: AnyRef; args: (i: Ids) => Record<string, unknown>; allow: Label[] };
  const SUBS: Label[] = ["sub (own contractor)", "sub (other contractor)", "linked billing agent"];
  const READS: ReadCase[] = [
    { name: "agreements:listAgreements", fn: api.agreements.listAgreements, args: (i) => ({ projectId: i.projectId }), allow: ["gc", "owner", ...SUBS] },
    { name: "agreements:getAgreementByBid", fn: api.agreements.getAgreementByBid, args: (i) => ({ bidId: i.bidId }), allow: ["gc"] },
    { name: "agreements:getAgreementByPackage", fn: api.agreements.getAgreementByPackage, args: (i) => ({ tradePackageId: i.tradePackageId }), allow: ["gc"] },
    // An explicit inaccessible project reads like a deleted one: "Not found.".
    { name: "auditLogs:listRecentLogs", fn: api.auditLogs.listRecentLogs, args: (i) => ({ projectId: i.projectId }), allow: ["gc", "owner", ...SUBS] },
    { name: "bids:listByPackage", fn: api.bids.listByPackage, args: (i) => ({ tradePackageId: i.tradePackageId }), allow: ["gc"] },
    { name: "bids:listAllProjectBids", fn: api.bids.listAllProjectBids, args: (i) => ({ projectId: i.projectId }), allow: ["gc"] },
    { name: "contractors:listByPackage", fn: api.contractors.listByPackage, args: (i) => ({ tradePackageId: i.tradePackageId }), allow: ["gc"] },
    { name: "contractors:listByProject", fn: api.contractors.listByProject, args: (i) => ({ projectId: i.projectId }), allow: ["gc"] },
    { name: "coordination:detectCrossTradeClashes", fn: api.coordination.detectCrossTradeClashes, args: (i) => ({ projectId: i.projectId }), allow: ["gc"] },
    { name: "crons:getCronStatus", fn: api.crons.getCronStatus, args: () => ({}), allow: ["gc", "owner"] },
    { name: "evals:getLatestEvalRun", fn: api.evals.getLatestEvalRun, args: () => ({}), allow: ["gc"] },
    { name: "evals:listTracesForRun", fn: api.evals.listTracesForRun, args: () => ({ runId: "eval_1" }), allow: ["gc"] },
    { name: "files:listFilesByProject", fn: api.files.listFilesByProject, args: (i) => ({ projectId: i.projectId }), allow: ["gc", "owner"] },
    { name: "files:listFilesByPackage", fn: api.files.listFilesByPackage, args: (i) => ({ tradePackageId: i.tradePackageId }), allow: ["gc", "owner"] },
    { name: "llmRouter:getProviderAvailability", fn: api.llmRouter.getProviderAvailability, args: () => ({}), allow: ["gc", "owner"] },
    { name: "projects:getDemoProject", fn: api.projects.getDemoProject, args: () => ({}), allow: ["gc", "owner"] },
    { name: "projects:listProjects", fn: api.projects.listProjects, args: () => ({}), allow: ["gc", "owner", ...SUBS] },
    { name: "projects:getProject", fn: api.projects.getProject, args: (i) => ({ projectId: i.projectId }), allow: ["gc", "owner", ...SUBS] },
    { name: "rfq:listConversations", fn: api.rfq.listConversations, args: (i) => ({ tradePackageId: i.tradePackageId }), allow: ["gc", ...SUBS] },
    { name: "rfq:getProjectDeliveryStatus", fn: api.rfq.getProjectDeliveryStatus, args: (i) => ({ projectId: i.projectId }), allow: ["gc"] },
    { name: "tradePackages:listByProject", fn: api.tradePackages.listByProject, args: (i) => ({ projectId: i.projectId }), allow: ["gc", "owner"] },
    { name: "tradePackages:getPackage", fn: api.tradePackages.getPackage, args: (i) => ({ tradePackageId: i.tradePackageId }), allow: ["gc", "owner"] },
  ];

  test.each(READS)("$name", async (c) => {
    const { gc, ids, wrongRole } = await setup();
    const callers: Record<Label, Caller> = { gc, ...(wrongRole as Record<Exclude<Label, "gc">, Caller>) };
    for (const [label, caller] of Object.entries(callers) as [Label, Caller][]) {
      const call = caller.query(c.fn, c.args(ids));
      if (c.allow.includes(label)) await expect(call, `${c.name} as ${label}`).resolves.toBeDefined();
      else await expect(call, `${c.name} as ${label}`).rejects.toThrow(DENIED);
    }
  });
});

describe("static guard sweep over convex/**", () => {
  const sources = import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const TENANCY_GUARDS = [
    "requireProjectScope",
    "requireDocScope",
    "findDocScope",
    "findSubcontractDocScope",
    "scopedAgreements",
    "gcAgreementsAndOwnerProjects",
    "requireProjectScopeInAction",
    "requireDemoCompany",
    "requireDemoCompanyInAction",
    "callerProjects",
    "subContractorScope",
    "requireProjectAccess",
    "requireDocInProject",
    "requireCompanyMember",
    "requireCompanyMemberInAction",
    "accessibleProjectIds",
  ];
  const TENANCY = new RegExp(`\\b(${TENANCY_GUARDS.join("|")})\\(`);
  const GUARD = new RegExp(`\\b(requireRole|requireRoleInAction|requireAgreementAccess|getViewer|requireVerifiedUser|${TENANCY_GUARDS.join("|")})\\(`);
  // Same lists as scripts/tools/guard-audit.mjs.
  const NO_PROJECT_DATA = new Set([
    "crons:getCronStatus",
    "llmRouter:getProviderAvailability",
    "llmRouter:runModelDiagnostic",
    "contractorDiscovery:scrapeContractorWebsite",
    "profiles:me",
    "onboarding:createCompany",
    "invites:accept",
    "invites:acceptMine",
    "invites:listMine",
    "invites:getByToken",
  ]);
  // Public before sign-in by design; the invite token is the credential (see guard-audit.mjs TOKEN_GATED).
  const TOKEN_GATED = new Set(["invites:getByToken"]);

  function publicExports() {
    const out: { name: string; kind: string; body: string }[] = [];
    for (const [path, src] of Object.entries(sources)) {
      if (path.endsWith(".test.ts") || path.startsWith("./_generated/")) continue;
      const mod = path.replace(/^\.\//, "").replace(/\.ts$/, "");
      const re = /^export const (\w+) = (query|mutation|action|httpAction)\(/gm;
      const hits = [...src.matchAll(re)];
      hits.forEach((h, i) => {
        const end = i + 1 < hits.length ? hits[i + 1].index! : src.length;
        out.push({ name: `${mod}:${h[1]}`, kind: h[2], body: src.slice(h.index!, end) });
      });
    }
    return out;
  }

  test("every exported public query, mutation and action checks the caller's role", () => {
    const fns = publicExports().filter((f) => f.kind !== "httpAction");
    expect(fns.length).toBeGreaterThan(100);
    expect(fns.filter((f) => !GUARD.test(f.body) && !TOKEN_GATED.has(f.name)).map((f) => f.name)).toEqual([]);
    const tokenGated = fns.find((f) => f.name === "invites:getByToken")!;
    expect(tokenGated.body.search(/hashInviteToken\(token\)/)).toBeGreaterThan(-1);
    expect(tokenGated.body.search(/hashInviteToken\(token\)/)).toBeLessThan(tokenGated.body.search(/ctx\.db/));
    expect(tokenGated.body).not.toMatch(/ctx\.db\.(insert|patch|replace|delete)|runMutation/);
  });

  test("every public function has a company-tenancy guard unless it reads no project data", () => {
    const fns = publicExports().filter((f) => f.kind !== "httpAction");
    const missing = fns.filter((f) => !TENANCY.test(f.body) && !NO_PROJECT_DATA.has(f.name));
    expect(missing.map((f) => f.name)).toEqual([]);
    for (const mod of [
      "projects",
      "tradePackages",
      "contractors",
      "bids",
      "agreements",
      "files",
      "rfq",
      "coordination",
      "portal",
      "agentLinks",
      "payments/ledger",
      "payments/orders",
      "payments/release",
      "payments/retainage",
      "payments/invoices",
      "payments/changeOrderDb",
      "payments/sandboxTopUp",
      "payApps/submit",
      "payApps/g703",
      "billing/sov",
      "billing/tranches",
      "billing/canPay",
      "billing/pay",
      "billing/retainage",
      "payApps/review",
      "payApps/proposals",
      "payApps/reviewEvals",
      "kernel/licenseChecks",
      "dashboard/queries",
      "dashboard/payAgent",
      "judgeDemo/runs",
    ]) {
      expect(fns.filter((f) => f.name.startsWith(`${mod}:`) && TENANCY.test(f.body)).length, mod).toBeGreaterThan(0);
    }
  });

  test("exported httpActions are the PayPal and AgentMail webhooks, the auth-gated Studio AI proxy and the authenticated project file download", () => {
    const http = publicExports().filter((f) => f.kind === "httpAction");
    expect(http.map((f) => f.name).sort()).toEqual([
      "agentmailWebhook:agentmailWebhook",
      "dashboard/studioProxy:studioPreflight",
      "dashboard/studioProxy:studioProxy",
      "payments/webhook:paypalWebhook",
      "projectFileDownload:projectFileDownload",
      "projectFileDownload:projectFilePreflight",
    ]);
    const byName = new Map(http.map((f) => [f.name, f.body]));

    const webhook = byName.get("payments/webhook:paypalWebhook")!;
    const verifyAt = webhook.search(/verif/i);
    const writeAt = webhook.search(/runMutation|runAction/);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(writeAt === -1 || verifyAt < writeAt).toBe(true);

    const mailHook = byName.get("agentmailWebhook:agentmailWebhook")!;
    const mailVerifyAt = mailHook.search(/verifyAgentMailWebhook\(/);
    const mailWriteAt = mailHook.search(/runMutation|runAction/);
    expect(mailVerifyAt).toBeGreaterThan(-1);
    expect(mailWriteAt).toBeGreaterThan(mailVerifyAt);

    const proxy = byName.get("dashboard/studioProxy:studioProxy")!;
    const identityAt = proxy.search(/getUserIdentity/);
    const roleAt = proxy.search(/internal\.dashboard\.studioAccess\.authorizeStudioCaller/);
    const fetchAt = proxy.search(/\bfetch\(/);
    expect(identityAt).toBeGreaterThan(-1);
    expect(roleAt).toBeGreaterThan(identityAt);
    expect(fetchAt).toBeGreaterThan(roleAt);
    expect(proxy).not.toMatch(/runMutation|runAction/);
    expect(byName.get("dashboard/studioProxy:studioPreflight")!).not.toMatch(/runQuery|runMutation|runAction|fetch\(/);

    const download = byName.get("projectFileDownload:projectFileDownload")!;
    const sessionAt = download.search(/getUserIdentity/);
    const authorizeAt = download.search(/internal\.projectFileDownload\.authorizeDownload/);
    const storageAt = download.search(/ctx\.storage/);
    expect(sessionAt).toBeGreaterThan(-1);
    expect(authorizeAt).toBeGreaterThan(sessionAt);
    expect(storageAt).toBeGreaterThan(authorizeAt);
    expect(download).not.toMatch(/runMutation|runAction/);
    expect(byName.get("projectFileDownload:projectFilePreflight")!).not.toMatch(/ctx\.|fetch\(/);
  });

  test("seed and test-only helpers are internal functions", () => {
    const internalOnly: [string, string][] = [
      ["./demoAccounts.ts", "seedDemo"],
      ["./projects.ts", "seedInitialDataInternal"],
      ["./payApps/reviewScenario.ts", "seedReviewScenario"],
      ["./payments/testing.ts", "backdateAuthorization"],
      ["./payments/testing.ts", "backdateRetainageRelease"],
    ];
    for (const [file, fn] of internalOnly) {
      expect(sources[file], file).toMatch(new RegExp(`^export const ${fn} = internal(Query|Mutation|Action)\\(`, "m"));
    }
  });
});
