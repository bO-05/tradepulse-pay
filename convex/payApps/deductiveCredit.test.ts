/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture } from "../lib/tenancyFixtures";
import { allocateApprovedTotal } from "./approvalAllocation";

const modules = import.meta.glob("/convex/**/*.ts");

const fetchSpy = vi.fn(async () => {
  throw new Error("network disabled in tests");
});
beforeEach(() => {
  vi.useFakeTimers();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SOV = [800_000, 640_000, 3_150_000, 3_820_000, 4_200_000, 2_860_000, 1_270_000, 500_000];

async function setup() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  const { agreementId, projectId } = f.gcA.project;
  const sov = await t.run(async (ctx) => {
    await ctx.db.patch(projectId, { billingDay: 25, startDate: "2026-10-01", retainageBps: 500, state: "CA" });
    await ctx.db.patch(agreementId, { contractSum: 172_400, contractSumCents: 17_240_000, retainagePercent: 5 });
    const ids: Id<"scheduleOfValues">[] = [];
    for (const [i, cents] of SOV.entries()) {
      ids.push(
        await ctx.db.insert("scheduleOfValues", { agreementId, lineNo: i + 1, description: `Line ${i + 1}`, scheduledValueCents: cents, excludedScope: false }),
      );
    }
    return ids;
  });
  const s = { t, f, agreementId, sov, gc: f.gcA.admin.as, sub: f.sub.admin.as };
  for (const [title, amountCents] of [
    ["Add 6 duplex receptacles", 875_000],
    ["Delete 2 exterior fixtures", -120_000],
  ] as const) {
    const { changeOrderId } = await s.sub.mutation(api.billing.changeOrders.createChangeOrder, { scope: "subcontract", agreementId, title, amountCents });
    await s.sub.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId });
    await s.gc.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId });
  }
  const creditLine = await t.run(async (ctx) =>
    (await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId).eq("lineNo", 10))
      .unique())!,
  );
  expect(creditLine.scheduledValueCents).toBe(-120_000);
  return { ...s, credit: creditLine._id };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const row = (s: Setup, id: Id<"payApplications">) => s.t.run(async (ctx) => (await ctx.db.get(id))!);

async function errorText(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return JSON.stringify((e as { data?: unknown }).data ?? String(e));
  }
  return "no error";
}

describe("deductive change-order credits on a G703 pay app", () => {
  test("$2,000.00 of work plus a -$1,200.00 credit: submit, review, approve, retainage and carry-forward all net the credit", async () => {
    const s = await setup();
    const { payAppId } = await s.sub.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    await s.sub.mutation(api.payApps.g703.saveDraft, {
      payAppId,
      lines: [
        { sovLineId: s.sov[0], workThisPeriodCents: 200_000, storedCents: 0 },
        { sovLineId: s.credit, workThisPeriodCents: -120_000, storedCents: 0, note: "CO #2 credit: 2 exterior fixtures deleted" },
      ],
    });
    const draft = await s.sub.query(api.payApps.g703.getPayApp, { payAppId });
    expect(draft.lineErrors).toEqual([]);
    expect(draft.canSubmit).toBe(true);

    // 5% retainage: 10,000 on the work, -6,000 on the credit. Earned 80,000 - 4,000 = 76,000 due.
    const submitted = await s.sub.mutation(api.payApps.g703.submitPayApp, { payAppId });
    expect(submitted.currentPaymentDueCents).toBe(76_000);
    let p = await row(s, payAppId);
    expect(p.requestedTotalCents).toBe(80_000);
    expect(p.lines.map((l) => [l.sovLineId, l.requestedCents])).toEqual([
      [s.sov[0], 200_000],
      [s.credit, -120_000],
    ]);
    expect(p.g703!.requested).toMatchObject({ completedAndStoredCents: 80_000, retainageCents: 4_000, currentPaymentDueCents: 76_000 });

    await s.t.action(internal.payApps.review.reviewPayApp, { payAppId });
    p = await row(s, payAppId);
    expect(p.status).toBe("reviewed");
    const reviewCredit = p.review!.lines.find((l) => l.sovLineId === s.credit)!;
    expect(reviewCredit).toMatchObject({ verdict: "ok", approvedCents: -120_000 });
    expect(p.review!.lines.find((l) => l.sovLineId === s.sov[0])!.approvedCents).toBe(200_000);
    expect(p.review!.approvedTotalCents).toBe(80_000);

    // The credit cannot be overridden away.
    expect(
      await errorText(
        s.gc.mutation(api.payApps.decisions.decidePayApp, {
          payAppId,
          decision: "approve",
          lines: [{ sovLineId: s.credit, action: "override", amountCents: 0, reason: "Drop the credit" }],
        }),
      ),
    ).toMatch(/deductive change-order credit.*applied in full/);

    const decided = await s.gc.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve" });
    expect(decided).toMatchObject({ status: "approved", approvedTotalCents: 80_000, currentPaymentDueCents: 76_000 });
    p = await row(s, payAppId);
    expect(p.finalApproval!.totalCents).toBe(80_000);
    expect(p.finalApproval!.lines.find((l) => l.sovLineId === s.credit)!.approvedCents).toBe(-120_000);
    expect(p.g703!.approved).toMatchObject({ completedAndStoredCents: 80_000, retainageCents: 4_000, currentPaymentDueCents: 76_000 });

    const view = await s.gc.query(api.payApps.g703.getPayApp, { payAppId });
    expect(view.basis).toBe("approved");
    expect(view.lines.find((l) => l.sovLineId === s.credit)).toMatchObject({ workThisPeriodCents: -120_000, requestedWorkCents: null });
    expect(view.summary.currentPaymentDueCents).toBe(76_000);

    // Next period: D carries the credit, previous certificates are the 76,000 certified, and the credit line is fully deducted.
    const { payAppId: nextId } = await s.sub.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    const next = await s.sub.query(api.payApps.g703.getPayApp, { payAppId: nextId });
    expect(next.lines.find((l) => l.sovLineId === s.credit)).toMatchObject({ previousWorkCents: -120_000, previousStoredCents: 0 });
    expect(next.lines.find((l) => l.sovLineId === s.sov[0])).toMatchObject({ previousWorkCents: 200_000 });
    expect(next.summary.previousCertificatesCents).toBe(76_000);
    expect(next.summary.previousWorkCents).toBe(80_000);
    await s.sub.mutation(api.payApps.g703.saveDraft, { payAppId: nextId, lines: [{ sovLineId: s.credit, workThisPeriodCents: -1, storedCents: 0 }] });
    expect((await s.sub.query(api.payApps.g703.getPayApp, { payAppId: nextId })).lineErrors[0].message).toMatch(/Line 10: at most \$0\.00 remains to deduct/);
  });

  test("a credit larger than the work billed with it is refused at submit", async () => {
    const s = await setup();
    const { payAppId } = await s.sub.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    const text = await errorText(
      s.sub.mutation(api.payApps.g703.submitPayApp, {
        payAppId,
        lines: [
          { sovLineId: s.sov[0], workThisPeriodCents: 100_000, storedCents: 0 },
          { sovLineId: s.credit, workThisPeriodCents: -120_000, storedCents: 0 },
        ],
      }),
    );
    expect(text).toMatch(/deductive change-order credits \(-\$1,200\.00\).*net requested is -\$200\.00/);
    expect((await row(s, payAppId)).status).toBe("draft");
  });
});

describe("allocating an approved total with credits", () => {
  const lines = [
    { sovLineId: "a", lineNo: 1, excludedScope: false, recommendedCents: 200_000, capCents: 200_000 },
    { sovLineId: "credit", lineNo: 10, excludedScope: false, recommendedCents: -120_000, capCents: -120_000 },
  ];
  test("the net total keeps the full credit and spreads the rest over the work lines", () => {
    expect(allocateApprovedTotal(lines, 80_000)).toEqual({
      ok: true,
      lines: [
        { sovLineId: "a", approvedCents: 200_000 },
        { sovLineId: "credit", approvedCents: -120_000 },
      ],
      totalCents: 80_000,
    });
    const down = allocateApprovedTotal(lines, 30_000);
    expect(down).toMatchObject({ ok: true, totalCents: 30_000 });
    expect(down.ok && down.lines).toEqual([
      { sovLineId: "a", approvedCents: 150_000 },
      { sovLineId: "credit", approvedCents: -120_000 },
    ]);
  });
  test("a net total above the work less the credits is refused", () => {
    expect(allocateApprovedTotal(lines, 80_001)).toMatchObject({ ok: false, maxCents: 80_000 });
  });
});
