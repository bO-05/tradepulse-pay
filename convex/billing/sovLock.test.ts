/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture } from "../lib/tenancyFixtures";

const modules = import.meta.glob("/convex/**/*.ts");
type T = TestConvex<typeof schema>;

const CUSTOM = [
  { description: "Mobilization & submittals", csiCode: "26 01 00", scheduledValueCents: 1_500_000 },
  { description: "Rough-in", csiCode: "26 05 19", scheduledValueCents: 1_750_000 },
  { description: "Trim & closeout", csiCode: "26 08 00", scheduledValueCents: 750_000 },
];

async function lines(t: T, agreementId: Id<"agreements">) {
  return await t.run(async (ctx) =>
    (await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
      .collect()).sort((a, b) => a.lineNo - b.lineNo),
  );
}

/** A generated (unexecuted) agreement whose GC imported and approved a custom 3-line SOV. */
async function approvedCustomSov() {
  const t = convexTest(schema, modules);
  const fx = await buildTenancyFixture(t);
  const { agreementId, bidId, tradePackageId } = fx.gcA.project;
  const gc = fx.gcA.admin.as;
  await t.run(async (ctx) => {
    await ctx.db.patch(agreementId, { status: "generated", executedAt: undefined, sov: { status: "draft" } });
  });
  await gc.mutation(api.agreements.generateAgreement, { bidId, tradePackageId });
  const agreement = await t.run(async (ctx) => (await ctx.db.get(agreementId))!);
  expect(agreement.contractSumCents).toBe(4_000_000);
  await gc.mutation(api.billing.sov.importSovLines, { agreementId, rows: CUSTOM });
  await gc.mutation(api.billing.sov.approveSov, { agreementId });
  return { t, fx, gc, agreementId, bidId, tradePackageId, approved: await lines(t, agreementId) };
}

describe("SOV approval lock on agreement regeneration", () => {
  test("regenerating an unchanged, unexecuted agreement keeps the approved custom SOV", async () => {
    const s = await approvedCustomSov();
    await s.gc.mutation(api.agreements.generateAgreement, { bidId: s.bidId, tradePackageId: s.tradePackageId });
    const after = await lines(s.t, s.agreementId);
    expect(after.map((l) => l._id)).toEqual(s.approved.map((l) => l._id));
    expect(after.map((l) => [l.description, l.scheduledValueCents])).toEqual(CUSTOM.map((l) => [l.description, l.scheduledValueCents]));
    const sov = await s.gc.query(api.billing.sov.getSov, { agreementId: s.agreementId });
    expect(sov.status).toBe("approved");
    expect(sov.canEdit).toBe(false);
  });

  test("a regeneration that changes the contract sum never deletes the approved lines", async () => {
    const s = await approvedCustomSov();
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.bidId, { alternates: [{ description: "Add LED upgrade", amountCents: 250_000 }] });
    });
    await s.gc.mutation(api.agreements.generateAgreement, { bidId: s.bidId, tradePackageId: s.tradePackageId, acceptedAlternateIndexes: [0] });
    const after = await lines(s.t, s.agreementId);
    expect(after.map((l) => l._id)).toEqual(s.approved.map((l) => l._id));
    const sov = await s.gc.query(api.billing.sov.getSov, { agreementId: s.agreementId });
    // Back in draft for the GC to reconcile the new sum, never silently replaced.
    expect(sov.status).toBe("draft");
    expect(sov.contractSumCents).toBe(4_250_000);
    expect(sov.approvalProblem).toContain("short");
  });
});
