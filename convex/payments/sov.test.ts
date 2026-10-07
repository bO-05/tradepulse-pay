/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";

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
    const contractSumCents = Math.round(demo.agreement.contractSum * 100);
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

  test("leveled exclusions are flagged as excluded scope", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(demo.agreement.bidId, {
        identifiedExclusions: [
          { description: "Crane hoisting excluded", costImpact: 45000, severity: "critical", isWaived: false },
        ],
      });
      await ctx.db.patch(demo.agreement._id, { contractSum: demo.agreement.contractSum + 45000.37 });
    });
    const gc = await signInAs(t, "gc");
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const { sov } = await rowsFor(t, demo.agreement._id);
    const excluded = sov.filter((r) => r.excludedScope);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].scheduledValueCents).toBe(4_500_000);
    expect(sov.reduce((a, r) => a + r.scheduledValueCents, 0)).toBe(
      Math.round((demo.agreement.contractSum + 45000.37) * 100),
    );
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
    const cents = Math.round(demo.agreement.contractSum * 100);
    expect(ledger!.totals).toEqual({
      contractSumCents: cents,
      billedCents: 0,
      paidCents: 0,
      retainageHeldCents: 0,
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
