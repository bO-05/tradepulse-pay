/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { agentIdProfile, syncAgentProfile } from "./lib/agentAccess";
import { bidRowFromDollars } from "./lib/bidMoney";
import { buildTenancyFixture } from "./lib/tenancyFixtures";
import { withSession } from "./lib/testIdentity";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Caller = Pick<T, "query" | "mutation" | "action" | "fetch">;

const TABLES = Object.keys(schema.tables) as (keyof typeof schema.tables)[];
const NOT_FOUND = JSON.stringify({ code: "NOT_FOUND", message: "Not found." });
const LINKED_AGENT_EMAIL = "boldlevel182@agentmail.to";

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

async function errorData(p: Promise<unknown>): Promise<{ code?: string; message?: string; field?: string }> {
  try {
    await p;
  } catch (err) {
    return ((err as { data?: unknown }).data ?? {}) as { code?: string; message?: string; field?: string };
  }
  throw new Error("expected the call to fail");
}

const BID = {
  baseAmountCents: 17_490_000,
  alternates: [
    { description: "Alt 1 – LED troffer upgrade", amountCents: 625_000 },
    { description: "Alt 2 – Generator transfer switch", amountCents: 1_180_000 },
  ],
  exclusions: ["Permit fees", "Low-voltage cabling (27 00 00)"],
  inclusions: ["Temporary power", "Fire alarm rough-in"],
  unitPrices: [{ item: "Additional duplex receptacle", unit: "each", unitPriceCents: 18_500 }],
  qualifications: "Work during normal hours; one mobilization.",
  validUntil: "2099-12-31",
};

/**
 * Bayview's open Electrical package on the fixture project: Eastbay (Kim) and Northbay (Nia) are
 * invited sub companies, Oakland has an AI-parsed emailed bid, Golden Gate has no bid yet, and
 * Lakeshore (Ray) is a sub on the project that is not invited to this package.
 */
async function setup() {
  const t = convexTest(schema, modules);
  const fx = await buildTenancyFixture(t);
  const a = fx.gcA.project;
  await fx.gcA.admin.as.mutation(api.agentLinks.addAgentLink, { agentEmail: LINKED_AGENT_EMAIL, contractorId: a.contractorId });
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const sub = async (name: string, email: string, person: string) => {
      const companyId = await ctx.db.insert("companies", { name, kind: "sub", isDemo: false, createdAt: now });
      const userId = await ctx.db.insert("users", { email, name: person, emailVerificationTime: now });
      await ctx.db.insert("userProfiles", { userId, role: "sub", displayName: person, actorType: "human", companyId, createdAt: now });
      await ctx.db.insert("companyMembers", { companyId, userId, role: "admin", status: "active", createdAt: now });
      return { companyId, userId };
    };
    const vendor = async (name: string, tradePackageId: Id<"tradePackages">, linkedCompanyId?: Id<"companies">) =>
      await ctx.db.insert("contractors", {
        tradePackageId,
        companyName: name,
        contactEmail: `bids@${name.split(" ")[0].toLowerCase()}.invalid`,
        licenseNumber: "1",
        licenseStatus: "Unverified",
        sourceUrl: "https://example.invalid",
        rfqStatus: "rfq_sent",
        ...(linkedCompanyId ? { linkedCompanyId } : {}),
      });
    const packageId = await ctx.db.insert("tradePackages", {
      projectId: a.projectId,
      csiDivision: "26 00 00",
      tradeName: "Electrical",
      budgetEstimate: 165_000,
      agentMailbox: "fixture@example.invalid",
      agentMailboxId: "fixture",
      scopeSummary: "Complete electrical for the dental suite: lighting, power, panels.",
      mandatoryInclusions: ["Temporary power"],
      bidDeadline: "2099-06-15T17:00:00.000Z",
      status: "rfqs_dispatched",
    });
    const northbay = await sub("Northbay Electric", "nia@northbay.test", "Nia Park");
    const northbayContractor = await vendor("Northbay Electric", a.tradePackageId, northbay.companyId);
    const lakeshore = await sub("Lakeshore Mechanical", "ray@lakeshore.test", "Ray Ortiz");
    const lakeshoreContractor = await vendor("Lakeshore Mechanical", a.tradePackageId, lakeshore.companyId);
    for (const [companyId, contractorId] of [
      [northbay.companyId, northbayContractor],
      [lakeshore.companyId, lakeshoreContractor],
    ] as const) {
      await ctx.db.insert("projectMembers", { projectId: a.projectId, companyId, partyRole: "sub", contractorId, status: "active", createdAt: now });
    }
    await ctx.db.patch(packageId, { invitedContractorIds: [a.contractorId, northbayContractor] });
    const oakland = await vendor("Oakland Power & Light", packageId);
    const goldenGate = await vendor("Golden Gate Electric", packageId);
    const emailId = await ctx.db.insert("inboundEmails", {
      eventId: "evt-oak",
      messageId: "msg-oak",
      inboxId: "inbox",
      threadId: "thread-oak",
      from: "bids@oakland.invalid",
      subject: "Re: RFQ Electrical",
      text: "Base bid $158,900.00. Excludes permit fees.",
      routing: "routed",
      matchMethod: "thread",
      projectId: a.projectId,
      companyId: fx.gcA.companyId,
      tradePackageId: packageId,
      contractorId: oakland,
      receivedAt: now,
    });
    const oaklandBid = await ctx.db.insert("bids", {
      ...bidRowFromDollars({
        tradePackageId: packageId,
        contractorId: oakland,
        subcontractorName: "Oakland Power & Light",
        baseBidAmount: 158_900,
        lineItems: [],
        identifiedExclusions: [{ description: "Permit fees", costImpact: 0, severity: "moderate" }],
        longLeadEquipmentWeeks: 4,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: 158_900,
        isAwarded: false,
        receivedAt: now,
      }),
      exclusions: ["Permit fees"],
      source: "email_ai" as const,
      sourceInboundEmailId: emailId,
      submittedByName: "AI parser (email)",
    });
    const store = async (body: string) => await ctx.storage.store(new Blob([body], { type: "application/pdf" }));
    const planFileId = await ctx.db.insert("projectFiles", {
      projectId: a.projectId,
      tradePackageId: packageId,
      storageId: await store("%PDF-1.4 lighting plan"),
      fileName: "E-101 Lighting Plan.pdf",
      fileType: "blueprint",
      fileSize: 22,
      uploadedBy: "Dana",
      uploadedAt: now,
    });
    const quoteFileId = await ctx.db.insert("projectFiles", {
      projectId: a.projectId,
      tradePackageId: packageId,
      storageId: await store("%PDF-1.4 oakland quote"),
      fileName: "Oakland quote.pdf",
      fileType: "quote_pdf",
      fileSize: 22,
      uploadedBy: "Dana",
      uploadedAt: now,
    });
    return { packageId, northbay, lakeshore, oakland, goldenGate, oaklandBid, emailId, planFileId, quoteFileId };
  });
  const agentUserId = await t.run(async (ctx) => {
    const { id, ...fields } = agentIdProfile({ sub: "linked-agent-sub", email: LINKED_AGENT_EMAIL, name: "Agent" });
    const userId = await ctx.db.insert("users", fields);
    await syncAgentProfile(ctx, userId, { duringAgentIdSignIn: true });
    await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: id });
    return userId;
  });
  const kim = fx.sub.admin.as;
  const nia = await withSession(t, ids.northbay.userId, "nia@northbay.test");
  const ray = await withSession(t, ids.lakeshore.userId, "ray@lakeshore.test");
  const agent = await withSession(t, agentUserId, LINKED_AGENT_EMAIL);
  const dana = fx.gcA.admin.as;
  return { t, fx, ids, kim, nia, ray, agent, dana, pkg: ids.packageId };
}

describe("bid invitations", () => {
  test("Kim sees only the packages Eastbay is invited to; a new sub company sees none", async () => {
    const { t, fx, kim, ray, pkg } = await setup();
    const rows = await kim.query(api.bidPortal.listMyBidInvitations, {});
    const open = rows.find((r) => r.tradePackageId === pkg)!;
    expect(open).toMatchObject({
      projectTitle: "Harbor Point Dental Office TI",
      gcName: "Bayview Builders Inc.",
      csiDivision: "26 00 00",
      bidderName: "Eastbay Electric",
      status: "not_submitted",
      revisionNumber: 0,
    });
    expect(open.dueLabel).toMatch(/2099/);
    expect(rows.map((r) => r.projectTitle).every((p) => p === "Harbor Point Dental Office TI")).toBe(true);
    expect((await ray.query(api.bidPortal.listMyBidInvitations, {})).map((r) => r.tradePackageId)).not.toContain(pkg);

    const freshUser = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "Brand New Electric", kind: "sub", isDemo: false, createdAt: Date.now() });
      const userId = await ctx.db.insert("users", { email: "new@brandnew.test", emailVerificationTime: Date.now() });
      await ctx.db.insert("userProfiles", { userId, role: "sub", displayName: "New", actorType: "human", companyId, createdAt: Date.now() });
      await ctx.db.insert("companyMembers", { companyId, userId, role: "admin", status: "active", createdAt: Date.now() });
      return userId;
    });
    const fresh = await withSession(t, freshUser, "new@brandnew.test");
    expect(await fresh.query(api.bidPortal.listMyBidInvitations, {})).toEqual([]);
    for (const c of [fx.gcA.admin.as, fx.owner.admin.as]) {
      expect(await outcome(c.query(api.bidPortal.listMyBidInvitations, {}))).toBe(NOT_FOUND);
    }
  });

  test("package details show scope, documents through the authenticated route and nothing GC-internal", async () => {
    const { ids, kim, pkg } = await setup();
    const view = await kim.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg });
    expect(view.package).toMatchObject({ csiDivision: "26 00 00", scopeSummary: expect.stringMatching(/dental suite/) });
    expect(view.documents.map((d) => d.fileName)).toEqual(["E-101 Lighting Plan.pdf"]);
    expect(view.documents[0]).toMatchObject({ url: null, downloadPath: `/api/project-files/${ids.planFileId}` });
    const text = JSON.stringify(view);
    for (const hidden of ["Oakland Power", "Golden Gate", "Northbay", "budgetEstimate", "165000", "leveled", "15890000"]) {
      expect(text).not.toContain(hidden);
    }
    const ok = await kim.fetch(`/api/project-files/${ids.planFileId}`, { method: "GET" });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("%PDF-1.4 lighting plan");
    expect((await kim.fetch(`/api/project-files/${ids.quoteFileId}`, { method: "GET" })).status).toBe(404);
  });
});

describe("submitting and revising a bid", () => {
  test("the bid is stored in cents, revised as revision 2, and the GC sees both with what changed", async () => {
    const { t, kim, dana, pkg } = await setup();
    const first = await kim.mutation(api.bidPortal.submitPortalBid, { tradePackageId: pkg, ...BID });
    expect(first).toMatchObject({ revisionNumber: 1, baseAmountCents: 17_490_000 });
    const row = await t.run(async (ctx) => await ctx.db.get(first.bidId));
    expect(row).toMatchObject({
      baseAmountCents: 17_490_000,
      alternates: BID.alternates,
      unitPrices: BID.unitPrices,
      exclusions: BID.exclusions,
      inclusions: BID.inclusions,
      validUntil: "2099-12-31",
      source: "portal",
      submittedByName: "kim@eastbay.test",
      revisionNumber: 1,
    });
    expect(row!.baseBidAmount).toBeUndefined();
    expect(Number.isInteger(row!.leveledTotalCents)).toBe(true);

    const second = await kim.mutation(api.bidPortal.submitPortalBid, {
      tradePackageId: pkg,
      ...BID,
      baseAmountCents: 17_240_000,
      exclusions: ["Low-voltage cabling (27 00 00)"],
      note: "Revised after addendum 1",
    });
    expect(second).toMatchObject({ bidId: first.bidId, revisionNumber: 2 });
    const revisions = await t.run(async (ctx) => await ctx.db.query("bidRevisions").collect());
    expect(revisions.map((r) => [r.revisionNumber, r.baseAmountCents])).toEqual([
      [1, 17_490_000],
      [2, 17_240_000],
    ]);

    const gcView = (await dana.query(api.bidPortal.listPackageBidsWithHistory, { tradePackageId: pkg })).find((b) => b._id === first.bidId)!;
    expect(gcView).toMatchObject({ baseAmountCents: 17_240_000, revisionNumber: 2, source: "portal" });
    expect(gcView.history.map((h) => h.baseAmountCents)).toEqual([17_490_000, 17_240_000]);
    expect(gcView.history[1].note).toBe("Revised after addendum 1");
    expect(gcView.history[1].changes.join(" ")).toMatch(/Permit fees/);

    const mine = await kim.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg });
    expect(mine.myBid).toMatchObject({ revisionNumber: 2, baseAmountCents: 17_240_000 });
    expect(mine.status).toBe("submitted");
  });

  test("the server rejects invalid terms and saves nothing", async () => {
    const { t, kim, pkg } = await setup();
    const before = await snapshot(t);
    const bad: Record<string, Partial<typeof BID>> = {
      base: { baseAmountCents: 0 },
      negative: { baseAmountCents: -10_000 },
      fractional: { baseAmountCents: 1724.5 },
      alternate: { alternates: [{ description: "", amountCents: 625_000 }] },
      unit: { unitPrices: [{ item: "Receptacle", unit: "", unitPriceCents: 18_500 }] },
      past: { validUntil: "2020-01-01" },
    };
    for (const patch of Object.values(bad)) {
      const e = await errorData(kim.mutation(api.bidPortal.submitPortalBid, { tradePackageId: pkg, ...BID, ...patch }));
      expect(e.code).toBe("INVALID");
    }
    expect(await snapshot(t)).toBe(before);
    const deduct = await kim.mutation(api.bidPortal.submitPortalBid, {
      tradePackageId: pkg,
      ...BID,
      alternates: [{ description: "Deduct: owner-furnished fixtures", amountCents: -150_000 }],
    });
    expect(deduct.revisionNumber).toBe(1);
  });

  test("revising is blocked once the package is awarded", async () => {
    const { t, kim, pkg } = await setup();
    await kim.mutation(api.bidPortal.submitPortalBid, { tradePackageId: pkg, ...BID });
    await t.run(async (ctx) => await ctx.db.patch(pkg, { status: "awarded" }));
    const before = await snapshot(t);
    const e = await errorData(kim.mutation(api.bidPortal.submitPortalBid, { tradePackageId: pkg, ...BID, baseAmountCents: 1 }));
    expect(e.code).toBe("CLOSED");
    expect(await snapshot(t)).toBe(before);
    const view = await kim.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg });
    expect(view.status).toBe("not_awarded");
    expect(view.closedReason).toMatch(/closed/);
  });
});

describe("isolation", () => {
  test("Kim never reads a competitor's bid, the leveling or the GC history", async () => {
    const { kim, ids, pkg } = await setup();
    for (const call of [
      () => kim.query(api.bidPortal.listPackageBidsWithHistory, { tradePackageId: pkg }),
      () => kim.query(api.bidPortal.listPackageQuestions, { tradePackageId: pkg }),
      () => kim.query(api.bids.listByPackage, { tradePackageId: pkg }),
      () => kim.mutation(api.bidPortal.confirmParsedBid, { bidId: ids.oaklandBid, ...BID }),
      () => kim.mutation(api.bidPortal.enterBidOnBehalf, { tradePackageId: pkg, contractorId: ids.goldenGate, ...BID }),
    ]) {
      expect(await outcome(call())).toBe(NOT_FOUND);
    }
  });

  test("another GC, the owner, an uninvited sub, the Demo GC, a user without a company and a billing agent can't read or submit", async () => {
    const { t, fx, ray, agent, pkg } = await setup();
    const before = await snapshot(t);
    const callers: [string, Caller][] = [
      ["Sonoran GC", fx.gcB.admin.as],
      ["owner", fx.owner.admin.as],
      ["uninvited sub", ray],
      ["Demo GC", fx.demo.gc.as],
      ["no company", fx.noCompany.as],
      ["billing agent", agent],
    ];
    for (const [label, c] of callers) {
      const results = [
        await outcome(c.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg })),
        await outcome(c.mutation(api.bidPortal.submitPortalBid, { tradePackageId: pkg, ...BID })),
        await outcome(c.mutation(api.bidPortal.askBidQuestion, { tradePackageId: pkg, question: "Can we use MC cable?" })),
      ];
      expect([label, results]).toEqual([label, [NOT_FOUND, NOT_FOUND, NOT_FOUND]]);
    }
    for (const [, c] of callers.filter(([l]) => l !== "uninvited sub" && l !== "billing agent")) {
      expect(await outcome(c.query(api.bidPortal.listPackageBidsWithHistory, { tradePackageId: pkg }))).toBe(NOT_FOUND);
    }
    expect(await snapshot(t)).toBe(before);
  });
});

describe("GC entry and AI-parsed bids", () => {
  test("a bid entered on behalf of a bidder is attributed to the GC user", async () => {
    const { t, dana, ids, pkg } = await setup();
    const r = await dana.mutation(api.bidPortal.enterBidOnBehalf, {
      tradePackageId: pkg,
      contractorId: ids.goldenGate,
      baseAmountCents: 18_100_000,
      alternates: [],
      exclusions: [],
      inclusions: [],
      unitPrices: [],
      note: "Phoned in by estimator",
    });
    const row = await t.run(async (ctx) => await ctx.db.get(r.bidId));
    expect(row).toMatchObject({ source: "gc_entered", submittedByName: "dana@bayview.test", baseAmountCents: 18_100_000 });
    const gcView = (await dana.query(api.bidPortal.listPackageBidsWithHistory, { tradePackageId: pkg })).find((b) => b._id === r.bidId)!;
    expect(gcView.history).toMatchObject([{ source: "gc_entered", submittedByName: "dana@bayview.test" }]);
    expect((await dana.query(api.bids.listByPackage, { tradePackageId: pkg })).map((b) => b._id)).toContain(r.bidId);
  });

  test("the GC corrects an emailed bid; the correction is a revision and the email origin is kept", async () => {
    const { t, dana, ids, pkg } = await setup();
    const list = await dana.query(api.bidPortal.listPackageBidsWithHistory, { tradePackageId: pkg });
    const oak = list.find((b) => b._id === ids.oaklandBid)!;
    expect(oak).toMatchObject({ source: "email_ai", baseAmountCents: 15_890_000, sourceInboundEmail: { _id: ids.emailId } });

    const same = await dana.mutation(api.bidPortal.confirmParsedBid, {
      bidId: ids.oaklandBid,
      baseAmountCents: 15_890_000,
      alternates: [],
      exclusions: ["Permit fees"],
      inclusions: [],
      unitPrices: [],
    });
    expect(same.changed).toBe(false);
    expect(await t.run(async (ctx) => (await ctx.db.query("bidRevisions").collect()).length)).toBe(0);

    const fixed = await dana.mutation(api.bidPortal.confirmParsedBid, {
      bidId: ids.oaklandBid,
      baseAmountCents: 15_950_000,
      alternates: [],
      exclusions: ["Permit fees", "Trenching"],
      inclusions: [],
      unitPrices: [],
    });
    expect(fixed).toMatchObject({ changed: true, revisionNumber: 2 });
    const row = await t.run(async (ctx) => await ctx.db.get(ids.oaklandBid));
    expect(row).toMatchObject({
      source: "email_ai",
      sourceInboundEmailId: ids.emailId,
      baseAmountCents: 15_950_000,
      confirmedByName: "dana@bayview.test",
    });
    const revs = await t.run(async (ctx) => await ctx.db.query("bidRevisions").collect());
    expect(revs.map((r) => [r.source, r.baseAmountCents])).toEqual([["gc_edit", 15_950_000]]);
  });
});

describe("bidder questions", () => {
  test("the GC sees who asked; other bidders see the question only once published, without the asker", async () => {
    const { t, kim, nia, dana, pkg } = await setup();
    const { conversationId } = await kim.mutation(api.bidPortal.askBidQuestion, { tradePackageId: pkg, question: "Can we use MC cable above ceilings?" });
    await t.mutation(internal.bidPortal.storePortalDraft, { conversationId, draft: "MC cable is acceptable above accessible ceilings.", confidenceScore: 0.8 });

    const gcQs = await dana.query(api.bidPortal.listPackageQuestions, { tradePackageId: pkg });
    expect(gcQs[0]).toMatchObject({ askerCompanyName: "Eastbay Electric", status: "escalated_to_pm", publishedAt: null, origin: "portal" });
    expect((await nia.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg })).questions).toEqual([]);
    expect((await kim.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg })).myQuestions).toMatchObject([{ published: false }]);

    expect(await outcome(kim.mutation(api.bidPortal.publishQuestion, { conversationId, question: "x x x x x", answer: "yes" }))).toBe(NOT_FOUND);
    await dana.mutation(api.bidPortal.publishQuestion, {
      conversationId,
      question: "Can MC cable be used above ceilings?",
      answer: "Yes, above accessible ceilings per spec 26 05 19.",
    });
    const niaView = await nia.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg });
    expect(niaView.questions).toMatchObject([{ question: "Can MC cable be used above ceilings?", answer: expect.stringMatching(/26 05 19/) }]);
    expect(JSON.stringify(niaView)).not.toMatch(/Eastbay|kim@/);
    expect((await kim.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg })).myQuestions).toMatchObject([{ published: true }]);
  });
});

describe("bid due date and time", () => {
  const DUE = Date.parse("2026-10-30T21:00:00Z");
  afterEach(() => {
    vi.useRealTimers();
  });

  async function dueSetup() {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.fx.gcA.project.projectId, { state: "CA" });
      await ctx.db.patch(s.pkg, { bidDeadline: "2026-10-30", bidDueTime: "14:00", bidDueTimeZone: "America/Los_Angeles" });
    });
    return s;
  }

  test("every view shows the same due date and time with its zone", async () => {
    const { kim, dana, pkg, fx } = await dueSetup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DUE - 60_000);
    const label = "Oct 30, 2026, 2:00 PM PT";
    expect((await kim.query(api.bidPortal.listMyBidInvitations, {})).find((r) => r.tradePackageId === pkg)).toMatchObject({ dueLabel: label, bidClosesAt: DUE, status: "not_submitted" });
    expect((await kim.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg })).package).toMatchObject({ dueLabel: label, bidClosesAt: DUE });
    expect((await dana.query(api.tradePackages.listByProject, { projectId: fx.gcA.project.projectId })).find((p) => p._id === pkg)).toMatchObject({ dueLabel: label, bidClosesAt: DUE });
    expect(await dana.query(api.tradePackages.getPackage, { tradePackageId: pkg })).toMatchObject({ dueLabel: label });
    expect(await dana.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: pkg })).toMatchObject({ dueLabel: label });
  });

  test("portal bids are accepted until the due instant and refused from it on; the GC can still enter a late bid", async () => {
    const { t, kim, nia, dana, pkg, ids } = await dueSetup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DUE - 1);
    expect(await kim.mutation(api.bidPortal.submitPortalBid, { tradePackageId: pkg, ...BID })).toMatchObject({ revisionNumber: 1 });

    vi.setSystemTime(DUE);
    const before = await snapshot(t);
    const late = await errorData(nia.mutation(api.bidPortal.submitPortalBid, { tradePackageId: pkg, ...BID }));
    expect(late).toMatchObject({ code: "CLOSED", message: "Bidding on this package is closed: bids were due Oct 30, 2026, 2:00 PM PT." });
    expect(await errorData(kim.mutation(api.bidPortal.submitPortalBid, { tradePackageId: pkg, ...BID, baseAmountCents: 1_000_000 }))).toMatchObject({ code: "CLOSED" });
    expect(await snapshot(t)).toBe(before);

    const view = await nia.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg });
    expect(view.status).toBe("closed");
    expect(view.closedReason).toMatch(/bids were due Oct 30, 2026, 2:00 PM PT/);
    expect((await kim.query(api.bidPortal.listMyBidInvitations, {})).find((r) => r.tradePackageId === pkg)?.status).toBe("closed");

    const onBehalf = await dana.mutation(api.bidPortal.enterBidOnBehalf, {
      tradePackageId: pkg,
      contractorId: ids.goldenGate,
      baseAmountCents: 18_100_000,
      alternates: [],
      exclusions: [],
      inclusions: [],
      unitPrices: [],
    });
    expect(onBehalf.revisionNumber).toBe(1);
  });

  test("with no time set, bidding closes at the next local midnight", async () => {
    const { t, kim, pkg } = await dueSetup();
    await t.run(async (ctx) => await ctx.db.patch(pkg, { bidDueTime: undefined, bidDueTimeZone: undefined }));
    const midnight = Date.parse("2026-10-31T07:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(midnight - 1);
    const row = (await kim.query(api.bidPortal.listMyBidInvitations, {})).find((r) => r.tradePackageId === pkg)!;
    expect(row).toMatchObject({ dueLabel: "Oct 30, 2026, end of day PT", bidClosesAt: midnight });
    await kim.mutation(api.bidPortal.submitPortalBid, { tradePackageId: pkg, ...BID });
    vi.setSystemTime(midnight);
    expect(await errorData(kim.mutation(api.bidPortal.submitPortalBid, { tradePackageId: pkg, ...BID }))).toMatchObject({ code: "CLOSED" });
  });

  test("the GC sets and clears the due time; bidders and other companies cannot", async () => {
    const { t, kim, dana, pkg, fx } = await dueSetup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-09T18:00:00Z"));
    const set = await dana.mutation(api.tradePackages.updateBidDue, { tradePackageId: pkg, bidDeadline: "2026-11-02", bidDueTime: "14:00" });
    expect(set).toEqual({ dueLabel: "Nov 2, 2026, 2:00 PM PT", bidClosesAt: Date.parse("2026-11-02T22:00:00Z") });
    expect(await t.run(async (ctx) => await ctx.db.get(pkg))).toMatchObject({ bidDeadline: "2026-11-02", bidDueTime: "14:00", bidDueTimeZone: "America/Los_Angeles" });
    expect((await kim.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg })).package.dueLabel).toBe("Nov 2, 2026, 2:00 PM PT");

    const cleared = await dana.mutation(api.tradePackages.updateBidDue, { tradePackageId: pkg, bidDeadline: "2026-11-02", bidDueTime: "" });
    expect(cleared.dueLabel).toBe("Nov 2, 2026, end of day PT");
    const row = await t.run(async (ctx) => await ctx.db.get(pkg));
    expect(row?.bidDueTime).toBeUndefined();
    expect(row?.bidDueTimeZone).toBeUndefined();

    expect(await outcome(dana.mutation(api.tradePackages.updateBidDue, { tradePackageId: pkg, bidDeadline: "2026-11-02", bidDueTime: "2pm" }))).toMatch(/time like 14:00/);
    const before = await snapshot(t);
    for (const caller of [kim, fx.owner.admin.as, fx.gcB.admin.as, fx.demo.gc.as]) {
      expect(await outcome(caller.mutation(api.tradePackages.updateBidDue, { tradePackageId: pkg, bidDeadline: "2026-11-05", bidDueTime: "10:00" }))).toBe(NOT_FOUND);
    }
    expect(await snapshot(t)).toBe(before);

    await t.run(async (ctx) => await ctx.db.patch(pkg, { status: "awarded" }));
    expect(await outcome(dana.mutation(api.tradePackages.updateBidDue, { tradePackageId: pkg, bidDeadline: "2026-11-05" }))).toMatch(/awarded/);
  });

  test("a new package stores the due time with the project's zone", async () => {
    const { t, dana, fx } = await dueSetup();
    const id = await dana.mutation(api.tradePackages.createTradePackage, {
      projectId: fx.gcA.project.projectId,
      csiDivision: "09 00 00",
      tradeName: "Finishes",
      budgetEstimate: 10_000,
      scopeSummary: "Paint and drywall",
      mandatoryInclusions: [],
      bidDeadline: "2099-03-10",
      bidDueTime: "09:30",
    });
    expect(await t.run(async (ctx) => await ctx.db.get(id))).toMatchObject({ bidDueTime: "09:30", bidDueTimeZone: "America/Los_Angeles" });
    const blank = await dana.mutation(api.tradePackages.createTradePackage, {
      projectId: fx.gcA.project.projectId,
      csiDivision: "22 00 00",
      tradeName: "Plumbing",
      budgetEstimate: 10_000,
      scopeSummary: "Plumbing",
      mandatoryInclusions: [],
      bidDeadline: "2099-03-10",
    });
    expect((await t.run(async (ctx) => await ctx.db.get(blank)))?.bidDueTime).toBeUndefined();
  });
});
