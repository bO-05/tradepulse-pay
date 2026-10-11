/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";
import { api } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import schema from "./schema";
import { bidRowFromDollars } from "./lib/bidMoney";
import { buildTenancyFixture, type FixtureUser, type TenancyFixture } from "./lib/tenancyFixtures";
import { withSession } from "./lib/testIdentity";
import { projectSetupArgs } from "./lib/projectSetupFixture";

/**
 * Cross-company isolation for the procurement surface (architecture §12): another GC company, a
 * user without a company, the Demo company, the project's owner and another sub on the same
 * project all get exactly the "Not found." a missing id produces, and nothing changes.
 */

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRef = FunctionReference<"query" | "mutation" | "action", "public", any, any>;
type Caller = Pick<T, "query" | "mutation" | "action">;

const TABLES = Object.keys(schema.tables) as (keyof typeof schema.tables)[];
const NOT_FOUND = JSON.stringify({ code: "NOT_FOUND", message: "Not found." });

type Ids = {
  projectId: Id<"projects">;
  tradePackageId: Id<"tradePackages">;
  contractorId: Id<"contractors">;
  bidId: Id<"bids">;
  agreementId: Id<"agreements">;
  conversationId: Id<"conversations">;
  fileId: Id<"projectFiles">;
  uploadIntentId: Id<"uploadIntents">;
};

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

async function snapshot(t: T): Promise<string> {
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) out[table] = await ctx.db.query(table).collect();
    return JSON.stringify(out);
  });
}

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "RESOLVED";
  } catch (err) {
    const data = (err as { data?: unknown }).data;
    if (data !== undefined) return typeof data === "string" ? data : JSON.stringify(data);
    return (err as Error).message;
  }
}

async function freshId<N extends TableNames>(t: T, insert: (ctx: Parameters<Parameters<T["run"]>[0]>[0]) => Promise<Id<N>>): Promise<Id<N>> {
  return await t.run(async (ctx) => {
    const id = await insert(ctx);
    await ctx.db.delete(id);
    return id;
  });
}

/** buildTenancyFixture plus a second sub (Lakeshore, Ray) on Bayview's project, an RFI, a stored file and feed entries. */
async function setup() {
  const t = convexTest(schema, modules);
  const fx = await buildTenancyFixture(t);
  const a = fx.gcA.project;
  const extra = await t.run(async (ctx) => {
    const now = Date.now();
    const lakeshore = await ctx.db.insert("companies", { name: "Lakeshore Mechanical", kind: "sub", isDemo: false, createdAt: now });
    const rayId = await ctx.db.insert("users", { email: "ray@lakeshore.test", name: "Ray Ortiz", emailVerificationTime: now });
    await ctx.db.insert("userProfiles", {
      userId: rayId,
      role: "sub",
      displayName: "Ray Ortiz",
      actorType: "human",
      companyId: lakeshore,
      createdAt: now,
    });
    await ctx.db.insert("companyMembers", { companyId: lakeshore, userId: rayId, role: "admin", status: "active", createdAt: now });
    const rayContractor = await ctx.db.insert("contractors", {
      tradePackageId: a.tradePackageId,
      companyName: "Lakeshore Mechanical",
      contactEmail: "bids@lakeshore.invalid",
      licenseNumber: "1",
      licenseStatus: "Unverified",
      sourceUrl: "https://example.invalid",
      rfqStatus: "bid_received",
      linkedCompanyId: lakeshore,
    });
    await ctx.db.insert("bids", bidRowFromDollars({
      tradePackageId: a.tradePackageId,
      contractorId: rayContractor,
      subcontractorName: "Lakeshore Mechanical",
      baseBidAmount: 45_000,
      lineItems: [],
      identifiedExclusions: [],
      longLeadEquipmentWeeks: 4,
      leadTimePenalty: 0,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      leveledTotalCost: 45_000,
      isAwarded: false,
      receivedAt: now,
    }));
    await ctx.db.insert("projectMembers", {
      projectId: a.projectId,
      companyId: lakeshore,
      partyRole: "sub",
      contractorId: rayContractor,
      status: "active",
      createdAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      tradePackageId: a.tradePackageId,
      contractorId: a.contractorId,
      threadId: "thread-eastbay",
      inboundSubject: "Eastbay RFI",
      inboundQuestion: "Who furnishes the switchgear?",
      autonomousReply: "",
      confidenceScore: 0,
      status: "escalated_to_pm",
      timestamp: now,
    });
    const storageId = await ctx.storage.store(new Blob(["%PDF-1.4 bayview spec"], { type: "application/pdf" }));
    const fileId = await ctx.db.insert("projectFiles", {
      projectId: a.projectId,
      tradePackageId: a.tradePackageId,
      storageId,
      fileName: "Bayview spec.pdf",
      fileType: "spec",
      fileSize: 21,
      uploadedBy: "Dana",
      uploadedAt: now,
    });
    const quoteStorage = await ctx.storage.store(new Blob(["%PDF-1.4 eastbay quote"], { type: "application/pdf" }));
    const quoteFileId = await ctx.db.insert("projectFiles", {
      projectId: a.projectId,
      tradePackageId: a.tradePackageId,
      storageId: quoteStorage,
      fileName: "Eastbay quote.pdf",
      fileType: "quote_pdf",
      fileSize: 22,
      uploadedBy: "Dana",
      uploadedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      projectId: a.projectId,
      tradePackageId: a.tradePackageId,
      eventType: "quote_received",
      title: "Eastbay bid received",
      description: "Eastbay Electric bid $40,000",
      actor: "Kim",
      actorUserId: fx.sub.admin.userId,
      actorCompanyId: fx.sub.companyId,
      contractorId: a.contractorId,
      timestamp: now,
    });
    await ctx.db.insert("auditLogs", {
      projectId: a.projectId,
      eventType: "package_created",
      title: "Package created",
      description: "Electrical package",
      actor: "Dana",
      actorUserId: fx.gcA.admin.userId,
      actorCompanyId: fx.gcA.companyId,
      timestamp: now,
    });
    return { lakeshore, rayId, rayContractor, conversationId, fileId, quoteFileId };
  });
  const ray: FixtureUser = {
    userId: extra.rayId,
    email: "ray@lakeshore.test",
    as: await withSession(t, extra.rayId, "ray@lakeshore.test"),
  };
  const bayview: Ids = {
    projectId: a.projectId,
    tradePackageId: a.tradePackageId,
    contractorId: a.contractorId,
    bidId: a.bidId,
    agreementId: a.agreementId,
    conversationId: extra.conversationId,
    fileId: extra.fileId,
    uploadIntentId: await freshId(t, (ctx) =>
      ctx.db.insert("uploadIntents", {
        userId: fx.gcA.admin.userId,
        companyId: fx.gcA.companyId,
        projectId: a.projectId,
        createdAt: 0,
        expiresAt: 0,
      }),
    ),
  };
  const missing: Ids = {
    projectId: await freshId(t, (ctx) =>
      ctx.db.insert("projects", {
        title: "gone",
        location: "x",
        projectType: "x",
        estBudget: 1,
        targetCompletionWeeks: 1,
        specDocumentText: "x",
        isDemoProject: false,
        createdAt: 0,
      }),
    ),
    tradePackageId: await freshId(t, (ctx) =>
      ctx.db.insert("tradePackages", {
        projectId: a.projectId,
        csiDivision: "00",
        tradeName: "gone",
        budgetEstimate: 0,
        agentMailbox: "x",
        agentMailboxId: "x",
        scopeSummary: "x",
        mandatoryInclusions: [],
        bidDeadline: "2026-01-01",
        status: "draft",
      }),
    ),
    contractorId: await freshId(t, (ctx) =>
      ctx.db.insert("contractors", {
        tradePackageId: a.tradePackageId,
        companyName: "gone",
        contactEmail: "x@example.invalid",
        licenseNumber: "0",
        licenseStatus: "x",
        sourceUrl: "https://example.invalid",
        rfqStatus: "discovered",
      }),
    ),
    bidId: await freshId(t, (ctx) =>
      ctx.db.insert("bids", bidRowFromDollars({
        tradePackageId: a.tradePackageId,
        contractorId: a.contractorId,
        subcontractorName: "gone",
        baseBidAmount: 1,
        lineItems: [],
        identifiedExclusions: [],
        longLeadEquipmentWeeks: 0,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: 1,
        isAwarded: false,
        receivedAt: 0,
      })),
    ),
    agreementId: await t.run(async (ctx) => {
      const src = (await ctx.db.get(a.agreementId))!;
      const { _id, _creationTime, ...fields } = src;
      void _id;
      void _creationTime;
      const id = await ctx.db.insert("agreements", fields);
      await ctx.db.delete(id);
      return id;
    }),
    conversationId: await freshId(t, (ctx) =>
      ctx.db.insert("conversations", {
        tradePackageId: a.tradePackageId,
        contractorId: a.contractorId,
        threadId: "gone",
        inboundSubject: "gone",
        inboundQuestion: "gone",
        autonomousReply: "",
        confidenceScore: 0,
        status: "pending_analysis",
        timestamp: 0,
      }),
    ),
    fileId: await freshId(t, (ctx) =>
      ctx.db.insert("projectFiles", {
        projectId: a.projectId,
        storageId: "gone",
        fileName: "gone",
        fileType: "spec",
        fileSize: 0,
        uploadedBy: "x",
        uploadedAt: 0,
      }),
    ),
    uploadIntentId: bayview.uploadIntentId,
  };
  return { t, fx, ray, bayview, missing, extra };
}

type Case = { name: string; kind: "query" | "mutation" | "action"; fn: AnyRef; args: (i: Ids) => Record<string, unknown> };
const q = (name: string, fn: AnyRef, args: Case["args"]): Case => ({ name, kind: "query", fn, args });
const m = (name: string, fn: AnyRef, args: Case["args"]): Case => ({ name, kind: "mutation", fn, args });
const a = (name: string, fn: AnyRef, args: Case["args"]): Case => ({ name, kind: "action", fn, args });

function call(caller: Caller, c: Case, ids: Ids): Promise<unknown> {
  if (c.kind === "query") return caller.query(c.fn as FunctionReference<"query", "public">, c.args(ids));
  if (c.kind === "mutation") return caller.mutation(c.fn as FunctionReference<"mutation", "public">, c.args(ids));
  return caller.action(c.fn as FunctionReference<"action", "public">, c.args(ids));
}

/** Functions on a Bayview id; every caller outside the allowed parties must get the missing-id error. */
const GC_ONLY: Case[] = [
  q("tradePackages:getPackage (owner allowed)", api.tradePackages.getPackage, (i) => ({ tradePackageId: i.tradePackageId })),
  q("tradePackages:listByProject (owner allowed)", api.tradePackages.listByProject, (i) => ({ projectId: i.projectId })),
  m("tradePackages:createTradePackage", api.tradePackages.createTradePackage, (i) => ({
    projectId: i.projectId,
    csiDivision: "09 00 00",
    tradeName: "Forged",
    budgetEstimate: 1000,
    scopeSummary: "x",
    mandatoryInclusions: [],
    bidDeadline: "2026-12-01",
  })),
  m("tradePackages:updateBidDue", api.tradePackages.updateBidDue, (i) => ({ tradePackageId: i.tradePackageId, bidDeadline: "2026-12-01", bidDueTime: "14:00" })),
  m("tradePackages:updateStatus", api.tradePackages.updateStatus, (i) => ({ tradePackageId: i.tradePackageId, status: "draft" })),
  m("tradePackages:deleteTradePackage", api.tradePackages.deleteTradePackage, (i) => ({ tradePackageId: i.tradePackageId })),
  a("tradePackages:generateTradePackagesFromSpec", api.tradePackages.generateTradePackagesFromSpec, (i) => ({ projectId: i.projectId })),
  q("contractors:listByPackage", api.contractors.listByPackage, (i) => ({ tradePackageId: i.tradePackageId })),
  q("contractors:listByProject", api.contractors.listByProject, (i) => ({ projectId: i.projectId })),
  m("contractors:createContractor", api.contractors.createContractor, (i) => ({
    tradePackageId: i.tradePackageId,
    companyName: "Forged LLC",
    contactEmail: "forged@example.com",
    licenseNumber: "X",
    licenseStatus: "Active",
    sourceUrl: "https://example.com",
    rfqStatus: "invited",
  })),
  m("contractors:updateRfqStatus", api.contractors.updateRfqStatus, (i) => ({ contractorId: i.contractorId, rfqStatus: "invited" })),
  m("contractors:updateContractor", api.contractors.updateContractor, (i) => ({
    contractorId: i.contractorId,
    companyName: "Renamed",
    contactEmail: "renamed@example.com",
    licenseNumber: "X",
    licenseStatus: "Active",
    sourceUrl: "https://example.com",
  })),
  m("contractors:deleteContractor", api.contractors.deleteContractor, (i) => ({ contractorId: i.contractorId })),
  a("contractorDiscovery:discoverSubcontractors", api.contractorDiscovery.discoverSubcontractors, (i) => ({ tradePackageId: i.tradePackageId })),
  q("bids:listByPackage", api.bids.listByPackage, (i) => ({ tradePackageId: i.tradePackageId })),
  q("bids:listAllProjectBids", api.bids.listAllProjectBids, (i) => ({ projectId: i.projectId })),
  q("bids:getLevelingSummary", api.bids.getLevelingSummary, (i) => ({ tradePackageId: i.tradePackageId })),
  m("bids:setExclusionPlug", api.bids.setExclusionPlug, (i) => ({ bidId: i.bidId, exclusionIndex: 0, amountCents: 1_500_000 })),
  m("bids:awardContract", api.bids.awardContract, (i) => ({ bidId: i.bidId, tradePackageId: i.tradePackageId })),
  m("bids:unawardContract", api.bids.unawardContract, (i) => ({ bidId: i.bidId, tradePackageId: i.tradePackageId })),
  m("bids:deleteBid", api.bids.deleteBid, (i) => ({ bidId: i.bidId })),
  m("bids:updateBidLeveling", api.bids.updateBidLeveling, (i) => ({ bidId: i.bidId, baseAmountCents: 100 })),
  m("bids:updateBidAdjustments", api.bids.updateBidAdjustments, (i) => ({ bidId: i.bidId, identifiedExclusions: [] })),
  m("bids:submitDirectBid", api.bids.submitDirectBid, (i) => ({
    tradePackageId: i.tradePackageId,
    contractorId: i.contractorId,
    subcontractorName: "Forged Sub",
    baseAmountCents: 100_000,
  })),
  m("agreements:generateAgreement", api.agreements.generateAgreement, (i) => ({ bidId: i.bidId, tradePackageId: i.tradePackageId })),
  m("agreements:generateAgreement (with alternates)", api.agreements.generateAgreement, (i) => ({
    bidId: i.bidId,
    tradePackageId: i.tradePackageId,
    acceptedAlternateIndexes: [0],
  })),
  m("agreements:executeAgreement", api.agreements.executeAgreement, (i) => ({ agreementId: i.agreementId })),
  m("agreements:voidExecutedAgreement", api.agreements.voidExecutedAgreement, (i) => ({
    agreementId: i.agreementId,
    reason: "Forged void reason",
  })),
  q("agreements:getAgreementByBid", api.agreements.getAgreementByBid, (i) => ({ bidId: i.bidId })),
  q("agreements:getAgreementByPackage", api.agreements.getAgreementByPackage, (i) => ({ tradePackageId: i.tradePackageId })),
  q("files:listFilesByProject (owner allowed)", api.files.listFilesByProject, (i) => ({ projectId: i.projectId })),
  q("files:listFilesByPackage (owner allowed)", api.files.listFilesByPackage, (i) => ({ tradePackageId: i.tradePackageId })),
  m("files:saveFileRecord", api.files.saveFileRecord, (i) => ({
    projectId: i.projectId,
    uploadIntentId: i.uploadIntentId,
    storageId: "kg2forgedstorageid",
    fileName: "forged.pdf",
    fileType: "spec",
    fileSize: 1,
    uploadedBy: "attacker",
  })),
  m("files:deleteFile", api.files.deleteFile, (i) => ({ fileId: i.fileId })),
  a("files:extractBidFromQuoteFile", api.files.extractBidFromQuoteFile, (i) => ({
    projectId: i.projectId,
    tradePackageId: i.tradePackageId,
    quoteText: "Base bid $1",
  })),
  a("files:extractBidFromFile", api.files.extractBidFromFile, (i) => ({
    projectId: i.projectId,
    tradePackageId: i.tradePackageId,
    fileId: i.fileId,
  })),
  a("files:generatePreBidAddendum", api.files.generatePreBidAddendum, (i) => ({ projectId: i.projectId })),
  q("rfq:getProjectDeliveryStatus", api.rfq.getProjectDeliveryStatus, (i) => ({ projectId: i.projectId })),
  m("rfq:reviewEscalatedRfi", api.rfq.reviewEscalatedRfi, (i) => ({ conversationId: i.conversationId, status: "rejected" })),
  a("rfq:generatePreBidAddendum", api.rfq.generatePreBidAddendum, (i) => ({ projectId: i.projectId })),
  a("rfqActions:provisionPackageInbox", api.rfqActions.provisionPackageInbox, (i) => ({
    tradePackageId: i.tradePackageId,
    usernamePrefix: "forged",
  })),
  a("rfqActions:dispatchRfqsWithNotification", api.rfqActions.dispatchRfqsWithNotification, (i) => ({
    tradePackageId: i.tradePackageId,
    recipients: [{ contractorId: i.contractorId, email: "bids@example.test" }],
  })),
  a("rfqActions:dispatchSingleRfqWithNotification", api.rfqActions.dispatchSingleRfqWithNotification, (i) => ({
    contractorId: i.contractorId,
    email: "bids@example.test",
  })),
  q("coordination:detectCrossTradeClashes", api.coordination.detectCrossTradeClashes, (i) => ({ projectId: i.projectId })),
  m("coordination:deductDoubleBuyCredit", api.coordination.deductDoubleBuyCredit, (i) => ({
    projectId: i.projectId,
    clashId: "c1",
    tradePackageId: i.tradePackageId,
    deductAmount: 100,
    description: "x",
  })),
  m("coordination:reverseDoubleBuyCredit", api.coordination.reverseDoubleBuyCredit, (i) => ({
    projectId: i.projectId,
    clashId: "c1",
    tradePackageId: i.tradePackageId,
  })),
  m("coordination:assignScopeVoidToTrade", api.coordination.assignScopeVoidToTrade, (i) => ({
    projectId: i.projectId,
    voidId: "v1",
    tradePackageId: i.tradePackageId,
    additionalCost: 100,
    description: "x",
  })),
  a("coordination:scanCrossTradeClashes", api.coordination.scanCrossTradeClashes, (i) => ({ projectId: i.projectId })),
  a("coordination:extractDynamicClashes", api.coordination.extractDynamicClashes, (i) => ({ projectId: i.projectId })),
  m("crons:runDeadlineMonitorNow", api.crons.runDeadlineMonitorNow, (i) => ({ projectId: i.projectId })),
  m("crons:runComplianceAuditNow", api.crons.runComplianceAuditNow, (i) => ({ projectId: i.projectId })),
  m("simulation:triggerJudgeSimulation", api.simulation.triggerJudgeSimulation, (i) => ({
    tradePackageId: i.tradePackageId,
    scenario: "rfi_inquiry",
  })),
  m("simulation:submitCustomRfi", api.simulation.submitCustomRfi, (i) => ({ tradePackageId: i.tradePackageId, subject: "x", question: "y" })),
  m("simulation:retryRfiAnalysis", api.simulation.retryRfiAnalysis, (i) => ({ conversationId: i.conversationId })),
  m("simulation:runFullProcurementCycle", api.simulation.runFullProcurementCycle, (i) => ({ projectId: i.projectId })),
  m("projects:deleteProject", api.projects.deleteProject, (i) => ({ projectId: i.projectId })),
];

/** Reads every party on the project may call (results are filtered per party). */
const PARTY_READS: Case[] = [
  q("projects:getProject", api.projects.getProject, (i) => ({ projectId: i.projectId })),
  q("agreements:listAgreements", api.agreements.listAgreements, (i) => ({ projectId: i.projectId })),
  q("rfq:listConversations", api.rfq.listConversations, (i) => ({ tradePackageId: i.tradePackageId })),
];

const OWNER_ALLOWED = new Set(GC_ONLY.filter((c) => c.name.includes("(owner allowed)")).map((c) => c.name));

function outsiders(fx: TenancyFixture): [string, Caller][] {
  return [
    ["other GC company (Sonoran)", fx.gcB.admin.as],
    ["no company", fx.noCompany.as],
    ["Demo company GC", fx.demo.gc.as],
  ];
}

describe("another company's ids read exactly like missing ids", () => {
  test.each([...GC_ONLY, ...PARTY_READS])("$name", async (c) => {
    const { t, fx, bayview, missing } = await setup();
    const before = await snapshot(t);
    for (const [label, caller] of outsiders(fx)) {
      const forbidden = await outcome(call(caller, c, bayview));
      const absent = await outcome(call(caller, c, missing));
      expect(forbidden, `${c.name} as ${label}`).toBe(NOT_FOUND);
      expect(absent, `${c.name} as ${label} (missing id)`).toBe(NOT_FOUND);
    }
    expect(await outcome(call(fx.gcA.admin.as, c, missing)), `${c.name} as Dana (missing id)`).toBe(NOT_FOUND);
    expect(await snapshot(t)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a foreign secondary id next to the caller's own primary id reads like a missing one", () => {
  const MIXED: { name: string; run: (c: Caller, own: Ids, secondary: Ids) => Promise<unknown> }[] = [
    {
      name: "coordination:deductDoubleBuyCredit bidId",
      run: (c, own, s) =>
        c.mutation(api.coordination.deductDoubleBuyCredit, {
          projectId: own.projectId,
          clashId: "c1",
          tradePackageId: own.tradePackageId,
          deductAmount: 100,
          description: "x",
          bidId: s.bidId,
        }),
    },
    {
      name: "coordination:assignScopeVoidToTrade bidId",
      run: (c, own, s) =>
        c.mutation(api.coordination.assignScopeVoidToTrade, {
          projectId: own.projectId,
          voidId: "v1",
          tradePackageId: own.tradePackageId,
          additionalCost: 100,
          description: "x",
          bidId: s.bidId,
        }),
    },
    {
      name: "simulation:submitCustomRfi contractorId",
      run: (c, own, s) =>
        c.mutation(api.simulation.submitCustomRfi, {
          tradePackageId: own.tradePackageId,
          contractorId: s.contractorId,
          subject: "x",
          question: "y",
        }),
    },
  ];

  test.each(MIXED)("$name", async (c) => {
    const { t, fx, bayview, missing } = await setup();
    const foreign = { ...missing, bidId: fx.gcB.project.bidId, contractorId: fx.gcB.project.contractorId };
    const before = await snapshot(t);
    expect(await outcome(c.run(fx.gcA.admin.as, bayview, foreign)), "foreign secondary id").toBe(NOT_FOUND);
    expect(await outcome(c.run(fx.gcA.admin.as, bayview, missing)), "missing secondary id").toBe(NOT_FOUND);
    expect(await snapshot(t)).toBe(before);
  });
});

describe("parties on the project without the GC role get the same Not found", () => {
  test.each(GC_ONLY)("$name", async (c) => {
    const { t, fx, ray, bayview } = await setup();
    const before = await snapshot(t);
    const callers: [string, Caller][] = [
      ["Eastbay sub (Kim)", fx.sub.admin.as],
      ["Lakeshore sub (Ray)", ray.as],
    ];
    if (!OWNER_ALLOWED.has(c.name)) callers.push(["owner (Harbor Point)", fx.owner.admin.as]);
    for (const [label, caller] of callers) {
      expect(await outcome(call(caller, c, bayview)), `${c.name} as ${label}`).toBe(NOT_FOUND);
    }
    expect(await snapshot(t)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the owning GC company still works (control)", () => {
  test("Dana reads the project, packages, bidders, bids, agreements, files and feed", async () => {
    const { fx, bayview } = await setup();
    const dana = fx.gcA.admin.as;
    expect((await dana.query(api.projects.getProject, { projectId: bayview.projectId }))?.title).toBe("Harbor Point Dental Office TI");
    expect(await dana.query(api.tradePackages.listByProject, { projectId: bayview.projectId })).toHaveLength(1);
    expect(await dana.query(api.contractors.listByPackage, { tradePackageId: bayview.tradePackageId })).toHaveLength(2);
    expect(await dana.query(api.bids.listByPackage, { tradePackageId: bayview.tradePackageId })).toHaveLength(2);
    expect(await dana.query(api.agreements.listAgreements, { projectId: bayview.projectId })).toHaveLength(1);
    expect(await dana.query(api.files.listFilesByProject, { projectId: bayview.projectId })).toHaveLength(2);
    expect(await dana.query(api.rfq.listConversations, { tradePackageId: bayview.tradePackageId })).toHaveLength(1);
    const feed = await dana.query(api.auditLogs.listRecentLogs, { projectId: bayview.projectId });
    expect(feed.map((l) => l.title).sort()).toEqual(["Eastbay bid received", "Package created"]);
  });

  test("Dana's writes succeed and the audit entry names her, not a job title", async () => {
    const { t, fx, bayview } = await setup();
    await fx.gcA.admin.as.mutation(api.tradePackages.updateStatus, { tradePackageId: bayview.tradePackageId, status: "leveling" });
    const pkg = await t.run((ctx) => ctx.db.get(bayview.tradePackageId));
    expect(pkg?.status).toBe("leveling");
    await fx.gcA.admin.as.mutation(api.tradePackages.createTradePackage, {
      projectId: bayview.projectId,
      csiDivision: "09 00 00",
      tradeName: "Finishes",
      budgetEstimate: 1000,
      scopeSummary: "Paint and drywall",
      mandatoryInclusions: [],
      bidDeadline: "2026-12-01",
    });
    await fx.gcA.admin.as.mutation(api.crons.runComplianceAuditNow, { projectId: bayview.projectId });
    const logs = await t.run((ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_project", (q) => q.eq("projectId", bayview.projectId))
        .collect(),
    );
    const mine = logs.filter((l) => l.actorUserId === fx.gcA.admin.userId && l.title !== "Package created");
    expect(mine.length).toBe(2);
    for (const l of mine) {
      expect(l.actor).toBe("dana@bayview.test");
      expect(l.actorCompanyId).toBe(fx.gcA.companyId);
    }
  });

  test("Sonoran's own ids work for Sonoran (control for the denials above)", async () => {
    const { fx } = await setup();
    const b = fx.gcB.project;
    const priya = fx.gcB.admin.as;
    expect((await priya.query(api.projects.getProject, { projectId: b.projectId }))?.title).toBe("Camelback Suite 400");
    expect(await priya.query(api.bids.listByPackage, { tradePackageId: b.tradePackageId })).toHaveLength(1);
    await priya.mutation(api.tradePackages.updateStatus, { tradePackageId: b.tradePackageId, status: "leveling" });
    await priya.mutation(api.contractors.updateRfqStatus, { contractorId: b.contractorId, rfqStatus: "invited" });
  });
});

describe("project lists and switchers", () => {
  test("each company lists only its own projects", async () => {
    const { fx, ray } = await setup();
    const titles = async (c: Caller) => (await c.query(api.projects.listProjects, {})).map((p) => p.title).sort();
    expect(await titles(fx.gcA.admin.as)).toEqual(["Harbor Point Dental Office TI"]);
    expect(await titles(fx.gcA.member.as)).toEqual(["Harbor Point Dental Office TI"]);
    expect(await titles(fx.gcB.admin.as)).toEqual(["Camelback Suite 400"]);
    expect(await titles(fx.sub.admin.as)).toEqual(["Harbor Point Dental Office TI"]);
    expect(await titles(ray.as)).toEqual(["Harbor Point Dental Office TI"]);
    expect(await titles(fx.owner.admin.as)).toEqual(["Harbor Point Dental Office TI"]);
    expect(await titles(fx.demo.gc.as)).toEqual(["Demo fixture project"]);
    expect(await titles(fx.noCompany.as)).toEqual([]);
  });

  test("getDemoProject and ownerOverview never return another company's project", async () => {
    const { fx } = await setup();
    expect((await fx.gcB.admin.as.query(api.projects.getDemoProject, {}))?.title).toBe("Camelback Suite 400");
    expect(await fx.noCompany.as.query(api.projects.getDemoProject, {})).toBeNull();
    const overview = await fx.gcB.admin.as.query(api.portal.ownerOverview, {});
    expect(overview.map((p) => p.title)).toEqual(["Camelback Suite 400"]);
    const ownerView = await fx.owner.admin.as.query(api.portal.ownerOverview, {});
    expect(ownerView.map((p) => p.title)).toEqual(["Harbor Point Dental Office TI"]);
  });

  test("archived projects are hidden unless asked for", async () => {
    const { t, fx } = await setup();
    await t.run((ctx) => ctx.db.patch(fx.gcA.project.projectId, { archived: true }));
    expect(await fx.gcA.admin.as.query(api.projects.listProjects, {})).toEqual([]);
    expect(await fx.gcA.admin.as.query(api.projects.listProjects, { includeArchived: true })).toHaveLength(1);
  });
});

describe("createProject takes the company from the session", () => {
  test("a client-supplied gcCompanyId is rejected and the new project belongs to the caller's company", async () => {
    const { t, fx } = await setup();
    const base = { ...projectSetupArgs({ title: "Bayview new build" }), isDemoProject: true };
    await expect(
      fx.gcA.admin.as.mutation(api.projects.createProject, { ...base, gcCompanyId: fx.gcB.companyId } as typeof base),
    ).rejects.toThrow();
    const id = await fx.gcA.admin.as.mutation(api.projects.createProject, base);
    const row = await t.run((ctx) => ctx.db.get(id as Id<"projects">));
    expect(row?.gcCompanyId).toBe(fx.gcA.companyId);
    expect(row?.isDemoProject).toBe(false);
    expect((await fx.gcB.admin.as.query(api.projects.listProjects, {})).map((p) => p.title)).toEqual(["Camelback Suite 400"]);
  });

  test("users without a GC company cannot create projects", async () => {
    const { fx } = await setup();
    const args = projectSetupArgs({ title: "x" });
    await expect(fx.noCompany.as.mutation(api.projects.createProject, args)).rejects.toThrow(/company/i);
    await expect(fx.sub.admin.as.mutation(api.projects.createProject, args)).rejects.toThrow();
    await expect(fx.owner.admin.as.mutation(api.projects.createProject, args)).rejects.toThrow();
  });
});

describe("subs see only their own vendor's records; owners never see bids", () => {
  test("Ray cannot read or act on Eastbay's agreement, bid or RFI; Kim sees only Eastbay's", async () => {
    const { t, fx, ray, bayview } = await setup();
    const before = await snapshot(t);
    expect(await ray.as.query(api.agreements.listAgreements, { projectId: bayview.projectId })).toEqual([]);
    expect(await ray.as.query(api.rfq.listConversations, { tradePackageId: bayview.tradePackageId })).toEqual([]);
    expect(await ray.as.query(api.portal.getAgreementSummary, { agreementId: bayview.agreementId })).toBeNull();
    const rayPortal = await ray.as.query(api.portal.mySubPortal, {});
    expect(rayPortal.agreements).toEqual([]);
    expect(await snapshot(t)).toBe(before);

    const kimAgreements = await fx.sub.admin.as.query(api.agreements.listAgreements, { projectId: bayview.projectId });
    expect(kimAgreements.map((x) => x._id)).toEqual([bayview.agreementId]);
    const kimPortal = await fx.sub.admin.as.query(api.portal.mySubPortal, {});
    expect(kimPortal.agreements.map((x) => x._id)).toEqual([bayview.agreementId]);
    expect(await fx.sub.admin.as.query(api.rfq.listConversations, { tradePackageId: bayview.tradePackageId })).toHaveLength(1);
    expect((await fx.sub.admin.as.query(api.portal.getAgreementSummary, { agreementId: bayview.agreementId }))?._id).toBe(
      bayview.agreementId,
    );
  });

  test("another company's sub and GC get null from getAgreementSummary, like a missing id", async () => {
    const { fx, bayview, missing } = await setup();
    for (const caller of [fx.gcB.admin.as, fx.noCompany.as, fx.demo.gc.as]) {
      expect(await caller.query(api.portal.getAgreementSummary, { agreementId: bayview.agreementId })).toBeNull();
      expect(await caller.query(api.portal.getAgreementSummary, { agreementId: missing.agreementId })).toBeNull();
    }
  });

  test("the owner reads the project and packages but no bids, bidders, leveling or quotes", async () => {
    const { fx, bayview } = await setup();
    const owner = fx.owner.admin.as;
    expect((await owner.query(api.projects.getProject, { projectId: bayview.projectId }))?._id).toBe(bayview.projectId);
    expect(await owner.query(api.tradePackages.listByProject, { projectId: bayview.projectId })).toHaveLength(1);
    for (const p of [
      owner.query(api.bids.listByPackage, { tradePackageId: bayview.tradePackageId }),
      owner.query(api.bids.listAllProjectBids, { projectId: bayview.projectId }),
      owner.query(api.contractors.listByPackage, { tradePackageId: bayview.tradePackageId }),
      owner.query(api.coordination.detectCrossTradeClashes, { projectId: bayview.projectId }),
      owner.query(api.rfq.listConversations, { tradePackageId: bayview.tradePackageId }),
    ]) {
      expect(await outcome(p)).toBe(NOT_FOUND);
    }
    const files = await owner.query(api.files.listFilesByProject, { projectId: bayview.projectId });
    expect(files.map((f) => f.fileName)).toEqual(["Bayview spec.pdf"]);
  });
});

describe("activity feeds never mix companies or vendors", () => {
  test("Dana sees the whole project; Priya, Ray and outsiders see none of it; the owner sees no bid events", async () => {
    const { fx, ray, bayview } = await setup();
    const titles = async (c: Caller, args: { projectId?: Id<"projects"> } = {}) =>
      (await c.query(api.auditLogs.listRecentLogs, args)).map((l) => l.title).sort();
    expect(await titles(fx.gcA.admin.as, { projectId: bayview.projectId })).toEqual(["Eastbay bid received", "Package created"]);
    expect(await titles(fx.gcA.admin.as)).toEqual(["Eastbay bid received", "Package created"]);
    expect(await outcome(fx.gcB.admin.as.query(api.auditLogs.listRecentLogs, { projectId: bayview.projectId }))).toBe(NOT_FOUND);
    expect(await outcome(fx.demo.gc.as.query(api.auditLogs.listRecentLogs, { projectId: bayview.projectId }))).toBe(NOT_FOUND);
    expect(await titles(fx.gcB.admin.as)).toEqual([]);
    expect(await titles(fx.demo.gc.as)).toEqual([]);
    expect(await titles(ray.as, { projectId: bayview.projectId })).toEqual([]);
    expect(await titles(fx.sub.admin.as, { projectId: bayview.projectId })).toEqual(["Eastbay bid received"]);
    expect(await titles(fx.owner.admin.as, { projectId: bayview.projectId })).toEqual(["Package created"]);
  });
});

describe("authenticated project file download", () => {
  const path = (id: string) => `/api/project-files/${id}`;

  test("Dana gets the bytes; Priya, Ray (for a competitor's quote) and missing ids get the same 404; no token gets 401", async () => {
    const { t, fx, ray, bayview, missing, extra } = await setup();
    const ok = await fx.gcA.admin.as.fetch(path(bayview.fileId), { method: "GET" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("application/pdf");
    expect(await ok.text()).toBe("%PDF-1.4 bayview spec");

    const denied = await fx.gcB.admin.as.fetch(path(bayview.fileId), { method: "GET" });
    const absent = await fx.gcA.admin.as.fetch(path(missing.fileId), { method: "GET" });
    const garbage = await fx.gcA.admin.as.fetch(path("not-an-id"), { method: "GET" });
    for (const r of [denied, absent, garbage]) {
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("Not found.");
    }
    // Ray bids on the package, so its spec is a bid document for him; Eastbay's quote never is.
    expect((await ray.as.fetch(path(bayview.fileId), { method: "GET" })).status).toBe(200);
    expect((await ray.as.fetch(path(extra.quoteFileId), { method: "GET" })).status).toBe(404);
    expect((await fx.sub.admin.as.fetch(path(extra.quoteFileId), { method: "GET" })).status).toBe(404);
    expect((await fx.owner.admin.as.fetch(path(extra.quoteFileId), { method: "GET" })).status).toBe(404);
    expect((await fx.owner.admin.as.fetch(path(bayview.fileId), { method: "GET" })).status).toBe(200);
    expect((await t.fetch(path(bayview.fileId), { method: "GET" })).status).toBe(401);
  });

  test("file lists expose a download route, never a raw storage URL", async () => {
    const { fx, bayview } = await setup();
    const files = await fx.gcA.admin.as.query(api.files.listFilesByProject, { projectId: bayview.projectId });
    for (const f of files) {
      expect(f.url).toBeNull();
      expect(f.downloadPath).toBe(`/api/project-files/${f._id}`);
      expect(JSON.stringify(f)).not.toMatch(/\/api\/storage\//);
    }
  });
});

describe("Demo-only diagnostics", () => {
  test("eval runs and traces are visible to the Demo company only", async () => {
    const { fx } = await setup();
    expect(await outcome(fx.demo.gc.as.query(api.evals.getLatestEvalRun, {}))).toBe("RESOLVED");
    for (const caller of [fx.gcA.admin.as, fx.gcB.admin.as, fx.noCompany.as]) {
      expect(await outcome(caller.query(api.evals.getLatestEvalRun, {}))).toBe(NOT_FOUND);
      expect(await outcome(caller.query(api.evals.listTracesForRun, { runId: "eval_1" }))).toBe(NOT_FOUND);
      expect(await outcome(caller.mutation(api.projects.seedInitialData, { force: false }))).toBe(NOT_FOUND);
      expect(await outcome(caller.mutation(api.files.repairSeededDocumentSizes, {}))).toBe(NOT_FOUND);
    }
  });

  test("the Demo company cannot read a real company's traces by run id", async () => {
    const { t, fx } = await setup();
    const trace = (runId: string, caseId: string, rawPrompt: string) => ({
      runId,
      caseId,
      csiDivision: "26",
      contractorName: "x",
      provider: "Anthropic",
      model: "m",
      rawPrompt,
      rawResponse: "r",
      parsedOutput: null,
      groundTruth: null,
      metrics: null,
      status: "AGENT_PROPOSED",
      latencyMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      timestamp: 1,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("agentTraces", trace("pay_agent_bayview_1", "bayview-pay-app", "Bayview secret prompt"));
      await ctx.db.insert("agentTraces", trace("eval_demo_1", "case-26-01", "fixture prompt"));
      await ctx.db.insert("evalRuns", {
        runId: "eval_demo_1",
        targetEnvironment: "dev",
        triggeredBy: "test",
        totalCases: 1,
        passedCases: 1,
        scopeRecallAvg: 1,
        scopePrecisionAvg: 1,
        leveledCostMape: 0,
        veAccuracyAvg: 1,
        coiF1Score: 1,
        clashRecallAvg: 1,
        aiaConformityAvg: 1,
        overallScore: 1,
        totalDurationMs: 1,
        createdAt: 1,
      });
    });
    expect(await fx.demo.gc.as.query(api.evals.listTracesForRun, { runId: "pay_agent_bayview_1" })).toEqual([]);
    const own = await fx.demo.gc.as.query(api.evals.listTracesForRun, { runId: "eval_demo_1" });
    expect(own.map((r) => r.rawPrompt)).toEqual(["fixture prompt"]);
  });
});
