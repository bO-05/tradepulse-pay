/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";

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
