/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { signInAs } from "./lib/testIdentity";
import { buildTenancyFixture, insertProjectFor } from "./lib/tenancyFixtures";

const modules = import.meta.glob("/convex/**/*.ts");

type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  const agreement = await t.run(async (ctx) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_demo", (q) => q.eq("isDemoProject", true))
      .first();
    return (await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project!._id))
      .first())!;
  });
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  const sub1 = await signInAs(t, "sub", { email: "sub1@test.tradepulse", contractorId: agreement.contractorId! });
  return { t, sub1, agreement };
}

async function insertPayApp(
  t: T,
  agreement: Doc<"agreements">,
  userId: Id<"users">,
  periodLabel: string,
  status: Doc<"payApplications">["status"],
  createdAt: number,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("payApplications", {
      agreementId: agreement._id,
      contractorId: agreement.contractorId,
      subUserId: userId,
      periodLabel,
      lines: [],
      requestedTotalCents: 1_000,
      notes: "",
      lienWaiver: true,
      status,
      submittedBy: { userId, actorType: "human" },
      createdAt,
    }),
  );
}

type Sub = Awaited<ReturnType<typeof setup>>["sub1"];

async function page(sub: Sub, numItems: number, cursor: string | null = null) {
  return await sub.as.query(api.portal.mySubPayApps, { paginationOpts: { numItems, cursor } });
}

/** Every page in order, as usePaginatedQuery's "Show older" would load them. */
async function allPages(sub: Sub, numItems: number) {
  const rows = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const r = await page(sub, numItems, cursor);
    rows.push(...r.page);
    if (r.isDone) return rows;
    cursor = r.continueCursor;
  }
  throw new Error("pagination did not finish");
}

async function latestOutcome(sub: Sub) {
  return (await page(sub, 25)).page[0].outcome!;
}

describe("mySubPayApps history", () => {
  test("with more than 500 applications the newest is first and the oldest stays reachable and withdrawable", async () => {
    const { t, sub1, agreement } = await setup();
    const base = Date.now() - 1_000_000;
    const oldestId = await insertPayApp(t, agreement, sub1.userId, "Oldest", "submitted", base);
    await t.run(async (ctx) => {
      for (let i = 0; i < 520; i++) {
        await ctx.db.insert("payApplications", {
          agreementId: agreement._id,
          contractorId: agreement.contractorId,
          subUserId: sub1.userId,
          periodLabel: `Old #${i}`,
          lines: [],
          requestedTotalCents: 1_000,
          notes: "",
          lienWaiver: true,
          status: i % 2 === 0 ? "withdrawn" : "rejected",
          submittedBy: { userId: sub1.userId, actorType: "human" },
          createdAt: base + 1 + i,
        });
      }
    });
    const newestId = await insertPayApp(t, agreement, sub1.userId, "Newest", "submitted", base + 600);

    const first = await page(sub1, 25);
    expect(first.page).toHaveLength(25);
    expect(first.isDone).toBe(false);
    expect(first.page[0]).toMatchObject({ _id: newestId, periodLabel: "Newest", canWithdraw: true, submittedBy: { actorType: "human" } });

    const all = await allPages(sub1, 100);
    expect(all).toHaveLength(522);
    expect(new Set(all.map((p) => p._id)).size).toBe(522);
    const times = all.map((p) => p.createdAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(all.at(-1)).toMatchObject({ _id: oldestId, periodLabel: "Oldest", status: "submitted", canWithdraw: true });

    await sub1.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId: oldestId });
    expect((await allPages(sub1, 100)).at(-1)).toMatchObject({ _id: oldestId, status: "withdrawn", canWithdraw: false });
  });

  test("another contractor's sub and a sub without a contractor see no pay applications", async () => {
    const { t, sub1, agreement } = await setup();
    await insertPayApp(t, agreement, sub1.userId, "Mine", "submitted", Date.now());
    const other = await t.run(async (ctx) => (await ctx.db.query("contractors").collect()).find((c) => c._id !== agreement.contractorId)!._id);
    const sub2 = await signInAs(t, "sub", { email: "sub2@test.tradepulse", contractorId: other });
    expect((await page(sub2, 25)).page).toEqual([]);
    const loose = await signInAs(t, "sub", { email: "loose@test.tradepulse" });
    expect(await page(loose, 25)).toMatchObject({ page: [], isDone: true });
  });
});

describe("mySubPayApps across contractor relationships", () => {
  test("a sub company working for two GCs pages through both, and keeps the second after the first is removed", async () => {
    const t = convexTest(schema, modules);
    const fx = await buildTenancyFixture(t);
    const second = await t.run((ctx) =>
      insertProjectFor(ctx, fx.gcB.companyId, { title: "Camelback Suite 500", subCompanyId: fx.sub.companyId, bidderName: "Eastbay Electric" }),
    );
    const kim = fx.sub.admin;
    const agreements = await t.run(async (ctx) => ({
      first: (await ctx.db.get(fx.gcA.project.agreementId))!,
      second: (await ctx.db.get(second.agreementId))!,
    }));
    const base = Date.now();
    for (let i = 0; i < 3; i++) {
      await insertPayApp(t, agreements.first, kim.userId, `Bayview #${i}`, "submitted", base + 2 * i);
      await insertPayApp(t, agreements.second, kim.userId, `Sonoran #${i}`, "submitted", base + 2 * i + 1);
    }
    const all = await allPages(kim, 2);
    expect(all.map((p) => p.periodLabel)).toEqual(["Sonoran #2", "Bayview #2", "Sonoran #1", "Bayview #1", "Sonoran #0", "Bayview #0"]);

    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_company", (q) => q.eq("projectId", fx.gcA.project.projectId).eq("companyId", fx.sub.companyId))
        .collect();
      for (const r of rows) await ctx.db.patch(r._id, { status: "removed" });
    });
    expect((await allPages(kim, 2)).map((p) => p.periodLabel)).toEqual(["Sonoran #2", "Sonoran #1", "Sonoran #0"]);
    expect((await fx.gcB.admin.as.query(api.portal.mySubPayApps, { paginationOpts: { numItems: 10, cursor: null } }).catch(() => null))).toBeNull();
  });
});

describe("mySubPortal payout outcome", () => {
  test("UNCLAIMED shows as unclaimed with retainage held, then RETURNED shows returned with the ledger's zero hold", async () => {
    const { t, sub1, agreement } = await setup();
    const payAppId = await insertPayApp(t, agreement, sub1.userId, "Pay app #1", "approved", Date.now());
    const paymentId = await t.run(async (ctx) =>
      ctx.db.insert("payments", {
        agreementId: agreement._id,
        payAppId,
        kind: "payout",
        status: "created",
        grossCents: 100_000,
        retainageCents: 10_000,
        netCents: 90_000,
        receiverEmail: "sub1@test.tradepulse",
        idempotencyKey: "portal-test-payout",
        createdAt: Date.now(),
      }),
    );

    const created = await latestOutcome(sub1);
    expect(created).toMatchObject({ payoutStatus: "created", retainageHeldCents: null, retainageWithheldCents: 10_000 });

    await t.mutation(internal.payments.payoutDb.recordPayoutCreated, {
      paymentId,
      batchId: "BATCH-1",
      auditRecorded: true,
      duplicate: false,
    });
    await t.mutation(internal.payments.payoutDb.applyPayoutStatus, {
      paymentId,
      status: "unclaimed",
      itemStatus: "UNCLAIMED",
    });
    const unclaimed = await latestOutcome(sub1);
    expect(unclaimed).toMatchObject({
      payoutStatus: "unclaimed",
      paypalItemStatus: "UNCLAIMED",
      netPaid: false,
      approvedGrossCents: 100_000,
      retainageHeldCents: 10_000,
      netCents: 90_000,
    });

    await t.mutation(internal.payments.payoutDb.applyPayoutStatus, {
      paymentId,
      status: "returned",
      itemStatus: "RETURNED",
    });
    const returned = await latestOutcome(sub1);
    expect(returned).toMatchObject({
      payoutStatus: "returned",
      paypalItemStatus: "RETURNED",
      netPaid: false,
      retainageHeldCents: 0,
      retainageWithheldCents: 10_000,
    });
    const ledger = await t.run(async (ctx) =>
      ctx.db
        .query("retainageLedger")
        .withIndex("by_paymentId", (q) => q.eq("paymentId", paymentId))
        .collect(),
    );
    expect(ledger.reduce((a, r) => a + r.deltaCents, 0)).toBe(returned.retainageHeldCents);
  });

  test("a RETURNED payout followed by a FAILED retry shows Failed with the ledger's zero hold", async () => {
    const { t, sub1, agreement } = await setup();
    const payAppId = await insertPayApp(t, agreement, sub1.userId, "Pay app #1", "approved", Date.now());
    const payout = (key: string, retryOf?: Id<"payments">) =>
      t.run(async (ctx) =>
        ctx.db.insert("payments", {
          agreementId: agreement._id,
          payAppId,
          kind: "payout",
          status: "created",
          grossCents: 100_000,
          retainageCents: 10_000,
          netCents: 90_000,
          receiverEmail: "sub1@test.tradepulse",
          idempotencyKey: key,
          ...(retryOf ? { retryOfPaymentId: retryOf } : {}),
          createdAt: Date.now(),
        }),
      );
    const originalId = await payout("portal-test-returned");
    await t.mutation(internal.payments.payoutDb.recordPayoutCreated, { paymentId: originalId, batchId: "BATCH-R", auditRecorded: true, duplicate: false });
    await t.mutation(internal.payments.payoutDb.applyPayoutStatus, { paymentId: originalId, status: "returned", itemStatus: "RETURNED" });
    expect(await latestOutcome(sub1)).toMatchObject({ payoutStatus: "returned", retainageHeldCents: 0 });

    vi.advanceTimersByTime(60_000);
    const retryId = await payout("portal-test-returned-r1", originalId);
    await t.mutation(internal.payments.payoutDb.recordPayoutCreated, { paymentId: retryId, batchId: "BATCH-F", auditRecorded: true, duplicate: false });
    expect(await latestOutcome(sub1)).toMatchObject({ payoutStatus: "pending", retainageHeldCents: 10_000 });
    await t.mutation(internal.payments.payoutDb.applyPayoutStatus, { paymentId: retryId, status: "failed", itemStatus: "FAILED" });

    const failed = await latestOutcome(sub1);
    expect(failed).toMatchObject({
      payoutStatus: "failed",
      paypalItemStatus: "FAILED",
      netPaid: false,
      approvedGrossCents: 100_000,
      retainageHeldCents: 0,
      netCents: 90_000,
    });
    const ledger = await t.run(async (ctx) => ctx.db.query("retainageLedger").collect());
    expect(ledger.reduce((a, r) => a + r.deltaCents, 0)).toBe(0);
  });
});

describe("mySubPortal milestone funding", () => {
  async function fundFirstMilestone(t: T, agreementId: Id<"agreements">, status: "authorized" | "partially_captured", capturedCents = 0) {
    return await t.run(async (ctx) => {
      const milestone = (await ctx.db
        .query("milestones")
        .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId))
        .first())!;
      await ctx.db.patch(milestone._id, { status: "funded" });
      const existing = (await ctx.db
        .query("payments")
        .withIndex("by_milestoneId", (q) => q.eq("milestoneId", milestone._id))
        .collect()).find((p) => p.kind === "funding");
      if (existing) {
        await ctx.db.patch(existing._id, { status, capturedCents });
      } else {
        const now = Date.now();
        await ctx.db.insert("payments", {
          agreementId,
          milestoneId: milestone._id,
          kind: "funding",
          status,
          paypalOrderId: "PORTAL-ORDER-1",
          paypalAuthorizationId: "PORTAL-AUTH-1",
          authorizationExpiresAt: now + 29 * 86_400_000,
          honorPeriodEndsAt: now + 3 * 86_400_000,
          grossCents: milestone.amountCents,
          retainageCents: 0,
          netCents: milestone.amountCents,
          capturedCents,
          idempotencyKey: "portal-funding",
          createdAt: now,
        });
      }
      return milestone;
    });
  }

  test("sub1 sees each milestone's name, amount and funding state, and it follows the funding row", async () => {
    const { t, sub1, agreement } = await setup();
    const before = await sub1.as.query(api.portal.mySubPortal, {});
    expect(before.milestoneFunding.map((a) => a.agreementId)).toEqual([agreement._id]);
    const rows = before.milestoneFunding[0].milestones;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((m) => m.state === "not_funded" && m.amountCents > 0 && m.name.length > 0)).toBe(true);

    const milestone = await fundFirstMilestone(t, agreement._id, "authorized");
    const funded = (await sub1.as.query(api.portal.mySubPortal, {})).milestoneFunding[0].milestones;
    expect(funded[0]).toMatchObject({ _id: milestone._id, name: milestone.name, amountCents: milestone.amountCents, state: "funded" });
    expect(funded.slice(1).every((m) => m.state === "not_funded")).toBe(true);

    await fundFirstMilestone(t, agreement._id, "partially_captured", 1_000);
    const captured = (await sub1.as.query(api.portal.mySubPortal, {})).milestoneFunding[0].milestones;
    expect(captured[0]).toMatchObject({ state: "captured", capturedCents: 1_000 });

    const detail = await sub1.as.query(api.portal.getAgreementSummary, { agreementId: agreement._id });
    expect(detail?.milestones[0]).toMatchObject({ _id: milestone._id, state: "captured" });
  });

  test("sub2 sees none of sub1's milestones in its portal or through the agreement detail", async () => {
    const { t, agreement } = await setup();
    await fundFirstMilestone(t, agreement._id, "authorized");
    const other = await t.run(async (ctx) => (await ctx.db.query("contractors").collect()).find((c) => c._id !== agreement.contractorId)!._id);
    const sub2 = await signInAs(t, "sub", { email: "sub2@test.tradepulse", contractorId: other });
    const portal = await sub2.as.query(api.portal.mySubPortal, {});
    expect(portal.milestoneFunding).toEqual([]);
    expect(JSON.stringify(portal)).not.toContain(agreement._id);
    expect(await sub2.as.query(api.portal.getAgreementSummary, { agreementId: agreement._id })).toBeNull();
    const loose = await signInAs(t, "sub", { email: "loose@test.tradepulse" });
    expect((await loose.as.query(api.portal.mySubPortal, {})).milestoneFunding).toEqual([]);
  });
});
