/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";

const modules = import.meta.glob("./**/*.ts");

test("legacy dollar bids get cents equal to round(dollars x 100), a revision, and the report reads zero missing", async () => {
  const t = convexTest(schema, modules);
  const fx = await buildTenancyFixture(t);
  const a = fx.gcA.project;
  const bidId = await t.run(async (ctx) =>
    // A row written before the cents fields existed: dollars only, with float noise.
    await ctx.db.insert("bids", {
      tradePackageId: a.tradePackageId,
      contractorId: a.contractorId,
      subcontractorName: "Legacy Electric",
      baseBidAmount: 174_900.005,
      lineItems: [{ item: "Base", unit: "LS", quantity: 1, unitCost: 0.1 + 0.2, totalCost: 0.1 + 0.2 }],
      identifiedExclusions: [{ description: "Permit fees", costImpact: 1_250.5, severity: "moderate" }],
      valueEngineeringAlternates: [{ description: "Aluminum feeders", costDeduct: 3_000.25, isAccepted: true }],
      longLeadEquipmentWeeks: 0,
      leadTimePenalty: 99.99,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      leveledTotalCost: 172_150.245,
      isAwarded: false,
      receivedAt: Date.now(),
    }),
  );
  const before = await t.query(internal.bidCentsMigration.bidCentsReport, {});
  expect(before.legacyWithoutCents).toBe(1);

  await t.mutation(internal.bidCentsMigration.backfillBidCents, {});
  const row = (await t.run(async (ctx) => await ctx.db.get(bidId)))!;
  expect(row).toMatchObject({
    baseAmountCents: Math.round(174_900.005 * 100),
    leveledTotalCents: Math.round(172_150.245 * 100),
    leadTimePenaltyCents: 9_999,
    coiPenaltyCents: 0,
    source: "legacy",
  });
  expect(row.lineItems[0]).toMatchObject({ unitCostCents: 30, totalCostCents: 30 });
  expect(row.identifiedExclusions[0].costImpactCents).toBe(125_050);
  expect(row.valueEngineeringAlternates![0].costDeductCents).toBe(300_025);
  for (const n of [row.baseAmountCents, row.leveledTotalCents]) expect(Number.isInteger(n)).toBe(true);

  const report = await t.query(internal.bidCentsMigration.bidCentsReport, {});
  expect(report).toMatchObject({ missingCents: 0, legacyWithoutCents: 0, mismatches: 0, withoutRevision: 0 });

  // Idempotent: a second run changes nothing.
  const snapshot = await t.run(async (ctx) => JSON.stringify([await ctx.db.query("bids").collect(), await ctx.db.query("bidRevisions").collect()]));
  const again = await t.mutation(internal.bidCentsMigration.backfillBidCents, {});
  expect(again).toMatchObject({ patched: 0, revisionsCreated: 0, isDone: true });
  expect(await t.run(async (ctx) => JSON.stringify([await ctx.db.query("bids").collect(), await ctx.db.query("bidRevisions").collect()]))).toBe(snapshot);
});
