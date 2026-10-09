/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { signInAs } from "./lib/testIdentity";
import {
  SCENARIO_COMPETING_LEVELED,
  SCENARIO_SUB1_EXCLUSION,
  SCENARIO_SUB1_LEVELED,
  scenarioProjectTitle,
} from "./procurementScenario";

const modules = import.meta.glob("/convex/**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const [contractorId, otherContractorId] = await t.run(async (ctx) => {
    const all = await ctx.db.query("contractors").collect();
    return [all[0]._id, all[1]._id] as const;
  });
  const gc = await signInAs(t, "gc", { email: "gc@demo.tradepulse" });
  const sub1 = await signInAs(t, "sub", { email: "sub1@demo.tradepulse", contractorId });
  const sub2 = await signInAs(t, "sub", { email: "sub2@demo.tradepulse", contractorId: otherContractorId });
  return { t, gc, sub1, sub2, contractorId, otherContractorId };
}

async function snapshot(t: Awaited<ReturnType<typeof setup>>["t"]) {
  return await t.run(async (ctx) => ({
    contractors: await ctx.db.query("contractors").collect(),
    agreements: await ctx.db.query("agreements").collect(),
    profiles: await ctx.db.query("userProfiles").collect(),
  }));
}

describe("procurement scenario fixture", () => {
  test("seeds an unawarded two-bid leveling package where sub1's existing contractor bids", async () => {
    const { t, contractorId } = await setup();
    const before = await snapshot(t);
    const res = await t.mutation(internal.procurementScenario.seedProcurementScenario, { suffix: "r2" });
    expect(res.created).toBe(true);
    expect(res.projectTitle).toBe(scenarioProjectTitle("r2"));
    expect(res.sub1ContractorId).toBe(contractorId);

    const bids = await t.run((ctx) =>
      ctx.db.query("bids").withIndex("by_package", (q) => q.eq("tradePackageId", res.tradePackageId!)).collect(),
    );
    expect(bids).toHaveLength(2);
    expect(bids.every((b) => !b.isAwarded)).toBe(true);
    const mine = bids.find((b) => b._id === res.sub1BidId)!;
    expect(mine.contractorId).toBe(contractorId);
    expect(mine.leveledTotalCents).toBe(SCENARIO_SUB1_LEVELED * 100);
    expect(mine.identifiedExclusions.map((e) => e.description)).toEqual([SCENARIO_SUB1_EXCLUSION.description]);
    const competing = bids.find((b) => b._id === res.competingBidId)!;
    expect(competing.contractorId).not.toBe(contractorId);
    expect(competing.leveledTotalCents).toBe(SCENARIO_COMPETING_LEVELED * 100);

    const after = await snapshot(t);
    // Existing contractors are untouched; only the competing bidder is new.
    expect(after.contractors.filter((c) => before.contractors.some((b) => b._id === c._id))).toEqual(before.contractors);
    expect(after.contractors).toHaveLength(before.contractors.length + 1);
    expect(after.agreements).toEqual(before.agreements);
    expect(after.profiles).toEqual(before.profiles);
  });

  test("is idempotent per suffix and validates the suffix", async () => {
    const { t } = await setup();
    const first = await t.mutation(internal.procurementScenario.seedProcurementScenario, { suffix: "r2" });
    const counts = await t.run(async (ctx) => ({
      projects: (await ctx.db.query("projects").collect()).length,
      bids: (await ctx.db.query("bids").collect()).length,
      contractors: (await ctx.db.query("contractors").collect()).length,
    }));
    const again = await t.mutation(internal.procurementScenario.seedProcurementScenario, { suffix: "r2" });
    expect(again.created).toBe(false);
    expect(again.projectId).toBe(first.projectId);
    expect(again.tradePackageId).toBe(first.tradePackageId);
    expect(again.sub1BidId).toBe(first.sub1BidId);
    expect(again.competingBidId).toBe(first.competingBidId);
    expect(
      await t.run(async (ctx) => ({
        projects: (await ctx.db.query("projects").collect()).length,
        bids: (await ctx.db.query("bids").collect()).length,
        contractors: (await ctx.db.query("contractors").collect()).length,
      })),
    ).toEqual(counts);

    const other = await t.mutation(internal.procurementScenario.seedProcurementScenario, { suffix: "r3" });
    expect(other.projectId).not.toBe(first.projectId);
    await expect(
      t.mutation(internal.procurementScenario.seedProcurementScenario, { suffix: "bad suffix!" }),
    ).rejects.toThrow(/suffix/);
  });

  test("GC award and execution produce sub1's agreement in Payments and the portal with matching exclusions", async () => {
    const { t, gc, sub1, sub2, contractorId } = await setup();
    const before = await snapshot(t);
    const res = await t.mutation(internal.procurementScenario.seedProcurementScenario, { suffix: "r2" });
    const pkgId = res.tradePackageId!;
    const bidId = res.sub1BidId!;

    // The procurement UI's Award button generates the agreement (and marks the bid awarded).
    await gc.as.mutation(api.agreements.generateAgreement, { bidId, tradePackageId: pkgId });
    const award = await gc.as.mutation(api.bids.awardContract, { bidId, tradePackageId: pkgId });
    expect(award.success).toBe(true);
    const agreement = await gc.as.query(api.agreements.getAgreementByBid, { bidId });
    expect(agreement?.contractorId).toBe(contractorId);
    expect(agreement?.contractSum).toBe(SCENARIO_SUB1_LEVELED);
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement!._id });

    const gcList = await gc.as.query(api.payments.ledger.listLedgerAgreements, {});
    const gcRow = gcList.find((a: any) => a._id === agreement!._id);
    expect(gcRow).toBeDefined();
    expect(gcRow!.status).toBe("executed");

    const portal = await sub1.as.query(api.portal.mySubPortal, {});
    expect(portal.agreements.map((a: any) => a._id)).toContain(agreement!._id);
    const sub2List = await sub2.as.query(api.payments.ledger.listLedgerAgreements, {});
    expect(sub2List.map((a: any) => a._id)).not.toContain(agreement!._id);

    const ledger: any = await sub1.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement!._id });
    const excluded = ledger.sov.filter((l: any) => l.excludedScope);
    const bid = await t.run((ctx) => ctx.db.get(bidId));
    expect(excluded.map((l: any) => l.description)).toEqual(
      bid!.identifiedExclusions.map((e) => `Excluded scope: ${e.description}`),
    );
    expect(excluded[0].scheduledValueCents).toBe(SCENARIO_SUB1_EXCLUSION.costImpact * 100);

    // Pre-existing contractors and agreements are unchanged by the whole flow.
    const after = await snapshot(t);
    expect(after.contractors.filter((c) => before.contractors.some((b) => b._id === c._id))).toEqual(before.contractors);
    expect(after.agreements.filter((a) => before.agreements.some((b) => b._id === a._id))).toEqual(before.agreements);
    expect(after.profiles).toEqual(before.profiles);
  });

  test("a contractor from another package that was not invited still cannot be awarded", async () => {
    const { t, gc, otherContractorId } = await setup();
    const res = await t.mutation(internal.procurementScenario.seedProcurementScenario, { suffix: "r2" });
    const strayBidId = await t.run(async (ctx) => {
      const bid = (await ctx.db.get(res.sub1BidId!))!;
      const { _id, _creationTime, ...rest } = bid;
      return await ctx.db.insert("bids", { ...rest, contractorId: otherContractorId });
    });
    await expect(
      gc.as.mutation(api.agreements.generateAgreement, { bidId: strayBidId, tradePackageId: res.tradePackageId! }),
    ).rejects.toThrow(/not linked to a valid contractor/);
  });
});
