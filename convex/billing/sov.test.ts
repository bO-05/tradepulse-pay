/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture, insertProjectFor } from "../lib/tenancyFixtures";
import { insertTestSession } from "../lib/testIdentity";
import { SOV_MAX_DESCRIPTION, SOV_NOT_APPROVED_MESSAGE } from "../lib/sovRules";

const modules = import.meta.glob("/convex/**/*.ts");
type T = TestConvex<typeof schema>;

const CONTRACT_CENTS = 17_240_000;
const EXAMPLE = [
  { description: "Mobilization & submittals", csiCode: "26 01 00", scheduledValueCents: 850_000 },
  { description: "Rough-in, branch circuits", csiCode: "26 05 19", scheduledValueCents: 3_150_000 },
  { description: "Panelboards & distribution", csiCode: "26 24 16", scheduledValueCents: 2_840_000 },
  { description: "Lighting fixtures", csiCode: "26 51 00", scheduledValueCents: 3_820_000 },
  { description: "Low-voltage & data", csiCode: "27 10 00", scheduledValueCents: 1_270_000 },
  { description: "Fire alarm devices", csiCode: "28 31 00", scheduledValueCents: 2_160_000 },
  { description: "Trim & devices", csiCode: "26 27 26", scheduledValueCents: 800_000 },
  { description: "Testing, closeout & as-builts", csiCode: "26 08 00", scheduledValueCents: 2_350_000 },
];

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await buildTenancyFixture(t);
  const agreementId = fx.gcA.project.agreementId;
  await t.run(async (ctx) => {
    await ctx.db.patch(agreementId, {
      contractSum: 172_400,
      contractSumCents: CONTRACT_CENTS,
      sov: { status: "draft" },
      excludedScopeNotes: ["Fire alarm monitoring contract (by owner)"],
    });
    await ctx.db.insert("scheduleOfValues", {
      agreementId,
      lineNo: 1,
      description: "Electrical base bid",
      scheduledValueCents: CONTRACT_CENTS,
      excludedScope: false,
      sourceBidLineRef: "base",
    });
  });
  return { t, fx, agreementId };
}

async function lines(t: T, agreementId: Id<"agreements">) {
  return await t.run(async (ctx) =>
    (await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
      .collect()).sort((a, b) => a.lineNo - b.lineNo),
  );
}

describe("SOV editor", () => {
  test("the GC sees the draft prefilled from the award, with excluded scope as notes", async () => {
    const { fx, agreementId } = await setup();
    const sov = await fx.gcA.admin.as.query(api.billing.sov.getSov, { agreementId });
    expect(sov.status).toBe("draft");
    expect(sov.canEdit).toBe(true);
    expect(sov.totalCents).toBe(CONTRACT_CENTS);
    expect(sov.differenceCents).toBe(0);
    expect(sov.lines).toHaveLength(1);
    expect(sov.excludedScopeNotes).toEqual(["Fire alarm monitoring contract (by owner)"]);
    expect(sov.approvalProblem).toBeNull();
  });

  test("add, edit, move and delete keep lineNo 1..n and exact cents", async () => {
    const { t, fx, agreementId } = await setup();
    const gc = fx.gcA.admin.as;
    const [prefilled] = await lines(t, agreementId);
    await gc.mutation(api.billing.sov.deleteSovLine, { lineId: prefilled._id });
    for (const l of EXAMPLE) {
      await gc.mutation(api.billing.sov.addSovLine, { agreementId, ...(l.description === "Lighting fixtures" ? { ...l, scheduledValueCents: 3_800_000 } : l) });
    }
    let sov = await gc.query(api.billing.sov.getSov, { agreementId });
    expect(sov.differenceCents).toBe(-20_000);
    expect(sov.approvalProblem).toContain("−$200.00");
    const line4 = sov.lines[3];
    await gc.mutation(api.billing.sov.updateSovLine, { lineId: line4._id, description: line4.description, csiCode: line4.csiCode, scheduledValueCents: 3_820_000 });
    const spare = await gc.mutation(api.billing.sov.addSovLine, { agreementId, description: "Spare", scheduledValueCents: 100 });
    expect((await gc.query(api.billing.sov.getSov, { agreementId })).differenceCents).toBe(100);
    await gc.mutation(api.billing.sov.moveSovLine, { lineId: spare, direction: "up" });
    expect((await lines(t, agreementId)).map((l) => l.description)[7]).toBe("Spare");
    await gc.mutation(api.billing.sov.deleteSovLine, { lineId: spare });
    sov = await gc.query(api.billing.sov.getSov, { agreementId });
    expect(sov.differenceCents).toBe(0);
    const rows = await lines(t, agreementId);
    expect(rows.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.map((l) => l.description)).toEqual(EXAMPLE.map((l) => l.description));
    expect(rows.reduce((s, l) => s + l.scheduledValueCents, 0)).toBe(CONTRACT_CENTS);
  });

  test("approval needs an exact sum; one cent off either way is refused", async () => {
    const { t, fx, agreementId } = await setup();
    const gc = fx.gcA.admin.as;
    await gc.mutation(api.billing.sov.importSovLines, { agreementId, rows: EXAMPLE });
    const line8 = (await lines(t, agreementId))[7];
    for (const [cents, text] of [
      [2_349_999, "−$0.01"],
      [2_350_001, "+$0.01"],
    ] as const) {
      await gc.mutation(api.billing.sov.updateSovLine, { lineId: line8._id, description: line8.description, scheduledValueCents: cents });
      await expect(gc.mutation(api.billing.sov.approveSov, { agreementId })).rejects.toThrow(/SOV_SUM_MISMATCH/);
      const sov = await gc.query(api.billing.sov.getSov, { agreementId });
      expect(sov.status).toBe("draft");
      expect(sov.approvalProblem).toContain("$172,400.00");
      expect(sov.approvalProblem).toContain(text);
    }
    await gc.mutation(api.billing.sov.updateSovLine, { lineId: line8._id, description: line8.description, scheduledValueCents: 2_350_000 });
    expect((await gc.query(api.billing.sov.getSov, { agreementId })).approvalProblem).toBeNull();
  });

  test("import replaces the draft; the server re-checks limits and every row", async () => {
    const { t, fx, agreementId } = await setup();
    const gc = fx.gcA.admin.as;
    const before = await lines(t, agreementId);
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({ description: `Line ${i + 1}`, scheduledValueCents: 100 }));
    await expect(gc.mutation(api.billing.sov.importSovLines, { agreementId, rows: tooMany })).rejects.toThrow(/1,000 rows/);
    await expect(
      gc.mutation(api.billing.sov.importSovLines, {
        agreementId,
        rows: [EXAMPLE[0], { description: "x".repeat(SOV_MAX_DESCRIPTION + 1), scheduledValueCents: 100 }],
      }),
    ).rejects.toThrow(/Line 2: description is longer than 200 characters/);
    for (const bad of [-50_000, 1.5, Number.NaN]) {
      await expect(
        gc.mutation(api.billing.sov.importSovLines, { agreementId, rows: [{ description: "Bad", scheduledValueCents: bad }] }),
      ).rejects.toThrow(/INVALID_IMPORT/);
    }
    await expect(
      gc.mutation(api.billing.sov.importSovLines, { agreementId, rows: [{ description: "Bad", csiCode: "9".repeat(33), scheduledValueCents: 1 }] }),
    ).rejects.toThrow(/CSI code is longer than 32/);
    expect(await lines(t, agreementId)).toEqual(before);

    const result = await gc.mutation(api.billing.sov.importSovLines, { agreementId, rows: EXAMPLE });
    expect(result).toEqual({ imported: 8, totalCents: CONTRACT_CENTS });
    const after = await lines(t, agreementId);
    expect(after).toHaveLength(8);
    expect(after.map((l) => l.scheduledValueCents)).toEqual(EXAMPLE.map((l) => l.scheduledValueCents));
  });

  test("approval locks every edit path and records the approver", async () => {
    const { t, fx, agreementId } = await setup();
    const gc = fx.gcA.admin.as;
    await gc.mutation(api.billing.sov.importSovLines, { agreementId, rows: EXAMPLE });
    await gc.mutation(api.billing.sov.approveSov, { agreementId });
    const sov = await gc.query(api.billing.sov.getSov, { agreementId });
    expect(sov.status).toBe("approved");
    expect(sov.canEdit).toBe(false);
    expect(sov.approvedByName).toBeTruthy();
    expect(sov.approvedAt).toBeGreaterThan(0);
    const before = await lines(t, agreementId);
    const line = before[0];
    const locked = /SOV is locked/;
    await expect(gc.mutation(api.billing.sov.updateSovLine, { lineId: line._id, description: "x", scheduledValueCents: 1 })).rejects.toThrow(locked);
    await expect(gc.mutation(api.billing.sov.deleteSovLine, { lineId: line._id })).rejects.toThrow(locked);
    await expect(gc.mutation(api.billing.sov.moveSovLine, { lineId: line._id, direction: "down" })).rejects.toThrow(locked);
    await expect(gc.mutation(api.billing.sov.addSovLine, { agreementId, description: "x", scheduledValueCents: 1 })).rejects.toThrow(locked);
    await expect(gc.mutation(api.billing.sov.importSovLines, { agreementId, rows: EXAMPLE })).rejects.toThrow(locked);
    await expect(gc.mutation(api.billing.sov.resetSovFromBid, { agreementId })).rejects.toThrow(locked);
    await expect(gc.mutation(api.billing.sov.approveSov, { agreementId })).rejects.toThrow(locked);
    expect(await lines(t, agreementId)).toEqual(before);
  });

  test("reset from bid restores the award lines without plugs", async () => {
    const { t, fx, agreementId } = await setup();
    const gc = fx.gcA.admin.as;
    await gc.mutation(api.billing.sov.importSovLines, { agreementId, rows: EXAMPLE.slice(0, 2) });
    await gc.mutation(api.billing.sov.resetSovFromBid, { agreementId });
    const rows = await lines(t, agreementId);
    expect(rows.reduce((s, l) => s + l.scheduledValueCents, 0)).toBe(CONTRACT_CENTS);
    expect(rows.some((l) => /plug/i.test(l.description))).toBe(false);
  });
});

describe("SOV access", () => {
  test("the sub reads only the approved SOV and cannot edit it", async () => {
    const { t, fx, agreementId } = await setup();
    const sub = fx.sub.admin.as;
    const draft = await sub.query(api.billing.sov.getSov, { agreementId });
    expect(draft.status).toBe("draft");
    expect(draft.lines).toEqual([]);
    await fx.gcA.admin.as.mutation(api.billing.sov.importSovLines, { agreementId, rows: EXAMPLE });
    await fx.gcA.admin.as.mutation(api.billing.sov.approveSov, { agreementId });
    const approved = await sub.query(api.billing.sov.getSov, { agreementId });
    expect(approved.lines).toHaveLength(8);
    expect(approved.totalCents).toBe(CONTRACT_CENTS);
    expect(approved.canEdit).toBe(false);
    const line = (await lines(t, agreementId))[0];
    await expect(sub.mutation(api.billing.sov.updateSovLine, { lineId: line._id, description: "x", scheduledValueCents: 1 })).rejects.toThrow(
      /Not found|Forbidden/,
    );
    await expect(sub.mutation(api.billing.sov.approveSov, { agreementId })).rejects.toThrow(/Not found|Forbidden/);
  });

  test("other companies, the owner, another sub and the Demo company get Not found", async () => {
    const { t, fx, agreementId } = await setup();
    const otherSub = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "Lakeshore Mechanical", kind: "sub", isDemo: false, createdAt: Date.now() });
      const userId = await ctx.db.insert("users", { email: "pat@lakeshore.test", emailVerificationTime: Date.now() });
      await ctx.db.insert("userProfiles", { userId, role: "sub", displayName: "Pat", actorType: "human", companyId, createdAt: Date.now() });
      await ctx.db.insert("companyMembers", { companyId, userId, role: "admin", status: "active", createdAt: Date.now() });
      const sessionId = await insertTestSession(ctx, userId);
      return { userId, sessionId };
    });
    const lakeshore = t.withIdentity({ subject: `${otherSub.userId}|${otherSub.sessionId}`, email: "pat@lakeshore.test" });
    const line = (await lines(t, agreementId))[0];
    for (const caller of [fx.gcB.admin.as, fx.owner.admin.as, lakeshore, fx.demo.gc.as, fx.noCompany.as]) {
      await expect(caller.query(api.billing.sov.getSov, { agreementId })).rejects.toThrow(/Not found/);
      await expect(caller.mutation(api.billing.sov.updateSovLine, { lineId: line._id, description: "x", scheduledValueCents: 1 })).rejects.toThrow(
        /Not found|Forbidden/,
      );
      await expect(caller.mutation(api.billing.sov.importSovLines, { agreementId, rows: EXAMPLE })).rejects.toThrow(/Not found|Forbidden/);
    }
  });
});

describe("pay apps wait for SOV approval", () => {
  test("the form shows the reason and submission is refused with it", async () => {
    const { t, fx, agreementId } = await setup();
    const sub = fx.sub.admin.as;
    const context = await sub.query(api.payApps.submit.payAppFormContext, { agreementId });
    expect(context?.sovApproved).toBe(false);
    expect(context?.blockedReason).toBe(SOV_NOT_APPROVED_MESSAGE);
    expect(context?.sovLines).toEqual([]);
    const line = (await lines(t, agreementId))[0];
    await expect(
      sub.mutation(api.payApps.submit.submitPayApplication, {
        agreementId,
        periodLabel: "Pay app #1",
        lines: [{ sovLineId: line._id, pctCompleteThisPeriod: 10, pctCompleteToDate: 10, requestedCents: 1_724_000 }],
        notes: "",
        lienWaiver: true,
      }),
    ).rejects.toThrow(SOV_NOT_APPROVED_MESSAGE);
    expect(await t.run(async (ctx) => (await ctx.db.query("payApplications").collect()).length)).toBe(0);
  });
});

describe("SOV state backfill", () => {
  test("agreements without SOV state become draft, or approved when money already moved", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const gc = await ctx.db.insert("companies", { name: "GC", kind: "gc", isDemo: false, createdAt: Date.now() });
      const quiet = await insertProjectFor(ctx, gc, { title: "Quiet" });
      const billed = await insertProjectFor(ctx, gc, { title: "Billed" });
      for (const p of [quiet, billed]) await ctx.db.patch(p.agreementId, { sov: undefined });
      await ctx.db.insert("payments", {
        agreementId: billed.agreementId,
        kind: "payout",
        status: "failed",
        grossCents: 100,
        retainageCents: 0,
        netCents: 100,
        idempotencyKey: "backfill-test",
        createdAt: Date.now(),
      });
      return { quiet: quiet.agreementId, billed: billed.agreementId };
    });
    const dry = await t.mutation(internal.billing.sovMigration.backfillSovState, { dryRun: true });
    expect(dry).toMatchObject({ approved: 1, drafts: 1 });
    expect(await t.run(async (ctx) => (await ctx.db.get(ids.quiet))?.sov ?? null)).toBeNull();
    await t.mutation(internal.billing.sovMigration.backfillSovState, {});
    const after = await t.run(async (ctx) => ({ quiet: await ctx.db.get(ids.quiet), billed: await ctx.db.get(ids.billed) }));
    expect(after.quiet?.sov?.status).toBe("draft");
    expect(after.billed?.sov?.status).toBe("approved");
  });
});
