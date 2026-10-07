/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { agentIdProfile, syncAgentProfile } from "../lib/agentAccess";
import { signInAs } from "../lib/testIdentity";

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
  return t.withIdentity({ subject: `${userId}|agent-session`, email });
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

  test("owner gets the same rows marked read-only", async () => {
    const { gc, owner } = await setup();
    const asGc = await gc.as.query(api.dashboard.queries.getDashboardData, {});
    const asOwner = await owner.as.query(api.dashboard.queries.getDashboardData, {});
    expect(asOwner.readOnly).toBe(true);
    expect(asOwner.payments).toEqual(asGc.payments);
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
});
