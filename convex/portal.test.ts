/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { signInAs } from "./lib/testIdentity";

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

describe("mySubPortal history", () => {
  test("with more than 100 applications the newest is listed first, withdrawable, and older ones load on request", async () => {
    const { t, sub1, agreement } = await setup();
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 105; i++) {
      await insertPayApp(t, agreement, sub1.userId, `Old #${i}`, "withdrawn", base + i);
    }
    const newestId = await insertPayApp(t, agreement, sub1.userId, "Newest", "submitted", base + 500);

    const first = await sub1.as.query(api.portal.mySubPortal, {});
    expect(first.payApplications[0]).toMatchObject({
      _id: newestId,
      periodLabel: "Newest",
      status: "submitted",
      canWithdraw: true,
      submittedBy: { actorType: "human" },
    });
    expect(first.payApplications.length).toBeLessThan(106);
    expect(first.hasMore).toBe(true);

    await sub1.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId: newestId });
    const after = await sub1.as.query(api.portal.mySubPortal, {});
    expect(after.payApplications[0]).toMatchObject({ _id: newestId, status: "withdrawn", canWithdraw: false });

    const all = await sub1.as.query(api.portal.mySubPortal, { limit: 200 });
    expect(all.payApplications).toHaveLength(106);
    expect(all.hasMore).toBe(false);
    expect(all.payApplications.at(-1)!.periodLabel).toBe("Old #0");
    const times = all.payApplications.map((p) => p.createdAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
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

    const created = (await sub1.as.query(api.portal.mySubPortal, {})).payApplications[0].outcome!;
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
    const unclaimed = (await sub1.as.query(api.portal.mySubPortal, {})).payApplications[0].outcome!;
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
    const returned = (await sub1.as.query(api.portal.mySubPortal, {})).payApplications[0].outcome!;
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
});
