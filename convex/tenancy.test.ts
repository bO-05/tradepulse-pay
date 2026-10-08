/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { DEMO_COMPANIES } from "./lib/demoTenancy";
import { getViewer, requireRole } from "./lib/roles";
import {
  accessibleProjectIds,
  requireCompanyMember,
  requireDocInProject,
  requireProjectAccess,
  requireUser,
  requireVerifiedUser,
} from "./lib/tenancy";
import { buildTenancyFixture } from "./lib/tenancyFixtures";
import { withSession } from "./lib/testIdentity";

const modules = import.meta.glob("./**/*.ts");

function newTest() {
  return convexTest(schema, modules);
}

/** The ConvexError payload a call rejects with, so tests can compare whole errors. */
async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConvexError) return e.data;
    return { message: (e as Error).message };
  }
  throw new Error("expected the call to fail");
}

const NOT_FOUND = { code: "NOT_FOUND", message: "Not found." };

describe("identity helpers", () => {
  test("requireUser rejects anonymous callers and returns the signed-in user", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    expect(await errorOf(t.run((ctx) => requireUser(ctx)))).toMatchObject({ code: "UNAUTHENTICATED" });
    const user = await f.gcA.admin.as.run((ctx) => requireUser(ctx));
    expect(user._id).toBe(f.gcA.admin.userId);
  });

  test("a token whose session row was deleted is signed out everywhere, and other sessions keep working", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const other = await withSession(t, f.gcA.admin.userId, "dana@bayview.test");
    await t.run(async (ctx) => {
      const sessions = await ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", f.gcA.admin.userId))
        .collect();
      await ctx.db.delete(sessions[0]._id);
    });
    const stale = f.gcA.admin.as;
    expect(await errorOf(stale.run((ctx) => requireUser(ctx)))).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await errorOf(stale.run((ctx) => requireProjectAccess(ctx, f.gcA.project.projectId)))).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(await stale.run((ctx) => getViewer(ctx))).toBeNull();
    expect(await stale.query(api.profiles.me, {})).toBeNull();
    await expect(other.run((ctx) => requireUser(ctx))).resolves.toMatchObject({ _id: f.gcA.admin.userId });
  });

  test("requireVerifiedUser requires a verified email for humans but not for agents", async () => {
    const t = newTest();
    const { unverified, agent } = await t.run(async (ctx) => ({
      unverified: await ctx.db.insert("users", { email: "new@x.test" }),
      agent: await ctx.db.insert("users", { email: "bot@agentmail.to", actorType: "agent" }),
    }));
    const asUnverified = await withSession(t, unverified);
    expect(await errorOf(asUnverified.run((ctx) => requireVerifiedUser(ctx)))).toMatchObject({ code: "EMAIL_UNVERIFIED" });
    const asAgent = await withSession(t, agent);
    await expect(asAgent.run((ctx) => requireVerifiedUser(ctx))).resolves.toMatchObject({ _id: agent });
  });

  test("requireCompanyMember derives the company from the session and checks admin", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const member = await f.gcA.admin.as.run((ctx) => requireCompanyMember(ctx, { admin: true }));
    expect(member.company._id).toBe(f.gcA.companyId);
    expect(await errorOf(f.gcA.member.as.run((ctx) => requireCompanyMember(ctx, { admin: true })))).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await errorOf(f.noCompany.as.run((ctx) => requireCompanyMember(ctx)))).toMatchObject({ code: "NO_COMPANY" });

    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("companyMembers")
        .withIndex("by_userId", (q) => q.eq("userId", f.gcA.member.userId))
        .unique();
      await ctx.db.patch(m!._id, { status: "removed" });
    });
    expect(await errorOf(f.gcA.member.as.run((ctx) => requireCompanyMember(ctx)))).toMatchObject({ code: "NO_COMPANY" });
  });

  test("many removed memberships never hide the current active one or allow a second company", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const userId = f.gcA.member.userId;
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("companyMembers")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();
      for (const r of rows) await ctx.db.patch(r._id, { status: "removed" });
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("companyMembers", {
          companyId: i % 2 === 0 ? f.gcB.companyId : f.gcA.companyId,
          userId,
          role: "member",
          status: "removed",
          createdAt: i,
        });
      }
      await ctx.db.insert("companyMembers", {
        companyId: f.gcA.companyId,
        userId,
        role: "member",
        status: "active",
        createdAt: 100,
      });
    });

    const member = await f.gcA.member.as.run((ctx) => requireCompanyMember(ctx));
    expect(member.company._id).toBe(f.gcA.companyId);
    expect((await f.gcA.member.as.run((ctx) => requireProjectAccess(ctx, f.gcA.project.projectId))).partyRole).toBe("gc");
    expect(
      await errorOf(
        f.gcA.member.as.mutation(api.onboarding.createCompany, {
          name: "Second Co",
          address: { line1: "1 Main St", city: "Oakland", state: "CA", zip: "94607" },
          phone: "5105550100",
        }),
      ),
    ).toMatchObject({ code: "ALREADY_ONBOARDED" });
    const active = await t.run((ctx) =>
      ctx.db
        .query("companyMembers")
        .withIndex("by_userId_and_status", (q) => q.eq("userId", userId).eq("status", "active"))
        .collect(),
    );
    expect(active).toHaveLength(1);
  });
});

describe("requireProjectAccess", () => {
  test("each company reaches only its own or member projects, with its party role", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const a = f.gcA.project.projectId;

    expect((await f.gcA.admin.as.run((ctx) => requireProjectAccess(ctx, a))).partyRole).toBe("gc");
    expect((await f.gcA.member.as.run((ctx) => requireProjectAccess(ctx, a))).partyRole).toBe("gc");
    const sub = await f.sub.admin.as.run((ctx) => requireProjectAccess(ctx, a));
    expect(sub.partyRole).toBe("sub");
    expect(sub.contractorIds).toEqual([f.gcA.project.contractorId]);
    expect((await f.owner.admin.as.run((ctx) => requireProjectAccess(ctx, a))).partyRole).toBe("owner");

    for (const outsider of [f.gcB.admin, f.demo.gc, f.noCompany]) {
      expect(await errorOf(outsider.as.run((ctx) => requireProjectAccess(ctx, a)))).toEqual(NOT_FOUND);
    }
    for (const user of [f.gcA.admin, f.sub.admin, f.owner.admin]) {
      expect(await errorOf(user.as.run((ctx) => requireProjectAccess(ctx, f.gcB.project.projectId)))).toEqual(NOT_FOUND);
      expect(await errorOf(user.as.run((ctx) => requireProjectAccess(ctx, f.demo.project.projectId)))).toEqual(NOT_FOUND);
    }
    expect(await errorOf(t.run((ctx) => requireProjectAccess(ctx, a)))).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  test("another company's project and a missing project fail with the identical error", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const deleted = await t.run(async (ctx) => {
      const id = await ctx.db.insert("projects", {
        title: "gone",
        location: "x",
        projectType: "x",
        estBudget: 1,
        targetCompletionWeeks: 1,
        specDocumentText: "x",
        isDemoProject: false,
        gcCompanyId: f.gcB.companyId,
        createdAt: 0,
      });
      await ctx.db.delete(id);
      return id;
    });
    const forbidden = await errorOf(f.gcA.admin.as.run((ctx) => requireProjectAccess(ctx, f.gcB.project.projectId)));
    const missing = await errorOf(f.gcA.admin.as.run((ctx) => requireProjectAccess(ctx, deleted)));
    const malformed = await errorOf(f.gcA.admin.as.run((ctx) => requireProjectAccess(ctx, "not-an-id")));
    expect(forbidden).toEqual(NOT_FOUND);
    expect(missing).toEqual(forbidden);
    expect(malformed).toEqual(forbidden);
  });

  test("role checks use the party role inside an accessible project", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const a = f.gcA.project.projectId;
    expect(await errorOf(f.sub.admin.as.run((ctx) => requireProjectAccess(ctx, a, { roles: ["gc"] })))).toEqual({
      code: "FORBIDDEN",
      message: "Forbidden: role gc required.",
    });
    expect(await errorOf(f.gcB.admin.as.run((ctx) => requireProjectAccess(ctx, a, { roles: ["gc"] })))).toEqual(NOT_FOUND);
  });

  test("a removed project membership loses access on the next request", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const a = f.gcA.project.projectId;
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_company", (q) => q.eq("projectId", a).eq("companyId", f.sub.companyId))
        .collect();
      for (const r of rows) await ctx.db.patch(r._id, { status: "removed" });
    });
    expect(await errorOf(f.sub.admin.as.run((ctx) => requireProjectAccess(ctx, a)))).toEqual(NOT_FOUND);
  });

  test("writes need a verified email and a non-archived project", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const a = f.gcA.project.projectId;
    await expect(f.gcA.admin.as.run((ctx) => requireProjectAccess(ctx, a, { write: true }))).resolves.toBeTruthy();
    await t.run((ctx) => ctx.db.patch(f.gcA.member.userId, { emailVerificationTime: undefined }));
    expect(await errorOf(f.gcA.member.as.run((ctx) => requireProjectAccess(ctx, a, { write: true })))).toMatchObject({
      code: "EMAIL_UNVERIFIED",
    });
    await t.run((ctx) => ctx.db.patch(a, { archived: true }));
    await expect(f.gcA.admin.as.run((ctx) => requireProjectAccess(ctx, a))).resolves.toBeTruthy();
    expect(await errorOf(f.gcA.admin.as.run((ctx) => requireProjectAccess(ctx, a, { write: true })))).toMatchObject({
      code: "ARCHIVED",
    });
  });

  test("a linked AgentID billing agent reaches only projects with its contractor's agreements", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const agent = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "bot@agentmail.to", actorType: "agent", agentSub: "a1" });
      await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: "a1" });
      await ctx.db.insert("userProfiles", {
        userId,
        role: "sub",
        displayName: "bot",
        actorType: "agent",
        contractorId: f.gcA.project.contractorId,
        createdAt: 0,
      });
      await ctx.db.insert("agentLinks", {
        agentEmail: "bot@agentmail.to",
        contractorId: f.gcA.project.contractorId,
        gcCompanyId: f.gcA.companyId,
        subCompanyId: f.sub.companyId,
        status: "active",
        createdBy: f.gcA.admin.userId,
        createdAt: 0,
      });
      return userId;
    });
    const asAgent = await withSession(t, agent);
    const access = await asAgent.run((ctx) => requireProjectAccess(ctx, f.gcA.project.projectId));
    expect(access.partyRole).toBe("sub");
    expect(access.company).toBeNull();
    expect(await errorOf(asAgent.run((ctx) => requireProjectAccess(ctx, f.gcB.project.projectId)))).toEqual(NOT_FOUND);
    expect(await asAgent.run((ctx) => accessibleProjectIds(ctx))).toEqual([f.gcA.project.projectId]);
  });
});

describe("requireDocInProject", () => {
  test("accepts a document of the project and rejects one from another project as not found", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const a = f.gcA.project;
    const b = f.gcB.project;
    const ok = await f.gcA.admin.as.run((ctx) => requireDocInProject(ctx, "agreements", a.agreementId, a.projectId));
    expect(ok.doc._id).toBe(a.agreementId);
    const bid = await f.gcA.admin.as.run((ctx) => requireDocInProject(ctx, "bids", a.bidId, a.projectId));
    expect(bid.doc._id).toBe(a.bidId);

    // gcA cannot launder gcB's agreement through its own project id, nor reach it directly.
    expect(
      await errorOf(f.gcA.admin.as.run((ctx) => requireDocInProject(ctx, "agreements", b.agreementId, a.projectId))),
    ).toEqual(NOT_FOUND);
    expect(
      await errorOf(f.gcA.admin.as.run((ctx) => requireDocInProject(ctx, "agreements", b.agreementId, b.projectId))),
    ).toEqual(NOT_FOUND);
    expect(
      await errorOf(f.gcA.admin.as.run((ctx) => requireDocInProject(ctx, "contractors", b.contractorId, a.projectId))),
    ).toEqual(NOT_FOUND);
  });
});

describe("accessibleProjectIds", () => {
  test("lists only accessible projects and hides archived ones by default", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const a = f.gcA.project.projectId;
    expect(await f.gcA.admin.as.run((ctx) => accessibleProjectIds(ctx))).toEqual([a]);
    expect(await f.sub.admin.as.run((ctx) => accessibleProjectIds(ctx))).toEqual([a]);
    expect(await f.owner.admin.as.run((ctx) => accessibleProjectIds(ctx))).toEqual([a]);
    expect(await f.gcB.admin.as.run((ctx) => accessibleProjectIds(ctx))).toEqual([f.gcB.project.projectId]);
    expect(await f.demo.gc.as.run((ctx) => accessibleProjectIds(ctx))).toEqual([f.demo.project.projectId]);
    expect(await f.noCompany.as.run((ctx) => accessibleProjectIds(ctx))).toEqual([]);
    expect(await t.run((ctx) => accessibleProjectIds(ctx))).toEqual([]);

    await t.run((ctx) => ctx.db.patch(a, { archived: true }));
    expect(await f.gcA.admin.as.run((ctx) => accessibleProjectIds(ctx))).toEqual([]);
    expect(await f.gcA.admin.as.run((ctx) => accessibleProjectIds(ctx, { includeArchived: true }))).toEqual([a]);
  });
});

describe("projects:listProjects", () => {
  test("hides archived projects unless asked for them", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    await t.run((ctx) => ctx.db.patch(f.demo.project.projectId, { archived: true }));
    const visible = await f.demo.gc.as.query(api.projects.listProjects, {});
    expect(visible.map((p) => p._id)).not.toContain(f.demo.project.projectId);
    const all = await f.demo.gc.as.query(api.projects.listProjects, { includeArchived: true });
    expect(all.map((p) => p._id)).toContain(f.demo.project.projectId);
  });
});

describe("requireRole with a projectId", () => {
  test("is company-scoped and matches roles against the party role", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const a = f.gcA.project.projectId;
    await expect(f.gcA.admin.as.run((ctx) => requireRole(ctx, ["gc"], a))).resolves.toMatchObject({ role: "gc" });
    expect(await errorOf(f.gcB.admin.as.run((ctx) => requireRole(ctx, ["gc"], a)))).toEqual(NOT_FOUND);
    expect(await errorOf(f.sub.admin.as.run((ctx) => requireRole(ctx, ["gc"], a)))).toMatchObject({ code: "FORBIDDEN" });
    await expect(f.owner.admin.as.run((ctx) => requireRole(ctx, ["gc", "owner"], a))).resolves.toMatchObject({
      role: "owner",
    });
  });
});

describe("tenancy migration", () => {
  type Legacy = { projects: Record<string, Id<"projects">>; otherCompanyProject: Id<"projects"> };

  async function seedLegacy(t: ReturnType<typeof newTest>): Promise<Legacy> {
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    return await t.run(async (ctx) => {
      const demo = await ctx.db
        .query("projects")
        .withIndex("by_demo", (q) => q.eq("isDemoProject", true))
        .first();
      // Pre-migration rows carry no company; the seed has already attached the demo project.
      await ctx.db.patch(demo!._id, { gcCompanyId: undefined });
      for (const m of await ctx.db.query("projectMembers").collect()) await ctx.db.delete(m._id);
      for (const m of await ctx.db.query("companyMembers").collect()) await ctx.db.delete(m._id);
      for (const c of await ctx.db.query("companies").collect()) await ctx.db.delete(c._id);
      for (const c of await ctx.db.query("contractors").collect()) await ctx.db.patch(c._id, { linkedCompanyId: undefined });

      const contractors = await ctx.db.query("contractors").collect();
      const rosendin = contractors.find((c) => c.companyName === "Rosendin Electric, Inc.")!;
      const tdi = contractors.find((c) => c.companyName === "TDIndustries, Inc.")!;
      const accounts: [string, "gc" | "sub" | "owner", Id<"contractors"> | undefined][] = [
        ["gc@demo.tradepulse", "gc", undefined],
        ["sub1@demo.tradepulse", "sub", rosendin._id],
        ["sub2@demo.tradepulse", "sub", tdi._id],
        ["owner@demo.tradepulse", "owner", undefined],
        ["maria@bayview-builders.example.com", "gc", undefined],
      ];
      for (const [email, role, contractorId] of accounts) {
        const userId = await ctx.db.insert("users", { email });
        await ctx.db.insert("userProfiles", { userId, role, displayName: email, contractorId, actorType: "human", createdAt: 0 });
      }
      const base = {
        location: "Austin, TX",
        projectType: "x",
        estBudget: 1,
        targetCompletionWeeks: 1,
        specDocumentText: "x",
        isDemoProject: false,
        createdAt: 0,
      };
      const projects: Record<string, Id<"projects">> = { demo: demo!._id };
      projects.review1 = await ctx.db.insert("projects", { ...base, title: "Demo · Pay-app review scenario" });
      projects.review2 = await ctx.db.insert("projects", { ...base, title: "Demo · Pay-app review scenario" });
      projects.utr3 = await ctx.db.insert("projects", { ...base, title: "Procurement scenario · ut-r3-835f53f1" });
      projects.uter1 = await ctx.db.insert("projects", { ...base, title: "UTER1 edited payment" });
      projects.judge = await ctx.db.insert("projects", { ...base, title: "Demo · TradePulse Pay judge demo 20261008-04" });
      const realGc = await ctx.db.insert("companies", { name: "Real GC", kind: "gc", isDemo: false, createdAt: 0 });
      const otherCompanyProject = await ctx.db.insert("projects", {
        ...base,
        title: "UTER1 lookalike owned by a real company",
        gcCompanyId: realGc,
      });
      return { projects, otherCompanyProject };
    });
  }

  async function snapshot(t: ReturnType<typeof newTest>) {
    return await t.run(async (ctx) => {
      const out: Record<string, { count: number; maxCreation: number }> = {};
      for (const table of ["companies", "companyMembers", "projectMembers", "projects", "users", "userProfiles", "contractors", "agreements", "agentLinks"] as const) {
        const rows = await ctx.db.query(table).collect();
        out[table] = { count: rows.length, maxCreation: Math.max(0, ...rows.map((r) => r._creationTime)) };
      }
      return out;
    });
  }

  test("attaches existing data to the Demo company, archives junk, deletes nothing, and is idempotent", async () => {
    const t = newTest();
    const legacy = await seedLegacy(t);
    const before = await snapshot(t);

    const first = await t.mutation(internal.tenancyMigration.migrate, {});
    expect(first.counts.companiesCreated).toBe(DEMO_COMPANIES.length);
    expect(first.counts.projectsAttached).toBe(Object.keys(legacy.projects).length);
    expect(first.archivedTitles.sort()).toEqual(
      ["Demo · Pay-app review scenario", "Procurement scenario · ut-r3-835f53f1", "UTER1 edited payment"].sort(),
    );

    const after = await snapshot(t);
    for (const table of Object.keys(before)) expect(after[table].count).toBeGreaterThanOrEqual(before[table].count);
    expect(after.projects.count).toBe(before.projects.count);

    const state = await t.run(async (ctx) => {
      const companies = await ctx.db.query("companies").collect();
      const demoGc = companies.find((c) => c.demoKey === "gc")!;
      const projects = await ctx.db.query("projects").collect();
      const users = await ctx.db.query("users").collect();
      const members = await ctx.db.query("companyMembers").collect();
      const projectMembers = await ctx.db.query("projectMembers").collect();
      return { companies, demoGc, projects, users, members, projectMembers };
    });
    expect(state.demoGc).toMatchObject({ name: "Demo GC (TradePulse Pay demo)", kind: "gc", isDemo: true });
    expect(state.companies.filter((c) => c.isDemo).map((c) => c.name).sort()).toEqual(DEMO_COMPANIES.map((c) => c.name).sort());
    for (const id of Object.values(legacy.projects)) {
      expect(state.projects.find((p) => p._id === id)!.gcCompanyId).toBe(state.demoGc._id);
    }
    const byId = (id: Id<"projects">) => state.projects.find((p) => p._id === id)!;
    expect(byId(legacy.projects.review1).archived).toBeUndefined();
    expect(byId(legacy.projects.review2).archived).toBe(true);
    expect(byId(legacy.projects.utr3).archived).toBe(true);
    expect(byId(legacy.projects.judge).archived).toBeUndefined();
    expect(byId(legacy.projects.demo).archived).toBeUndefined();
    const other = byId(legacy.otherCompanyProject);
    expect(other.archived).toBeUndefined();
    expect(other.gcCompanyId).not.toBe(state.demoGc._id);

    for (const u of state.users.filter((u) => u.email?.endsWith("@demo.tradepulse"))) {
      expect(u.emailVerificationTime).toBeDefined();
      const m = state.members.find((m) => m.userId === u._id);
      expect(m?.status).toBe("active");
    }
    const maria = state.users.find((u) => u.email === "maria@bayview-builders.example.com")!;
    expect(maria.emailVerificationTime).toBeUndefined();
    expect(state.members.some((m) => m.userId === maria._id)).toBe(false);

    const rosendinCo = state.companies.find((c) => c.demoKey === "sub:rosendin")!;
    const ownerCo = state.companies.find((c) => c.demoKey === "owner")!;
    const demoProjectMembers = state.projectMembers.filter((m) => m.projectId === legacy.projects.demo);
    expect(demoProjectMembers.map((m) => m.companyId)).toEqual(expect.arrayContaining([rosendinCo._id, ownerCo._id]));

    // The demo accounts now resolve through tenancy.
    const sub1 = state.users.find((u) => u.email === "sub1@demo.tradepulse")!;
    const asSub1 = await withSession(t, sub1._id);
    expect((await asSub1.run((ctx) => requireProjectAccess(ctx, legacy.projects.demo))).partyRole).toBe("sub");
    expect(await errorOf(asSub1.run((ctx) => requireProjectAccess(ctx, legacy.otherCompanyProject)))).toEqual(NOT_FOUND);

    const second = await t.mutation(internal.tenancyMigration.migrate, {});
    expect(Object.values(second.counts).every((n) => n === 0)).toBe(true);
    expect(second.archivedTitles).toEqual([]);
    expect(await snapshot(t)).toEqual(after);
  });

  test("another company's example.com contractor does not trigger a demo reseed", async () => {
    const t = newTest();
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    const f = await buildTenancyFixture(t);
    await t.run((ctx) => ctx.db.patch(f.gcA.project.contractorId, { contactEmail: "kim@eastbay-electric.example.com" }));
    const again = await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    expect(again.status).toBe("already_seeded");
    await expect(t.run((ctx) => ctx.db.get(f.gcA.project.contractorId))).resolves.not.toBeNull();
  });

  test("a demo reseed repoints other demo agreements at the recreated demo contractor", async () => {
    const t = newTest();
    await seedLegacy(t);
    await t.mutation(internal.tenancyMigration.migrate, {});
    const scenario = await t.mutation(internal.payApps.reviewScenario.seedReviewScenario, { suffix: "RP1" });
    await t.mutation(internal.projects.seedInitialDataInternal, { force: true });

    const state = await t.run(async (ctx) => {
      const agreement = (await ctx.db.get(scenario.agreementId))!;
      const contractor = await ctx.db.get(agreement.contractorId);
      const bid = (await ctx.db.get(agreement.bidId))!;
      const sub1 = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", "sub1@demo.tradepulse"))
        .first();
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", sub1!._id))
        .unique();
      return { agreement, contractor, bid, profile, sub1Id: sub1!._id };
    });
    expect(state.contractor).not.toBeNull();
    expect(state.agreement.contractorId).toBe(state.profile!.contractorId);
    expect(state.bid.contractorId).toBe(state.agreement.contractorId);
    const asSub1 = await withSession(t, state.sub1Id);
    const access = await asSub1.run((ctx) => requireProjectAccess(ctx, state.agreement.projectId));
    expect(access.contractorIds).toContain(state.agreement.contractorId);

    const rerun = await t.mutation(internal.tenancyMigration.migrate, {});
    // The new scenario is a duplicate review scenario, so the migration archives it; nothing else changes.
    expect(rerun.archivedTitles).toEqual(["Demo · Pay-app review scenario"]);
    expect(Object.entries(rerun.counts).filter(([, n]) => n !== 0)).toEqual([["projectsArchived", 1]]);
  });
});
