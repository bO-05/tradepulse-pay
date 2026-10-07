/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { agentIdProfile, syncAgentProfile } from "../lib/agentAccess";
import { signInAs } from "../lib/testIdentity";

const modules = import.meta.glob("/convex/**/*.ts");
const AGENT_EMAIL = "boldlevel182@agentmail.to";
const ROSENDIN = "Rosendin Electric, Inc.";

const PER_AGREEMENT_TABLES = [
  "scheduleOfValues",
  "milestones",
  "payApplications",
  "agentProposals",
  "payments",
  "retainageLedger",
  "changeOrders",
] as const;

async function seededWithMoney() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  const agreement = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  const sub = await signInAs(t, "sub", { contractorId: agreement.contractorId, email: "sub1@test.tradepulse" });
  await t.run(async (ctx) => {
    const sov = (await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id))
      .first())!;
    const milestone = (await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
      .first())!;
    const payAppId = await ctx.db.insert("payApplications", {
      agreementId: agreement._id,
      subUserId: sub.userId,
      periodLabel: "Oct 2026",
      lines: [{ sovLineId: sov._id, pctCompleteThisPeriod: 10, pctCompleteToDate: 10, requestedCents: 100_000 }],
      requestedTotalCents: 100_000,
      notes: "",
      lienWaiver: true,
      status: "submitted",
      submittedBy: { userId: sub.userId, actorType: "human" },
      createdAt: Date.now(),
    });
    await ctx.db.insert("agentProposals", {
      payAppId,
      agreementId: agreement._id,
      milestoneId: milestone._id,
      kind: "capture",
      amountCents: 100_000,
      rationale: "test",
      flags: [],
      status: "pending",
      createdAt: Date.now(),
    });
    const paymentId = await ctx.db.insert("payments", {
      agreementId: agreement._id,
      milestoneId: milestone._id,
      kind: "payout",
      status: "success",
      grossCents: 100_000,
      retainageCents: 10_000,
      netCents: 90_000,
      idempotencyKey: "pay_test",
      createdAt: Date.now(),
    });
    await ctx.db.insert("retainageLedger", { agreementId: agreement._id, paymentId, deltaCents: 10_000, reason: "test", createdAt: Date.now() });
    await ctx.db.insert("changeOrders", { agreementId: agreement._id, number: 1, description: "CO", amountCents: 250_000, status: "paid", createdAt: Date.now() });
    await ctx.db.insert("licenseChecks", {
      contractorId: agreement.contractorId,
      licenseNumber: "123",
      state: "CA",
      status: "active",
      rawSummary: "test",
      checkedAt: Date.now(),
    });
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      agreementId: agreement._id,
      eventType: "paypal_write",
      title: "PayPal write",
      description: "POST /v1/payments/payouts -> HTTP 201",
      actor: "test",
      timestamp: Date.now(),
    });
    await ctx.db.insert("paypalEvents", { eventId: "WH-1", eventType: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", receivedAt: Date.now(), verified: true, processed: true });
  });
  return { t, gc, agreement };
}

async function orphanCounts(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    for (const table of PER_AGREEMENT_TABLES) {
      const rows = (await ctx.db.query(table).collect()) as { agreementId: Id<"agreements"> }[];
      let orphans = 0;
      for (const r of rows) if ((await ctx.db.get(r.agreementId)) === null) orphans++;
      counts[table] = orphans;
    }
    const checks = await ctx.db.query("licenseChecks").collect();
    let orphanChecks = 0;
    for (const c of checks) if ((await ctx.db.get(c.contractorId)) === null) orphanChecks++;
    counts.licenseChecks = orphanChecks;
    return counts;
  });
}

describe("agreement cascade delete", () => {
  test("a force reseed leaves no per-agreement payment rows behind and keeps audit history", async () => {
    const { t, gc, agreement } = await seededWithMoney();
    await gc.as.mutation(api.projects.seedInitialData, { force: true });

    expect(await t.run(async (ctx) => await ctx.db.get(agreement._id))).toBeNull();
    const counts = await orphanCounts(t);
    expect(counts).toEqual({
      scheduleOfValues: 0,
      milestones: 0,
      payApplications: 0,
      agentProposals: 0,
      payments: 0,
      retainageLedger: 0,
      changeOrders: 0,
      licenseChecks: 0,
    });
    const kept = await t.run(async (ctx) => ({
      paypalWrites: (await ctx.db.query("auditLogs").collect()).filter((l) => l.eventType === "paypal_write").length,
      events: (await ctx.db.query("paypalEvents").collect()).length,
      payments: (await ctx.db.query("payments").collect()).length,
    }));
    expect(kept).toEqual({ paypalWrites: 1, events: 1, payments: 0 });

    // Ledger totals only see live agreements.
    const ledgers = await gc.as.query(api.payments.ledger.listLedgerAgreements, {});
    for (const l of ledgers) {
      const ledger = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: l._id });
      expect(ledger!.totals.paidCents).toBe(0);
      expect(ledger!.totals.changeOrdersPaidCents).toBe(0);
    }
  });

  test("deleting a trade package removes its agreements' payment rows", async () => {
    const { t, gc, agreement } = await seededWithMoney();
    // Executed agreements block deletion, so void the status for this check.
    await t.run(async (ctx) => await ctx.db.patch(agreement._id, { status: "generated" }));
    await gc.as.mutation(api.tradePackages.deleteTradePackage, { tradePackageId: agreement.tradePackageId });
    expect(Object.values(await orphanCounts(t)).every((n) => n === 0)).toBe(true);
  });
});

/** Mirrors a completed AgentID sign-in (users row from profile(), authAccounts row, profile sync). */
async function signInAgent(t: TestConvex<typeof schema>, email: string) {
  const userId = await t.run(async (ctx) => {
    const { id, ...fields } = agentIdProfile({ sub: "agent-sub-1", email, name: "Billing Agent", owner_email: "pat@example.com" });
    const userId = await ctx.db.insert("users", fields);
    await syncAgentProfile(ctx, userId, { duringAgentIdSignIn: true });
    await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: id });
    return userId;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|agent-session`, email }) };
}

describe("billing-agent links across a reseed", () => {
  test("a linked agent keeps sub access to the new Rosendin contractor after a force reseed", async () => {
    const { t, gc, agreement } = await seededWithMoney();
    const oldRosendin = agreement.contractorId;
    await gc.as.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: oldRosendin });
    // An agreement-scoped link: the agreement is deleted by the reseed, so the scope is cleared.
    await t.run(async (ctx) => {
      const link = (await ctx.db.query("agentLinks").first())!;
      await ctx.db.patch(link._id, { agreementId: agreement._id });
    });
    const agent = await signInAgent(t, AGENT_EMAIL);
    expect(await agent.as.query(api.profiles.me, {})).toMatchObject({ role: "sub", contractorId: oldRosendin });

    await gc.as.mutation(api.projects.seedInitialData, { force: true });

    const after = await t.run(async (ctx) => {
      const contractors = await ctx.db.query("contractors").collect();
      const links = await ctx.db.query("agentLinks").collect();
      return { newRosendin: contractors.find((c) => c.companyName === ROSENDIN)!._id, links };
    });
    expect(after.newRosendin).not.toBe(oldRosendin);
    expect(after.links).toHaveLength(1);
    expect(after.links[0]).toMatchObject({ status: "active", contractorId: after.newRosendin, agentEmail: AGENT_EMAIL });
    expect(after.links[0].agreementId).toBeUndefined();

    expect(await agent.as.query(api.profiles.me, {})).toMatchObject({
      role: "sub",
      contractorId: after.newRosendin,
      contractorName: ROSENDIN,
    });
    const visible = await agent.as.query(api.payments.ledger.listLedgerAgreements, {});
    const newAgreement = await t.run(async (ctx) =>
      (await ctx.db.query("agreements").collect()).find((a) => a.contractorId === after.newRosendin),
    );
    if (newAgreement) expect(visible.map((a) => a._id)).toContain(newAgreement._id);
    const profile = await t.run(async (ctx) =>
      ctx.db.query("userProfiles").withIndex("by_userId", (q) => q.eq("userId", agent.userId)).unique(),
    );
    expect(profile).toMatchObject({ role: "sub", actorType: "agent", contractorId: after.newRosendin });
  });

  test("a revoked link is not reactivated or remapped by a reseed", async () => {
    const { t, gc, agreement } = await seededWithMoney();
    const linkId = await gc.as.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: agreement.contractorId });
    await gc.as.mutation(api.agentLinks.revokeAgentLink, { linkId });
    await gc.as.mutation(api.projects.seedInitialData, { force: true });
    const link = await t.run(async (ctx) => await ctx.db.get(linkId));
    expect(link).toMatchObject({ status: "revoked", contractorId: agreement.contractorId });
  });
});
