/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { agentIdProfile, syncAgentProfile } from "./lib/agentAccess";
import { signInAs } from "./lib/testIdentity";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Caller = Pick<T, "query" | "mutation" | "action">;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRef = FunctionReference<any, "public", any, any>;

const TABLES = Object.keys(schema.tables) as (keyof typeof schema.tables)[];
const DENIED = /Not authenticated|Forbidden/;
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
  return t.withIdentity({ subject: `${userId}|agent-session`, email });
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
  m("projects:seedInitialData (reset/seed)", api.projects.seedInitialData, () => ({ force: true })),
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
      await expect(call, `${c.name} as ${label}`).rejects.toThrow(label === "unauthenticated" ? /Not authenticated/ : /Forbidden/);
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
      await expect(call, `${c.name} as ${label}`).rejects.toThrow(label === "unauthenticated" ? /Not authenticated/ : /Forbidden/);
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
    { name: "portal:mySubPortal", fn: api.portal.mySubPortal, args: () => ({}) },
    { name: "portal:mySubPayApps", fn: api.portal.mySubPayApps, args: () => ({ paginationOpts: { numItems: 50, cursor: null } }) },
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

describe("legacy procurement reads are GC/owner only", () => {
  type ReadCase = { name: string; fn: AnyRef; args: (i: Ids) => Record<string, unknown> };
  const LEGACY_READS: ReadCase[] = [
    { name: "agreements:listAgreements", fn: api.agreements.listAgreements, args: (i) => ({ projectId: i.projectId }) },
    { name: "agreements:getAgreementByBid", fn: api.agreements.getAgreementByBid, args: (i) => ({ bidId: i.bidId }) },
    { name: "agreements:getAgreementByPackage", fn: api.agreements.getAgreementByPackage, args: (i) => ({ tradePackageId: i.tradePackageId }) },
    { name: "auditLogs:listRecentLogs", fn: api.auditLogs.listRecentLogs, args: (i) => ({ projectId: i.projectId }) },
    { name: "bids:listByPackage", fn: api.bids.listByPackage, args: (i) => ({ tradePackageId: i.tradePackageId }) },
    { name: "bids:listAllProjectBids", fn: api.bids.listAllProjectBids, args: (i) => ({ projectId: i.projectId }) },
    { name: "contractors:listByPackage", fn: api.contractors.listByPackage, args: (i) => ({ tradePackageId: i.tradePackageId }) },
    { name: "contractors:listByProject", fn: api.contractors.listByProject, args: (i) => ({ projectId: i.projectId }) },
    { name: "coordination:detectCrossTradeClashes", fn: api.coordination.detectCrossTradeClashes, args: (i) => ({ projectId: i.projectId }) },
    { name: "crons:getCronStatus", fn: api.crons.getCronStatus, args: () => ({}) },
    { name: "evals:getLatestEvalRun", fn: api.evals.getLatestEvalRun, args: () => ({}) },
    { name: "evals:listTracesForRun", fn: api.evals.listTracesForRun, args: () => ({ runId: "eval_1" }) },
    { name: "files:listFilesByProject", fn: api.files.listFilesByProject, args: (i) => ({ projectId: i.projectId }) },
    { name: "files:listFilesByPackage", fn: api.files.listFilesByPackage, args: (i) => ({ tradePackageId: i.tradePackageId }) },
    { name: "llmRouter:getProviderAvailability", fn: api.llmRouter.getProviderAvailability, args: () => ({}) },
    { name: "projects:getDemoProject", fn: api.projects.getDemoProject, args: () => ({}) },
    { name: "projects:listProjects", fn: api.projects.listProjects, args: () => ({}) },
    { name: "projects:getProject", fn: api.projects.getProject, args: (i) => ({ projectId: i.projectId }) },
    { name: "rfq:listConversations", fn: api.rfq.listConversations, args: (i) => ({ tradePackageId: i.tradePackageId }) },
    { name: "rfq:getProjectDeliveryStatus", fn: api.rfq.getProjectDeliveryStatus, args: (i) => ({ projectId: i.projectId }) },
    { name: "tradePackages:listByProject", fn: api.tradePackages.listByProject, args: (i) => ({ projectId: i.projectId }) },
    { name: "tradePackages:getPackage", fn: api.tradePackages.getPackage, args: (i) => ({ tradePackageId: i.tradePackageId }) },
  ];

  test.each(LEGACY_READS)("$name rejects unauthenticated, sub and agent callers; GC and owner can read", async (c) => {
    const { gc, ids, wrongRole } = await setup();
    for (const label of ["unauthenticated", "sub (own contractor)", "sub (other contractor)", "unlinked agent", "linked billing agent"]) {
      await expect(wrongRole[label].query(c.fn, c.args(ids)), `${c.name} as ${label}`).rejects.toThrow(DENIED);
    }
    await expect(gc.query(c.fn, c.args(ids))).resolves.toBeDefined();
    await expect(wrongRole.owner.query(c.fn, c.args(ids))).resolves.toBeDefined();
  });
});

describe("static guard sweep over convex/**", () => {
  const sources = import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const GUARD = /\b(requireRole|requireRoleInAction|requireAgreementAccess|getViewer)\(/;

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
    expect(fns.filter((f) => !GUARD.test(f.body)).map((f) => f.name)).toEqual([]);
  });

  test("exported httpActions are the PayPal webhook (signature verified before any write) and the auth-gated Studio AI proxy", () => {
    const http = publicExports().filter((f) => f.kind === "httpAction");
    expect(http.map((f) => f.name).sort()).toEqual([
      "dashboard/studioProxy:studioPreflight",
      "dashboard/studioProxy:studioProxy",
      "payments/webhook:paypalWebhook",
    ]);
    const byName = new Map(http.map((f) => [f.name, f.body]));

    const webhook = byName.get("payments/webhook:paypalWebhook")!;
    const verifyAt = webhook.search(/verif/i);
    const writeAt = webhook.search(/runMutation|runAction/);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(writeAt === -1 || verifyAt < writeAt).toBe(true);

    const proxy = byName.get("dashboard/studioProxy:studioProxy")!;
    const identityAt = proxy.search(/getUserIdentity/);
    const roleAt = proxy.search(/requireRoleForAction/);
    const fetchAt = proxy.search(/\bfetch\(/);
    expect(identityAt).toBeGreaterThan(-1);
    expect(roleAt).toBeGreaterThan(identityAt);
    expect(fetchAt).toBeGreaterThan(roleAt);
    expect(proxy).not.toMatch(/runMutation|runAction/);
    expect(byName.get("dashboard/studioProxy:studioPreflight")!).not.toMatch(/runQuery|runMutation|runAction|fetch\(/);
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
