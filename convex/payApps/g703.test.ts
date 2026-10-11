/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture, type FixtureUser } from "../lib/tenancyFixtures";
import { insertTestSession } from "../lib/testIdentity";

const modules = import.meta.glob("/convex/**/*.ts");
type T = TestConvex<typeof schema>;

// Submitting schedules the AI review; fake timers keep it from running mid-test.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const SOV = [
  ["Mobilization & general conditions", "26 01 00", 800_000],
  ["Temporary power & lighting", "26 05 00", 640_000],
  ["Underground & slab conduit rough-in", "26 05 33", 3_150_000],
  ["Branch wiring rough-in", "26 05 19", 3_820_000],
  ["Switchboard & panelboards", "26 24 00", 4_200_000],
  ["Lighting fixtures & controls", "26 51 00", 2_860_000],
  ["Devices & trim-out", "26 27 26", 1_270_000],
  ["Testing, closeout & as-builts", "26 08 00", 500_000],
] as const;

async function setup() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  const { agreementId, projectId } = f.gcA.project;
  const extra = await t.run(async (ctx) => {
    await ctx.db.patch(projectId, { billingDay: 25, startDate: "2026-10-01", retainageBps: 500, state: "CA" });
    await ctx.db.patch(agreementId, { contractSum: 172_400, contractSumCents: 17_240_000, retainagePercent: 5 });
    const sov: Id<"scheduleOfValues">[] = [];
    for (const [i, [description, csiCode, cents]] of SOV.entries()) {
      sov.push(
        await ctx.db.insert("scheduleOfValues", {
          agreementId,
          lineNo: i + 1,
          description,
          csiCode,
          scheduledValueCents: cents,
          excludedScope: false,
        }),
      );
    }
    // A second sub on the same project, for sub-versus-sub denial checks.
    const lakeshore = await ctx.db.insert("companies", { name: "Lakeshore Mechanical", kind: "sub", isDemo: false, createdAt: Date.now() });
    const lakeUser = await ctx.db.insert("users", { email: "pat@lakeshore.test", emailVerificationTime: Date.now() });
    await ctx.db.insert("userProfiles", {
      userId: lakeUser,
      role: "sub",
      displayName: "Pat",
      actorType: "human",
      companyId: lakeshore,
      createdAt: Date.now(),
    });
    await ctx.db.insert("companyMembers", { companyId: lakeshore, userId: lakeUser, role: "admin", status: "active", createdAt: Date.now() });
    const pkg = (await ctx.db.get(f.gcA.project.tradePackageId))!;
    const lakeContractor = await ctx.db.insert("contractors", {
      tradePackageId: pkg._id,
      companyName: "Lakeshore Mechanical",
      contactEmail: "bids@lakeshore.invalid",
      licenseNumber: "0",
      licenseStatus: "Unverified",
      sourceUrl: "https://example.invalid",
      rfqStatus: "bid_received",
      linkedCompanyId: lakeshore,
    });
    await ctx.db.insert("projectMembers", {
      projectId,
      companyId: lakeshore,
      partyRole: "sub",
      contractorId: lakeContractor,
      status: "active",
      createdAt: Date.now(),
    });
    const session = await insertTestSession(ctx, lakeUser);
    return { sov, lakeUser, session };
  });
  const lakeshore = t.withIdentity({ subject: `${extra.lakeUser}|${extra.session}`, email: "pat@lakeshore.test" });
  return { t, f, agreementId, projectId, sov: extra.sov, lakeshore };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function entry(sovLineId: Id<"scheduleOfValues">, workThisPeriodCents: number, storedCents = 0, note?: string) {
  return { sovLineId, workThisPeriodCents, storedCents, ...(note ? { note } : {}) };
}

const v1Entries = (sov: Id<"scheduleOfValues">[]) => [
  entry(sov[0], 800_000),
  entry(sov[1], 480_010),
  entry(sov[2], 1_400_000),
  entry(sov[4], 0, 1_800_000, "Switchboard delivered, stored in locked conex on site"),
];

/** Stands in for the GC's per-line decision (a later feature): line 3 approved at 12,612.50. */
async function approvePayApp1(t: T, payAppId: Id<"payApplications">, sov: Id<"scheduleOfValues">[], approvedBy: Id<"users">) {
  const lines = [
    { sovLineId: sov[0], approvedCents: 800_000 },
    { sovLineId: sov[1], approvedCents: 480_010 },
    { sovLineId: sov[2], approvedCents: 1_261_250 },
    { sovLineId: sov[4], approvedCents: 1_800_000 },
  ];
  await t.run(async (ctx) => {
    await ctx.db.patch(payAppId, {
      status: "approved",
      finalApproval: { totalCents: 4_341_260, lines, approvedBy, approvedAt: Date.now() },
    });
  });
}

async function submitPayApp1(s: Setup) {
  const kim = s.f.sub.admin.as;
  const { payAppId } = await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
  await kim.mutation(api.payApps.g703.saveDraft, { payAppId, lines: v1Entries(s.sov) });
  await kim.mutation(api.payApps.g703.submitPayApp, { payAppId });
  return payAppId;
}

describe("G703 drafts", () => {
  test("pay app 1 opens on the project billing day and autosaves its entries", async () => {
    const s = await setup();
    const kim = s.f.sub.admin.as;
    const { payAppId, created } = await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    expect(created).toBe(true);
    // Idempotent: the open draft is returned instead of a second one.
    expect(await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId })).toEqual({ payAppId, created: false });

    await kim.mutation(api.payApps.g703.saveDraft, { payAppId, lines: [entry(s.sov[0], 800_000), entry(s.sov[1], 480_010)] });
    const view = await kim.query(api.payApps.g703.getPayApp, { payAppId });
    expect(view).toMatchObject({
      status: "draft",
      applicationNo: 1,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-25",
      dueDate: "2026-10-25",
      editable: true,
    });
    expect(view.lines.map((l) => l.workThisPeriodCents)).toEqual([800_000, 480_010, 0, 0, 0, 0, 0, 0]);
    expect(view.lines.every((l) => l.previousWorkCents === 0)).toBe(true);

    // The draft is the sub's: the GC neither opens it nor sees it in the billing worklist.
    await expect(s.f.gcA.admin.as.query(api.payApps.g703.getPayApp, { payAppId })).rejects.toThrow(/Not found/);
    const worklist = await s.f.gcA.admin.as.query(api.payApps.g703.gcBillingWorklist, {});
    expect(worklist.rows).toHaveLength(0);
    expect(await s.t.run(async (ctx) => (await ctx.db.query("notifications").collect()).length)).toBe(0);
  });

  test("the continuation sheet and G702 figures for pay app 1 version 1 are exact", async () => {
    const s = await setup();
    const kim = s.f.sub.admin.as;
    const { payAppId } = await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    await kim.mutation(api.payApps.g703.saveDraft, { payAppId, lines: v1Entries(s.sov) });
    const view = await kim.query(api.payApps.g703.getPayApp, { payAppId });
    expect(view.lines[4].note).toBe("Switchboard delivered, stored in locked conex on site");
    expect(view.summary).toMatchObject({
      contractSumToDateCents: 17_240_000,
      workThisPeriodCents: 2_680_010,
      storedCents: 1_800_000,
      completedAndStoredCents: 4_480_010,
      balanceToFinishCents: 12_759_990,
      retainageCents: 224_001,
      previousCertificatesCents: 0,
      currentPaymentDueCents: 4_256_009,
    });
    expect(view.lineErrors).toEqual([]);
    expect(view.canSubmit).toBe(true);
  });
});

describe("G703 submit", () => {
  test("submitting locks entries, records human attribution and notifies only the GC company", async () => {
    const s = await setup();
    const payAppId = await submitPayApp1(s);
    const row = await s.t.run(async (ctx) => ctx.db.get(payAppId));
    expect(row).toMatchObject({
      status: "submitted",
      requestedTotalCents: 4_480_010,
      submittedBy: { userId: s.f.sub.admin.userId, actorType: "human" },
    });
    expect(row!.g703!.requested).toMatchObject({ retainageCents: 224_001, currentPaymentDueCents: 4_256_009 });
    // Phase-1 lines hold the per-line increments, so review and billing history keep working.
    expect(row!.lines.map((l) => l.requestedCents)).toEqual([800_000, 480_010, 1_400_000, 1_800_000]);

    await expect(
      s.f.sub.admin.as.mutation(api.payApps.g703.saveDraft, { payAppId, lines: [entry(s.sov[0], 1)] }),
    ).rejects.toThrow(/locked/);
    const subView = await s.f.sub.admin.as.query(api.payApps.g703.getPayApp, { payAppId });
    expect(subView).toMatchObject({ editable: false, canSubmit: false, canWithdraw: true });

    const notes = await s.t.run(async (ctx) => ctx.db.query("notifications").collect());
    expect(notes.map((n) => n.userId).sort()).toEqual([s.f.gcA.admin.userId, s.f.gcA.member.userId].sort());
    for (const n of notes) {
      expect(n).toMatchObject({
        kind: "pay_app_submitted",
        companyId: s.f.gcA.companyId,
        title: "Eastbay Electric submitted pay app #1 – $42,560.09",
        link: `#/pay-apps/${payAppId}`,
      });
    }
    // The bell's unread count reads the new rows.
    const bell = await s.f.gcA.admin.as.query(api.notifications.summary, {});
    expect(bell.unreadCount).toBe(1);
    expect(bell.latest[0]).toMatchObject({ title: "Eastbay Electric submitted pay app #1 – $42,560.09", link: `#/pay-apps/${payAppId}` });
    for (const who of [s.f.sub.admin.as, s.f.owner.admin.as, s.f.gcB.admin.as, s.lakeshore]) {
      expect((await who.query(api.notifications.summary, {})).unreadCount).toBe(0);
    }

    const worklist = await s.f.gcA.admin.as.query(api.payApps.g703.gcBillingWorklist, {});
    expect(worklist.rows).toHaveLength(1);
    expect(worklist.rows[0]).toMatchObject({ applicationNo: 1, status: "submitted", subName: "Eastbay Electric", currentPaymentDueCents: 4_256_009 });
  });

  test("over 100% on a line is refused by the server, exactly 100% is accepted", async () => {
    const s = await setup();
    const payAppId = await submitPayApp1(s);
    await approvePayApp1(s.t, payAppId, s.sov, s.f.gcA.admin.userId);
    const kim = s.f.sub.admin.as;
    const { payAppId: app2 } = await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });

    await expect(
      kim.mutation(api.payApps.g703.submitPayApp, { payAppId: app2, lines: [entry(s.sov[1], 160_000)] }),
    ).rejects.toThrow(/Line 2: at most \$1,599\.90 remains; this is \$0\.10 over 100%/);
    await expect(
      kim.mutation(api.payApps.g703.submitPayApp, { payAppId: app2, lines: [entry(s.sov[0], 1)] }),
    ).rejects.toThrow(/Line 1: at most \$0\.00 remains/);
    await expect(
      kim.mutation(api.payApps.g703.submitPayApp, { payAppId: app2, lines: [entry(s.sov[4], 1_500_000, 3_000_000)] }),
    ).rejects.toThrow(/Line 5: at most \$42,000\.00 remains/);
    await expect(
      kim.mutation(api.payApps.g703.saveDraft, { payAppId: app2, lines: [entry(s.sov[3], -1)] }),
    ).rejects.toThrow(/cannot be negative/);

    // Draft keeps over-100% values with inline errors so the sub can fix them.
    await kim.mutation(api.payApps.g703.saveDraft, { payAppId: app2, lines: [entry(s.sov[1], 160_000)] });
    const bad = await kim.query(api.payApps.g703.getPayApp, { payAppId: app2 });
    expect(bad.canSubmit).toBe(false);
    expect(bad.lineErrors.map((e) => e.message)).toEqual([
      "Line 2: at most $1,599.90 remains; this is $0.10 over 100% of the scheduled value.",
    ]);

    await kim.mutation(api.payApps.g703.saveDraft, { payAppId: app2, lines: [entry(s.sov[1], 159_990)] });
    const ok = await kim.query(api.payApps.g703.getPayApp, { payAppId: app2 });
    expect(ok.lineErrors).toEqual([]);
    const line2 = ok.lines[1];
    expect(line2.previousWorkCents + line2.workThisPeriodCents + line2.storedCents).toBe(640_000);
    await kim.mutation(api.payApps.g703.submitPayApp, { payAppId: app2 });
  });
});

describe("G703 approval, carry-forward and periods", () => {
  test("approved pay app 1 G702 uses the approved amounts for the GC and the sub", async () => {
    const s = await setup();
    const payAppId = await submitPayApp1(s);
    await approvePayApp1(s.t, payAppId, s.sov, s.f.gcA.admin.userId);
    for (const who of [s.f.gcA.admin.as, s.f.sub.admin.as]) {
      const view = await who.query(api.payApps.g703.getPayApp, { payAppId });
      expect(view.basis).toBe("approved");
      expect(view.summary).toMatchObject({
        originalContractSumCents: 17_240_000,
        netChangeOrdersCents: 0,
        contractSumToDateCents: 17_240_000,
        completedAndStoredCents: 4_341_260,
        retainageCents: 217_064,
        retainageWorkCents: 127_064,
        retainageStoredCents: 90_000,
        earnedLessRetainageCents: 4_124_196,
        previousCertificatesCents: 0,
        currentPaymentDueCents: 4_124_196,
        balanceToFinishInclRetainageCents: 13_115_804,
      });
      expect(view.lines[2]).toMatchObject({ workThisPeriodCents: 1_261_250, requestedWorkCents: 1_400_000 });
    }
    // Withdraw is gone after the GC decision and refused by the server.
    const subView = await s.f.sub.admin.as.query(api.payApps.g703.getPayApp, { payAppId });
    expect(subView.canWithdraw).toBe(false);
    await expect(s.f.sub.admin.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId })).rejects.toThrow(
      /awaiting a GC decision/,
    );
  });

  test("pay app 2 opens right after approval with D, stored F and previous certificates carried forward", async () => {
    const s = await setup();
    const payAppId = await submitPayApp1(s);
    const kim = s.f.sub.admin.as;
    // While pay app 1 awaits a decision, "New pay app" reopens it.
    expect((await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId })).payAppId).toBe(payAppId);
    await approvePayApp1(s.t, payAppId, s.sov, s.f.gcA.admin.userId);
    // CO #1 as a ninth line (change orders are their own feature).
    const line9 = await s.t.run(async (ctx) =>
      ctx.db.insert("scheduleOfValues", {
        agreementId: s.agreementId,
        lineNo: 9,
        description: "CO #1 Add 6 dedicated 20A circuits for dental chairs",
        scheduledValueCents: 875_000,
        excludedScope: false,
      }),
    );
    const { payAppId: app2, created } = await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    expect(created).toBe(true);
    const fresh = await kim.query(api.payApps.g703.getPayApp, { payAppId: app2 });
    expect(fresh).toMatchObject({ applicationNo: 2, periodStart: "2026-10-26", periodEnd: "2026-11-25", dueDate: "2026-11-25" });
    expect(fresh.lines.map((l) => l.previousWorkCents)).toEqual([800_000, 480_010, 1_261_250, 0, 0, 0, 0, 0, 0]);
    expect(fresh.lines[4]).toMatchObject({ previousStoredCents: 1_800_000, storedCents: 1_800_000 });
    expect(fresh.summary.previousWorkCents).toBe(2_541_260);
    expect(fresh.summary.previousCertificatesCents).toBe(4_124_196);

    await kim.mutation(api.payApps.g703.saveDraft, {
      payAppId: app2,
      lines: [
        entry(s.sov[1], 159_990),
        entry(s.sov[2], 945_000),
        entry(s.sov[3], 1_910_000),
        entry(s.sov[4], 1_500_000, 600_000),
        entry(s.sov[5], 0, 950_000),
        entry(line9, 437_500),
      ],
    });
    const v2 = await kim.query(api.payApps.g703.getPayApp, { payAppId: app2 });
    expect(v2.lineErrors).toEqual([]);
    expect(v2.summary).toMatchObject({
      contractSumToDateCents: 18_115_000,
      netChangeOrdersCents: 875_000,
      previousWorkCents: 2_541_260,
      workThisPeriodCents: 4_952_490,
      storedCents: 1_550_000,
      completedAndStoredCents: 9_043_750,
      balanceToFinishCents: 9_071_250,
      retainageCents: 452_188,
      earnedLessRetainageCents: 8_591_562,
      previousCertificatesCents: 4_124_196,
      currentPaymentDueCents: 4_467_366,
      balanceToFinishInclRetainageCents: 9_523_438,
    });
    await kim.mutation(api.payApps.g703.submitPayApp, { payAppId: app2 });
    const row = await s.t.run(async (ctx) => ctx.db.get(app2));
    // Line 5's increment is 15,000.00 + 6,000.00 − 18,000.00 carried in = 3,000.00.
    expect(row!.lines.find((l) => l.sovLineId === s.sov[4])!.requestedCents).toBe(300_000);
    expect(row!.requestedTotalCents).toBe(9_043_750 - 4_341_260);
  });

  test("a billing-day change applies to periods not yet created only", async () => {
    const s = await setup();
    const payAppId = await submitPayApp1(s);
    await approvePayApp1(s.t, payAppId, s.sov, s.f.gcA.admin.userId);
    await s.t.run(async (ctx) => ctx.db.patch(s.projectId, { billingDay: 20 }));
    const { payAppId: app2 } = await s.f.sub.admin.as.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    const [one, two] = await s.t.run(async (ctx) => [await ctx.db.get(payAppId), await ctx.db.get(app2)]);
    expect(one).toMatchObject({ periodEnd: "2026-10-25", dueDate: "2026-10-25" });
    expect(two).toMatchObject({ periodStart: "2026-10-26", periodEnd: "2026-11-20", dueDate: "2026-11-20" });
  });

  test("withdrawing before a decision leaves the queue and reopens the same period", async () => {
    const s = await setup();
    const payAppId = await submitPayApp1(s);
    await s.f.sub.admin.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId });
    const worklist = await s.f.gcA.admin.as.query(api.payApps.g703.gcBillingWorklist, {});
    expect(worklist.rows.filter((r) => r.awaitingReview)).toHaveLength(0);
    const proposals = await s.t.run(async (ctx) =>
      (await ctx.db.query("agentProposals").collect()).filter((p) => p.payAppId === payAppId && p.status !== "cancelled"),
    );
    expect(proposals).toHaveLength(0);
    const { payAppId: again, created } = await s.f.sub.admin.as.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    expect(created).toBe(true);
    const view = await s.f.sub.admin.as.query(api.payApps.g703.getPayApp, { payAppId: again });
    expect(view).toMatchObject({ applicationNo: 1, periodStart: "2026-10-01", periodEnd: "2026-10-25" });
  });
});

describe("G703 isolation", () => {
  async function submitted() {
    const s = await setup();
    const payAppId = await submitPayApp1(s);
    return { ...s, payAppId };
  }

  test("other sub, other GC company, owner and Demo GC get Not found", async () => {
    const s = await submitted();
    const outsiders: FixtureUser["as"][] = [s.lakeshore, s.f.gcB.admin.as, s.f.owner.admin.as, s.f.demo.gc.as, s.f.noCompany.as];
    for (const who of outsiders) {
      await expect(who.query(api.payApps.g703.getPayApp, { payAppId: s.payAppId })).rejects.toThrow(/Not found/);
      await expect(who.query(api.payApps.g703.payAppLines, { payAppId: s.payAppId })).rejects.toThrow(/Not found/);
      const reviewList = await who
        .query(api.payApps.review.listAgreementPayApps, { agreementId: s.agreementId })
        .catch((e: unknown) => String(e));
      expect(Array.isArray(reviewList) ? reviewList.length === 0 : /Not found/.test(reviewList)).toBe(true);
      await expect(who.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId })).rejects.toThrow(/Not found/);
      await expect(
        who.mutation(api.payApps.g703.saveDraft, { payAppId: s.payAppId, lines: [entry(s.sov[0], 1)] }),
      ).rejects.toThrow(/Not found/);
      await expect(who.mutation(api.payApps.g703.submitPayApp, { payAppId: s.payAppId })).rejects.toThrow(/Not found/);
    }
    await expect(s.t.query(api.payApps.g703.getPayApp, { payAppId: s.payAppId })).rejects.toThrow();
    // The GC may read it but never edit the sub's entries.
    await expect(s.f.gcA.admin.as.mutation(api.payApps.g703.saveDraft, { payAppId: s.payAppId })).rejects.toThrow(/Not found/);

    const lakeList = JSON.stringify(await s.lakeshore.query(api.payApps.g703.mySubPayAppAgreements, {}));
    expect(lakeList).not.toContain(s.payAppId);
    expect(lakeList).not.toContain(s.agreementId);
    for (const who of [s.f.gcB.admin.as, s.f.demo.gc.as]) {
      const list = JSON.stringify(await who.query(api.payApps.g703.gcBillingWorklist, {}));
      expect(list).not.toContain(s.payAppId);
      expect(list).not.toContain("Harbor Point");
    }
    await expect(s.f.owner.admin.as.query(api.payApps.g703.gcBillingWorklist, {})).rejects.toThrow(/Forbidden|Not found/);
    await expect(s.f.owner.admin.as.query(api.payApps.g703.mySubPayAppAgreements, {})).rejects.toThrow(/Forbidden|Not found/);
  });

  test("the sub's own list shows the agreement with its open pay app", async () => {
    const s = await submitted();
    const list = await s.f.sub.admin.as.query(api.payApps.g703.mySubPayAppAgreements, {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ agreementId: s.agreementId, blockedReason: null, nextApplication: null });
    expect(list[0].openPayApp).toMatchObject({ _id: s.payAppId, applicationNo: 1, status: "submitted", currentPaymentDueCents: 4_256_009 });
  });
});
