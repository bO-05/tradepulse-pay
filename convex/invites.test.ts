/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { hashInviteToken, INVITE_TTL_MS } from "./lib/inviteRules";
import { buildTenancyFixture, insertProjectFor, type FixtureUser } from "./lib/tenancyFixtures";
import { withSession } from "./lib/testIdentity";

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

const TABLES = Object.keys(schema.tables) as (keyof typeof schema.tables)[];

async function setup() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const fx = await buildTenancyFixture(t);
  // A fresh Bayview project with an Eastbay bidder row (contact = Kim's new address) and no members yet.
  const fresh = await t.run(async (ctx) => {
    const p = await insertProjectFor(ctx, fx.gcA.companyId, { title: "Harbor Point Phase 2", bidderName: "Eastbay Electric" });
    await ctx.db.patch(p.contractorId, { contactEmail: "kim.tran@eastbay-mail.com" });
    await ctx.db.patch(p.projectId, { ownerName: "Harbor Point Dental LLC" });
    return p;
  });
  return { t, fx, fresh };
}

async function newHuman(t: T, email: string, name = "New Person", verified = true): Promise<FixtureUser> {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { email, name, emailVerificationTime: verified ? Date.now() : undefined }),
  );
  return { userId, email, as: await withSession(t, userId, email) };
}

function tokenOf(link: string): string {
  const m = link.match(/#\/invite\/([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error(`not an invite link: ${link}`);
  return m[1];
}

async function dump(t: T): Promise<string> {
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) out[table] = await ctx.db.query(table).collect();
    return JSON.stringify(out);
  });
}

async function inviteRow(t: T, id: Id<"invites">) {
  return (await t.run(async (ctx) => await ctx.db.get(id)))!;
}

type FetchCall = { url: string; body: any };
function stubAgentmail(status = 200) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (status !== 200) return new Response("boom", { status });
    return new Response(JSON.stringify({ message_id: `<m${calls.length}@x>`, thread_id: `th${calls.length}` }), { status: 200 });
  }) as typeof fetch);
  return calls;
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
  vi.useRealTimers();
});

describe("creating invites", () => {
  test("copy-link teammate invite: link with a 256-bit token, only its sha256 stored, 7-day expiry, no email", async () => {
    const { t, fx } = await setup();
    const calls = stubAgentmail();
    const res = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "Luis@Bayview-Mail.com", sendEmail: false });
    expect(res.link).toMatch(/^http:\/\/localhost:3150\/#\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(res.emailStatus).toBe("not_sent");
    const token = tokenOf(res.link);
    const row = await inviteRow(t, res.inviteId);
    expect(row).toMatchObject({ kind: "teammate", email: "luis@bayview-mail.com", status: "pending", emailStatus: "not_sent" });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).toBe(await hashInviteToken(token));
    expect(row.expiresAt - row.createdAt).toBe(INVITE_TTL_MS);
    expect(await dump(t)).not.toContain(token);
    expect(calls).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("emailOutbox").collect()).length)).toBe(0);
  });

  test("emailed invite: one branded send with the link, outbox 'sent', token never stored", async () => {
    const { t, fx, fresh } = await setup();
    const calls = stubAgentmail();
    const res = await fx.gcA.admin.as.action(api.invites.create, {
      kind: "owner",
      email: "mendez@harbor-mail.com",
      projectId: fresh.projectId,
    });
    expect(res.emailStatus).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/inboxes/cleverneed464%40agentmail.to/messages/send");
    expect(calls[0].body.to).toEqual(["mendez@harbor-mail.com"]);
    expect(calls[0].body.text).toContain(res.link);
    expect(calls[0].body.text).toContain("Bayview Builders Inc.");
    expect(calls[0].body.text).toContain("Harbor Point Phase 2");
    expect(calls[0].body.html).toContain("TradePulse Pay");
    const token = tokenOf(res.link);
    expect(await dump(t)).not.toContain(token);
    const outbox = await t.run(async (ctx) => await ctx.db.query("emailOutbox").collect());
    expect(outbox).toEqual([expect.objectContaining({ kind: "invite", status: "sent", to: "mendez@harbor-mail.com" })]);
    const row = await inviteRow(t, res.inviteId);
    expect(row.emailStatus).toBe("sent");
    expect(row.lastSentAt).toBeDefined();
  });

  test("over the invite budget the email is skipped, recorded, and the link still returned", async () => {
    const { t, fx } = await setup();
    vi.stubEnv("EMAIL_DAILY_BUDGET", "10"); // invites stop at budget - 10 = 0
    const calls = stubAgentmail();
    const res = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "budget@mail-test.com" });
    expect(res.emailStatus).toBe("skipped_budget");
    expect(res.link).toMatch(/#\/invite\//);
    expect(calls).toHaveLength(0);
    expect((await inviteRow(t, res.inviteId)).emailStatus).toBe("skipped_budget");
    const outbox = await t.run(async (ctx) => await ctx.db.query("emailOutbox").collect());
    expect(outbox).toEqual([expect.objectContaining({ kind: "invite", status: "skipped_budget" })]);
  });

  test("a rejected send is reported as failed with the reason", async () => {
    const { t, fx } = await setup();
    stubAgentmail(500);
    const res = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "fails@mail-test.com" });
    expect(res.emailStatus).toBe("failed");
    expect(res.emailError).toMatch(/AgentMail 500/);
    expect((await inviteRow(t, res.inviteId)).emailStatus).toBe("failed");
  });

  test("only GC members create project invites, only on their own projects; bad emails create nothing", async () => {
    const { t, fx } = await setup();
    const projectId = fx.gcA.project.projectId;
    const before = await t.run(async (ctx) => (await ctx.db.query("invites").collect()).length);
    await expect(
      fx.sub.admin.as.action(api.invites.create, { kind: "owner", email: "x@mail-test.com", projectId, sendEmail: false }),
    ).rejects.toThrow(/Not found/);
    await expect(
      fx.owner.admin.as.action(api.invites.create, {
        kind: "sub",
        email: "x@mail-test.com",
        projectId,
        newVendor: { name: "X Co", trade: "26 00 00", contactName: "X" },
        sendEmail: false,
      }),
    ).rejects.toThrow(/Not found/);
    await expect(
      fx.gcB.admin.as.action(api.invites.create, { kind: "owner", email: "x@mail-test.com", projectId, sendEmail: false }),
    ).rejects.toThrow(/Not found/);
    await expect(fx.gcA.member.as.action(api.invites.create, { kind: "teammate", email: "x@mail-test.com", sendEmail: false })).rejects.toThrow(
      /only company admins/,
    );
    await expect(fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "bad@@example", sendEmail: false })).rejects.toThrow(
      /valid email/,
    );
    expect(await t.run(async (ctx) => (await ctx.db.query("invites").collect()).length)).toBe(before);
    const ok = await fx.gcA.member.as.action(api.invites.create, {
      kind: "sub",
      email: "lake@mail-test.com",
      projectId,
      newVendor: { name: "Lakeshore Mechanical", trade: "23 00 00", contactName: "Ray" },
      sendEmail: false,
    });
    expect((await inviteRow(t, ok.inviteId)).kind).toBe("sub");
  });

  test("a GC admin whose email is not verified cannot create teammate or sub invites, and nothing is sent", async () => {
    const { t, fx, fresh } = await setup();
    const calls = stubAgentmail();
    await t.run(async (ctx) => ctx.db.patch(fx.gcA.admin.userId, { emailVerificationTime: undefined }));
    const counts = () =>
      t.run(async (ctx) => ({
        invites: (await ctx.db.query("invites").collect()).length,
        emailOutbox: (await ctx.db.query("emailOutbox").collect()).length,
        companies: (await ctx.db.query("companies").collect()).length,
      }));
    const before = await counts();
    expect(await errorData(fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "luis.v@mail-test.com" }))).toMatchObject({
      code: "EMAIL_UNVERIFIED",
    });
    expect(
      await errorData(
        fx.gcA.admin.as.action(api.invites.create, {
          kind: "sub",
          email: "kim.v@mail-test.com",
          projectId: fresh.projectId,
          newVendor: { name: "Eastbay Electric", trade: "26 00 00", contactName: "Kim" },
        }),
      ),
    ).toMatchObject({ code: "EMAIL_UNVERIFIED" });
    expect(await counts()).toEqual(before);
    expect(calls).toHaveLength(0);
  });

  test("an unverified user with no company cannot create invites, and nothing is created", async () => {
    const { t, fresh } = await setup();
    const calls = stubAgentmail();
    const stranger = await newHuman(t, "unverified@mail-test.com", "Una Verified", false);
    const before = await dump(t);
    // The action's company check refuses before any email-verification check is reached.
    const noCompany = { code: "NO_COMPANY", message: "Create or join a company first." };
    expect(await errorData(stranger.as.action(api.invites.create, { kind: "teammate", email: "someone@mail-test.com" }))).toEqual(noCompany);
    expect(
      await errorData(stranger.as.action(api.invites.create, { kind: "owner", email: "someone@mail-test.com", projectId: fresh.projectId })),
    ).toEqual(noCompany);
    expect(await dump(t)).toBe(before);
    expect(calls).toHaveLength(0);
  });
});

async function errorData(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p;
  } catch (e) {
    const data = (e as { data?: unknown }).data;
    if (data && typeof data === "object") return data as { code?: string };
    return { message: (e as Error).message };
  }
  throw new Error("expected the call to fail");
}

describe("accepting invites", () => {
  test("teammate joins the inviter company as a member and sees its projects", async () => {
    const { t, fx } = await setup();
    const res = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "luis.new@mail-test.com", sendEmail: false });
    const luis = await newHuman(t, "luis.new@mail-test.com", "Luis Ortega");
    const page = await luis.as.query(api.invites.getByToken, { token: tokenOf(res.link) });
    expect(page).toMatchObject({ state: "pending", kind: "teammate", inviterCompanyName: "Bayview Builders Inc.", viewer: { emailMatches: true } });
    await luis.as.mutation(api.invites.accept, { token: tokenOf(res.link) });
    const rows = await t.run(async (ctx) => ({
      members: await ctx.db.query("companyMembers").withIndex("by_userId", (q) => q.eq("userId", luis.userId)).collect(),
      invite: await ctx.db.get(res.inviteId),
      companies: (await ctx.db.query("companies").collect()).length,
    }));
    expect(rows.members).toEqual([expect.objectContaining({ companyId: fx.gcA.companyId, role: "member", status: "active" })]);
    expect(rows.invite).toMatchObject({ status: "accepted", acceptedByUserId: luis.userId });
    const projects = await luis.as.query(api.projects.listProjects, {});
    expect(projects.map((p) => p.title)).toContain("Harbor Point Dental Office TI");
    const me = await luis.as.query(api.profiles.me, {});
    expect(me).toMatchObject({ role: "gc", company: { name: "Bayview Builders Inc.", memberRole: "member" } });
    // Reuse by anyone, including the inviter, is refused.
    await expect(fx.gcA.admin.as.mutation(api.invites.accept, { token: tokenOf(res.link) })).rejects.toThrow(/no longer valid/);
    expect(await luis.as.query(api.invites.getByToken, { token: tokenOf(res.link) })).toEqual({ state: "no_longer_valid" });
  });

  test("a different email cannot accept, and the invite stays pending", async () => {
    const { t, fx } = await setup();
    const res = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "ops-1@mail-test.com", sendEmail: false });
    const page = await fx.gcB.admin.as.query(api.invites.getByToken, { token: tokenOf(res.link) });
    expect(page).toMatchObject({ state: "pending", email: "o***@mail-test.com", viewer: { emailMatches: false } });
    await expect(fx.gcB.admin.as.mutation(api.invites.accept, { token: tokenOf(res.link) })).rejects.toThrow(/different email \(o\*\*\*@mail-test.com\)/);
    expect((await inviteRow(t, res.inviteId)).status).toBe("pending");
    const memberships = await t.run(async (ctx) =>
      ctx.db.query("companyMembers").withIndex("by_userId", (q) => q.eq("userId", fx.gcB.admin.userId)).collect(),
    );
    expect(memberships).toEqual([expect.objectContaining({ companyId: fx.gcB.companyId, status: "active" })]);
  });

  test("sub invite creates the sub company, links vendor and bidder rows, and adds the project member", async () => {
    const { t, fx, fresh } = await setup();
    const res = await fx.gcA.admin.as.action(api.invites.create, {
      kind: "sub",
      email: "kim.tran@eastbay-mail.com",
      projectId: fresh.projectId,
      newVendor: { name: "Eastbay Electric", trade: "26 00 00", contactName: "Kim Tran" },
      sendEmail: false,
    });
    const kim = await newHuman(t, "kim.tran@eastbay-mail.com", "Kim Tran");
    const accepted = await kim.as.mutation(api.invites.accept, { token: tokenOf(res.link) });
    const rows = await t.run(async (ctx) => {
      const invite = (await ctx.db.get(res.inviteId))!;
      return {
        company: await ctx.db.get(accepted.companyId),
        vendor: await ctx.db.get(invite.vendorId!),
        contractor: await ctx.db.get(fresh.contractorId),
        members: await ctx.db.query("projectMembers").withIndex("by_project_company_and_status", (q) => q.eq("projectId", fresh.projectId).eq("companyId", accepted.companyId)).collect(),
        admin: await ctx.db.query("companyMembers").withIndex("by_userId", (q) => q.eq("userId", kim.userId)).collect(),
      };
    });
    expect(rows.company).toMatchObject({ name: "Eastbay Electric", kind: "sub", isDemo: false });
    expect(rows.vendor?.linkedCompanyId).toBe(accepted.companyId);
    expect(rows.contractor).toMatchObject({ linkedCompanyId: accepted.companyId, vendorId: rows.vendor!._id });
    expect(rows.members).toEqual([expect.objectContaining({ partyRole: "sub", vendorId: rows.vendor!._id, status: "active" })]);
    expect(rows.admin).toEqual([expect.objectContaining({ role: "admin", status: "active" })]);
    const projects = await kim.as.query(api.people.myProjects, {});
    expect(projects).toEqual([expect.objectContaining({ title: "Harbor Point Phase 2", gcCompanyName: "Bayview Builders Inc." })]);
    expect((await kim.as.query(api.profiles.me, {}))?.role).toBe("sub");
  });

  test("a sub invited by a second GC reuses its company and sees each GC's data only in that GC's project", async () => {
    const { t, fx } = await setup();
    // Sonoran invites the fixture's Eastbay admin to its project.
    const res = await fx.gcB.admin.as.action(api.invites.create, {
      kind: "sub",
      email: fx.sub.admin.email,
      projectId: fx.gcB.project.projectId,
      newVendor: { name: "Eastbay Electric", trade: "26 00 00", contactName: "Kim" },
      sendEmail: false,
    });
    const before = await t.run(async (ctx) => (await ctx.db.query("companies").collect()).length);
    const accepted = await fx.sub.admin.as.mutation(api.invites.accept, { token: tokenOf(res.link) });
    expect(accepted.companyId).toBe(fx.sub.companyId);
    expect(await t.run(async (ctx) => (await ctx.db.query("companies").collect()).length)).toBe(before);
    const projects = await fx.sub.admin.as.query(api.people.myProjects, {});
    expect(projects.map((p) => [p.title, p.gcCompanyName]).sort()).toEqual([
      ["Camelback Suite 400", "Sonoran Interiors GC"],
      ["Harbor Point Dental Office TI", "Bayview Builders Inc."],
    ]);
    // Sonoran's other bidder (not linked to Eastbay) stays invisible; Bayview's agreement stays invisible to Sonoran.
    const camelback = await fx.sub.admin.as.query(api.people.projectOverview, { projectId: fx.gcB.project.projectId });
    expect(camelback?.agreements).toEqual([]);
    const harbor = await fx.sub.admin.as.query(api.people.projectOverview, { projectId: fx.gcA.project.projectId });
    expect(harbor?.agreements.map((a) => a._id)).toEqual([fx.gcA.project.agreementId]);
    expect(await fx.gcB.admin.as.query(api.portal.getAgreementSummary, { agreementId: fx.gcA.project.agreementId })).toBeNull();
    await expect(fx.gcB.admin.as.query(api.people.listForProject, { projectId: fx.gcA.project.projectId })).rejects.toThrow(/Not found/);
  });

  test("a sub invite never admits a fresh account into the vendor's existing sub company", async () => {
    const { t, fx, fresh } = await setup();
    // Bayview's vendor record is already linked to Eastbay's company; Bayview invites an address it controls.
    const vendorId = await t.run(async (ctx) =>
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
    const res = await fx.gcA.admin.as.action(api.invites.create, {
      kind: "sub",
      email: "spy@bayview-controlled.test",
      projectId: fresh.projectId,
      vendorId,
      sendEmail: false,
    });
    const spy = await newHuman(t, "spy@bayview-controlled.test", "Spy");
    const before = await dump(t);
    await expect(spy.as.mutation(api.invites.accept, { token: tokenOf(res.link) })).rejects.toThrow(
      "Eastbay Electric is already on TradePulse Pay — invite one of its members, or ask its admin to add you.",
    );
    expect(await dump(t)).toBe(before);
    expect((await inviteRow(t, res.inviteId)).status).toBe("pending");
    // The fresh account gained nothing: no company, no access to Eastbay's projects with either GC.
    await expect(spy.as.query(api.projects.getProject, { projectId: fx.gcA.project.projectId })).rejects.toThrow(/Not found|NO_COMPANY/);
    const members = await t.run(async (ctx) =>
      ctx.db.query("companyMembers").withIndex("by_companyId", (q) => q.eq("companyId", fx.sub.companyId)).collect(),
    );
    expect(members.map((m) => m.userId)).toEqual([fx.sub.admin.userId]);

    // A member of a different sub company is refused the same way.
    const other = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "Lakeshore Mechanical", kind: "sub", isDemo: false, createdAt: Date.now() });
      const userId = await ctx.db.insert("users", { email: "ray@lakeshore.test", name: "Ray", emailVerificationTime: Date.now() });
      await ctx.db.insert("companyMembers", { companyId, userId, role: "admin", status: "active", createdAt: Date.now() });
      return userId;
    });
    const ray = await withSession(t, other, "ray@lakeshore.test");
    const res2 = await fx.gcA.admin.as.action(api.invites.create, { kind: "sub", email: "ray@lakeshore.test", projectId: fresh.projectId, vendorId, sendEmail: false });
    await expect(ray.mutation(api.invites.accept, { token: tokenOf(res2.link) })).rejects.toThrow(/Eastbay Electric is already on TradePulse Pay/);

    // A member of the linked company itself still accepts.
    const res3 = await fx.gcA.admin.as.action(api.invites.create, { kind: "sub", email: fx.sub.admin.email, projectId: fresh.projectId, vendorId, sendEmail: false });
    const accepted = await fx.sub.admin.as.mutation(api.invites.accept, { token: tokenOf(res3.link) });
    expect(accepted.companyId).toBe(fx.sub.companyId);
  });

  test("owner invite creates the owner company (name prefilled, editable) and sets the project owner", async () => {
    const { t, fx, fresh } = await setup();
    const res = await fx.gcA.admin.as.action(api.invites.create, { kind: "owner", email: "mendez@mail-test.com", projectId: fresh.projectId, sendEmail: false });
    const mendez = await newHuman(t, "mendez@mail-test.com", "Dr. Elena Mendez");
    const page = await mendez.as.query(api.invites.getByToken, { token: tokenOf(res.link) });
    expect(page).toMatchObject({ state: "pending", kind: "owner", inviteeCompanyName: "Harbor Point Dental LLC", projectTitle: "Harbor Point Phase 2" });
    const accepted = await mendez.as.mutation(api.invites.accept, { token: tokenOf(res.link), companyName: "Harbor Point Dental LLC" });
    const rows = await t.run(async (ctx) => ({
      company: await ctx.db.get(accepted.companyId),
      project: await ctx.db.get(fresh.projectId),
      members: await ctx.db.query("projectMembers").withIndex("by_project_company_and_status", (q) => q.eq("projectId", fresh.projectId).eq("companyId", accepted.companyId)).collect(),
    }));
    expect(rows.company).toMatchObject({ name: "Harbor Point Dental LLC", kind: "owner" });
    expect(rows.project?.ownerCompanyId).toBe(accepted.companyId);
    expect(rows.members).toEqual([expect.objectContaining({ partyRole: "owner", status: "active" })]);
    expect((await mendez.as.query(api.profiles.me, {}))?.role).toBe("owner");
    expect((await mendez.as.query(api.projects.listProjects, {})).map((p) => p.title)).toEqual(["Harbor Point Phase 2"]);
  });

  test("billing agents cannot accept, and nothing is created for them", async () => {
    const { t, fx, fresh } = await setup();
    const res = await fx.gcA.admin.as.action(api.invites.create, {
      kind: "sub",
      email: "boldlevel182@agentmail.to",
      projectId: fresh.projectId,
      newVendor: { name: "Agent Co", trade: "26 00 00", contactName: "Agent" },
      sendEmail: false,
    });
    const agentId = await t.run(async (ctx) => ctx.db.insert("users", { email: "boldlevel182@agentmail.to", actorType: "agent", agentSub: "agent-1" }));
    const agent = await withSession(t, agentId, "boldlevel182@agentmail.to");
    const page = await agent.query(api.invites.getByToken, { token: tokenOf(res.link) });
    expect(page).toMatchObject({ state: "pending", viewer: { isAgent: true, emailMatches: false } });
    const before = await dump(t);
    await expect(agent.mutation(api.invites.accept, { token: tokenOf(res.link) })).rejects.toThrow(/billing agents can't accept/);
    expect(await dump(t)).toBe(before);
  });

  test("malformed, unknown and empty tokens read as not valid", async () => {
    const { fx } = await setup();
    for (const token of ["", "not-a-real-token", "A".repeat(43)]) {
      expect(await fx.noCompany.as.query(api.invites.getByToken, { token })).toEqual({ state: "invalid" });
    }
    const t2 = convexTest(schema, modules);
    expect(await t2.query(api.invites.getByToken, { token: "not-a-real-token" })).toEqual({ state: "invalid" });
  });
});

describe("resend, revoke and expiry", () => {
  test("resend rotates the token: the old link is no longer valid, the new one works and is emailed", async () => {
    const { t, fx } = await setup();
    const calls = stubAgentmail();
    const first = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "estimator-1@mail-test.com", sendEmail: false });
    const hash1 = (await inviteRow(t, first.inviteId)).tokenHash;
    const second = await fx.gcA.admin.as.action(api.invites.resend, { inviteId: first.inviteId, sendEmail: true });
    expect(second.link).not.toBe(first.link);
    expect(second.emailStatus).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.text).toContain(second.link);
    expect(calls[0].body.text).not.toContain(first.link);
    const row = await inviteRow(t, first.inviteId);
    expect(row.tokenHash).not.toBe(hash1);
    expect(row.lastSentAt).toBeDefined();
    const est = await newHuman(t, "estimator-1@mail-test.com");
    expect(await est.as.query(api.invites.getByToken, { token: tokenOf(first.link) })).toEqual({ state: "no_longer_valid" });
    expect(await est.as.query(api.invites.getByToken, { token: tokenOf(second.link) })).toMatchObject({ state: "pending" });
    await expect(est.as.mutation(api.invites.accept, { token: tokenOf(first.link) })).rejects.toThrow(/no longer valid/);
  });

  test("revoked invites cannot be accepted; other companies cannot revoke", async () => {
    const { t, fx } = await setup();
    const res = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "rev@mail-test.com", sendEmail: false });
    await expect(fx.sub.admin.as.mutation(api.invites.revoke, { inviteId: res.inviteId })).rejects.toThrow(/Not found/);
    await expect(fx.gcB.admin.as.mutation(api.invites.revoke, { inviteId: res.inviteId })).rejects.toThrow(/Not found/);
    expect((await inviteRow(t, res.inviteId)).status).toBe("pending");
    await fx.gcA.admin.as.mutation(api.invites.revoke, { inviteId: res.inviteId });
    expect((await inviteRow(t, res.inviteId)).status).toBe("revoked");
    const user = await newHuman(t, "rev@mail-test.com");
    await expect(user.as.mutation(api.invites.accept, { token: tokenOf(res.link) })).rejects.toThrow(/no longer valid/);
    expect(await user.as.query(api.invites.getByToken, { token: tokenOf(res.link) })).toEqual({ state: "no_longer_valid" });
  });

  test("invites expire after 7 days: accept fails at 7 days + 1 minute", async () => {
    vi.useFakeTimers();
    const { t, fx } = await setup();
    const res = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "late@mail-test.com", sendEmail: false });
    const user = await newHuman(t, "late@mail-test.com");
    vi.advanceTimersByTime(INVITE_TTL_MS + 60_000);
    await expect(user.as.mutation(api.invites.accept, { token: tokenOf(res.link) })).rejects.toThrow(
      /This invite has expired — ask Bayview Builders Inc\. to resend it/,
    );
    const page = await user.as.query(api.invites.getByToken, { token: tokenOf(res.link) });
    expect(page.state === "pending" && page.expiresAt <= Date.now()).toBe(true);
    expect((await inviteRow(t, res.inviteId)).status).toBe("pending");
  });

  test("an invite 6 days 23 hours old is still accepted", async () => {
    vi.useFakeTimers();
    const { t, fx } = await setup();
    const res = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "ontime@mail-test.com", sendEmail: false });
    const user = await newHuman(t, "ontime@mail-test.com");
    vi.advanceTimersByTime(6 * 86_400_000 + 23 * 3_600_000);
    await user.as.mutation(api.invites.accept, { token: tokenOf(res.link) });
    expect((await inviteRow(t, res.inviteId)).status).toBe("accepted");
  });
});

describe("people and company settings", () => {
  test("People lists companies and invites for the GC only; removal is immediate and re-invite restores access", async () => {
    const { t, fx } = await setup();
    const projectId = fx.gcA.project.projectId;
    const people = await fx.gcA.admin.as.query(api.people.listForProject, { projectId });
    expect(people.companies.map((c) => [c.name, c.partyRole])).toEqual([
      ["Bayview Builders Inc.", "gc"],
      ["Eastbay Electric", "sub"],
      ["Harbor Point Dental LLC", "owner"],
    ]);
    await expect(fx.sub.admin.as.query(api.people.listForProject, { projectId })).rejects.toThrow(/Not found/);
    await expect(fx.owner.admin.as.query(api.people.listForProject, { projectId })).rejects.toThrow(/Not found/);
    await expect(fx.sub.admin.as.mutation(api.people.removeProjectMember, { projectId, companyId: fx.owner.companyId })).rejects.toThrow(/Not found/);

    await fx.gcA.admin.as.mutation(api.people.removeProjectMember, { projectId, companyId: fx.sub.companyId });
    await expect(fx.sub.admin.as.query(api.projects.getProject, { projectId })).rejects.toThrow(/Not found/);
    expect(await fx.sub.admin.as.query(api.people.projectOverview, { projectId })).toBeNull();
    const row = await t.run(async (ctx) =>
      ctx.db.query("projectMembers").withIndex("by_project_company_and_status", (q) => q.eq("projectId", projectId).eq("companyId", fx.sub.companyId)).collect(),
    );
    expect(row).toEqual([expect.objectContaining({ status: "removed" })]);
    // History stays with the GC.
    expect(await fx.gcA.admin.as.query(api.portal.getAgreementSummary, { agreementId: fx.gcA.project.agreementId })).not.toBeNull();

    const vendorId = await t.run(async (ctx) =>
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
    const again = await fx.gcA.admin.as.action(api.invites.create, { kind: "sub", email: fx.sub.admin.email, projectId, vendorId, sendEmail: false });
    await fx.sub.admin.as.mutation(api.invites.accept, { token: tokenOf(again.link) });
    expect((await fx.sub.admin.as.query(api.projects.getProject, { projectId }))._id).toBe(projectId);
    const subView = (await fx.sub.admin.as.query(api.people.projectOverview, { projectId }))!;
    expect(subView.gcContacts.map((m) => m.email)).toEqual(["dana@bayview.test"]);
    expect(subView.yourCompanyName).toBe("Eastbay Electric");
    expect(subView.yourTeam.map((m) => m.email)).toEqual(["kim@eastbay.test"]);
  });

  test("company settings: admins edit and manage roles, members cannot, the last admin stays", async () => {
    const { t, fx } = await setup();
    await fx.gcA.admin.as.mutation(api.companies.updateProfile, {
      name: "Bayview Builders Inc.",
      phone: "510 555 0190",
      website: "https://bayviewbuilders.example",
    });
    const company = await t.run(async (ctx) => ctx.db.get(fx.gcA.companyId));
    expect(company).toMatchObject({ phone: "(510) 555-0190", website: "https://bayviewbuilders.example" });
    await expect(fx.gcA.member.as.mutation(api.companies.updateProfile, { name: "Hacked" })).rejects.toThrow(/admin required/);
    await expect(fx.gcA.admin.as.mutation(api.companies.updateProfile, { name: "Bayview", website: "not a url" })).rejects.toThrow(/https/);

    const settings = await fx.gcA.admin.as.query(api.companies.myCompany, {});
    const luis = settings.members.find((m) => m.email === "luis@bayview.test")!;
    const dana = settings.members.find((m) => m.isYou)!;
    await expect(fx.gcA.member.as.mutation(api.companies.removeMember, { membershipId: dana.membershipId })).rejects.toThrow(/admin required/);
    await expect(fx.gcB.admin.as.mutation(api.companies.removeMember, { membershipId: luis.membershipId })).rejects.toThrow(/Not found/);

    await fx.gcA.admin.as.mutation(api.companies.setMemberRole, { membershipId: luis.membershipId, role: "admin" });
    await fx.gcA.admin.as.mutation(api.companies.setMemberRole, { membershipId: luis.membershipId, role: "member" });
    await fx.gcA.admin.as.mutation(api.companies.removeMember, { membershipId: luis.membershipId });
    await expect(fx.gcA.member.as.query(api.projects.getProject, { projectId: fx.gcA.project.projectId })).rejects.toThrow(/Not found/);
    expect(await fx.gcA.member.as.query(api.profiles.me, {})).toMatchObject({ company: null, wasRemovedFromCompany: true });

    await expect(fx.gcA.admin.as.mutation(api.companies.removeMember, { membershipId: dana.membershipId })).rejects.toThrow(
      /A company needs at least one admin/,
    );
    await expect(fx.gcA.admin.as.mutation(api.companies.setMemberRole, { membershipId: dana.membershipId, role: "member" })).rejects.toThrow(
      /A company needs at least one admin/,
    );
  });

  test("cross-company isolation: other GC, sub, owner, Demo and no-company callers see Not found", async () => {
    const { t, fx } = await setup();
    const projectId = fx.gcA.project.projectId;
    const vendorId = await t.run(async (ctx) =>
      ctx.db.insert("vendors", { companyId: fx.gcA.companyId, name: "Lakeshore Mechanical", trades: ["23 00 00"], contactName: "Ray", email: "ray@lakeshore.test", status: "active", createdAt: Date.now() }),
    );
    const inv = await fx.gcA.admin.as.action(api.invites.create, { kind: "owner", email: "owner2@mail-test.com", projectId, companyName: "HP", sendEmail: false });
    const outsiders = [fx.gcB.admin, fx.sub.admin, fx.owner.admin, fx.demo.gc, fx.noCompany];
    // A caller with no company is told to set one up; nothing about the project is revealed.
    const denied = /Not found|NO_COMPANY/;
    for (const who of outsiders) {
      await expect(who.as.query(api.people.listForProject, { projectId })).rejects.toThrow(denied);
      await expect(who.as.mutation(api.people.removeProjectMember, { projectId, companyId: fx.sub.companyId })).rejects.toThrow(denied);
      await expect(who.as.mutation(api.invites.revoke, { inviteId: inv.inviteId })).rejects.toThrow(denied);
      await expect(who.as.action(api.invites.resend, { inviteId: inv.inviteId, sendEmail: false })).rejects.toThrow(denied);
      await expect(who.as.action(api.invites.create, { kind: "sub", email: "x@mail-test.com", projectId, vendorId, sendEmail: false })).rejects.toThrow(denied);
      if (who !== fx.sub.admin && who !== fx.owner.admin) expect(await who.as.query(api.people.projectOverview, { projectId })).toBeNull();
    }
    for (const who of [fx.gcB.admin, fx.demo.gc]) {
      const vendors = await who.as.query(api.vendors.listVendors, {});
      expect(vendors.map((v) => v._id)).not.toContain(vendorId);
      const mine = await who.as.query(api.companies.myCompany, {});
      expect(mine?.members.map((m) => m.email)).not.toContain("luis@bayview.test");
    }
    expect((await inviteRow(t, inv.inviteId)).status).toBe("pending");
  });

  test("People shows the GC company's teammate invites: admins manage them, members only see status", async () => {
    const { t, fx } = await setup();
    const projectId = fx.gcA.project.projectId;
    const inv = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "pm-new@mail-test.com", sendEmail: false });
    // Another GC's teammate invite never shows up.
    await fx.gcB.admin.as.action(api.invites.create, { kind: "teammate", email: "sonoran-pm@mail-test.com", sendEmail: false });

    const asAdmin = await fx.gcA.admin.as.query(api.people.listForProject, { projectId });
    expect(asAdmin.canManageTeammateInvites).toBe(true);
    expect(asAdmin.teammateInvites).toEqual([expect.objectContaining({ _id: inv.inviteId, email: "pm-new@mail-test.com", status: "pending" })]);
    expect(asAdmin.invites.map((i) => i._id)).not.toContain(inv.inviteId);

    const asMember = await fx.gcA.member.as.query(api.people.listForProject, { projectId });
    expect(asMember.canManageTeammateInvites).toBe(false);
    expect(asMember.teammateInvites.map((i) => [i.email, i.status])).toEqual([["pm-new@mail-test.com", "pending"]]);
    // Members cannot manage them; Company settings permissions are unchanged.
    await expect(fx.gcA.member.as.mutation(api.invites.revoke, { inviteId: inv.inviteId })).rejects.toThrow(/only company admins/);
    await expect(fx.gcA.member.as.action(api.invites.resend, { inviteId: inv.inviteId, sendEmail: false })).rejects.toThrow(/only company admins/);
    expect((await fx.gcA.member.as.query(api.companies.myCompany, {})).teammateInvites).toEqual([]);

    const copied = await fx.gcA.admin.as.action(api.invites.resend, { inviteId: inv.inviteId, sendEmail: false });
    expect(copied.link).not.toBe(inv.link);
    await fx.gcA.admin.as.mutation(api.invites.revoke, { inviteId: inv.inviteId });
    const after = await fx.gcA.admin.as.query(api.people.listForProject, { projectId });
    expect(after.teammateInvites.map((i) => i.status)).toEqual(["revoked"]);
    expect((await inviteRow(t, inv.inviteId)).status).toBe("revoked");
  });

  test("a pending teammate invite stays listed after 200+ newer sub and owner invites", async () => {
    const { t, fx } = await setup();
    const projectId = fx.gcA.project.projectId;
    const inv = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "pm-old@mail-test.com", sendEmail: false });
    await t.run(async (ctx) => {
      for (let i = 0; i < 210; i++) {
        await ctx.db.insert("invites", {
          tokenHash: `bulk-${i}`,
          email: `bulk-${i}@mail-test.com`,
          kind: i % 2 === 0 ? "sub" : "owner",
          inviterCompanyId: fx.gcA.companyId,
          projectId,
          status: i % 3 === 0 ? "pending" : "expired",
          expiresAt: Date.now() + 86_400_000,
          emailStatus: "not_sent",
          tokenVersion: 1,
          createdByUserId: fx.gcA.admin.userId,
          createdAt: Date.now() + i + 1,
        });
      }
    });
    const admin = await fx.gcA.admin.as.query(api.people.listForProject, { projectId });
    expect(admin.teammateInvites.map((i) => [i._id, i.status])).toEqual([[inv.inviteId, "pending"]]);
    expect(admin.canManageTeammateInvites).toBe(true);
    const member = await fx.gcA.member.as.query(api.people.listForProject, { projectId });
    expect(member.teammateInvites.map((i) => i.email)).toEqual(["pm-old@mail-test.com"]);
    const settings = await fx.gcA.admin.as.query(api.companies.myCompany, {});
    expect(settings.teammateInvites.map((i) => i._id)).toEqual([inv.inviteId]);
  });

  test("removed project-member history never hides an active membership", async () => {
    const { t, fx } = await setup();
    const projectId = fx.gcA.project.projectId;
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_company_and_status", (q) => q.eq("projectId", projectId).eq("companyId", fx.sub.companyId))
        .collect();
      for (const r of rows) await ctx.db.patch(r._id, { status: "removed", removedAt: Date.now() });
      for (let i = 0; i < 7; i++) {
        await ctx.db.insert("projectMembers", {
          projectId,
          companyId: fx.sub.companyId,
          partyRole: "sub",
          contractorId: fx.gcA.project.contractorId,
          status: "removed",
          removedAt: Date.now(),
          createdAt: Date.now(),
        });
      }
      await ctx.db.insert("projectMembers", {
        projectId,
        companyId: fx.sub.companyId,
        partyRole: "sub",
        contractorId: fx.gcA.project.contractorId,
        status: "active",
        createdAt: Date.now(),
      });
    });
    expect((await fx.sub.admin.as.query(api.projects.getProject, { projectId }))._id).toBe(projectId);

    // A linked vendor already active on the project cannot be invited again.
    const vendorId = await t.run(async (ctx) =>
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
    await expect(
      fx.gcA.admin.as.action(api.invites.create, { kind: "sub", email: fx.sub.admin.email, projectId, vendorId, sendEmail: false }),
    ).rejects.toThrow(/already on this project/);

    await fx.gcA.admin.as.mutation(api.people.removeProjectMember, { projectId, companyId: fx.sub.companyId });
    await expect(fx.sub.admin.as.query(api.projects.getProject, { projectId })).rejects.toThrow(/Not found/);
    const active = await t.run(async (ctx) =>
      ctx.db
        .query("projectMembers")
        .withIndex("by_project_company_and_status", (q) => q.eq("projectId", projectId).eq("companyId", fx.sub.companyId).eq("status", "active"))
        .collect(),
    );
    expect(active).toEqual([]);
  });

  test("listMine and acceptMine work only for the caller's own email", async () => {
    const { t, fx } = await setup();
    const res = await fx.gcA.admin.as.action(api.invites.create, { kind: "teammate", email: "mine@mail-test.com", sendEmail: false });
    const me = await newHuman(t, "mine@mail-test.com");
    expect(await me.as.query(api.invites.listMine, {})).toEqual([expect.objectContaining({ _id: res.inviteId, inviterCompanyName: "Bayview Builders Inc." })]);
    await expect(fx.noCompany.as.mutation(api.invites.acceptMine, { inviteId: res.inviteId })).rejects.toThrow(/Not found/);
    await me.as.mutation(api.invites.acceptMine, { inviteId: res.inviteId });
    expect(await me.as.query(api.invites.listMine, {})).toEqual([]);
  });
});
