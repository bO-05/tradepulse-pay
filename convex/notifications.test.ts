/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { notify, sanitizeNotificationText } from "./lib/notify";
import { buildTenancyFixture, insertProjectFor } from "./lib/tenancyFixtures";
import { withSession } from "./lib/testIdentity";

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

async function setup() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const fx = await buildTenancyFixture(t);
  return { t, fx };
}

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { data?: { message?: string } }).data?.message ?? String(err);
  }
  throw new Error("expected the call to fail");
}

async function allNotifications(t: T) {
  return await t.run((ctx) => ctx.db.query("notifications").collect());
}

beforeEach(() => {
  vi.stubEnv("AGENTMAIL_API_KEY", "test-agentmail-key");
  vi.stubEnv("EMAIL_DAILY_BUDGET", "60");
  vi.stubEnv("SITE_URL", "http://localhost:3150");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unexpected network call", { status: 500 })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("notify()", () => {
  test("a company target writes one row per active human member; a company outside the project gets none", async () => {
    const { t, fx } = await setup();
    const written = await t.run(async (ctx) => [
      await notify(ctx, { companyId: fx.gcA.companyId }, { kind: "invite_accepted", title: "A", body: "B", link: "#/people", projectId: fx.gcA.project.projectId }),
      await notify(ctx, { companyId: fx.gcB.companyId }, { kind: "invite_accepted", title: "A", body: "B", link: "#/people", projectId: fx.gcA.project.projectId }),
      await notify(ctx, { companyId: fx.demo.companyIds.gc }, { kind: "invite_accepted", title: "A", body: "B", link: "#/people", projectId: fx.gcA.project.projectId }),
      await notify(ctx, { userId: fx.sub.admin.userId }, { kind: "payee_confirmed", title: "C", body: "D", link: "#/company" }),
      await notify(ctx, { userId: fx.noCompany.userId }, { kind: "payee_confirmed", title: "C", body: "D", link: "#/company" }),
    ]);
    expect(written).toEqual([2, 0, 0, 1, 0]);
    const rows = await allNotifications(t);
    expect(rows.map((r) => r.companyId).sort()).toEqual([fx.gcA.companyId, fx.gcA.companyId, fx.sub.companyId].sort());
  });

  test("titles and bodies never carry emails, tokens or codes, and links must be hash routes", async () => {
    expect(sanitizeNotificationText("Kim (kim@eastbay.test) used code 12345678 and token abcdefghijklmnopqrstuvwxyz0123", 400)).toBe(
      "Kim ([email hidden]) used code [hidden] and token [hidden]",
    );
    const { t, fx } = await setup();
    await t.run((ctx) => notify(ctx, { userId: fx.gcA.admin.userId }, { kind: "payout_sent", title: "x", body: "y", link: "https://evil.example" }));
    expect((await allNotifications(t))[0].link).toBe("#/");
  });
});

describe("bell, list and mark read", () => {
  test("unread count, newest first, mark one read, mark all read; only the caller's own rows", async () => {
    const { t, fx } = await setup();
    await t.run(async (ctx) => {
      for (const title of ["First", "Second", "Third"]) {
        await notify(ctx, { companyId: fx.gcA.companyId }, { kind: "pay_app_submitted", title, body: `${title} body`, link: "#/payments" });
      }
      await notify(ctx, { companyId: fx.gcB.companyId }, { kind: "pay_app_submitted", title: "Sonoran only", body: "x", link: "#/payments" });
      const rows = await ctx.db.query("notifications").collect();
      for (const r of rows) await ctx.db.patch(r._id, { createdAt: 1_000 + ["First", "Second", "Third"].indexOf(r.title) });
    });
    const dana = fx.gcA.admin.as;
    const bell = await dana.query(api.notifications.summary, {});
    expect(bell.unreadCount).toBe(3);
    expect(bell.latest.map((n) => n.title)).toEqual(["Third", "Second", "First"]);
    expect((await fx.gcB.admin.as.query(api.notifications.summary, {})).latest.map((n) => n.title)).toEqual(["Sonoran only"]);

    const target = bell.latest[0];
    // Kim, Priya and Dana's own teammate cannot mark Dana's notification read.
    for (const other of [fx.sub.admin.as, fx.gcB.admin.as, fx.gcA.member.as]) {
      expect(await errorOf(other.mutation(api.notifications.markRead, { notificationId: target._id }))).toBe("Not found.");
    }
    expect(await errorOf(dana.mutation(api.notifications.markRead, { notificationId: "bogus" }))).toBe("Not found.");
    expect((await dana.query(api.notifications.summary, {})).unreadCount).toBe(3);

    await dana.mutation(api.notifications.markRead, { notificationId: target._id });
    expect((await dana.query(api.notifications.summary, {})).unreadCount).toBe(2);
    expect((await t.run((ctx) => ctx.db.get(target._id)))?.readAt).toBeTypeOf("number");
    expect(await dana.mutation(api.notifications.markAllRead, {})).toBe(2);
    expect((await dana.query(api.notifications.summary, {})).unreadCount).toBe(0);
    // Luis (same company) keeps his own unread copies.
    expect((await fx.gcA.member.as.query(api.notifications.summary, {})).unreadCount).toBe(3);

    const page = await dana.query(api.notifications.list, { paginationOpts: { numItems: 2, cursor: null } });
    expect(page.page).toHaveLength(2);
    expect(page.isDone).toBe(false);
    expect(page.page.every((n) => n.read)).toBe(true);
  });

  test("mark all read clears a backlog larger than one batch, and only the caller's rows", async () => {
    vi.useFakeTimers();
    try {
      const { t, fx } = await setup();
      const backlog = 2 * 1000 + 1;
      await t.run(async (ctx) => {
        for (let i = 0; i < backlog; i++) {
          await ctx.db.insert("notifications", {
            userId: fx.gcA.admin.userId,
            companyId: fx.gcA.companyId,
            kind: "pay_app_submitted",
            title: `Event ${i}`,
            body: "x",
            link: "#/payments",
            createdAt: i,
          });
        }
        await ctx.db.insert("notifications", {
          userId: fx.gcA.member.userId,
          companyId: fx.gcA.companyId,
          kind: "pay_app_submitted",
          title: "Luis",
          body: "x",
          link: "#/payments",
          createdAt: 1,
        });
      });
      await fx.gcA.admin.as.mutation(api.notifications.markAllRead, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const rows = await allNotifications(t);
      expect(rows.filter((r) => r.userId === fx.gcA.admin.userId && r.readAt === undefined)).toHaveLength(0);
      expect(rows.find((r) => r.title === "Luis")?.readAt).toBeUndefined();
      expect((await fx.gcA.admin.as.query(api.notifications.summary, {})).unreadCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("users without a company and signed-out callers see an empty bell", async () => {
    const { t, fx } = await setup();
    expect(await fx.noCompany.as.query(api.notifications.summary, {})).toEqual({ unreadCount: 0, unreadCapped: false, latest: [], hasMore: false });
    expect(await t.query(api.notifications.summary, {})).toMatchObject({ unreadCount: 0 });
    await expect(t.mutation(api.notifications.markAllRead, {})).rejects.toThrow();
  });
});

describe("invite accepted", () => {
  test("only the inviting GC company is notified, linking to People; no email is sent", async () => {
    const { t, fx } = await setup();
    const fresh = await t.run(async (ctx) => {
      const p = await insertProjectFor(ctx, fx.gcA.companyId, { title: "Harbor Point Dental Office TI 2", bidderName: "Eastbay Electric" });
      await ctx.db.patch(p.contractorId, { contactEmail: "kim.tran@eastbay-mail.com" });
      return p;
    });
    const res = await fx.gcA.admin.as.action(api.invites.create, {
      kind: "sub",
      email: "kim.tran@eastbay-mail.com",
      projectId: fresh.projectId,
      newVendor: { name: "Eastbay Electric", trade: "26 00 00", contactName: "Kim Tran" },
      sendEmail: false,
    });
    const kimId = await t.run((ctx) => ctx.db.insert("users", { email: "kim.tran@eastbay-mail.com", name: "Kim Tran", emailVerificationTime: Date.now() }));
    const kim = await withSession(t, kimId, "kim.tran@eastbay-mail.com");
    const token = res.link.match(/#\/invite\/([A-Za-z0-9_-]+)$/)![1];
    const accepted = await kim.mutation(api.invites.accept, { token });

    const rows = await allNotifications(t);
    expect(rows.every((r) => r.companyId === fx.gcA.companyId)).toBe(true);
    expect(rows.map((r) => r.userId).sort()).toEqual([fx.gcA.admin.userId, fx.gcA.member.userId].sort());
    expect(rows[0]).toMatchObject({
      kind: "invite_accepted",
      title: "Eastbay Electric joined Harbor Point Dental Office TI 2",
      link: `#/people/${fresh.projectId}`,
      projectId: fresh.projectId,
    });
    const outbox = await t.run((ctx) => ctx.db.query("emailOutbox").collect());
    expect(outbox.filter((o) => o.kind === "notification")).toEqual([]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    // A second invite for the same vendor reuses the same sub company.
    const third = await t.run((ctx) => insertProjectFor(ctx, fx.gcA.companyId, { title: "Harbor Point Phase 3", bidderName: "Eastbay Electric" }));
    const again = await fx.gcA.admin.as.action(api.invites.create, {
      kind: "sub",
      email: "kim.tran@eastbay-mail.com",
      projectId: third.projectId,
      vendorId: (await t.run((ctx) => ctx.db.get(res.inviteId)))!.vendorId!,
      sendEmail: false,
    });
    const second = await kim.mutation(api.invites.accept, { token: again.link.match(/#\/invite\/([A-Za-z0-9_-]+)$/)![1] });
    expect(second.companyId).toBe(accepted.companyId);
    expect((await allNotifications(t)).filter((r) => r.kind === "invite_accepted")).toHaveLength(4);
  });
});
