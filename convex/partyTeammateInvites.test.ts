/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture, insertProjectFor, type FixtureUser, type TenancyFixture } from "./lib/tenancyFixtures";
import { withSession } from "./lib/testIdentity";

/**
 * Teammate invites for sub and owner companies (architecture §13: joining an existing company only
 * happens through that company's own admin teammate invite), non-admin members of those companies,
 * and repeat sub invites for an already-linked vendor (VAL-VEND-008).
 */

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

async function setup() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const fx = await buildTenancyFixture(t);
  return { t, fx };
}

async function newHuman(t: T, email: string, name = "New Person"): Promise<FixtureUser> {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", { email, name, emailVerificationTime: Date.now() }));
  return { userId, email, as: await withSession(t, userId, email) };
}

function tokenOf(link: string): string {
  const m = link.match(/#\/invite\/([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error(`not an invite link: ${link}`);
  return m[1];
}

function stubAgentmail() {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ message_id: `<m${calls.length}@x>`, thread_id: `th${calls.length}` }), { status: 200 });
  }) as typeof fetch);
  return calls;
}

async function count(t: T, table: "invites" | "companies" | "emailOutbox"): Promise<number> {
  return await t.run(async (ctx) => (await ctx.db.query(table).collect()).length);
}

/** Invites `email` to the company of `admin` as a teammate and accepts it as a fresh verified account. */
async function joinAsMember(t: T, admin: FixtureUser, email: string, name: string): Promise<FixtureUser> {
  const res = await admin.as.action(api.invites.create, { kind: "teammate", email, sendEmail: false });
  const person = await newHuman(t, email, name);
  await person.as.mutation(api.invites.accept, { token: tokenOf(res.link) });
  return person;
}

async function linkedEastbayVendor(t: T, fx: TenancyFixture): Promise<Id<"vendors">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("vendors", {
      companyId: fx.gcA.companyId,
      name: "Eastbay Electric",
      trades: ["26 00 00"],
      contactName: "Kim",
      email: fx.sub.admin.email,
      linkedCompanyId: fx.sub.companyId,
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("AGENTMAIL_API_KEY", "test-agentmail-key");
  // Fictitious recipient domains: these tests exercise real send paths, so allow them past the non-prod recipient guard.
  vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", "mail-test.com,bayview-mail.com,eastbay-mail.com,harbor-mail.com,other-mail.com,*.test,agentmail.to");
  vi.stubEnv("EMAIL_DAILY_BUDGET", "60");
  vi.stubEnv("SITE_URL", "http://localhost:3150");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sub and owner admins invite teammates", () => {
  test("a sub admin's teammate invite works like a GC's: copy link, email with outbox row, resend, revoke", async () => {
    const { t, fx } = await setup();
    const calls = stubAgentmail();
    const copy = await fx.sub.admin.as.action(api.invites.create, { kind: "teammate", email: "Nora@Eastbay-Mail.com", sendEmail: false });
    expect(copy.emailStatus).toBe("not_sent");
    expect(copy.link).toMatch(/^http:\/\/localhost:3150\/#\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(calls).toHaveLength(0);
    const row = await t.run(async (ctx) => ctx.db.get(copy.inviteId));
    expect(row).toMatchObject({ kind: "teammate", email: "nora@eastbay-mail.com", inviterCompanyId: fx.sub.companyId, status: "pending" });
    expect(row?.projectId).toBeUndefined();

    const emailed = await fx.sub.admin.as.action(api.invites.create, { kind: "teammate", email: "estimator@eastbay-mail.com" });
    expect(emailed.emailStatus).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.subject).toContain("join Eastbay Electric");
    expect(calls[0].body.text).toContain(emailed.link);
    const outbox = await t.run(async (ctx) => ctx.db.query("emailOutbox").collect());
    expect(outbox).toEqual([expect.objectContaining({ kind: "invite", status: "sent", to: "estimator@eastbay-mail.com", companyId: fx.sub.companyId })]);

    const settings = await fx.sub.admin.as.query(api.companies.myCompany, {});
    expect(settings.teammateInvites.map((i) => i.email).sort()).toEqual(["estimator@eastbay-mail.com", "nora@eastbay-mail.com"]);

    const rotated = await fx.sub.admin.as.action(api.invites.resend, { inviteId: copy.inviteId, sendEmail: false });
    expect(rotated.link).not.toBe(copy.link);
    const nora = await newHuman(t, "nora@eastbay-mail.com", "Nora Lee");
    expect(await nora.as.query(api.invites.getByToken, { token: tokenOf(copy.link) })).toEqual({ state: "no_longer_valid" });
    expect(await nora.as.query(api.invites.getByToken, { token: tokenOf(rotated.link) })).toMatchObject({
      state: "pending",
      kind: "teammate",
      inviterCompanyName: "Eastbay Electric",
    });

    await fx.sub.admin.as.mutation(api.invites.revoke, { inviteId: emailed.inviteId });
    expect((await t.run(async (ctx) => ctx.db.get(emailed.inviteId)))?.status).toBe("revoked");
  });

  test("an owner admin's teammate invite respects the email budget and still returns the link", async () => {
    const { t, fx } = await setup();
    vi.stubEnv("EMAIL_DAILY_BUDGET", "10");
    const calls = stubAgentmail();
    const res = await fx.owner.admin.as.action(api.invites.create, { kind: "teammate", email: "office@harbor-mail.com" });
    expect(res.emailStatus).toBe("skipped_budget");
    expect(res.link).toMatch(/#\/invite\//);
    expect(calls).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("emailOutbox").collect())).toEqual([
      expect.objectContaining({ kind: "invite", status: "skipped_budget", companyId: fx.owner.companyId }),
    ]);
    const settings = await fx.owner.admin.as.query(api.companies.myCompany, {});
    expect(settings.teammateInvites).toEqual([expect.objectContaining({ _id: res.inviteId, emailStatus: "skipped_budget" })]);
  });

  test("accepting a sub teammate invite joins the sub company as a member with sub access", async () => {
    const { t, fx } = await setup();
    const companiesBefore = await count(t, "companies");
    const nora = await joinAsMember(t, fx.sub.admin, "nora@eastbay-mail.com", "Nora Lee");
    expect(await count(t, "companies")).toBe(companiesBefore);
    const members = await t.run(async (ctx) =>
      ctx.db.query("companyMembers").withIndex("by_userId", (q) => q.eq("userId", nora.userId)).collect(),
    );
    expect(members).toEqual([expect.objectContaining({ companyId: fx.sub.companyId, role: "member", status: "active" })]);
    expect(await nora.as.query(api.profiles.me, {})).toMatchObject({ role: "sub", company: { name: "Eastbay Electric", memberRole: "member" } });
    const projects = await nora.as.query(api.people.myProjects, {});
    expect(projects.map((p) => p.title)).toEqual(["Harbor Point Dental Office TI"]);
    // Still only the sub's own view: the GC-only People list stays closed.
    await expect(nora.as.query(api.people.listForProject, { projectId: fx.gcA.project.projectId })).rejects.toThrow(/Not found/);
    const kimView = await fx.sub.admin.as.query(api.companies.myCompany, {});
    expect(kimView.members.map((m) => [m.email, m.role])).toContainEqual(["nora@eastbay-mail.com", "member"]);
  });

  test("accepting an owner teammate invite joins the owner company as a member with owner access", async () => {
    const { t, fx } = await setup();
    const est = await joinAsMember(t, fx.owner.admin, "estimator@harbor-mail.com", "Esther Mora");
    const members = await t.run(async (ctx) =>
      ctx.db.query("companyMembers").withIndex("by_userId", (q) => q.eq("userId", est.userId)).collect(),
    );
    expect(members).toEqual([expect.objectContaining({ companyId: fx.owner.companyId, role: "member", status: "active" })]);
    expect(await est.as.query(api.profiles.me, {})).toMatchObject({ role: "owner", company: { name: "Harbor Point Dental LLC" } });
    expect((await est.as.query(api.projects.listProjects, {})).map((p) => p.title)).toEqual(["Harbor Point Dental Office TI"]);
  });

  test("a user who already belongs to another company cannot accept, and nothing changes", async () => {
    const { t, fx } = await setup();
    const res = await fx.sub.admin.as.action(api.invites.create, { kind: "teammate", email: fx.gcA.member.email, sendEmail: false });
    await expect(fx.gcA.member.as.mutation(api.invites.accept, { token: tokenOf(res.link) })).rejects.toThrow(
      /already belongs to Bayview Builders Inc\./,
    );
    const rows = await t.run(async (ctx) => ({
      invite: await ctx.db.get(res.inviteId),
      memberships: await ctx.db.query("companyMembers").withIndex("by_userId", (q) => q.eq("userId", fx.gcA.member.userId)).collect(),
    }));
    expect(rows.invite?.status).toBe("pending");
    expect(rows.memberships).toEqual([expect.objectContaining({ companyId: fx.gcA.companyId, status: "active" })]);
  });

  test("sub and owner companies still cannot create sub or owner project invites", async () => {
    const { t, fx } = await setup();
    const projectId = fx.gcA.project.projectId;
    const vendorId = await linkedEastbayVendor(t, fx);
    const before = await count(t, "invites");
    for (const who of [fx.sub.admin, fx.owner.admin]) {
      await expect(who.as.action(api.invites.create, { kind: "owner", email: "x@mail-test.com", projectId, sendEmail: false })).rejects.toThrow(
        /Not found/,
      );
      await expect(
        who.as.action(api.invites.create, { kind: "sub", email: "x@mail-test.com", projectId, vendorId, sendEmail: false }),
      ).rejects.toThrow(/Not found/);
      await expect(who.as.action(api.invites.create, { kind: "owner", email: "x@mail-test.com", sendEmail: false })).rejects.toThrow(/Not found/);
    }
    expect(await count(t, "invites")).toBe(before);
  });

  test("other companies cannot manage a sub's teammate invites", async () => {
    const { t, fx } = await setup();
    const res = await fx.sub.admin.as.action(api.invites.create, { kind: "teammate", email: "nora@eastbay-mail.com", sendEmail: false });
    for (const who of [fx.gcA.admin, fx.gcB.admin, fx.owner.admin, fx.demo.gc]) {
      await expect(who.as.mutation(api.invites.revoke, { inviteId: res.inviteId })).rejects.toThrow(/Not found/);
      await expect(who.as.action(api.invites.resend, { inviteId: res.inviteId, sendEmail: false })).rejects.toThrow(/Not found/);
      expect((await who.as.query(api.companies.myCompany, {})).teammateInvites.map((i) => i._id)).not.toContain(res.inviteId);
    }
    await expect(fx.noCompany.as.mutation(api.invites.revoke, { inviteId: res.inviteId })).rejects.toThrow(/Create or join a company first/);
    expect((await t.run(async (ctx) => ctx.db.get(res.inviteId)))?.status).toBe("pending");
  });
});

describe("non-admin members of sub and owner companies", () => {
  test("cannot invite, manage invites, or change the profile and payout email", async () => {
    const { t, fx } = await setup();
    const pending = await fx.sub.admin.as.action(api.invites.create, { kind: "teammate", email: "pending@eastbay-mail.com", sendEmail: false });
    const nora = await joinAsMember(t, fx.sub.admin, "nora@eastbay-mail.com", "Nora Lee");
    const invitesBefore = await count(t, "invites");
    await expect(nora.as.action(api.invites.create, { kind: "teammate", email: "z@mail-test.com", sendEmail: false })).rejects.toThrow(
      /only company admins can invite teammates/,
    );
    await expect(nora.as.action(api.invites.resend, { inviteId: pending.inviteId, sendEmail: false })).rejects.toThrow(/only company admins/);
    await expect(nora.as.mutation(api.invites.revoke, { inviteId: pending.inviteId })).rejects.toThrow(/only company admins/);
    expect(await count(t, "invites")).toBe(invitesBefore);

    const view = await nora.as.query(api.companies.myCompany, {});
    expect(view.isAdmin).toBe(false);
    expect(view.teammateInvites).toEqual([]);

    const companyBefore = await t.run(async (ctx) => ctx.db.get(fx.sub.companyId));
    await expect(nora.as.mutation(api.companies.updateProfile, { name: "Hacked Electric", phone: "5105550100" })).rejects.toThrow(
      /Forbidden: company admin required/,
    );
    await expect(nora.as.mutation(api.payee.setPayoutEmail, { email: "attacker@mail-test.com" })).rejects.toThrow(
      /Forbidden: company admin required/,
    );
    await expect(nora.as.mutation(api.companies.setMemberRole, { membershipId: view.members.find((m) => m.isYou)!.membershipId, role: "admin" })).rejects.toThrow(
      /Forbidden: company admin required/,
    );
    expect(await t.run(async (ctx) => ctx.db.get(fx.sub.companyId))).toEqual(companyBefore);
  });

  test("an owner member cannot change the profile or billing email", async () => {
    const { t, fx } = await setup();
    await fx.owner.admin.as.mutation(api.payee.setBillingEmail, { email: "ap@harbor-mail.com" });
    const est = await joinAsMember(t, fx.owner.admin, "estimator@harbor-mail.com", "Esther Mora");
    const before = await t.run(async (ctx) => ctx.db.get(fx.owner.companyId));
    await expect(est.as.mutation(api.payee.setBillingEmail, { email: "attacker@mail-test.com" })).rejects.toThrow(
      /Forbidden: company admin required/,
    );
    await expect(est.as.mutation(api.companies.updateProfile, { name: "Hacked Dental" })).rejects.toThrow(/Forbidden: company admin required/);
    await expect(est.as.action(api.invites.create, { kind: "teammate", email: "z@mail-test.com", sendEmail: false })).rejects.toThrow(
      /only company admins/,
    );
    expect(await t.run(async (ctx) => ctx.db.get(fx.owner.companyId))).toEqual(before);
    const view = await est.as.query(api.companies.myCompany, {});
    expect(view).toMatchObject({ isAdmin: false, company: { billingEmail: "ap@harbor-mail.com" } });
  });
});

describe("repeat sub invites for an already-linked vendor (VAL-VEND-008)", () => {
  test("a second project of the same GC reuses the sub company; the same project is refused", async () => {
    const { t, fx } = await setup();
    const vendorId = await linkedEastbayVendor(t, fx);
    const second = await t.run(async (ctx) => {
      const p = await insertProjectFor(ctx, fx.gcA.companyId, { title: "Harbor Point Phase 2", bidderName: "Eastbay Electric" });
      await ctx.db.patch(p.contractorId, { contactEmail: fx.sub.admin.email, vendorId });
      return p;
    });
    const companiesBefore = await count(t, "companies");
    const res = await fx.gcA.admin.as.action(api.invites.create, {
      kind: "sub",
      email: fx.sub.admin.email,
      projectId: second.projectId,
      vendorId,
      sendEmail: false,
    });
    const accepted = await fx.sub.admin.as.mutation(api.invites.accept, { token: tokenOf(res.link) });
    expect(accepted.companyId).toBe(fx.sub.companyId);
    const rows = await t.run(async (ctx) => ({
      companies: (await ctx.db.query("companies").collect()).length,
      vendor: await ctx.db.get(vendorId),
      contractor: await ctx.db.get(second.contractorId),
      members: await ctx.db
        .query("projectMembers")
        .withIndex("by_project_company_and_status", (q) => q.eq("projectId", second.projectId).eq("companyId", fx.sub.companyId))
        .collect(),
      memberships: await ctx.db.query("companyMembers").withIndex("by_userId", (q) => q.eq("userId", fx.sub.admin.userId)).collect(),
    }));
    expect(rows.companies).toBe(companiesBefore);
    expect(rows.vendor?.linkedCompanyId).toBe(fx.sub.companyId);
    expect(rows.contractor).toMatchObject({ linkedCompanyId: fx.sub.companyId, vendorId });
    expect(rows.members).toEqual([expect.objectContaining({ partyRole: "sub", vendorId, status: "active" })]);
    expect(rows.memberships).toEqual([expect.objectContaining({ companyId: fx.sub.companyId, role: "admin", status: "active" })]);
    const projects = await fx.sub.admin.as.query(api.people.myProjects, {});
    expect(projects.map((p) => p.title).sort()).toEqual(["Harbor Point Dental Office TI", "Harbor Point Phase 2"]);

    const invitesBefore = await count(t, "invites");
    for (const projectId of [second.projectId, fx.gcA.project.projectId]) {
      await expect(
        fx.gcA.admin.as.action(api.invites.create, { kind: "sub", email: fx.sub.admin.email, projectId, vendorId, sendEmail: false }),
      ).rejects.toThrow("Eastbay Electric is already on this project.");
    }
    expect(await count(t, "invites")).toBe(invitesBefore);
  });
});
