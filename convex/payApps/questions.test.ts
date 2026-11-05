/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { withSession } from "../lib/testIdentity";
import { buildTenancyFixture } from "../lib/tenancyFixtures";

const modules = import.meta.glob("/convex/**/*.ts");

async function setup(opts: { status?: "submitted" | "draft"; readOnly?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  const payAppId = await t.run(async (ctx) => {
    if (opts.readOnly === true) await ctx.db.patch(f.gcA.project.projectId, { readOnlyReference: true });
    return await ctx.db.insert("payApplications", {
      agreementId: f.gcA.project.agreementId,
      subUserId: f.sub.admin.userId,
      periodLabel: "Pay app #2",
      lines: [],
      requestedTotalCents: 200_000,
      notes: "Demo fixture.",
      lienWaiver: true,
      status: opts.status ?? "submitted",
      submittedBy: { userId: f.sub.admin.userId, actorType: "human" },
      contractorId: f.gcA.project.contractorId,
      subCompanyId: f.sub.companyId,
      applicationNo: 2,
      createdAt: Date.now(),
    });
  });
  return { t, f, payAppId };
}

async function notifications(t: ReturnType<typeof convexTest>, companyId: Id<"companies">) {
  return await t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.companyId === companyId));
}

describe("pay-app question thread", () => {
  test("sub asks and GC replies; both sides see the thread and the other company gets one in-app notification", async () => {
    const { t, f, payAppId } = await setup();

    const subView = await f.sub.admin.as.query(api.payApps.questions.list, { payAppId });
    expect(subView).toMatchObject({
      viewerRole: "sub",
      canPost: true,
      applicationNo: 2,
      requestedTotalCents: 200_000,
      counterpartyName: "Fixture GC",
      entries: [],
    });
    const gcView = await f.gcA.admin.as.query(api.payApps.questions.list, { payAppId });
    expect(gcView).toMatchObject({ viewerRole: "gc", canPost: true, counterpartyName: "Eastbay Electric", entries: [] });

    const question = await f.sub.admin.as.mutation(api.payApps.questions.post, {
      payAppId,
      body: "  Why is line 2 approved at $1,800 instead of the $2,000 I requested?  ",
    });
    expect(question.entryId).toBeTruthy();

    const afterQuestion = await f.gcA.admin.as.query(api.payApps.questions.list, { payAppId });
    expect(afterQuestion?.entries).toHaveLength(1);
    expect(afterQuestion?.entries[0]).toMatchObject({
      authorRole: "sub",
      authorName: "kim@eastbay.test",
      body: "Why is line 2 approved at $1,800 instead of the $2,000 I requested?",
    });
    expect((await notifications(t, f.sub.companyId)).filter((n) => n.kind === "pay_app_question")).toHaveLength(0);
    const gcNotes = (await notifications(t, f.gcA.companyId)).filter((n) => n.kind === "pay_app_question");
    // The fixture GC has two active human members; both get one in-app notification.
    expect(gcNotes).toHaveLength(2);
    expect(gcNotes.every((n) => n.title === "Question about pay app #2" && n.link === `#/pay-apps/${payAppId}`)).toBe(true);

    await f.gcA.admin.as.mutation(api.payApps.questions.post, {
      payAppId,
      body: "The review held $200 of retainage; the approved gross is $2,000.",
    });
    const afterReply = await f.sub.admin.as.query(api.payApps.questions.list, { payAppId });
    expect(afterReply?.entries.map((e) => [e.authorRole, e.body])).toEqual([
      ["sub", "Why is line 2 approved at $1,800 instead of the $2,000 I requested?"],
      ["gc", "The review held $200 of retainage; the approved gross is $2,000."],
    ]);
    const subNotes = (await notifications(t, f.sub.companyId)).filter((n) => n.kind === "pay_app_reply");
    expect(subNotes).toHaveLength(1);
    expect(subNotes[0]).toMatchObject({ title: "GC replied on pay app #2", link: `#/pay-apps/${payAppId}` });

    const audit = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).filter((a) => a.eventType === "pay_app_question" || a.eventType === "pay_app_reply"),
    );
    expect(audit.map((a) => a.eventType).sort()).toEqual(["pay_app_question", "pay_app_reply"]);
    expect(audit.every((a) => a.projectId === f.gcA.project.projectId && a.agreementId === f.gcA.project.agreementId)).toBe(true);
  });

  test("the thread never changes the pay app or its requested amount", async () => {
    const { t, f, payAppId } = await setup();
    const before = await t.run(async (ctx) => ctx.db.get(payAppId));
    await f.sub.admin.as.mutation(api.payApps.questions.post, { payAppId, body: "Question on the amount." });
    await f.gcA.admin.as.mutation(api.payApps.questions.post, { payAppId, body: "Answer on the amount." });
    const after = await t.run(async (ctx) => ctx.db.get(payAppId));
    expect(after).toEqual(before);
  });

  test("drafts are private to the filing sub and closed to questions", async () => {
    const { f, payAppId } = await setup({ status: "draft" });
    expect(await f.gcA.admin.as.query(api.payApps.questions.list, { payAppId })).toBeNull();
    const subView = await f.sub.admin.as.query(api.payApps.questions.list, { payAppId });
    expect(subView).toMatchObject({
      canPost: false,
      postingBlockedReason: "Questions open after the subcontractor submits the pay app.",
      entries: [],
    });
    await expect(f.sub.admin.as.mutation(api.payApps.questions.post, { payAppId, body: "Can I ask now?" })).rejects.toThrow(
      /Questions open after the subcontractor submits the pay app/,
    );
  });

  test("owners, other GCs and signed-out callers cannot read or post", async () => {
    const { t, f, payAppId } = await setup();
    expect(await f.owner.admin.as.query(api.payApps.questions.list, { payAppId })).toBeNull();
    expect(await f.gcB.admin.as.query(api.payApps.questions.list, { payAppId })).toBeNull();
    await expect(f.owner.admin.as.mutation(api.payApps.questions.post, { payAppId, body: "Owner question" })).rejects.toThrow(
      /Not found/,
    );
    await expect(f.gcB.admin.as.mutation(api.payApps.questions.post, { payAppId, body: "Other GC question" })).rejects.toThrow(
      /Not found/,
    );
    await expect(t.query(api.payApps.questions.list, { payAppId })).rejects.toThrow(/Not authenticated/);
  });

  test("read-only reference projects expose the thread but refuse new entries", async () => {
    const { f, payAppId } = await setup({ readOnly: true });
    const view = await f.sub.admin.as.query(api.payApps.questions.list, { payAppId });
    expect(view).toMatchObject({ canPost: false, postingBlockedReason: expect.stringContaining("preserved demo run") });
    await expect(f.sub.admin.as.mutation(api.payApps.questions.post, { payAppId, body: "Can I post?" })).rejects.toThrow(
      /preserved, read-only demo fixture/,
    );
  });

  test("a linked billing agent can read the thread but cannot post", async () => {
    const { t, f, payAppId } = await setup();
    const agentId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "bot@agentmail.to", actorType: "agent" as const, agentSub: "a1" });
      await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: "a1" });
      await ctx.db.insert("userProfiles", {
        userId,
        role: "sub" as const,
        displayName: "bot",
        actorType: "agent" as const,
        contractorId: f.gcA.project.contractorId,
        createdAt: 0,
      });
      await ctx.db.insert("agentLinks", {
        agentEmail: "bot@agentmail.to",
        contractorId: f.gcA.project.contractorId,
        gcCompanyId: f.gcA.companyId,
        subCompanyId: f.sub.companyId,
        status: "active" as const,
        createdBy: f.gcA.admin.userId,
        createdAt: 0,
      });
      return userId;
    });
    const asAgent = await withSession(t, agentId);
    const view = await asAgent.query(api.payApps.questions.list, { payAppId });
    expect(view).toMatchObject({ viewerRole: "sub", canPost: false, postingBlockedReason: expect.stringContaining("Agents can read") });
    await expect(asAgent.mutation(api.payApps.questions.post, { payAppId, body: "Agent question" })).rejects.toThrow(
      /Agents cannot post pay-app questions/,
    );
  });

  test("body validation trims and rejects empty or oversized entries", async () => {
    const { f, payAppId } = await setup();
    await expect(f.sub.admin.as.mutation(api.payApps.questions.post, { payAppId, body: "   " })).rejects.toThrow(/at least two/);
    await expect(
      f.sub.admin.as.mutation(api.payApps.questions.post, { payAppId, body: "x".repeat(2_001) }),
    ).rejects.toThrow(/under 2,000 characters/);
    const view = await f.sub.admin.as.query(api.payApps.questions.list, { payAppId });
    expect(view?.entries).toEqual([]);
  });
});
