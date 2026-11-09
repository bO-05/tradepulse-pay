/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture, insertProjectFor } from "../lib/tenancyFixtures";
import { weekEndOf } from "./projectMoney";

const modules = import.meta.glob("/convex/**/*.ts");
type T = TestConvex<typeof schema>;

/** Tuesday of the week ending Sunday 2026-11-15. */
const AS_OF = "2026-11-10T18:00:00.000Z";
const WEEK_END = "2026-11-15";
const PAID_AT = 1_791_500_000_000;

const ZERO_G702 = {
  originalContractSumCents: 0,
  netChangeOrdersCents: 0,
  contractSumToDateCents: 0,
  completedAndStoredCents: 0,
  retainageCents: 0,
  retainageWorkCents: 0,
  retainageStoredCents: 0,
  earnedLessRetainageCents: 0,
  previousCertificatesCents: 0,
  currentPaymentDueCents: 0,
  balanceToFinishInclRetainageCents: 0,
};

function g702(currentPaymentDueCents: number, retainageCents = 0) {
  return { ...ZERO_G702, currentPaymentDueCents, retainageCents };
}

async function insertOwnerApp(
  t: T,
  args: {
    projectId: Id<"projects">;
    createdBy: Id<"users">;
    applicationNo: number;
    status: "draft" | "submitted_to_owner" | "changes_requested" | "approved" | "approved_invoiced" | "paid";
    currentPaymentDueCents: number;
    retainageCents?: number;
    paypalInvoiceId?: string;
    paidAt?: number;
  },
): Promise<Id<"ownerPayApps">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("ownerPayApps", {
      projectId: args.projectId,
      applicationNo: args.applicationNo,
      periodStart: "2026-10-16",
      periodEnd: WEEK_END,
      status: args.status,
      lines: [],
      retainageBps: 1_000,
      figures: g702(args.currentPaymentDueCents, args.retainageCents ?? 0),
      pendingSubPayApps: 0,
      history: [],
      createdBy: args.createdBy,
      createdAt: now,
      updatedAt: now,
      ...(args.paypalInvoiceId !== undefined ? { paypalInvoiceId: args.paypalInvoiceId } : {}),
      ...(args.paidAt !== undefined ? { paidAt: args.paidAt } : {}),
    });
  });
}

async function insertPayment(
  t: T,
  args: {
    key: string;
    agreementId: Id<"agreements">;
    kind: "funding" | "payout" | "retainage_release";
    status: "authorized" | "pending" | "success" | "failed" | "returned";
    netCents: number;
    grossCents?: number;
    retainageCents?: number;
    payAppId?: Id<"payApplications">;
    payoutBatchId?: string;
  },
): Promise<Id<"payments">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("payments", {
      agreementId: args.agreementId,
      kind: args.kind,
      status: args.status,
      grossCents: args.grossCents ?? args.netCents,
      retainageCents: args.retainageCents ?? 0,
      netCents: args.netCents,
      idempotencyKey: `project-money-${args.key}`,
      createdAt: now,
      ...(args.payAppId !== undefined ? { payAppId: args.payAppId } : {}),
      ...(args.payoutBatchId !== undefined ? { paypalPayoutBatchId: args.payoutBatchId } : {}),
    });
  });
}

async function insertRetainage(
  t: T,
  args: { agreementId: Id<"agreements">; paymentId?: Id<"payments">; deltaCents: number; reason: string },
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("retainageLedger", {
      agreementId: args.agreementId,
      deltaCents: args.deltaCents,
      reason: args.reason,
      createdAt: Date.now(),
      ...(args.paymentId !== undefined ? { paymentId: args.paymentId } : {}),
    });
  });
}

async function insertPayApp(
  t: T,
  args: {
    agreementId: Id<"agreements">;
    subUserId: Id<"users">;
    applicationNo?: number;
    status: "draft" | "submitted" | "under_review" | "reviewed" | "approved" | "approved_as_noted" | "paid";
    finalApprovalTotalCents?: number;
    g703ApprovedDueCents?: number;
    periodEnd?: string;
    dueDate?: string;
    requestedTotalCents?: number;
  },
): Promise<Id<"payApplications">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("payApplications", {
      agreementId: args.agreementId,
      subUserId: args.subUserId,
      periodLabel: "Period 1",
      lines: [],
      requestedTotalCents: args.requestedTotalCents ?? 0,
      notes: "",
      lienWaiver: true,
      status: args.status,
      submittedBy: { userId: args.subUserId, actorType: "human" },
      createdAt: now,
      ...(args.applicationNo !== undefined ? { applicationNo: args.applicationNo } : {}),
      ...(args.periodEnd !== undefined ? { periodEnd: args.periodEnd } : {}),
      ...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}),
      ...(args.finalApprovalTotalCents !== undefined
        ? {
            finalApproval: {
              totalCents: args.finalApprovalTotalCents,
              lines: [],
              approvedBy: args.subUserId,
              approvedAt: now,
            },
          }
        : {}),
      ...(args.g703ApprovedDueCents !== undefined
        ? {
            g703: {
              lines: [],
              originalContractSumCents: 0,
              retainageBps: 500,
              previousCertificatesCents: 0,
              savedAt: now,
              approved: g702(args.g703ApprovedDueCents),
            },
          }
        : {}),
    });
  });
}

/**
 * Lopez-style rows on gcA's first project, a second gcA project and a gcB project:
 * - project A: Draw #1 paid 360000 (retainage 40000, invoice id, paidAt), Ortiz payout 380000
 *   net of 20000 retainage with batch id, a failed payout and a successful funding row that
 *   must not count, plus approved stamps of 50000 (G703) and 30000 (legacy fallback).
 * - project C: another gcA project with 100000 collected and a 50000 payout.
 * - project B: gcB's own money, which gcA must never see.
 */
async function seedMoney(t: T, f: Awaited<ReturnType<typeof buildTenancyFixture>>) {
  const createdBy = f.gcA.admin.userId;
  const { projectId, agreementId } = f.gcA.project;
  const secondProject = await t.run((ctx) =>
    insertProjectFor(ctx, f.gcA.companyId, { title: "Second Bayview job", subCompanyId: f.sub.companyId }),
  );

  await t.run(async (ctx) => {
    await ctx.db.insert("changeOrders", {
      projectId,
      scope: "prime",
      number: 1,
      title: "Add under-cabinet lighting",
      description: "Add under-cabinet lighting",
      amountCents: 120_000,
      status: "paid",
      paidAt: PAID_AT,
      createdAt: Date.now(),
    });
  });

  await insertOwnerApp(t, {
    projectId,
    createdBy,
    applicationNo: 1,
    status: "paid",
    currentPaymentDueCents: 360_000,
    retainageCents: 40_000,
    paypalInvoiceId: "INV2-TEST-DRAW-1",
    paidAt: PAID_AT,
  });
  await insertOwnerApp(t, {
    projectId: secondProject.projectId,
    createdBy,
    applicationNo: 1,
    status: "paid",
    currentPaymentDueCents: 100_000,
  });

  const paidPayApp = await insertPayApp(t, {
    agreementId,
    subUserId: createdBy,
    applicationNo: 1,
    status: "paid",
    finalApprovalTotalCents: 400_000,
    g703ApprovedDueCents: 400_000,
    periodEnd: "2026-11-01",
    dueDate: "2026-11-01",
  });
  const payout = await insertPayment(t, {
    key: "ortiz-payout",
    agreementId,
    kind: "payout",
    status: "success",
    netCents: 380_000,
    grossCents: 400_000,
    retainageCents: 20_000,
    payAppId: paidPayApp,
    payoutBatchId: "BATCH-ORTIZ-1",
  });
  await insertPayment(t, {
    key: "ortiz-payout-failed",
    agreementId,
    kind: "payout",
    status: "failed",
    netCents: 999_999,
    payAppId: paidPayApp,
  });
  await insertPayment(t, {
    key: "ortiz-funding",
    agreementId,
    kind: "funding",
    status: "authorized",
    netCents: 400_000,
    grossCents: 400_000,
  });
  await insertRetainage(t, { agreementId, paymentId: payout, deltaCents: 20_000, reason: "5% holdback on the approved pay app" });

  await insertPayApp(t, {
    agreementId,
    subUserId: createdBy,
    applicationNo: 2,
    status: "approved",
    finalApprovalTotalCents: 50_000,
    g703ApprovedDueCents: 50_000,
    periodEnd: "2026-11-08",
    dueDate: "2026-11-10",
  });
  await insertPayApp(t, {
    agreementId,
    subUserId: createdBy,
    applicationNo: 3,
    status: "approved_as_noted",
    finalApprovalTotalCents: 30_000,
    periodEnd: "2026-11-14",
  });
  await insertPayApp(t, {
    agreementId,
    subUserId: createdBy,
    applicationNo: 4,
    status: "approved",
    finalApprovalTotalCents: 70_000,
    g703ApprovedDueCents: 70_000,
    periodEnd: "2026-11-16",
    dueDate: "2026-11-16",
  });

  await insertOwnerApp(t, {
    projectId: secondProject.projectId,
    createdBy,
    applicationNo: 2,
    status: "approved",
    currentPaymentDueCents: 1,
  });
  await insertPayment(t, {
    key: "second-project-payout",
    agreementId: secondProject.agreementId,
    kind: "payout",
    status: "success",
    netCents: 50_000,
    payoutBatchId: "BATCH-SECOND-1",
  });
  await insertRetainage(t, { agreementId: secondProject.agreementId, deltaCents: 5_000, reason: "holdback" });

  const otherOwnerApp = await insertOwnerApp(t, {
    projectId: f.gcB.project.projectId,
    createdBy: f.gcB.admin.userId,
    applicationNo: 1,
    status: "paid",
    currentPaymentDueCents: 777_000,
    retainageCents: 7_000,
  });
  await insertPayment(t, {
    key: "other-gc-payout",
    agreementId: f.gcB.project.agreementId,
    kind: "payout",
    status: "success",
    netCents: 888_000,
    payoutBatchId: "BATCH-OTHER-1",
  });
  await insertRetainage(t, { agreementId: f.gcB.project.agreementId, deltaCents: 9_000, reason: "holdback" });
  return { secondProject, paidPayApp, otherOwnerApp };
}

async function setup() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  await t.run(async (ctx) => {
    await ctx.db.patch(f.gcA.project.projectId, {
      projectKind: "residential",
      billingDay: 15,
      retainageBps: 1_000,
      contractValueCents: 8_650_000,
    });
  });
  return { t, f };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(AS_OF));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("weekEndOf", () => {
  test("ends the Monday–Sunday week on its Sunday", () => {
    expect(weekEndOf(Date.UTC(2026, 10, 8))).toBe("2026-11-08"); // Sunday
    expect(weekEndOf(Date.UTC(2026, 10, 9))).toBe("2026-11-15"); // Monday
    expect(weekEndOf(Date.UTC(2026, 10, 14))).toBe("2026-11-15"); // Saturday
    expect(weekEndOf(Date.UTC(2026, 10, 15))).toBe("2026-11-15"); // Sunday
    expect(weekEndOf(Date.UTC(2026, 11, 16))).toBe("2026-12-20"); // Wednesday
  });
});

describe("getProjectMoney project scope", () => {
  test("composes collected, paid, retainage and owed from stored ledger rows", async () => {
    const { t, f } = await setup();
    await seedMoney(t, f);

    const money = await f.gcA.admin.as.query(api.billing.projectMoney.getProjectMoney, {
      projectId: f.gcA.project.projectId,
    });

    expect(money.asOf).toBe(Date.parse(AS_OF));
    expect(money.weekEnd).toBe(WEEK_END);
    expect(money.truncated).toBe(false);
    expect(money.scope).toMatchObject({
      kind: "project",
      projectId: f.gcA.project.projectId,
      projectTitle: "Harbor Point Dental Office TI",
      projectKind: "residential",
    });
    expect(money.scope.projects).toEqual([
      {
        projectId: f.gcA.project.projectId,
        projectTitle: "Harbor Point Dental Office TI",
        projectKind: "residential",
        ownerRetainageBps: 1_000,
      },
    ]);

    // Paid owner app only; the paid $1,200 prime change order is not in this bucket.
    expect(money.collectedFromOwnerCents).toBe(360_000);
    expect(money.receipts.ownerPayApps).toEqual([
      {
        projectId: f.gcA.project.projectId,
        ownerPayAppId: expect.any(String),
        applicationNo: 1,
        amountCents: 360_000,
        retainageCents: 40_000,
        paypalInvoiceId: "INV2-TEST-DRAW-1",
        paidAt: PAID_AT,
      },
    ]);

    // Successful payout net only: the failed payout and the funding authorization are excluded.
    expect(money.paidToSubsCents).toBe(380_000);
    expect(money.receipts.payouts).toEqual([
      {
        projectId: f.gcA.project.projectId,
        agreementId: f.gcA.project.agreementId,
        agreementNumber: expect.any(String),
        paymentId: expect.any(String),
        payAppId: expect.any(String),
        kind: "payout",
        payoutBatchId: "BATCH-ORTIZ-1",
        amountCents: 380_000,
        paidAt: expect.any(Number),
      },
    ]);

    // Sub retainage from the retainage ledger, kept apart from the owner's prime retainage.
    expect(money.retainageHeldCents).toBe(20_000);
    expect(money.receipts.retainage).toEqual([
      {
        projectId: f.gcA.project.projectId,
        agreementId: f.gcA.project.agreementId,
        agreementNumber: expect.any(String),
        payAppId: expect.any(String),
        amountCents: 20_000,
        retainageBps: 500,
      },
    ]);
    expect(money.ownerRetainageHeldCents).toBe(40_000);

    // Approved in-week G703 due 50000 + legacy no-G702 finalApproval 30000; the paid app and the
    // app due after the week end do not count.
    expect(money.owedThisWeekCents).toBe(80_000);
    expect(money.receipts.owed).toEqual([
      {
        projectId: f.gcA.project.projectId,
        payAppId: expect.any(String),
        agreementId: f.gcA.project.agreementId,
        agreementNumber: expect.any(String),
        dueDate: "2026-11-10",
        amountCents: 50_000,
      },
      {
        projectId: f.gcA.project.projectId,
        payAppId: expect.any(String),
        agreementId: f.gcA.project.agreementId,
        agreementNumber: expect.any(String),
        dueDate: "2026-11-14",
        amountCents: 30_000,
      },
    ]);
  });

  test("a successful retainage release is paid-to-subs money with its own payout batch receipt", async () => {
    const { t, f } = await setup();
    await insertPayment(t, {
      key: "ortiz-retainage-release",
      agreementId: f.gcA.project.agreementId,
      kind: "retainage_release",
      status: "success",
      netCents: 20_000,
      payoutBatchId: "BATCH-RETAINAGE-1",
    });

    const money = await f.gcA.admin.as.query(api.billing.projectMoney.getProjectMoney, {
      projectId: f.gcA.project.projectId,
    });
    expect(money.paidToSubsCents).toBe(20_000);
    expect(money.receipts.payouts).toEqual([
      {
        projectId: f.gcA.project.projectId,
        agreementId: f.gcA.project.agreementId,
        agreementNumber: expect.any(String),
        paymentId: expect.any(String),
        payAppId: null,
        kind: "retainage_release",
        payoutBatchId: "BATCH-RETAINAGE-1",
        amountCents: 20_000,
        paidAt: expect.any(Number),
      },
    ]);
    // The ledger row, not the release payment, is what reduces retainage held; no rows exist here.
    expect(money.retainageHeldCents).toBe(0);
  });

  test("prefers g703.approved over finalApproval for owed, and uses finalApproval without a G703", async () => {
    const { t, f } = await setup();
    const createdBy = f.gcA.admin.userId;
    const { agreementId } = f.gcA.project;
    const withG703 = await insertPayApp(t, {
      agreementId,
      subUserId: createdBy,
      status: "approved",
      finalApprovalTotalCents: 99_000,
      g703ApprovedDueCents: 40_000,
      dueDate: WEEK_END,
    });
    const legacy = await insertPayApp(t, {
      agreementId,
      subUserId: createdBy,
      status: "approved_as_noted",
      finalApprovalTotalCents: 30_000,
      periodEnd: "2026-11-09",
    });

    const money = await f.gcA.admin.as.query(api.billing.projectMoney.getProjectMoney, {
      projectId: f.gcA.project.projectId,
    });
    expect(money.owedThisWeekCents).toBe(70_000);
    expect(money.receipts.owed.map((row) => ({ payAppId: row.payAppId, amountCents: row.amountCents, dueDate: row.dueDate }))).toEqual([
      { payAppId: legacy, amountCents: 30_000, dueDate: "2026-11-09" },
      { payAppId: withG703, amountCents: 40_000, dueDate: WEEK_END },
    ]);
  });

  test("a project with no money returns honest zeros and no receipts", async () => {
    const { t, f } = await setup();
    const empty = await t.run((ctx) =>
      insertProjectFor(ctx, f.gcA.companyId, { title: "Empty Bayview job", subCompanyId: f.sub.companyId }),
    );

    const money = await f.gcA.admin.as.query(api.billing.projectMoney.getProjectMoney, { projectId: empty.projectId });
    expect(money).toMatchObject({
      collectedFromOwnerCents: 0,
      paidToSubsCents: 0,
      retainageHeldCents: 0,
      ownerRetainageHeldCents: 0,
      owedThisWeekCents: 0,
      truncated: false,
      scope: { kind: "project", projectTitle: "Empty Bayview job", projectKind: "commercial" },
    });
    expect(money.receipts).toEqual({ ownerPayApps: [], payouts: [], retainage: [], owed: [] });
  });
});

describe("getProjectMoney portfolio scope", () => {
  test("sums only the caller's GC projects and names each one", async () => {
    const { t, f } = await setup();
    await seedMoney(t, f);

    const money = await f.gcA.admin.as.query(api.billing.projectMoney.getProjectMoney, {});
    expect(money.asOf).toBe(Date.parse(AS_OF));
    expect(money.weekEnd).toBe(WEEK_END);
    expect(money.truncated).toBe(false);
    expect(money.scope).toMatchObject({ kind: "portfolio", projectId: null, projectTitle: null, projectKind: null });
    expect(money.scope.projects.map((p) => p.projectTitle).sort()).toEqual(["Harbor Point Dental Office TI", "Second Bayview job"]);
    expect(money.scope.projects.find((p) => p.projectTitle === "Harbor Point Dental Office TI")?.projectKind).toBe("residential");
    expect(money.scope.projects.find((p) => p.projectTitle === "Second Bayview job")?.projectKind).toBe("commercial");

    expect(money.collectedFromOwnerCents).toBe(460_000); // 360000 Lopez-style + 100000 second job
    expect(money.paidToSubsCents).toBe(430_000); // 380000 + 50000
    expect(money.retainageHeldCents).toBe(25_000); // 20000 + 5000
    expect(money.ownerRetainageHeldCents).toBe(40_000);
    expect(money.owedThisWeekCents).toBe(80_000);
    expect(money.receipts.ownerPayApps.map((row) => row.projectId)).not.toContain(f.gcB.project.projectId);
    expect(money.receipts.payouts.map((row) => row.payoutBatchId)).not.toContain("BATCH-OTHER-1");
  });

  test("another GC sees only its own project and cannot read gcA's project", async () => {
    const { t, f } = await setup();
    await seedMoney(t, f);

    await expect(
      f.gcB.admin.as.query(api.billing.projectMoney.getProjectMoney, { projectId: f.gcA.project.projectId }),
    ).rejects.toThrow(/Not found/);

    const own = await f.gcB.admin.as.query(api.billing.projectMoney.getProjectMoney, {});
    expect(own.scope.projects).toEqual([
      { projectId: f.gcB.project.projectId, projectTitle: "Camelback Suite 400", projectKind: "commercial", ownerRetainageBps: null },
    ]);
    expect(own.collectedFromOwnerCents).toBe(777_000);
    expect(own.paidToSubsCents).toBe(888_000);
    expect(own.retainageHeldCents).toBe(9_000);
    expect(own.ownerRetainageHeldCents).toBe(7_000);
    expect(own.receipts.ownerPayApps.map((row) => row.amountCents)).toEqual([777_000]);
  });

  test("a GC with no money answers zero for its own empty projects", async () => {
    const { t, f } = await setup();
    const empty = await t.run((ctx) => insertProjectFor(ctx, f.gcB.companyId, { title: "Camelback empty phase" }));

    const money = await f.gcB.admin.as.query(api.billing.projectMoney.getProjectMoney, {});
    expect(money.collectedFromOwnerCents).toBe(0);
    expect(money.paidToSubsCents).toBe(0);
    expect(money.retainageHeldCents).toBe(0);
    expect(money.owedThisWeekCents).toBe(0);
    expect(money.scope.projects.map((p) => p.projectId).sort()).toEqual([f.gcB.project.projectId, empty.projectId].sort());
  });
});

describe("getProjectMoney guards", () => {
  test("rejects unauthenticated callers, subs and owners", async () => {
    const { t, f } = await setup();
    await expect(t.query(api.billing.projectMoney.getProjectMoney, {})).rejects.toThrow(/Not authenticated/);
    await expect(f.sub.admin.as.query(api.billing.projectMoney.getProjectMoney, {})).rejects.toThrow(/Forbidden/);
    await expect(f.owner.admin.as.query(api.billing.projectMoney.getProjectMoney, {})).rejects.toThrow(/Forbidden/);
    await expect(
      f.owner.admin.as.query(api.billing.projectMoney.getProjectMoney, { projectId: f.gcA.project.projectId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a project id the caller is not the GC on reads Not found", async () => {
    const { f } = await setup();
    await expect(
      f.gcA.admin.as.query(api.billing.projectMoney.getProjectMoney, { projectId: f.gcB.project.projectId }),
    ).rejects.toThrow(/Not found/);
  });
});
