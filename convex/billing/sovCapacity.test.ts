/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture } from "../lib/tenancyFixtures";
import { SOV_MAX_ROWS, SOV_MAX_TOTAL_LINES } from "../lib/sovRules";

const modules = import.meta.glob("/convex/**/*.ts");
type T = TestConvex<typeof schema>;
const CAPACITY = /SOV_CAPACITY|at most 1,200 lines/;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in tests");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function insertLines(t: T, agreementId: Id<"agreements">, count: number, opts: { from?: number; sourceFingerprint?: string } = {}) {
  await t.run(async (ctx) => {
    const from = opts.from ?? 1;
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("scheduleOfValues", {
        agreementId,
        lineNo: from + i,
        description: `Line ${from + i}`,
        scheduledValueCents: 100,
        excludedScope: false,
        ...(opts.sourceFingerprint ? { sourceFingerprint: opts.sourceFingerprint } : {}),
      });
    }
  });
}

async function countLines(t: T, agreementId: Id<"agreements">) {
  return await t.run(async (ctx) =>
    (await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
      .collect()),
  );
}

/** An executed agreement with an approved SOV of `lines` $1.00 lines; the contract sum covers the first 1,000. */
async function setup(lines: number) {
  const t = convexTest(schema, modules);
  const fx = await buildTenancyFixture(t);
  const { agreementId, projectId } = fx.gcA.project;
  await t.run(async (ctx) => {
    await ctx.db.patch(projectId, { billingDay: 25, startDate: "2026-10-01", retainageBps: 500 });
    await ctx.db.patch(agreementId, { contractSum: 1_000, contractSumCents: SOV_MAX_ROWS * 100 });
  });
  await insertLines(t, agreementId, lines);
  return { t, fx, agreementId, projectId, gc: fx.gcA.admin.as, sub: fx.sub.admin.as };
}

describe("SOV capacity: 1,000 base lines plus 200 change-order lines, never truncated", () => {
  test("billing, funding and the SOV CSV read every line of a 1,050-line SOV", async () => {
    const s = await setup(1_050);
    const sov = await s.gc.query(api.billing.sov.getSov, { agreementId: s.agreementId });
    expect(sov.lines).toHaveLength(1_050);
    const tranches = await s.gc.query(api.billing.tranches.listTranches, { agreementId: s.agreementId });
    expect(tranches?.contractSumToDateCents).toBe(105_000);

    const { payAppId } = await s.sub.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    const sheet = await s.sub.query(api.payApps.g703.payAppLines, { payAppId });
    expect(sheet).toHaveLength(1_050);
    expect(sheet.reduce((acc, l) => acc + l.scheduledValueCents, 0)).toBe(105_000);
    const form = await s.sub.query(api.payApps.submit.payAppFormContext, { agreementId: s.agreementId });
    expect(form?.sovLines).toHaveLength(1_050);

    const first = await s.gc.mutation(api.documents.documents.requestDocument, { kind: "sov_csv", relatedId: s.agreementId });
    if (first.status !== "ready") await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const ready = await s.gc.mutation(api.documents.documents.requestDocument, { kind: "sov_csv", relatedId: s.agreementId });
    expect(ready.status).toBe("ready");
    const csv = await s.t.run(async (ctx) => {
      const doc = (await ctx.db.get(ready.document!._id as Id<"documents">))!;
      return await (await ctx.storage.get(doc.storageId))!.text();
    });
    const rows = csv.split("\r\n").filter((r) => r !== "");
    expect(rows).toHaveLength(1_051);
    expect(rows.at(-1)).toMatch(/^1050,"Line 1050",/);
  });

  test("regenerating a 1,050-line stale draft removes every old row", async () => {
    const t = convexTest(schema, modules);
    const fx = await buildTenancyFixture(t);
    const { agreementId, bidId, tradePackageId } = fx.gcA.project;
    await t.run(async (ctx) => {
      await ctx.db.patch(agreementId, { status: "generated", executedAt: undefined, sov: { status: "draft" } });
    });
    await insertLines(t, agreementId, 1_050, { sourceFingerprint: "stale" });
    const old = new Set((await countLines(t, agreementId)).map((l) => l._id as string));
    await fx.gcA.admin.as.mutation(api.agreements.generateAgreement, { bidId, tradePackageId });
    const after = await countLines(t, agreementId);
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(10);
    expect(after.some((l) => old.has(l._id))).toBe(false);
  });

  test("beyond capacity every reader refuses instead of returning partial figures", async () => {
    const s = await setup(SOV_MAX_TOTAL_LINES + 1);
    await expect(s.gc.query(api.billing.sov.getSov, { agreementId: s.agreementId })).rejects.toThrow(CAPACITY);
    await expect(s.gc.query(api.billing.tranches.listTranches, { agreementId: s.agreementId })).rejects.toThrow(CAPACITY);
    await expect(s.gc.mutation(api.documents.documents.requestDocument, { kind: "sov_csv", relatedId: s.agreementId })).rejects.toThrow(CAPACITY);
    await expect(s.sub.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId })).rejects.toThrow(CAPACITY);
    const rows = await s.sub.query(api.payApps.g703.mySubPayAppAgreements, {});
    expect(rows[0].blockedReason).toMatch(/at most 1,200 lines/);
  });

  test("a change order that would exceed capacity is refused and adds no line", async () => {
    const s = await setup(SOV_MAX_TOTAL_LINES);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.agreementId, { contractSumCents: SOV_MAX_TOTAL_LINES * 100 });
    });
    const { changeOrderId } = await s.sub.mutation(api.billing.changeOrders.createChangeOrder, {
      scope: "subcontract",
      agreementId: s.agreementId,
      title: "Extra outlets",
      amountCents: 10_000,
    });
    await s.sub.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId });
    await expect(s.gc.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId })).rejects.toThrow(CAPACITY);
    expect(await countLines(s.t, s.agreementId)).toHaveLength(SOV_MAX_TOTAL_LINES);
  });
});
