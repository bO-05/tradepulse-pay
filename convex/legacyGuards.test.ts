/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { agentIdProfile, syncAgentProfile } from "./lib/agentAccess";
import { withSession, signInAs } from "./lib/testIdentity";
import { projectSetupArgs } from "./lib/projectSetupFixture";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Caller = Pick<T, "mutation" | "action">;

const TABLES = Object.keys(schema.tables) as (keyof typeof schema.tables)[];

async function snapshot(t: T): Promise<string> {
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) out[table] = await ctx.db.query(table).collect();
    return JSON.stringify(out);
  });
}

async function signInUnlinkedAgent(t: T) {
  const email = "dullstreet57@agentmail.to";
  const userId = await t.run(async (ctx) => {
    const { id, ...fields } = agentIdProfile({ sub: "unlinked-agent-sub", email, name: "Unlinked Agent" });
    const userId = await ctx.db.insert("users", fields);
    await syncAgentProfile(ctx, userId, { duringAgentIdSignIn: true });
    await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: id });
    return userId;
  });
  return await withSession(t, userId, email);
}

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = (await signInAs(t, "gc", { email: "gc@test.tradepulse" })).as;
  const ids = await t.run(async (ctx) => {
    const project = (await ctx.db.query("projects").first())!;
    const pkg = (await ctx.db.query("tradePackages").withIndex("by_project", (q) => q.eq("projectId", project._id)).first())!;
    const bid = (await ctx.db.query("bids").first())!;
    const contractor = (await ctx.db.query("contractors").first())!;
    const conversation = (await ctx.db.query("conversations").first())!;
    const file = (await ctx.db.query("projectFiles").first())!;
    const uploadIntentId = await ctx.db.insert("uploadIntents", {
      userId: (await ctx.db.query("users").first())!._id,
      companyId: (await ctx.db.query("companies").first())!._id,
      projectId: project._id,
      createdAt: 0,
      expiresAt: 0,
    });
    await ctx.db.delete(uploadIntentId);
    return {
      uploadIntentId,
      projectId: project._id,
      packageId: pkg._id,
      bidId: bid._id,
      bidPackageId: bid.tradePackageId,
      contractorId: contractor._id,
      conversationId: conversation._id,
      fileId: file._id,
    };
  });
  const agreementId: Id<"agreements"> = await (async () => {
    const existing = await t.run(async (ctx) => (await ctx.db.query("agreements").first())?._id ?? null);
    if (existing !== null) return existing;
    await gc.mutation(api.agreements.generateAgreement, { bidId: ids.bidId, tradePackageId: ids.bidPackageId });
    return await t.run(async (ctx) => (await ctx.db.query("agreements").first())!._id);
  })();
  const linkedEmail = "boldlevel182@agentmail.to";
  await gc.mutation(api.agentLinks.addAgentLink, { agentEmail: linkedEmail, contractorId: ids.contractorId });
  const linkedAgentId = await t.run(async (ctx) => {
    const { id, ...fields } = agentIdProfile({ sub: "linked-agent-sub", email: linkedEmail, name: "Billing Agent" });
    const userId = await ctx.db.insert("users", fields);
    await syncAgentProfile(ctx, userId, { duringAgentIdSignIn: true });
    await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: id });
    return userId;
  });
  const callers: Record<string, Caller> = {
    unauthenticated: t,
    sub: (await signInAs(t, "sub", { contractorId: ids.contractorId })).as,
    owner: (await signInAs(t, "owner")).as,
    "unlinked agent": await signInUnlinkedAgent(t),
    "linked billing agent": await withSession(t, linkedAgentId, linkedEmail),
  };
  return { t, gc, ids: { ...ids, agreementId }, callers };
}

type Ids = Awaited<ReturnType<typeof setup>>["ids"];
type Case = {
  name: string;
  kind: "mutation" | "action";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: FunctionReference<"mutation" | "action", "public", any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: (ids: Ids) => any;
};

const m = (name: string, fn: Case["fn"], args: Case["args"]): Case => ({ name, kind: "mutation", fn, args });
const a = (name: string, fn: Case["fn"], args: Case["args"]): Case => ({ name, kind: "action", fn, args });

const CASES: Case[] = [
  m("bids:deleteBid", api.bids.deleteBid, (i) => ({ bidId: i.bidId })),
  m("bids:updateBidLeveling", api.bids.updateBidLeveling, (i) => ({ bidId: i.bidId, baseAmountCents: 100 })),
  m("bids:updateBidAdjustments", api.bids.updateBidAdjustments, (i) => ({ bidId: i.bidId, identifiedExclusions: [] })),
  m("bids:setExclusionPlug", api.bids.setExclusionPlug, (i) => ({ bidId: i.bidId, exclusionIndex: 0, amountCents: 1_500_000 })),
  m("bids:submitDirectBid", api.bids.submitDirectBid, (i) => ({
    tradePackageId: i.packageId,
    contractorId: i.contractorId,
    subcontractorName: "Forged Sub",
    baseAmountCents: 100_000,
  })),
  m("bids:awardContract", api.bids.awardContract, (i) => ({ bidId: i.bidId, tradePackageId: i.bidPackageId })),
  m("bids:unawardContract", api.bids.unawardContract, (i) => ({ bidId: i.bidId, tradePackageId: i.bidPackageId })),
  m("tradePackages:createTradePackage", api.tradePackages.createTradePackage, (i) => ({
    projectId: i.projectId,
    csiDivision: "09 00 00",
    tradeName: "Forged",
    budgetEstimate: 1000,
    scopeSummary: "x",
    mandatoryInclusions: [],
    bidDeadline: "2026-12-01",
  })),
  m("tradePackages:updateBidDue", api.tradePackages.updateBidDue, (i) => ({ tradePackageId: i.packageId, bidDeadline: "2099-01-05", bidDueTime: "14:00" })),
  m("tradePackages:updateStatus", api.tradePackages.updateStatus, (i) => ({ tradePackageId: i.packageId, status: "awarded" })),
  m("tradePackages:deleteTradePackage", api.tradePackages.deleteTradePackage, (i) => ({ tradePackageId: i.packageId })),
  a("tradePackages:generateTradePackagesFromSpec", api.tradePackages.generateTradePackagesFromSpec, (i) => ({
    projectId: i.projectId,
  })),
  m("contractors:createContractor", api.contractors.createContractor, (i) => ({
    tradePackageId: i.packageId,
    companyName: "Forged LLC",
    contactEmail: "forged@example.com",
    licenseNumber: "X",
    licenseStatus: "Active",
    sourceUrl: "https://example.com",
    rfqStatus: "invited",
  })),
  m("contractors:updateRfqStatus", api.contractors.updateRfqStatus, (i) => ({ contractorId: i.contractorId, rfqStatus: "bid_received" })),
  m("contractors:updateContractor", api.contractors.updateContractor, (i) => ({
    contractorId: i.contractorId,
    companyName: "Renamed",
    contactEmail: "renamed@example.com",
    licenseNumber: "X",
    licenseStatus: "Active",
    sourceUrl: "https://example.com",
  })),
  m("contractors:deleteContractor", api.contractors.deleteContractor, (i) => ({ contractorId: i.contractorId })),
  a("contractorDiscovery:discoverSubcontractors", api.contractorDiscovery.discoverSubcontractors, (i) => ({
    tradePackageId: i.packageId,
  })),
  a("contractorDiscovery:scrapeContractorWebsite", api.contractorDiscovery.scrapeContractorWebsite, () => ({
    url: "https://example.com",
  })),
  m("coordination:deductDoubleBuyCredit", api.coordination.deductDoubleBuyCredit, (i) => ({
    projectId: i.projectId,
    clashId: "c1",
    tradePackageId: i.packageId,
    deductAmount: 100,
    description: "x",
  })),
  m("coordination:reverseDoubleBuyCredit", api.coordination.reverseDoubleBuyCredit, (i) => ({
    projectId: i.projectId,
    clashId: "c1",
    tradePackageId: i.packageId,
  })),
  m("coordination:assignScopeVoidToTrade", api.coordination.assignScopeVoidToTrade, (i) => ({
    projectId: i.projectId,
    voidId: "v1",
    tradePackageId: i.packageId,
    additionalCost: 100,
    description: "x",
  })),
  a("coordination:scanCrossTradeClashes", api.coordination.scanCrossTradeClashes, (i) => ({ projectId: i.projectId })),
  a("coordination:extractDynamicClashes", api.coordination.extractDynamicClashes, (i) => ({ projectId: i.projectId })),
  m("crons:runDeadlineMonitorNow", api.crons.runDeadlineMonitorNow, (i) => ({ projectId: i.projectId })),
  m("crons:runComplianceAuditNow", api.crons.runComplianceAuditNow, (i) => ({ projectId: i.projectId })),
  a("evals:executeEvalSuite", api.evals.executeEvalSuite, () => ({})),
  m("files:generateUploadUrl", api.files.generateUploadUrl, (i) => ({ projectId: i.projectId })),
  m("files:saveFileRecord", api.files.saveFileRecord, (i) => ({
    projectId: i.projectId,
    uploadIntentId: i.uploadIntentId,
    storageId: "forged",
    fileName: "forged.pdf",
    fileType: "spec",
    fileSize: 1,
    uploadedBy: "attacker",
  })),
  m("files:repairSeededDocumentSizes", api.files.repairSeededDocumentSizes, () => ({})),
  m("files:deleteFile", api.files.deleteFile, (i) => ({ fileId: i.fileId })),
  a("files:extractBidFromQuoteFile", api.files.extractBidFromQuoteFile, (i) => ({
    projectId: i.projectId,
    tradePackageId: i.packageId,
    quoteText: "Base bid $1",
  })),
  a("files:extractBidFromFile", api.files.extractBidFromFile, (i) => ({
    projectId: i.projectId,
    tradePackageId: i.packageId,
    fileId: i.fileId,
  })),
  a("files:generatePreBidAddendum", api.files.generatePreBidAddendum, (i) => ({ projectId: i.projectId })),
  a("llmRouter:runModelDiagnostic", api.llmRouter.runModelDiagnostic, () => ({ model: "claude", promptType: "spec_div26" })),
  m("projects:createProject", api.projects.createProject, () => projectSetupArgs({ title: "Forged" })),
  m("projects:seedInitialData", api.projects.seedInitialData, () => ({ force: true })),
  m("projects:deleteProject", api.projects.deleteProject, (i) => ({ projectId: i.projectId })),
  m("rfq:reviewEscalatedRfi", api.rfq.reviewEscalatedRfi, (i) => ({ conversationId: i.conversationId, status: "rejected" })),
  a("rfq:generatePreBidAddendum", api.rfq.generatePreBidAddendum, (i) => ({ projectId: i.projectId })),
  a("rfqActions:provisionPackageInbox", api.rfqActions.provisionPackageInbox, (i) => ({
    tradePackageId: i.packageId,
    usernamePrefix: "forged",
  })),
  a("rfqActions:dispatchRfqsWithNotification", api.rfqActions.dispatchRfqsWithNotification, (i) => ({
    tradePackageId: i.packageId,
    recipients: [{ contractorId: i.contractorId, email: "bids@example.test" }],
  })),
  a("rfqActions:dispatchSingleRfqWithNotification", api.rfqActions.dispatchSingleRfqWithNotification, (i) => ({
    contractorId: i.contractorId,
    email: "bids@example.test",
  })),
  m("rfqRecipients:confirmBidderEmail", api.rfqRecipients.confirmBidderEmail, (i) => ({
    contractorId: i.contractorId,
    email: "bids@example.test",
  })),
  m("simulation:triggerJudgeSimulation", api.simulation.triggerJudgeSimulation, (i) => ({
    tradePackageId: i.packageId,
    scenario: "rfi_inquiry",
  })),
  m("simulation:submitCustomRfi", api.simulation.submitCustomRfi, (i) => ({
    tradePackageId: i.packageId,
    subject: "x",
    question: "y",
  })),
  m("simulation:retryRfiAnalysis", api.simulation.retryRfiAnalysis, (i) => ({ conversationId: i.conversationId })),
  m("simulation:runFullProcurementCycle", api.simulation.runFullProcurementCycle, (i) => ({ projectId: i.projectId })),
  m("agreements:generateAgreement", api.agreements.generateAgreement, (i) => ({ bidId: i.bidId, tradePackageId: i.bidPackageId })),
  m("agreements:executeAgreement", api.agreements.executeAgreement, (i) => ({ agreementId: i.agreementId })),
  m("agreements:voidExecutedAgreement", api.agreements.voidExecutedAgreement, (i) => ({ agreementId: i.agreementId, reason: "x" })),
];

const DENIED = /Not authenticated|Forbidden|Not found/;

describe("legacy public mutations and actions are GC-only", () => {
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

  test.each(CASES)("$name rejects non-GC callers and leaves state unchanged", async (c) => {
    const { t, ids, callers } = await setup();
    const before = await snapshot(t);
    for (const [label, caller] of Object.entries(callers)) {
      const args = c.args(ids);
      const call =
        c.kind === "mutation"
          ? caller.mutation(c.fn as FunctionReference<"mutation", "public">, args)
          : caller.action(c.fn as FunctionReference<"action", "public">, args);
      await expect(call, `${c.name} as ${label}`).rejects.toThrow(DENIED);
    }
    expect(await snapshot(t)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("every exported public mutation/action in top-level convex modules is covered here", () => {
    const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const exported: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      if (path.endsWith(".test.ts")) continue;
      const mod = path.replace(/^\.\//, "").replace(/\.ts$/, "");
      for (const match of src.matchAll(/^export const (\w+) = (?:mutation|action)\(/gm)) exported.push(`${mod}:${match[1]}`);
    }
    // agentLinks is GC-guarded and has its own denial tests in agentLinks.test.ts; onboarding is
    // for verified users without a company, covered in onboarding.test.ts. Invites, People and
    // Company settings have their permission and cross-company tests in invites.test.ts. Project
    // settings, archive/restore and company defaults have theirs in projectSetup.test.ts. Agreement
    // terms edits have their party, lock and cross-company tests in agreementTerms.test.ts. Vendor
    // directory writes and directory bidders have theirs in vendors.test.ts. Payee control, billing
    // email and notifications have theirs in payee.test.ts and notifications.test.ts. Bid portal
    // submissions, GC bid entry/confirmation and Q&A publishing have theirs in bidPortal.test.ts.
    // RFI answer sends and addendum acknowledgments have theirs in rfiAnswers.test.ts.
    const covered = new Set([
      ...CASES.map((c) => c.name),
      "agentLinks:addAgentLink",
      "agentLinks:revokeAgentLink",
      "onboarding:createCompany",
      "companies:updateProfile",
      "companies:setMemberRole",
      "companies:removeMember",
      "invites:create",
      "invites:resend",
      "invites:revoke",
      "invites:accept",
      "invites:acceptMine",
      "people:removeProjectMember",
      "projects:updateProject",
      "projects:archiveProject",
      "projects:restoreProject",
      "companies:updateDefaults",
      "agreementTerms:updateAgreementTerms",
      "vendors:createVendor",
      "vendors:updateVendor",
      "vendors:setVendorStatus",
      "vendors:importVendors",
      "contractors:addBiddersFromDirectory",
      "contractors:createVendorBidder",
      "payee:setPayoutEmail",
      "payee:setBillingEmail",
      "payee:confirmPayee",
      "notifications:markRead",
      "notifications:markAllRead",
      "bidPortal:submitPortalBid",
      "bidPortal:askBidQuestion",
      "bidPortal:enterBidOnBehalf",
      "bidPortal:confirmParsedBid",
      "bidPortal:publishQuestion",
      "rfiAnswers:sendRfiAnswer",
      "addenda:acknowledgeAddendum",
    ]);
    expect(exported.filter((name) => !covered.has(name))).toEqual([]);
  });

  test("a GC can still delete a bid", async () => {
    const { t, gc, ids } = await setup();
    await gc.mutation(api.bids.deleteBid, { bidId: ids.bidId });
    expect(await t.run(async (ctx) => await ctx.db.get(ids.bidId))).toBeNull();
  });

  test("a GC can still run the judge simulation and the 1-click cycle", async () => {
    const { gc, ids } = await setup();
    await expect(
      gc.mutation(api.simulation.triggerJudgeSimulation, { tradePackageId: ids.packageId, scenario: "rfi_inquiry" }),
    ).resolves.toBeDefined();
    await expect(gc.mutation(api.simulation.runFullProcurementCycle, { projectId: ids.projectId })).resolves.toBeDefined();
  });
});
