/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";
import { buildReviewContext } from "./payApps/reviewContext";
import { buildReviewPrompt } from "./payApps/reviewModel";
import { awardConfirmation, levelingRowAwardInput } from "../src/bids/awardConfirm";

/**
 * Leveling and award (§15) as Bayview's GC on a fresh Electrical package with three bids:
 * Eastbay $172,400.00 (Alt 1 $6,250.00, Alt 2 $11,800.00; excludes low-voltage cabling),
 * Oakland $158,900.00 (excludes fire alarm rough-in and permit fees) and Golden Gate $181,000.00.
 */

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
const NOT_FOUND = JSON.stringify({ code: "NOT_FOUND", message: "Not found." });

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

async function setup() {
  const t: T = convexTest(schema, modules);
  const fx = await buildTenancyFixture(t);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = fx.gcA.project.projectId;
    const tradePackageId = await ctx.db.insert("tradePackages", {
      projectId,
      csiDivision: "26 00 00",
      tradeName: "Electrical",
      budgetEstimate: 165_000,
      agentMailbox: "fixture@example.invalid",
      agentMailboxId: "fixture",
      scopeSummary: "Complete electrical for the dental suite.",
      mandatoryInclusions: [],
      bidDeadline: "2099-06-15T17:00:00.000Z",
      status: "leveling",
    });
    const vendor = async (companyName: string, linkedCompanyId?: Id<"companies">) =>
      await ctx.db.insert("contractors", {
        tradePackageId,
        companyName,
        contactEmail: `bids@${companyName.split(" ")[0].toLowerCase()}.invalid`,
        licenseNumber: "1",
        licenseStatus: "Unverified",
        sourceUrl: "https://example.invalid",
        rfqStatus: "bid_received",
        ...(linkedCompanyId ? { linkedCompanyId } : {}),
      });
    const bid = async (
      contractorId: Id<"contractors">,
      subcontractorName: string,
      baseAmountCents: number,
      exclusions: string[],
      alternates: { description: string; amountCents: number }[],
      receivedAt: number,
    ) =>
      await ctx.db.insert("bids", {
        tradePackageId,
        contractorId,
        subcontractorName,
        baseAmountCents,
        leveledTotalCents: baseAmountCents,
        leadTimePenaltyCents: 0,
        coiPenaltyCents: 0,
        lineItems: [
          { item: "Distribution and feeders", unit: "LS", quantity: 1, unitCostCents: baseAmountCents - 1_000_000, totalCostCents: baseAmountCents - 1_000_000 },
          { item: "Lighting", unit: "LS", quantity: 1, unitCostCents: 1_000_000, totalCostCents: 1_000_000 },
        ],
        identifiedExclusions: exclusions.map((description) => ({ description, costImpactCents: 0, severity: "major", isWaived: false })),
        exclusions,
        alternates,
        longLeadEquipmentWeeks: 4,
        coiComplianceStatus: "compliant",
        isAwarded: false,
        revisionNumber: 1,
        receivedAt,
      } as never);
    const eastbayContractor = await vendor("Eastbay Electric", fx.sub.companyId);
    const eastbay = await bid(
      eastbayContractor,
      "Eastbay Electric",
      17_240_000,
      ["Low-voltage cabling (27 00 00)"],
      [
        { description: "Alt 1 – LED troffer upgrade", amountCents: 625_000 },
        { description: "Alt 2 – Generator transfer switch", amountCents: 1_180_000 },
      ],
      now - 3000,
    );
    const oakland = await bid(await vendor("Oakland Power & Light"), "Oakland Power & Light", 15_890_000, ["Fire alarm rough-in", "Permit fees"], [], now - 2000);
    const goldenGate = await bid(await vendor("Golden Gate Electric"), "Golden Gate Electric", 18_100_000, [], [], now - 1000);
    await ctx.db.insert("projectMembers", {
      projectId,
      companyId: fx.sub.companyId,
      partyRole: "sub",
      contractorId: eastbayContractor,
      status: "active",
      createdAt: now,
    });
    return { tradePackageId, eastbay, oakland, goldenGate };
  });
  return { t, fx, ...ids };
}

async function plugBoth(s: Awaited<ReturnType<typeof setup>>) {
  const dana = s.fx.gcA.admin.as;
  await dana.mutation(api.bids.setExclusionPlug, { bidId: s.eastbay, exclusionIndex: 0, amountCents: 1_500_000, note: "Comparison only" });
  await dana.mutation(api.bids.setExclusionPlug, { bidId: s.oakland, exclusionIndex: 0, amountCents: 3_000_000 });
}

describe("leveling plugs and apparent vs leveled low", () => {
  test("no plug is invented; GC plugs are attributed and only change the leveled total", async () => {
    const s = await setup();
    const dana = s.fx.gcA.admin.as;
    const before = await dana.query(api.bids.getLevelingSummary, { tradePackageId: s.tradePackageId });
    expect(before.rows.every((r) => r.plugTotalCents === 0)).toBe(true);

    await plugBoth(s);
    const after = await dana.query(api.bids.getLevelingSummary, { tradePackageId: s.tradePackageId });
    const byName = Object.fromEntries(after.rows.map((r) => [r.subcontractorName, r]));
    expect(byName["Eastbay Electric"]).toMatchObject({ baseAmountCents: 17_240_000, plugTotalCents: 1_500_000, leveledTotalCents: 18_740_000 });
    expect(byName["Eastbay Electric"].exclusions[0]).toMatchObject({ amountCents: 1_500_000, note: "Comparison only" });
    expect(byName["Eastbay Electric"].exclusions[0].enteredByName).toMatch(/\S/);
    expect(byName["Eastbay Electric"].exclusions[0].enteredAt).toEqual(expect.any(Number));
    expect(byName["Oakland Power & Light"]).toMatchObject({ baseAmountCents: 15_890_000, leveledTotalCents: 18_890_000 });
    expect(byName["Oakland Power & Light"].exclusions[1]).toMatchObject({ description: "Permit fees", amountCents: 0, enteredByName: null });
    expect(byName["Golden Gate Electric"].leveledTotalCents).toBe(18_100_000);
    expect(after.apparentLowBidId).toBe(s.oakland);
    expect(after.leveledLowBidId).toBe(s.goldenGate);

    const stored = await s.t.run((ctx) => ctx.db.get(s.eastbay));
    expect(stored!.baseAmountCents).toBe(17_240_000);
    expect(stored!.leveledTotalCents).toBe(18_740_000);
  });

  test("plug input is validated", async () => {
    const s = await setup();
    const dana = s.fx.gcA.admin.as;
    expect(await outcome(dana.mutation(api.bids.setExclusionPlug, { bidId: s.eastbay, exclusionIndex: 0, amountCents: -1 }))).toMatch(/\$0\.00 or more/);
    expect(await outcome(dana.mutation(api.bids.setExclusionPlug, { bidId: s.eastbay, exclusionIndex: 0, amountCents: 1.5 }))).toMatch(/whole cents/);
    expect(await outcome(dana.mutation(api.bids.setExclusionPlug, { bidId: s.eastbay, exclusionIndex: 5, amountCents: 100 }))).toMatch(/not on this bid/);
  });

  test("sub, owner, Sonoran GC and Demo GC cannot read leveling or set plugs", async () => {
    const s = await setup();
    for (const caller of [s.fx.sub.admin.as, s.fx.owner.admin.as, s.fx.gcB.admin.as, s.fx.demo.gc.as]) {
      expect(await outcome(caller.query(api.bids.getLevelingSummary, { tradePackageId: s.tradePackageId }))).toBe(NOT_FOUND);
      expect(await outcome(caller.mutation(api.bids.setExclusionPlug, { bidId: s.eastbay, exclusionIndex: 0, amountCents: 100 }))).toBe(NOT_FOUND);
    }
  });
});

const PARSED_PERMIT =
  "Permit fees explicitly excluded from the proposal. No dollar amount is stated and no benchmark rate exists for this item, so costImpact is 0 and the GC should carry the permit fees separately.";

describe("AI-parsed bids for real companies carry no invented plugs", () => {
  test("the parser's $15,000 benchmark is not stored and its pricing reasoning is dropped", async () => {
    const s = await setup();
    const oakland = (await s.t.run((ctx) => ctx.db.get(s.oakland)))!;
    await s.t.mutation(internal.bids.insertParsedBid, {
      tradePackageId: s.tradePackageId,
      contractorId: oakland.contractorId,
      subcontractorName: oakland.subcontractorName,
      baseAmountCents: 15_890_000,
      lineItems: [],
      identifiedExclusions: [{ description: PARSED_PERMIT, costImpactCents: 1_500_000, severity: "moderate", isWaived: false }],
      longLeadEquipmentWeeks: 4,
      coiComplianceStatus: "compliant",
      coiPenaltyCents: 0,
    });
    const saved = (await s.t.run((ctx) => ctx.db.get(s.oakland)))!;
    expect(saved.identifiedExclusions).toEqual([
      expect.objectContaining({ description: "Permit fees explicitly excluded from the proposal.", costImpactCents: 0 }),
    ]);
    expect(saved.leveledTotalCents).toBe(15_890_000);
  });

  test("the cleanup clears unattributed parsed plugs on real-company bids only", async () => {
    const s = await setup();
    const demoBidId = s.fx.demo.project.bidId;
    await s.t.run(async (ctx) => {
      const exclusion = { description: PARSED_PERMIT, costImpactCents: 1_500_000, severity: "moderate", isWaived: false };
      await ctx.db.patch(s.oakland, { source: "email_ai", identifiedExclusions: [exclusion], exclusions: [PARSED_PERMIT], leveledTotalCents: 17_390_000 });
      await ctx.db.patch(s.eastbay, {
        source: "email_ai",
        identifiedExclusions: [
          { description: "Low-voltage cabling (27 00 00)", costImpactCents: 1_500_000, severity: "major", isWaived: false, plugEnteredByName: "Dana", plugEnteredAt: 5 },
        ],
      });
      await ctx.db.patch(demoBidId, { source: "email_ai", isAwarded: false, identifiedExclusions: [exclusion] });
    });
    const dry = await s.t.mutation(internal.levelingPlugMigration.clearParsedPlugs, { dryRun: true });
    expect(dry.fixed.map((f) => f.bidId)).toEqual([s.oakland]);
    expect((await s.t.run((ctx) => ctx.db.get(s.oakland)))!.leveledTotalCents).toBe(17_390_000);

    const run = await s.t.mutation(internal.levelingPlugMigration.clearParsedPlugs, {});
    expect(run.fixed).toEqual([{ bidId: s.oakland, subcontractorName: "Oakland Power & Light", leveledBeforeCents: 17_390_000, leveledAfterCents: 15_890_000 }]);
    const oakland = (await s.t.run((ctx) => ctx.db.get(s.oakland)))!;
    expect(oakland.identifiedExclusions[0]).toMatchObject({ description: "Permit fees explicitly excluded from the proposal.", costImpactCents: 0 });
    expect((await s.t.run((ctx) => ctx.db.get(s.eastbay)))!.identifiedExclusions[0].costImpactCents).toBe(1_500_000);
    expect((await s.t.run((ctx) => ctx.db.get(demoBidId)))!.identifiedExclusions[0].costImpactCents).toBe(1_500_000);
    expect((await s.t.mutation(internal.levelingPlugMigration.clearParsedPlugs, {})).fixed).toEqual([]);
  });
});

describe("priced email after bidding closes (PROC-SCRUTINY-003)", () => {
  async function lateEmail(s: Awaited<ReturnType<typeof setup>>, bidId: Id<"bids">, from: string) {
    const bid = (await s.t.run((ctx) => ctx.db.get(bidId)))!;
    const inboundId = await s.t.run(async (ctx) => {
      const project = await ctx.db.get(s.fx.gcA.project.projectId);
      return await ctx.db.insert("inboundEmails", {
        eventId: `evt-${Math.random()}`,
        messageId: `<late-${Math.random()}@mail>`,
        inboxId: "rfq",
        threadId: "thread-late",
        from,
        subject: "Revised proposal: $149,000.00",
        text: "Revised base bid $149,000.00. Excludes permit fees.",
        routing: "routed",
        matchMethod: "thread",
        projectId: project!._id,
        companyId: project!.gcCompanyId,
        tradePackageId: s.tradePackageId,
        contractorId: bid.contractorId,
        receivedAt: Date.now(),
      });
    });
    const result = await s.t.mutation(internal.bids.insertParsedBid, {
      tradePackageId: s.tradePackageId,
      contractorId: bid.contractorId,
      subcontractorName: bid.subcontractorName,
      baseAmountCents: 14_900_000,
      lineItems: [],
      identifiedExclusions: [{ description: "Permit fees", costImpactCents: 0, severity: "minor", isWaived: false }],
      longLeadEquipmentWeeks: 4,
      coiComplianceStatus: "compliant",
      coiPenaltyCents: 0,
      sourceInboundEmailId: inboundId,
    });
    return { inboundId, result, before: bid };
  }

  test("a losing bidder's priced email after award leaves the package awarded and the bid unchanged; the GC sees it as late", async () => {
    const s = await setup();
    const dana = s.fx.gcA.admin.as;
    await dana.mutation(api.agreements.generateAgreement, { bidId: s.eastbay, tradePackageId: s.tradePackageId, acceptedAlternateIndexes: [] });
    const contractorBefore = await s.t.run(async (ctx) => (await ctx.db.get((await ctx.db.get(s.oakland))!.contractorId))!);

    const { inboundId, result, before } = await lateEmail(s, s.oakland, "bids@oakland.invalid");
    expect(result).toBeNull();

    const pkg = (await s.t.run((ctx) => ctx.db.get(s.tradePackageId)))!;
    expect(pkg.status).toBe("awarded");
    const after = (await s.t.run((ctx) => ctx.db.get(s.oakland)))!;
    expect(after.baseAmountCents).toBe(before.baseAmountCents);
    expect(after.revisionNumber).toBe(before.revisionNumber);
    expect(after.isAwarded).toBe(false);
    const contractorAfter = await s.t.run(async (ctx) => (await ctx.db.get(after.contractorId))!);
    expect(contractorAfter.rfqStatus).toBe(contractorBefore.rfqStatus);
    const revisions = await s.t.run((ctx) => ctx.db.query("bidRevisions").withIndex("by_bid_and_revision", (q) => q.eq("bidId", s.oakland)).collect());
    expect(revisions).toEqual([]);

    const winner = (await s.t.run((ctx) => ctx.db.get(s.eastbay)))!;
    expect(winner.isAwarded).toBe(true);

    const messages = await dana.query(api.rfqRecipients.listPackageMessages, { tradePackageId: s.tradePackageId });
    const late = messages.find((m) => m.id === inboundId)!;
    expect(late.lateReason).toMatch(/closed: it has been awarded/);

    const summary = await dana.query(api.bids.getLevelingSummary, { tradePackageId: s.tradePackageId });
    expect(summary.awardedTo).toBe("Eastbay Electric");

    // The winning sub's portal stays closed.
    const invitations = await s.fx.sub.admin.as.query(api.bidPortal.listMyBidInvitations, {});
    expect(invitations.find((i) => i.tradePackageId === s.tradePackageId)?.status).toBe("awarded");
  });

  test("a priced email after the project closes is kept as late and changes no bid or package", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.patch(s.fx.gcA.project.projectId, { status: "closed" } as never));
    const { inboundId, result, before } = await lateEmail(s, s.oakland, "bids@oakland.invalid");
    expect(result).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(s.tradePackageId)))!.status).toBe("leveling");
    expect((await s.t.run((ctx) => ctx.db.get(s.oakland)))!.baseAmountCents).toBe(before.baseAmountCents);
    expect((await s.t.run((ctx) => ctx.db.get(inboundId)))!.lateReason).toMatch(/project is closed/);
  });

  test("a quote file parsed after award is refused instead of reopening leveling", async () => {
    const s = await setup();
    await s.fx.gcA.admin.as.mutation(api.agreements.generateAgreement, { bidId: s.eastbay, tradePackageId: s.tradePackageId, acceptedAlternateIndexes: [] });
    const oakland = (await s.t.run((ctx) => ctx.db.get(s.oakland)))!;
    const fileId = await s.t.run((ctx) =>
      ctx.db.insert("projectFiles", {
        projectId: s.fx.gcA.project.projectId,
        tradePackageId: s.tradePackageId,
        storageId: "quote_late",
        fileName: "oakland-revised.pdf",
        fileType: "quote_pdf",
        fileSize: 10,
        uploadedBy: "Dana",
        uploadedAt: Date.now(),
      } as never),
    );
    expect(
      await outcome(
        s.t.mutation(internal.bids.insertParsedBid, {
          tradePackageId: s.tradePackageId,
          contractorId: oakland.contractorId,
          subcontractorName: oakland.subcontractorName,
          baseAmountCents: 14_900_000,
          lineItems: [],
          identifiedExclusions: [],
          longLeadEquipmentWeeks: 4,
          coiComplianceStatus: "compliant",
          coiPenaltyCents: 0,
          sourceFileId: fileId,
        }),
      ),
    ).toMatch(/closed: it has been awarded/);
    expect((await s.t.run((ctx) => ctx.db.get(s.tradePackageId)))!.status).toBe("awarded");
  });
});

describe("award", () => {
  test("contract sum is the base bid; plugs are excluded; losing bidders read Not awarded; SOV has no plug or exclusion line", async () => {
    const s = await setup();
    const dana = s.fx.gcA.admin.as;
    await plugBoth(s);
    await dana.mutation(api.agreements.generateAgreement, { bidId: s.eastbay, tradePackageId: s.tradePackageId, acceptedAlternateIndexes: [] });
    await dana.mutation(api.bids.awardContract, { bidId: s.eastbay, tradePackageId: s.tradePackageId });
    const agreement = (await dana.query(api.agreements.getAgreementByBid, { bidId: s.eastbay }))!;
    expect(agreement.contractSumCents).toBe(17_240_000);
    expect(agreement.contractSum).toBe(172_400);
    expect(agreement.baseBidCents).toBe(17_240_000);
    expect(agreement.acceptedAlternates).toEqual([]);
    expect(agreement.declinedAlternates!.map((a) => a.description)).toEqual(["Alt 1 – LED troffer upgrade", "Alt 2 – Generator transfer switch"]);
    expect(agreement.excludedScopeNotes).toEqual(["Low-voltage cabling (27 00 00)"]);
    expect(agreement.contractText).toContain("$172,400.00");
    expect(agreement.contractText).not.toContain("$187,400.00");
    expect(agreement.contractText).toMatch(/Leveling plugs used to compare bids are not part of the Subcontract Sum/);
    expect(agreement.contractText).toMatch(/Excluded scope \(not in contract\)/);

    const summary = await dana.query(api.bids.getLevelingSummary, { tradePackageId: s.tradePackageId });
    expect(summary.awardedTo).toBe("Eastbay Electric");
    expect(Object.fromEntries(summary.rows.map((r) => [r.subcontractorName, r.status]))).toEqual({
      "Eastbay Electric": "awarded",
      "Oakland Power & Light": "not_awarded",
      "Golden Gate Electric": "not_awarded",
    });
    expect(await outcome(dana.mutation(api.bids.setExclusionPlug, { bidId: s.eastbay, exclusionIndex: 0, amountCents: 1 }))).toMatch(/plugs are locked/);

    await dana.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
    const sov = await s.t.run((ctx) =>
      ctx.db.query("scheduleOfValues").withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id)).collect(),
    );
    expect(sov.length).toBeGreaterThan(0);
    expect(sov.reduce((a, r) => a + r.scheduledValueCents, 0)).toBe(17_240_000);
    expect(sov.some((r) => r.excludedScope || /excluded|low-voltage/i.test(r.description))).toBe(false);
    expect(sov.some((r) => r.scheduledValueCents === 1_500_000)).toBe(false);
  });

  test("accepted alternates are added exactly and listed; declined ones are not", async () => {
    const s = await setup();
    const dana = s.fx.gcA.admin.as;
    await plugBoth(s);
    await dana.mutation(api.agreements.generateAgreement, { bidId: s.eastbay, tradePackageId: s.tradePackageId, acceptedAlternateIndexes: [0] });
    const agreement = (await dana.query(api.agreements.getAgreementByBid, { bidId: s.eastbay }))!;
    expect(agreement.contractSumCents).toBe(17_865_000);
    expect(agreement.acceptedAlternates).toEqual([{ description: "Alt 1 – LED troffer upgrade", amountCents: 625_000 }]);
    expect(agreement.declinedAlternates).toEqual([{ description: "Alt 2 – Generator transfer switch", amountCents: 1_180_000 }]);
    expect(agreement.contractText).toContain("$178,650.00");

    await dana.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
    const sov = await s.t.run((ctx) =>
      ctx.db.query("scheduleOfValues").withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id)).collect(),
    );
    expect(sov.reduce((a, r) => a + r.scheduledValueCents, 0)).toBe(17_865_000);
    expect(sov.some((r) => /Alt 1/.test(r.description) && r.scheduledValueCents === 625_000)).toBe(true);
  });

  test("a GC-added leveling exclusion beside the bidder's own exclusions reaches the agreement notes, subcontract text and review context (PROC-SCRUTINY-005)", async () => {
    const s = await setup();
    const dana = s.fx.gcA.admin.as;
    const oakland = (await s.t.run((ctx) => ctx.db.get(s.oakland)))!;
    expect(oakland.exclusions).toEqual(["Fire alarm rough-in", "Permit fees"]);
    await dana.mutation(api.bids.updateBidAdjustments, {
      bidId: s.oakland,
      identifiedExclusions: [
        ...oakland.identifiedExclusions,
        { description: "Seismic bracing of conduit", costImpactCents: 800_000, severity: "moderate", isWaived: false },
      ],
      valueEngineeringAlternates: [],
    });
    await dana.mutation(api.agreements.generateAgreement, { bidId: s.oakland, tradePackageId: s.tradePackageId, acceptedAlternateIndexes: [] });
    const agreement = (await dana.query(api.agreements.getAgreementByBid, { bidId: s.oakland }))!;
    expect(agreement.excludedScopeNotes).toEqual(["Fire alarm rough-in", "Permit fees", "Seismic bracing of conduit"]);
    expect(agreement.contractSumCents).toBe(15_890_000);
    expect(agreement.contractText).toContain("  - Seismic bracing of conduit");
    expect(agreement.contractText).toContain("  - Permit fees");

    const stored = (await s.t.run((ctx) => ctx.db.get(agreement._id)))!;
    const context = buildReviewContext({
      payApp: { _id: "p1", _creationTime: 1, createdAt: 1, periodLabel: "Oct 2026", notes: "", lines: [], requestedTotalCents: 0 } as never,
      agreement: stored,
      sov: [],
      milestones: [],
      agreementPayApps: [],
      license: null,
    });
    expect(context.agreement.excludedScopeNotes).toContain("Seismic bracing of conduit");
    expect(buildReviewPrompt(context)).toContain("Seismic bracing of conduit");
  });

  test("a GC-added exclusion and its plug survive base-only portal revisions and reach the award (PROC-SCRUTINY-005)", async () => {
    const s = await setup();
    const dana = s.fx.gcA.admin.as;
    const kim = s.fx.sub.admin.as;
    const terms = {
      alternates: [],
      inclusions: [],
      unitPrices: [],
      exclusions: ["Low-voltage cabling (27 00 00)", "Temporary power"],
    };
    await kim.mutation(api.bidPortal.submitPortalBid, { tradePackageId: s.tradePackageId, baseAmountCents: 17_240_000, ...terms });
    const submitted = (await s.t.run((ctx) => ctx.db.get(s.eastbay)))!;
    await dana.mutation(api.bids.updateBidAdjustments, {
      bidId: s.eastbay,
      identifiedExclusions: [
        ...submitted.identifiedExclusions,
        { description: "Seismic bracing of conduit", costImpactCents: 0, severity: "moderate", isWaived: false },
      ],
      valueEngineeringAlternates: [],
    });
    await dana.mutation(api.bids.setExclusionPlug, { bidId: s.eastbay, exclusionIndex: 2, amountCents: 800_000, note: "GC estimate" });

    // The portal form is prefilled from the bidder's own list; the bidder changes only the base, then drops one of its exclusions.
    const prefill = (await s.t.run((ctx) => ctx.db.get(s.eastbay)))!.exclusions!;
    expect(prefill).toEqual(terms.exclusions);
    await kim.mutation(api.bidPortal.submitPortalBid, { tradePackageId: s.tradePackageId, baseAmountCents: 17_100_000, ...terms, exclusions: prefill });
    await kim.mutation(api.bidPortal.submitPortalBid, {
      tradePackageId: s.tradePackageId,
      baseAmountCents: 17_000_000,
      ...terms,
      exclusions: ["Low-voltage cabling (27 00 00)"],
    });
    const revised = (await s.t.run((ctx) => ctx.db.get(s.eastbay)))!;
    expect(revised.revisionNumber).toBe(4);
    expect(revised.exclusions).toEqual(["Low-voltage cabling (27 00 00)"]);
    expect(revised.identifiedExclusions.map((e) => [e.description, e.source])).toEqual([
      ["Low-voltage cabling (27 00 00)", "bidder"],
      ["Seismic bracing of conduit", "gc"],
    ]);
    expect(revised.identifiedExclusions[1]).toMatchObject({ costImpactCents: 800_000, plugNote: "GC estimate" });

    const summary = await dana.query(api.bids.getLevelingSummary, { tradePackageId: s.tradePackageId });
    const row = summary.rows.find((r) => r.bidId === s.eastbay)!;
    expect(row).toMatchObject({ baseAmountCents: 17_000_000, plugTotalCents: 800_000, leveledTotalCents: 17_800_000 });
    expect(row.exclusions.find((e) => e.description === "Seismic bracing of conduit")).toMatchObject({ amountCents: 800_000 });

    await dana.mutation(api.agreements.generateAgreement, { bidId: s.eastbay, tradePackageId: s.tradePackageId, acceptedAlternateIndexes: [] });
    const agreement = (await dana.query(api.agreements.getAgreementByBid, { bidId: s.eastbay }))!;
    expect(agreement.contractSumCents).toBe(17_000_000);
    expect(agreement.excludedScopeNotes).toEqual(["Low-voltage cabling (27 00 00)", "Seismic bracing of conduit"]);
    expect(agreement.contractText).toContain("  - Seismic bracing of conduit");
    expect(agreement.contractText).not.toContain("Temporary power");
    const stored = (await s.t.run((ctx) => ctx.db.get(agreement._id)))!;
    const context = buildReviewContext({
      payApp: { _id: "p1", _creationTime: 1, createdAt: 1, periodLabel: "Oct 2026", notes: "", lines: [], requestedTotalCents: 0 } as never,
      agreement: stored,
      sov: [],
      milestones: [],
      agreementPayApps: [],
      license: null,
    });
    expect(context.agreement.excludedScopeNotes).toContain("Seismic bracing of conduit");
    expect(buildReviewPrompt(context)).toContain("Seismic bracing of conduit");
  });

  test("legacy exclusion rows without an owner: rows the bidder never listed are kept as the GC's", async () => {
    const s = await setup();
    const kim = s.fx.sub.admin.as;
    await s.t.run(async (ctx) => {
      const bid = (await ctx.db.get(s.eastbay))!;
      await ctx.db.patch(s.eastbay, {
        identifiedExclusions: [
          ...bid.identifiedExclusions,
          { description: "Trenching by others", costImpactCents: 250_000, severity: "moderate", isWaived: false, plugEnteredAt: 1 },
        ],
      });
    });
    await kim.mutation(api.bidPortal.submitPortalBid, {
      tradePackageId: s.tradePackageId,
      baseAmountCents: 17_000_000,
      alternates: [],
      inclusions: [],
      unitPrices: [],
      exclusions: [],
    });
    const revised = (await s.t.run((ctx) => ctx.db.get(s.eastbay)))!;
    expect(revised.identifiedExclusions.map((e) => [e.description, e.source, e.costImpactCents])).toEqual([["Trenching by others", "gc", 250_000]]);
  });

  test("the legacy award dialog confirms the same sum the agreement stores, VE deduct included (PROC-SCRUTINY-006)", async () => {
    const s = await setup();
    const dana = s.fx.gcA.admin.as;
    const eastbay = (await s.t.run((ctx) => ctx.db.get(s.eastbay)))!;
    await dana.mutation(api.bids.updateBidAdjustments, {
      bidId: s.eastbay,
      identifiedExclusions: eastbay.identifiedExclusions,
      valueEngineeringAlternates: [{ description: "Aluminum feeders", costDeductCents: 150_000, isAccepted: true }],
    });
    const leveled = (await s.t.run((ctx) => ctx.db.get(s.eastbay)))!;
    const confirmed = awardConfirmation(leveled, []);
    expect(confirmed.contractSumCents).toBe(17_090_000);
    expect(confirmed.details).toContainEqual({ label: "Accepted VE deducts", value: "Aluminum feeders (−$1,500.00)" });

    await dana.mutation(api.agreements.generateAgreement, { bidId: s.eastbay, tradePackageId: s.tradePackageId, acceptedAlternateIndexes: [] });
    const agreement = (await dana.query(api.agreements.getAgreementByBid, { bidId: s.eastbay }))!;
    expect(agreement.contractSumCents).toBe(confirmed.contractSumCents);
    expect(agreement.veDeducts).toEqual([{ description: "Aluminum feeders", amountCents: 150_000 }]);

    const summary = await dana.query(api.bids.getLevelingSummary, { tradePackageId: s.tradePackageId });
    const row = summary.rows.find((r) => r.bidId === s.eastbay)!;
    expect(awardConfirmation(levelingRowAwardInput(row), []).contractSumCents).toBe(agreement.contractSumCents);
  });

  test("an alternate index from outside the bid is rejected", async () => {
    const s = await setup();
    expect(
      await outcome(
        s.fx.gcA.admin.as.mutation(api.agreements.generateAgreement, { bidId: s.eastbay, tradePackageId: s.tradePackageId, acceptedAlternateIndexes: [2] }),
      ),
    ).toMatch(/alternates from this bid/);
  });

  test("the Eastbay sub, the owner, Sonoran GC and Demo GC cannot award", async () => {
    const s = await setup();
    for (const caller of [s.fx.sub.admin.as, s.fx.owner.admin.as, s.fx.gcB.admin.as, s.fx.demo.gc.as]) {
      expect(await outcome(caller.mutation(api.agreements.generateAgreement, { bidId: s.eastbay, tradePackageId: s.tradePackageId }))).toBe(NOT_FOUND);
      expect(await outcome(caller.mutation(api.bids.awardContract, { bidId: s.eastbay, tradePackageId: s.tradePackageId }))).toBe(NOT_FOUND);
    }
    const agreements = await s.t.run((ctx) => ctx.db.query("agreements").withIndex("by_bid", (q) => q.eq("bidId", s.eastbay)).collect());
    expect(agreements).toEqual([]);
  });
});
