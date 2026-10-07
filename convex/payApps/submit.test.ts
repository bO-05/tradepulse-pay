/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { agentIdProfile, syncAgentProfile } from "../lib/agentAccess";
import { signInAs } from "../lib/testIdentity";

const modules = import.meta.glob("/convex/**/*.ts");
const AGENT_EMAIL = "boldlevel182@agentmail.to";

type T = TestConvex<typeof schema>;

// Submitting schedules the AI review; fake timers keep it from running mid-test.
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
  const { agreement, otherContractorId } = await t.run(async (ctx) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_demo", (q) => q.eq("isDemoProject", true))
      .first();
    const agreement = (await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project!._id))
      .first())!;
    const contractors = await ctx.db.query("contractors").collect();
    const other = contractors.find((c) => c._id !== agreement.contractorId)!;
    return { agreement, otherContractorId: other._id };
  });
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  const sov = await t.run(async (ctx) =>
    ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id))
      .collect(),
  );
  const contractorId = agreement.contractorId!;
  const sub1 = await signInAs(t, "sub", { email: "sub1@test.tradepulse", contractorId });
  const sub2 = await signInAs(t, "sub", { email: "sub2@test.tradepulse", contractorId: otherContractorId });
  const owner = await signInAs(t, "owner", { email: "owner@test.tradepulse" });
  return { t, gc, sub1, sub2, owner, agreement, sov, contractorId };
}

/** Mirrors a completed AgentID sign-in (users row, profile sync, authAccounts row). */
async function signInAgent(t: T, email: string) {
  const userId = await t.run(async (ctx) => {
    const { id, ...fields } = agentIdProfile({
      sub: "agent-sub-1",
      email,
      name: "Billing Agent",
      owner_sub: "owner-sub-1",
      owner_name: "Pat Owner",
      owner_email: "pat@example.com",
    });
    const userId = await ctx.db.insert("users", fields);
    await syncAgentProfile(ctx, userId, { duringAgentIdSignIn: true });
    await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: id });
    return userId;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|agent-session`, email }) };
}

function validArgs(agreementId: string, sov: { _id: Id<"scheduleOfValues">; scheduledValueCents: number }[]) {
  return {
    agreementId,
    periodLabel: "Pay app #1 — Oct 2026",
    lines: [
      { sovLineId: sov[0]._id, pctCompleteThisPeriod: 10, pctCompleteToDate: 10, requestedCents: 12_345 },
      { sovLineId: sov[1]._id, pctCompleteThisPeriod: 5, pctCompleteToDate: 5, requestedCents: 6_789 },
    ],
    notes: "Rough-in started",
    lienWaiver: true,
  };
}

const countPayApps = (t: T) => t.run(async (ctx) => (await ctx.db.query("payApplications").collect()).length);

describe("submitPayApplication", () => {
  test("sub submits for its own agreement with integer cents and human attribution", async () => {
    const { t, sub1, agreement, sov } = await setup();
    const id = await sub1.as.mutation(api.payApps.submit.submitPayApplication, validArgs(agreement._id, sov));
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row).toMatchObject({
      status: "submitted",
      subUserId: sub1.userId,
      requestedTotalCents: 12_345 + 6_789,
      lienWaiver: true,
      submittedBy: { userId: sub1.userId, actorType: "human" },
    });
    expect(row!.submittedBy.agentEmail).toBeUndefined();
    expect(row!.lines.every((l) => Number.isInteger(l.requestedCents))).toBe(true);

    const portal = await sub1.as.query(api.portal.mySubPortal, {});
    expect(portal.payApplications).toHaveLength(1);
    expect(portal.payApplications[0]).toMatchObject({ status: "submitted", canWithdraw: true });
  });

  test("linked billing agent submits with agent and owner attribution", async () => {
    const { t, gc, agreement, sov, contractorId, sub2 } = await setup();
    await gc.as.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId });
    const agent = await signInAgent(t, AGENT_EMAIL);
    const id = await agent.as.mutation(api.payApps.submit.submitPayApplication, validArgs(agreement._id, sov));
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row!.submittedBy).toEqual({
      userId: agent.userId,
      actorType: "agent",
      agentEmail: AGENT_EMAIL,
      ownerEmail: "pat@example.com",
      ownerName: "Pat Owner",
    });
    const audit = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).find((l) => l.eventType === "pay_app_submitted"),
    );
    expect(audit).toMatchObject({ agentSub: "agent-sub-1", ownerEmail: "pat@example.com", agreementId: agreement._id });

    const sub2Portal = JSON.stringify(await sub2.as.query(api.portal.mySubPortal, {}));
    expect(sub2Portal).not.toContain(AGENT_EMAIL);
    expect(sub2Portal).not.toContain("pat@example.com");
  });

  test("revoked or unlinked agent is denied on the next request and no row is created", async () => {
    const { t, gc, agreement, sov, contractorId } = await setup();
    const linkId = await gc.as.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId });
    const agent = await signInAgent(t, AGENT_EMAIL);
    await gc.as.mutation(api.agentLinks.revokeAgentLink, { linkId });
    await expect(
      agent.as.mutation(api.payApps.submit.submitPayApplication, validArgs(agreement._id, sov)),
    ).rejects.toThrow(/no TradePulse role/);
    await expect(agent.as.query(api.payApps.submit.payAppFormContext, { agreementId: agreement._id })).rejects.toThrow(
      /no TradePulse role/,
    );
    const unlinked = await signInAgent(t, "dullstreet57@agentmail.to");
    await expect(
      unlinked.as.mutation(api.payApps.submit.submitPayApplication, validArgs(agreement._id, sov)),
    ).rejects.toThrow(/no TradePulse role/);
    expect(await countPayApps(t)).toBe(0);

    await gc.as.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId });
    await agent.as.mutation(api.payApps.submit.submitPayApplication, validArgs(agreement._id, sov));
    expect(await countPayApps(t)).toBe(1);
  });

  test("GC, owner, unauthenticated and another sub are rejected", async () => {
    const { t, gc, owner, sub2, agreement, sov } = await setup();
    const args = validArgs(agreement._id, sov);
    await expect(gc.as.mutation(api.payApps.submit.submitPayApplication, args)).rejects.toThrow(/Forbidden: role sub/);
    await expect(owner.as.mutation(api.payApps.submit.submitPayApplication, args)).rejects.toThrow(/Forbidden: role sub/);
    await expect(t.mutation(api.payApps.submit.submitPayApplication, args)).rejects.toThrow(/Not authenticated/);
    await expect(sub2.as.mutation(api.payApps.submit.submitPayApplication, args)).rejects.toThrow(
      /only submit pay applications for your own agreements/,
    );
    expect(await sub2.as.query(api.payApps.submit.payAppFormContext, { agreementId: agreement._id })).toBeNull();
    expect(await countPayApps(t)).toBe(0);
  });

  test("invalid input is rejected with a readable error and no row", async () => {
    const { t, sub1, agreement, sov } = await setup();
    const good = validArgs(agreement._id, sov);
    const bad = [
      { ...good, periodLabel: "" },
      { ...good, lines: [] },
      { ...good, lines: [{ ...good.lines[0], pctCompleteToDate: 101, pctCompleteThisPeriod: 10 }] },
      { ...good, lines: [{ ...good.lines[0], pctCompleteToDate: -5, pctCompleteThisPeriod: 0 }] },
      { ...good, lines: [{ ...good.lines[0], requestedCents: -100 }] },
      { ...good, lines: [{ ...good.lines[0], pctCompleteThisPeriod: 20, pctCompleteToDate: 10 }] },
      { ...good, lines: [{ ...good.lines[0], requestedCents: sov[0].scheduledValueCents + 1 }] },
      { ...good, lines: [{ ...good.lines[0], requestedCents: 0 }] },
    ];
    for (const args of bad) {
      await expect(sub1.as.mutation(api.payApps.submit.submitPayApplication, args)).rejects.toThrow();
    }
    expect(await countPayApps(t)).toBe(0);
  });

  test("requested amount is capped by what earlier pay apps already billed", async () => {
    const { t, sub1, agreement, sov } = await setup();
    const full = sov[0].scheduledValueCents;
    const args = {
      ...validArgs(agreement._id, sov),
      lines: [{ sovLineId: sov[0]._id, pctCompleteThisPeriod: 100, pctCompleteToDate: 100, requestedCents: full }],
    };
    await sub1.as.mutation(api.payApps.submit.submitPayApplication, args);
    await expect(
      sub1.as.mutation(api.payApps.submit.submitPayApplication, {
        ...args,
        lines: [{ ...args.lines[0], requestedCents: 1 }],
      }),
    ).rejects.toThrow(/remaining scheduled value of \$0\.00/);
    const ctxView = await sub1.as.query(api.payApps.submit.payAppFormContext, { agreementId: agreement._id });
    expect(ctxView!.sovLines[0]).toMatchObject({ previouslyBilledCents: full, remainingCents: 0, previousPctToDate: 100 });
    expect(await countPayApps(t)).toBe(1);
  });

  test("an agreement that is not executed takes no pay apps", async () => {
    const { t, sub1, agreement, sov } = await setup();
    await t.run(async (ctx) => ctx.db.patch(agreement._id, { status: "generated" }));
    await expect(
      sub1.as.mutation(api.payApps.submit.submitPayApplication, validArgs(agreement._id, sov)),
    ).rejects.toThrow(/executed agreement/);
  });
});

describe("withdrawPayApplication", () => {
  test("withdraws, cancels pending proposals, leaves decided ones and moves no money", async () => {
    const { t, sub1, sub2, agreement, sov } = await setup();
    const payAppId = await sub1.as.mutation(api.payApps.submit.submitPayApplication, validArgs(agreement._id, sov));
    const [pendingId, rejectedId] = await t.run(async (ctx) => {
      const base = { payAppId, agreementId: agreement._id, rationale: "test", flags: [], createdAt: Date.now() };
      return [
        await ctx.db.insert("agentProposals", { ...base, kind: "capture", amountCents: 100, status: "pending" }),
        await ctx.db.insert("agentProposals", { ...base, kind: "payout", amountCents: 100, status: "rejected" }),
      ];
    });
    const paymentsBefore = await t.run(async (ctx) => (await ctx.db.query("payments").collect()).length);

    await expect(sub2.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId })).rejects.toThrow(
      /only withdraw your own/,
    );
    expect((await t.run(async (ctx) => ctx.db.get(payAppId)))!.status).toBe("submitted");

    const res = await sub1.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId });
    expect(res).toEqual({ status: "withdrawn", cancelledProposals: 1 });
    const after = await t.run(async (ctx) => ({
      app: await ctx.db.get(payAppId),
      pending: await ctx.db.get(pendingId),
      rejected: await ctx.db.get(rejectedId),
      payments: (await ctx.db.query("payments").collect()).length,
    }));
    expect(after.app!.status).toBe("withdrawn");
    expect(after.app!.withdrawnAt).toBeTypeOf("number");
    expect(after.pending!.status).toBe("cancelled");
    expect(after.rejected!.status).toBe("rejected");
    expect(after.payments).toBe(paymentsBefore);

    // A withdrawn app no longer counts against the remaining scheduled value.
    const form = await sub1.as.query(api.payApps.submit.payAppFormContext, { agreementId: agreement._id });
    expect(form!.sovLines[0].previouslyBilledCents).toBe(0);
  });

  test("only submitted or under_review apps can be withdrawn; GC and owner cannot withdraw", async () => {
    const { t, gc, owner, sub1, agreement, sov } = await setup();
    const payAppId = await sub1.as.mutation(api.payApps.submit.submitPayApplication, validArgs(agreement._id, sov));
    await expect(gc.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId })).rejects.toThrow(/Forbidden: role sub/);
    await expect(owner.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId })).rejects.toThrow(
      /Forbidden: role sub/,
    );
    await t.run(async (ctx) => ctx.db.patch(payAppId, { status: "under_review" }));
    await sub1.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId });
    await expect(sub1.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId })).rejects.toThrow(
      /Only submitted or under-review/,
    );
    for (const status of ["reviewed", "approved", "rejected", "paid"] as const) {
      await t.run(async (ctx) => ctx.db.patch(payAppId, { status }));
      await expect(sub1.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId })).rejects.toThrow(
        /Only submitted or under-review/,
      );
    }
  });

  test("a linked agent can withdraw its contractor's pay app", async () => {
    const { t, gc, sub1, agreement, sov, contractorId } = await setup();
    const payAppId = await sub1.as.mutation(api.payApps.submit.submitPayApplication, validArgs(agreement._id, sov));
    await gc.as.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId });
    const agent = await signInAgent(t, AGENT_EMAIL);
    await agent.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId });
    expect((await t.run(async (ctx) => ctx.db.get(payAppId)))!.status).toBe("withdrawn");
  });
});

describe("billing history beyond the first 500 applications", () => {
  async function insertHistory(
    t: T,
    agreementId: Id<"agreements">,
    subUserId: Id<"users">,
    sovLineId: Id<"scheduleOfValues">,
    rows: { status: "withdrawn" | "rejected" | "submitted"; requestedCents: number; count: number },
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < rows.count; i++) {
        await ctx.db.insert("payApplications", {
          agreementId,
          subUserId,
          periodLabel: `History ${rows.status} ${i}`,
          lines: [{ sovLineId, pctCompleteThisPeriod: 1, pctCompleteToDate: 1, requestedCents: rows.requestedCents }],
          requestedTotalCents: rows.requestedCents,
          notes: "",
          lienWaiver: true,
          status: rows.status,
          submittedBy: { userId: subUserId, actorType: "human" },
          createdAt: Date.now(),
        });
      }
    });
  }

  const oneLine = (agreementId: string, sovLineId: Id<"scheduleOfValues">, cents: number) => ({
    agreementId,
    periodLabel: `Line-only ${cents}`,
    lines: [{ sovLineId, pctCompleteThisPeriod: 100, pctCompleteToDate: 100, requestedCents: cents }],
    notes: "",
    lienWaiver: true,
  });

  test("withdrawn and rejected applications cannot hide a later reservation", async () => {
    const { t, sub1, agreement, sov } = await setup();
    const line = sov[0];
    await insertHistory(t, agreement._id, sub1.userId, line._id, { status: "withdrawn", requestedCents: line.scheduledValueCents, count: 520 });
    await insertHistory(t, agreement._id, sub1.userId, line._id, { status: "rejected", requestedCents: line.scheduledValueCents, count: 20 });
    // Application 541 reserves the whole line.
    await sub1.as.mutation(api.payApps.submit.submitPayApplication, oneLine(agreement._id, line._id, line.scheduledValueCents));
    await expect(sub1.as.mutation(api.payApps.submit.submitPayApplication, oneLine(agreement._id, line._id, 1))).rejects.toThrow(
      /exceeds the remaining scheduled value/,
    );
    const form = await sub1.as.query(api.payApps.submit.payAppFormContext, { agreementId: agreement._id });
    expect(form!.sovLines.find((l) => l._id === line._id)!.remainingCents).toBe(0);
  });

  test("more than 500 open applications are all counted", async () => {
    const { t, sub1, agreement, sov } = await setup();
    const line = sov[0];
    const each = Math.floor(line.scheduledValueCents / 600);
    await insertHistory(t, agreement._id, sub1.userId, line._id, { status: "submitted", requestedCents: each, count: 600 });
    const remaining = line.scheduledValueCents - each * 600;
    await expect(sub1.as.mutation(api.payApps.submit.submitPayApplication, oneLine(agreement._id, line._id, remaining + 1))).rejects.toThrow(
      /exceeds the remaining scheduled value/,
    );
    if (remaining > 0) await sub1.as.mutation(api.payApps.submit.submitPayApplication, oneLine(agreement._id, line._id, remaining));
  });

  test("a billing history too large to read completely fails closed", async () => {
    const { t, sub1, agreement, sov } = await setup();
    const { MAX_BILLING_HISTORY } = await import("./billingHistory");
    await insertHistory(t, agreement._id, sub1.userId, sov[0]._id, { status: "submitted", requestedCents: 0, count: MAX_BILLING_HISTORY + 1 });
    const before = await countPayApps(t);
    await expect(sub1.as.mutation(api.payApps.submit.submitPayApplication, oneLine(agreement._id, sov[1]._id, 1))).rejects.toThrow(
      /billing history is too large to verify/,
    );
    expect(await countPayApps(t)).toBe(before);
  });
});
