/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { fromDollars } from "../lib/money";
import { agreementContractSumCents } from "./sov";

const modules = import.meta.glob("/convex/**/*.ts");

function newTest() {
  return convexTest(schema, modules);
}

async function seedDemo(t: ReturnType<typeof newTest>) {
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  return await t.run(async (ctx) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_demo", (q) => q.eq("isDemoProject", true))
      .first();
    const agreement = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project!._id))
      .first();
    const contractors = await ctx.db.query("contractors").collect();
    const byName = (name: string) => contractors.find((c) => c.companyName === name)!._id;
    return {
      agreement: agreement!,
      rosendinId: byName("Rosendin Electric, Inc."),
      tdiId: byName("TDIndustries, Inc."),
    };
  });
}

async function rowsFor(t: ReturnType<typeof newTest>, agreementId: string) {
  return await t.run(async (ctx) => {
    const id = ctx.db.normalizeId("agreements", agreementId)!;
    const sov = await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", id))
      .collect();
    const milestones = await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", id))
      .collect();
    return { sov, milestones };
  });
}

describe("SOV and milestone generation on execution", () => {
  test("a generated-only agreement has no SOV or milestones", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    expect(demo.agreement.status).toBe("generated");
    const rows = await rowsFor(t, demo.agreement._id);
    expect(rows.sov).toHaveLength(0);
    expect(rows.milestones).toHaveLength(0);
  });

  test("executing creates an SOV and four planned milestones that sum to the contract sum", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });

    const { sov, milestones } = await rowsFor(t, demo.agreement._id);
    const contractSumCents = fromDollars(demo.agreement.contractSum);
    expect(sov.length).toBeGreaterThan(0);
    expect(sov.reduce((a, r) => a + r.scheduledValueCents, 0)).toBe(contractSumCents);
    expect(sov.every((r) => Number.isInteger(r.scheduledValueCents) && r.description.length > 0)).toBe(true);

    expect(milestones.map((m) => m.name)).toEqual(["Mobilization", "Rough-in", "Trim-out", "Closeout"]);
    expect(milestones.every((m) => m.status === "planned" && Number.isInteger(m.amountCents))).toBe(true);
    expect(milestones.reduce((a, m) => a + m.amountCents, 0)).toBe(contractSumCents);
    for (let i = 1; i < 4; i++) expect(milestones[i].plannedDate).toBeGreaterThan(milestones[i - 1].plannedDate);
  });

  test("executing again creates no duplicates", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const before = await rowsFor(t, demo.agreement._id);
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const after = await rowsFor(t, demo.agreement._id);
    expect(after.sov.map((r) => r._id)).toEqual(before.sov.map((r) => r._id));
    expect(after.milestones.map((r) => r._id)).toEqual(before.milestones.map((r) => r._id));
  });

  test("an agreement executed before SOV generation existed is backfilled on re-execute", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(demo.agreement._id, { status: "executed", executedAt: Date.now() });
    });
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const rows = await rowsFor(t, demo.agreement._id);
    expect(rows.sov.length).toBeGreaterThan(0);
    expect(rows.milestones).toHaveLength(4);
  });

  test("plugs and exclusions never become SOV lines; the SOV sums to the contract sum", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(demo.agreement.bidId, {
        identifiedExclusions: [
          { description: "Crane hoisting excluded", costImpactCents: 4500000, severity: "critical", isWaived: false },
        ],
      });
    });
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const { sov } = await rowsFor(t, demo.agreement._id);
    expect(sov.length).toBeGreaterThan(0);
    expect(sov.some((r) => r.excludedScope || /excluded/i.test(r.description))).toBe(false);
    expect(sov.some((r) => r.scheduledValueCents === 4_500_000)).toBe(false);
    expect(sov.reduce((a, r) => a + r.scheduledValueCents, 0)).toBe(fromDollars(demo.agreement.contractSum));
  });
});

const VOID_REASON = "Executed against the wrong bid revision";
const ALT_1 = { description: "Alt 1 – LED troffer upgrade", amountCents: 625_000 };

async function auditTitles(t: ReturnType<typeof newTest>, agreementId: string) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("auditLogs").collect();
    return rows.filter((r) => r.agreementId === agreementId).map((r) => r.title);
  });
}

describe("SOV regeneration when the award changes", () => {
  test("a re-award with an accepted alternate and different lead weeks regenerates SOV and milestone dates", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const before = await rowsFor(t, demo.agreement._id);

    await gc.as.mutation(api.agreements.voidExecutedAgreement, { agreementId: demo.agreement._id, reason: VOID_REASON });
    const bid = await t.run(async (ctx) => (await ctx.db.get(demo.agreement.bidId))!);
    await t.run(async (ctx) => {
      await ctx.db.patch(bid._id, {
        alternates: [ALT_1],
        identifiedExclusions: [{ description: "Crane hoisting excluded", costImpactCents: 4500000, severity: "critical", isWaived: false }],
        longLeadEquipmentWeeks: bid.longLeadEquipmentWeeks + 6,
      });
    });
    await gc.as.mutation(api.agreements.generateAgreement, {
      bidId: demo.agreement.bidId,
      tradePackageId: demo.agreement.tradePackageId,
      acceptedAlternateIndexes: [0],
    });
    const reAwarded = await t.run(async (ctx) => (await ctx.db.get(demo.agreement._id))!);
    expect(reAwarded.status).toBe("generated");
    const expectedSum = (bid.baseAmountCents ?? 0) + 625_000;
    expect(reAwarded.contractSumCents).toBe(expectedSum);
    expect(reAwarded.acceptedAlternates).toEqual([ALT_1]);
    expect(reAwarded.excludedScopeNotes).toEqual(["Crane hoisting excluded"]);

    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const after = await rowsFor(t, demo.agreement._id);
    expect(after.sov.some((r) => r.excludedScope)).toBe(false);
    expect(after.sov.find((r) => r.description === ALT_1.description)?.scheduledValueCents).toBe(625_000);
    expect(after.sov.reduce((a, r) => a + r.scheduledValueCents, 0)).toBe(expectedSum);
    const rough = (rows: typeof after) => rows.milestones.find((m) => m.name === "Rough-in")!;
    const mob = (rows: typeof after) => rows.milestones.find((m) => m.name === "Mobilization")!;
    expect(rough(after).plannedDate - mob(after).plannedDate).toBe(
      rough(before).plannedDate - mob(before).plannedDate + 6 * 7 * 86_400_000,
    );
  });

  test("execute regenerates rows whose recorded source no longer matches the award", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const before = await rowsFor(t, demo.agreement._id);
    // Rows left behind by a status change that bypassed cleanup.
    await t.run(async (ctx) => {
      await ctx.db.patch(demo.agreement._id, { status: "generated" });
      const bid = (await ctx.db.get(demo.agreement.bidId))!;
      await ctx.db.patch(bid._id, { lineItems: bid.lineItems.map((li, i) => (i === 0 ? { ...li, item: `${li.item} (revised)` } : li)) });
    });
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const after = await rowsFor(t, demo.agreement._id);
    expect(after.sov.some((r) => r.excludedScope)).toBe(false);
    expect(after.sov[0].description).toMatch(/\(revised\)$/);
    expect(after.sov.some((r) => before.sov.some((b) => b._id === r._id))).toBe(false);
    expect(after.milestones).toHaveLength(4);
    expect(after.sov.reduce((a, r) => a + r.scheduledValueCents, 0)).toBe(fromDollars(demo.agreement.contractSum));
  });

  test("re-executing with an unchanged source keeps the same row ids", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const before = await rowsFor(t, demo.agreement._id);
    await t.run(async (ctx) => {
      await ctx.db.patch(demo.agreement._id, { status: "generated" });
    });
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const after = await rowsFor(t, demo.agreement._id);
    expect(after.sov.map((r) => r._id)).toEqual(before.sov.map((r) => r._id));
    expect(after.milestones.map((r) => r._id)).toEqual(before.milestones.map((r) => r._id));
  });

  test("voiding or regenerating to unexecuted removes SOV and milestones when nothing was billed", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    await gc.as.mutation(api.agreements.voidExecutedAgreement, { agreementId: demo.agreement._id, reason: VOID_REASON });
    let rows = await rowsFor(t, demo.agreement._id);
    expect(rows.sov).toHaveLength(0);
    expect(rows.milestones).toHaveLength(0);

    // Regenerating a not-yet-executed agreement replaces its rows with a fresh draft SOV and no milestones.
    await t.run(async (ctx) => {
      await ctx.db.patch(demo.agreement._id, { status: "executed", executedAt: Date.now() });
    });
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    await t.run(async (ctx) => {
      await ctx.db.patch(demo.agreement._id, { status: "generated" });
    });
    expect((await rowsFor(t, demo.agreement._id)).sov.length).toBeGreaterThan(0);
    await gc.as.mutation(api.agreements.generateAgreement, {
      bidId: demo.agreement.bidId,
      tradePackageId: demo.agreement.tradePackageId,
    });
    rows = await rowsFor(t, demo.agreement._id);
    const regenerated = await t.run(async (ctx) => ctx.db.get(demo.agreement._id));
    expect(regenerated?.sov?.status).toBe("draft");
    expect(rows.sov.length).toBeGreaterThan(0);
    expect(rows.sov.reduce((s, r) => s + r.scheduledValueCents, 0)).toBe(agreementContractSumCents(regenerated!));
    expect(rows.milestones).toHaveLength(0);
  });

  test("with a payment recorded, a changed award keeps the rows and writes an audit warning", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const before = await rowsFor(t, demo.agreement._id);
    await t.run(async (ctx) => {
      await ctx.db.insert("payments", {
        agreementId: demo.agreement._id,
        milestoneId: before.milestones[0]._id,
        kind: "funding",
        status: "authorized",
        grossCents: before.milestones[0].amountCents,
        retainageCents: 0,
        netCents: before.milestones[0].amountCents,
        idempotencyKey: "test-funding-1",
        createdAt: Date.now(),
      });
      const bid = (await ctx.db.get(demo.agreement.bidId))!;
      await ctx.db.patch(bid._id, { lineItems: bid.lineItems.map((li, i) => (i === 0 ? { ...li, item: `${li.item} (revised)` } : li)) });
    });
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const after = await rowsFor(t, demo.agreement._id);
    expect(after.sov).toEqual(before.sov);
    expect(after.milestones).toEqual(before.milestones);
    expect(await auditTitles(t, demo.agreement._id)).toContain(`Schedule of values kept: ${demo.agreement.agreementNumber}`);
  });

  test("with a pay application recorded, voiding keeps the rows and writes an audit warning", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const gc = await signInAs(t, "gc");
    const sub = await signInAs(t, "sub", { contractorId: demo.rosendinId });
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const before = await rowsFor(t, demo.agreement._id);
    await t.run(async (ctx) => {
      await ctx.db.insert("payApplications", {
        agreementId: demo.agreement._id,
        subUserId: sub.userId,
        periodLabel: "Period 1",
        lines: [
          { sovLineId: before.sov[0]._id, pctCompleteThisPeriod: 10, pctCompleteToDate: 10, requestedCents: 1_000 },
        ],
        requestedTotalCents: 1_000,
        notes: "",
        lienWaiver: true,
        status: "submitted",
        submittedBy: { userId: sub.userId, actorType: "human" },
        createdAt: Date.now(),
      });
    });
    await gc.as.mutation(api.agreements.voidExecutedAgreement, { agreementId: demo.agreement._id, reason: VOID_REASON });
    const after = await rowsFor(t, demo.agreement._id);
    expect(after.sov).toEqual(before.sov);
    expect(after.milestones).toEqual(before.milestones);
    expect(await auditTitles(t, demo.agreement._id)).toContain(`Schedule of values kept: ${demo.agreement.agreementNumber}`);
  });
});

describe("agreement ledger", () => {
  test("a newly executed agreement shows zero billed, paid and retainage and the full balance", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const ledger = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: demo.agreement._id });
    expect(ledger).not.toBeNull();
    const cents = fromDollars(demo.agreement.contractSum);
    expect(ledger!.totals).toEqual({
      contractSumCents: cents,
      billedCents: 0,
      fundedCents: 0,
      capturedCents: 0,
      capturedNotPaidCents: 0,
      paidCents: 0,
      retainageHeldCents: 0,
      retainageReleasedCents: 0,
      changeOrdersInvoicedCents: 0,
      changeOrdersPaidCents: 0,
      balanceCents: cents,
    });
    expect(ledger!.sovTotalCents).toBe(cents);
    expect(ledger!.milestones).toHaveLength(4);
  });

  test("the owning sub sees the ledger; another sub gets null and an empty list", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const sub1 = await signInAs(t, "sub", { contractorId: demo.rosendinId });
    const sub2 = await signInAs(t, "sub", { contractorId: demo.tdiId });

    expect(await sub1.as.query(api.payments.ledger.getAgreementLedger, { agreementId: demo.agreement._id })).not.toBeNull();
    expect((await sub1.as.query(api.payments.ledger.listLedgerAgreements, {})).map((a) => a._id)).toEqual([
      demo.agreement._id,
    ]);
    expect(await sub2.as.query(api.payments.ledger.getAgreementLedger, { agreementId: demo.agreement._id })).toBeNull();
    expect(await sub2.as.query(api.payments.ledger.listLedgerAgreements, {})).toEqual([]);
    expect(
      (await gc.as.query(api.payments.ledger.listLedgerAgreements, {})).some((a) => a._id === demo.agreement._id),
    ).toBe(true);
  });

  test("unauthenticated callers and owners are refused the workspace list", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    await expect(t.query(api.payments.ledger.getAgreementLedger, { agreementId: demo.agreement._id })).rejects.toThrow(
      /Not authenticated/,
    );
    const owner = await signInAs(t, "owner");
    await expect(owner.as.query(api.payments.ledger.listLedgerAgreements, {})).rejects.toThrow(/Forbidden/);
  });
});
