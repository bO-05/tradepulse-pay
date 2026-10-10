/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { agentIdProfile, syncAgentProfile } from "../lib/agentAccess";
import { withSession, signInAs } from "../lib/testIdentity";
import { createReadBudget, loadAgreementHistory } from "../payments/agreementHistory";
import type { Id } from "../_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");
type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function signInAgent(t: T, email: string, sub: string) {
  const userId = await t.run(async (ctx) => {
    const { id, ...fields } = agentIdProfile({ sub, email, name: "Agent" });
    const userId = await ctx.db.insert("users", fields);
    await syncAgentProfile(ctx, userId, { duringAgentIdSignIn: true });
    await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: id });
    return userId;
  });
  return await withSession(t, userId, email);
}

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  const agreement = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  const contractorId = agreement.contractorId!;
  const sub1 = await signInAs(t, "sub", { email: "sub1@test.tradepulse", contractorId });
  const owner = await signInAs(t, "owner", { email: "owner@test.tradepulse" });

  await t.run(async (ctx) => {
    const now = Date.now();
    const milestone = (await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
      .first())!;
    const payoutId = await ctx.db.insert("payments", {
      agreementId: agreement._id,
      milestoneId: milestone._id,
      kind: "payout",
      status: "success",
      grossCents: 100_000,
      retainageCents: 10_000,
      netCents: 90_000,
      idempotencyKey: "dash-payout-1",
      createdAt: now,
    });
    await ctx.db.insert("payments", {
      agreementId: agreement._id,
      milestoneId: milestone._id,
      kind: "payout",
      status: "pending",
      grossCents: 50_000,
      retainageCents: 5_000,
      netCents: 45_000,
      idempotencyKey: "dash-payout-2",
      createdAt: now,
    });
    await ctx.db.insert("retainageLedger", {
      agreementId: agreement._id,
      paymentId: payoutId,
      deltaCents: 10_000,
      reason: "withheld",
      createdAt: now,
    });
    await ctx.db.insert("payApplications", {
      agreementId: agreement._id,
      contractorId,
      subUserId: sub1.userId,
      periodLabel: "Oct 2026",
      lines: [],
      requestedTotalCents: 25_000,
      notes: "",
      lienWaiver: true,
      status: "submitted",
      submittedBy: { userId: sub1.userId, actorType: "human" },
      createdAt: now,
    });
    await ctx.db.insert("changeOrders", {
      agreementId: agreement._id,
      projectId: agreement.projectId,
      scope: "prime",
      number: 1,
      description: "Added outlets",
      amountCents: 7_500,
      status: "invoiced",
      createdAt: now,
    });
  });
  return { t, gc, sub1, owner, agreement };
}

describe("dashboard data", () => {
  test("GC gets flat rows in cents for every source of the executed agreement", async () => {
    const { gc, agreement } = await setup();
    const data = await gc.as.query(api.dashboard.queries.getDashboardData, {});
    expect(data.readOnly).toBe(false);
    expect(data.agreements.some((a) => a.agreementId === agreement._id)).toBe(true);
    const mine = data.payments.filter((p) => p.agreementId === agreement._id);
    expect(mine.map((p) => p.netCents).sort()).toEqual([45_000, 90_000]);
    expect(data.retainage.filter((r) => r.agreementId === agreement._id).map((r) => r.deltaCents)).toEqual([10_000]);
    expect(data.payApps.find((p) => p.agreementId === agreement._id)).toMatchObject({
      requestedCents: 25_000,
      status: "submitted",
      aiRecommendedCents: null,
    });
    expect(data.changeOrders.find((c) => c.agreementId === agreement._id)).toMatchObject({ amountCents: 7_500 });
    expect(data.milestones.length).toBeGreaterThan(0);
    const a = data.agreements.find((x) => x.agreementId === agreement._id)!;
    expect(Number.isInteger(a.retainageCapCents)).toBe(true);
  });

  test("owner gets a read-only owner-safe view: no subcontract payments, agreements or retainage", async () => {
    const { gc, owner } = await setup();
    const asGc = await gc.as.query(api.dashboard.queries.getDashboardData, {});
    expect(asGc.payments.length).toBeGreaterThan(0);
    const asOwner = await owner.as.query(api.dashboard.queries.getDashboardData, {});
    expect(asOwner.readOnly).toBe(true);
    expect(asOwner.payments).toEqual([]);
    expect(asOwner.agreements).toEqual([]);
    expect(asOwner.retainage).toEqual([]);
    expect(asOwner.totals.contractSumCents).toBe(0);
  });

  test("subs, linked and unlinked billing agents, no-role users and signed-out callers are refused", async () => {
    const { t, gc, sub1, agreement } = await setup();
    await gc.as.mutation(api.agentLinks.addAgentLink, {
      agentEmail: "boldlevel182@agentmail.to",
      contractorId: agreement.contractorId!,
    });
    const linked = await signInAgent(t, "boldlevel182@agentmail.to", "agent-linked");
    const unlinked = await signInAgent(t, "dullstreet57@agentmail.to", "agent-unlinked");
    const noRole = await signInAs(t, null);
    for (const caller of [sub1.as, linked, unlinked, noRole.as, t]) {
      await expect(caller.query(api.dashboard.queries.getDashboardData, {})).rejects.toThrow(/Forbidden|Not authenticated/);
    }
  });

  test("reads past 500 payments: a later payout changes totals and counts, matching the ledger", async () => {
    const { t, gc, agreement } = await setup();
    await t.run(async (ctx) => {
      for (let i = 0; i < 520; i++) {
        await ctx.db.insert("payments", {
          agreementId: agreement._id,
          kind: "payout",
          status: "success",
          grossCents: 100,
          retainageCents: 0,
          netCents: 100,
          idempotencyKey: `bulk-${i}`,
          createdAt: Date.now(),
        });
      }
    });
    const before = await gc.as.query(api.dashboard.queries.getDashboardData, {});
    const mineBefore = before.payments.filter((p) => p.agreementId === agreement._id);
    expect(mineBefore).toHaveLength(522);
    expect(before.incomplete.truncated).toBe(false);

    const lateId = await t.run(async (ctx) =>
      ctx.db.insert("payments", {
        agreementId: agreement._id,
        kind: "payout",
        status: "success",
        grossCents: 12_345,
        retainageCents: 0,
        netCents: 12_345,
        idempotencyKey: "late-payout",
        createdAt: Date.now(),
      }),
    );
    const after = await gc.as.query(api.dashboard.queries.getDashboardData, {});
    expect(after.payments.filter((p) => p.agreementId === agreement._id)).toHaveLength(523);
    expect(after.payments.some((p) => p.paymentId === lateId)).toBe(true);
    expect(after.totals.paidCents - before.totals.paidCents).toBe(12_345);

    const ledger = (await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id }))!;
    const row = after.agreements.find((a) => a.agreementId === agreement._id)!;
    expect(row.totals).toEqual(ledger.totals);
    expect(ledger.totals.paidCents).toBe(90_000 + 520 * 100 + 12_345);
    expect(ledger.historyTruncated).toBe(false);
  });

  test("history past a safety bound keeps the newest rows and is flagged truncated", async () => {
    const { t, agreement } = await setup();
    await t.run(async (ctx) => {
      for (let i = 0; i < 6; i++) {
        await ctx.db.insert("payments", {
          agreementId: agreement._id,
          kind: "payout",
          status: "success",
          grossCents: 1,
          retainageCents: 0,
          netCents: 1,
          idempotencyKey: `bounded-${i}`,
          createdAt: Date.now(),
        });
      }
      const all = await loadAgreementHistory(ctx, agreement._id);
      expect(all.truncated).toBe(false);
      expect(all.payments).toHaveLength(8);
      const bounded = await loadAgreementHistory(ctx, agreement._id, createReadBudget(5));
      expect(bounded.truncated).toBe(true);
      expect(bounded.payments.map((p) => p.idempotencyKey)).toEqual(all.payments.slice(-5).map((p) => p.idempotencyKey));
    });
  });

  test("voiding a paid agreement with held retainage keeps its money in the totals, labeled superseded", async () => {
    const { gc, owner, agreement } = await setup();
    const before = await gc.as.query(api.dashboard.queries.getDashboardData, {});
    await gc.as.mutation(api.agreements.voidExecutedAgreement, {
      agreementId: agreement._id,
      reason: "Executed against the wrong bid by mistake",
    });
    const after = await gc.as.query(api.dashboard.queries.getDashboardData, {});
    const row = after.agreements.find((a) => a.agreementId === agreement._id)!;
    expect(row.status).toBe("superseded");
    expect(row.totals.paidCents).toBe(90_000);
    expect(row.totals.retainageHeldCents).toBe(10_000);
    expect(after.totals.paidCents).toBe(before.totals.paidCents);
    expect(after.totals.retainageHeldCents).toBe(before.totals.retainageHeldCents);
    expect(after.payments.filter((p) => p.agreementId === agreement._id)).toHaveLength(2);
    expect(after.retainage.filter((r) => r.agreementId === agreement._id)).toHaveLength(1);
    const asOwner = await owner.as.query(api.dashboard.queries.getDashboardData, {});
    expect(asOwner.readOnly).toBe(true);
    expect(asOwner.totals.paidCents).toBe(0);
    expect(asOwner.totals.changeOrdersInvoicedCents).toBe(after.totals.changeOrdersInvoicedCents);
    const summary = await gc.as.query(api.dashboard.payAgent.getPaySummary, {});
    expect(summary.agreements.find((a) => a.agreementId === agreement._id)).toMatchObject({ status: "superseded" });
  });

  test("retainage held/released match the ledger after a payout reversal and a failed release restoration", async () => {
    const { t, gc, agreement } = await setup();
    await t.run(async (ctx) => {
      const now = Date.now();
      const pay = (kind: "payout" | "retainage_release", status: "success" | "failed" | "returned", netCents: number, key: string) =>
        ctx.db.insert("payments", {
          agreementId: agreement._id,
          kind,
          status,
          grossCents: netCents,
          retainageCents: kind === "payout" ? 5_000 : 0,
          netCents,
          idempotencyKey: key,
          createdAt: now,
        });
      const entry = (paymentId: Id<"payments">, deltaCents: number, reason: string) =>
        ctx.db.insert("retainageLedger", { agreementId: agreement._id, paymentId, deltaCents, reason, createdAt: now });
      const failedPayout = await pay("payout", "failed", 45_000, "rev-payout");
      await entry(failedPayout, 5_000, "withheld");
      await entry(failedPayout, -5_000, "Retainage credit reversed: payout failed");
      const failedRelease = await pay("retainage_release", "returned", 3_000, "rev-release");
      await entry(failedRelease, -3_000, "released");
      await entry(failedRelease, 3_000, "Retainage release returned: the amount is held again");
      const release = await pay("retainage_release", "success", 2_000, "ok-release");
      await entry(release, -2_000, "released");
    });
    const data = await gc.as.query(api.dashboard.queries.getDashboardData, {});
    const ledger = (await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id }))!;
    expect(ledger.totals.retainageHeldCents).toBe(8_000);
    expect(ledger.totals.retainageReleasedCents).toBe(2_000);
    const rows = data.retainage.filter((r) => r.agreementId === agreement._id);
    const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((acc, r) => acc + pick(r), 0);
    expect(sum((r) => r.deltaCents)).toBe(8_000);
    expect(sum((r) => r.releasedCents)).toBe(2_000);
    expect(sum((r) => r.withheldCents) - sum((r) => r.releasedCents)).toBe(8_000);
    expect(rows.find((r) => r.reason.startsWith("Retainage credit reversed"))).toMatchObject({
      paymentKind: "payout",
      releasedCents: 0,
    });
    const row = data.agreements.find((a) => a.agreementId === agreement._id)!;
    expect(row.totals.retainageHeldCents).toBe(ledger.totals.retainageHeldCents);
    expect(row.totals.retainageReleasedCents).toBe(ledger.totals.retainageReleasedCents);
    expect(data.totals.retainageReleasedCents).toBe(sum((r) => r.releasedCents) + otherReleased(data, agreement._id));
  });

  for (const status of ["paid", "invoiced"] as const) {
    const label = status === "paid" ? "a paid change-order invoice" : "an invoiced but unpaid change order";
    test(`voiding an agreement whose only money is ${label} keeps it in dashboard and pay summary`, async () => {
      const t = convexTest(schema, modules);
      await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
      const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
      const agreement = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
      await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
      const changeOrderId = await t.run(async (ctx) => {
        const now = Date.now();
        // A draft and a cancelled change order alone would not keep a voided agreement in.
        await ctx.db.insert("changeOrders", {
          agreementId: agreement._id,
          number: 1,
          description: "Never sent",
          amountCents: 1_000,
          status: "draft",
          createdAt: now,
        });
        await ctx.db.insert("changeOrders", {
          agreementId: agreement._id,
          number: 2,
          description: "Withdrawn",
          amountCents: 2_000,
          status: "cancelled",
          createdAt: now,
        });
        return await ctx.db.insert("changeOrders", {
          agreementId: agreement._id,
          number: 3,
          description: "Extra panel",
          amountCents: 12_300,
          status,
          paypalInvoiceId: `INV2-CO-${status}`,
          paypalInvoiceStatus: status === "paid" ? "PAID" : "SENT",
          createdAt: now,
          invoicedAt: now,
          ...(status === "paid" ? { paidAt: now } : {}),
        });
      });
      const before = await gc.as.query(api.dashboard.queries.getDashboardData, {});
      await gc.as.mutation(api.agreements.voidExecutedAgreement, {
        agreementId: agreement._id,
        reason: "Executed against the wrong bid by mistake",
      });

      const after = await gc.as.query(api.dashboard.queries.getDashboardData, {});
      const row = after.agreements.find((a) => a.agreementId === agreement._id)!;
      expect(row).toMatchObject({ status: "superseded" });
      expect(after.payments.filter((p) => p.agreementId === agreement._id)).toHaveLength(0);
      expect(after.payApps.filter((p) => p.agreementId === agreement._id)).toHaveLength(0);
      expect(after.changeOrders.find((c) => c.changeOrderId === changeOrderId)).toMatchObject({
        status,
        amountCents: 12_300,
      });
      expect(after.changeOrders.filter((c) => c.agreementId === agreement._id)).toHaveLength(3);
      expect(row.totals.changeOrdersPaidCents).toBe(status === "paid" ? 12_300 : 0);
      expect(row.totals.changeOrdersInvoicedCents).toBe(status === "invoiced" ? 12_300 : 0);
      expect(after.totals.changeOrdersPaidCents).toBe(before.totals.changeOrdersPaidCents);
      expect(after.totals.changeOrdersInvoicedCents).toBe(before.totals.changeOrdersInvoicedCents);

      const ledger = (await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id }))!;
      expect(row.totals).toEqual(ledger.totals);
      const others = after.agreements.filter((a) => a.agreementId !== agreement._id);
      for (const key of ["changeOrdersPaidCents", "changeOrdersInvoicedCents", "paidCents", "balanceCents"] as const) {
        expect(after.totals[key]).toBe(ledger.totals[key] + others.reduce((acc, a) => acc + a.totals[key], 0));
      }

      const summary = await gc.as.query(api.dashboard.payAgent.getPaySummary, {});
      const summaryRow = summary.agreements.find((a) => a.agreementId === agreement._id)!;
      expect(summaryRow).toMatchObject({ status: "superseded" });
      expect(summaryRow.totalsCents).toEqual(ledger.totals);
    });
  }

  test("a voided agreement with only draft or cancelled change orders drops out", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
    const agreement = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
    await t.run(async (ctx) => {
      for (const [number, status] of [[1, "draft"], [2, "cancelled"]] as const) {
        await ctx.db.insert("changeOrders", {
          agreementId: agreement._id,
          number,
          description: "Not billed",
          amountCents: 1_000,
          status,
          createdAt: Date.now(),
        });
      }
    });
    await gc.as.mutation(api.agreements.voidExecutedAgreement, {
      agreementId: agreement._id,
      reason: "Executed against the wrong bid by mistake",
    });
    const data = await gc.as.query(api.dashboard.queries.getDashboardData, {});
    expect(data.agreements.some((a) => a.agreementId === agreement._id)).toBe(false);
    const summary = await gc.as.query(api.dashboard.payAgent.getPaySummary, {});
    expect(summary.agreements.some((a) => a.agreementId === agreement._id)).toBe(false);
  });
});

function otherReleased(
  data: { retainage: { agreementId: string; releasedCents: number }[] },
  agreementId: string,
): number {
  return data.retainage.filter((r) => r.agreementId !== agreementId).reduce((acc, r) => acc + r.releasedCents, 0);
}
