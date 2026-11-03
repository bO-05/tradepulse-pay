/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { signInAs } from "./lib/testIdentity";

/**
 * Regressions for the second external audit (Nov 2, 2026): shared demo fixtures are read-only,
 * guided runs carry a consent dialog plus a per-account limit, demo identities are masked, and
 * historical notifications never read as mangled references.
 */

const modules = import.meta.glob("/convex/**/*.ts");
const RECOVERY_SITE = "https://cheery-axolotl-689.convex.site";

beforeAll(() => {
  process.env.CONVEX_SITE_URL = RECOVERY_SITE;
});
afterAll(() => {
  delete process.env.CONVEX_SITE_URL;
});

async function errorData(p: Promise<unknown>): Promise<{ code?: string; kind?: string; message?: string }> {
  try {
    await p;
  } catch (err) {
    const data = (err as { data?: unknown }).data;
    if (data !== undefined && data !== null && typeof data === "object") return data as { code?: string; kind?: string; message?: string };
    return { message: (err as Error).message };
  }
  throw new Error("expected the call to fail");
}

async function seeded() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  return t;
}

function demoGcCompany(t: Awaited<ReturnType<typeof seeded>>) {
  return t.run(async (ctx) => {
    const companies = await ctx.db
      .query("companies")
      .withIndex("by_isDemo", (q) => q.eq("isDemo", true))
      .collect();
    const gc = companies.find((c) => c.kind === "gc");
    if (gc === undefined) throw new Error("the demo GC company is missing");
    return gc;
  });
}

describe("shared demo fixtures are read-only", () => {
  test("protectSharedFixtures freezes seeded companies and projects but not a fresh sandbox project", async () => {
    const t = await seeded();
    const gc = await signInAs(t, "gc", { email: "gc@demo.tradepulse" });
    const ids = await t.run(async (ctx) => {
      const companies = await ctx.db
        .query("companies")
        .withIndex("by_isDemo", (q) => q.eq("isDemo", true))
        .collect();
      const demoGc = companies.find((c) => c.kind === "gc")!;
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", demoGc._id))
        .collect();
      const { _id, _creationTime, ...copy } = projects[0];
      const sandboxId = await ctx.db.insert("projects", { ...copy, title: "Fresh guided sandbox", demoSandbox: true });
      return { companyIds: companies.map((c) => c._id), projectIds: projects.map((p) => p._id), sandboxId };
    });

    const out = await t.mutation(internal.judgeDemo.reference.protectSharedFixtures, {});
    expect(out.companies).toBe(ids.companyIds.length);
    expect(out.projects).toBe(ids.projectIds.length);

    const after = await t.run(async (ctx) => ({
      companies: await ctx.db.query("companies").collect(),
      projects: await ctx.db.query("projects").collect(),
    }));
    for (const company of after.companies.filter((c) => ids.companyIds.includes(c._id))) {
      expect(company.demoReadOnly, company.name).toBe(true);
    }
    for (const project of after.projects) {
      if (project._id === ids.sandboxId) expect(project.readOnlyDemoFixture, project.title).toBeUndefined();
      else expect(project.readOnlyDemoFixture, project.title).toBe(true);
    }
    // A second run is idempotent: the counts stay the same and nothing is duplicated.
    expect(await t.mutation(internal.judgeDemo.reference.protectSharedFixtures, {})).toEqual(out);
    expect(gc.userId).toBeTruthy();
  });

  test("a demo GC can read its company but cannot change shared identity, defaults or invites", async () => {
    const t = await seeded();
    const gc = await signInAs(t, "gc", { email: "gc@demo.tradepulse" });
    const company = await demoGcCompany(t);
    await t.run((ctx) => ctx.db.patch(company._id, { demoReadOnly: true }));

    expect(await errorData(gc.as.mutation(api.companies.updateProfile, { name: "Hijacked Demo GC" }))).toMatchObject({
      code: "DEMO_READ_ONLY",
    });
    expect(await errorData(gc.as.mutation(api.companies.updateDefaults, { defaultRetainageBps: 500 }))).toMatchObject({
      code: "DEMO_READ_ONLY",
    });

    // Read paths keep working: only writes to the shared fixture are refused.
    const mine = await gc.as.query(api.companies.myCompany, {});
    expect(mine?.company.name).toBe(company.name);
    expect(await t.run((ctx) => ctx.db.get(company._id))).toMatchObject({ name: company.name, demoReadOnly: true });

    const invited = await signInAs(t, null, { email: "new-teammate@test.tradepulse" });
    const inviteId = await t.run((ctx) =>
      ctx.db.insert("invites", {
        tokenHash: "0".repeat(64),
        email: "new-teammate@test.tradepulse",
        kind: "teammate",
        inviterCompanyId: company._id,
        status: "pending",
        expiresAt: Date.now() + 60_000,
        createdByUserId: gc.userId,
        emailStatus: "not_sent",
        createdAt: Date.now(),
      }),
    );
    expect(await errorData(invited.as.mutation(api.invites.acceptMine, { inviteId }))).toMatchObject({ code: "DEMO_READ_ONLY" });
  });

  test("the guided run is limited to three per account per hour", async () => {
    const t = convexTest(schema, modules);
    rateLimiterTest.register(t);
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    const contractorId = await t.run(async (ctx) => (await ctx.db.query("contractors").collect())[0]._id);
    const gc = await signInAs(t, "gc", { email: "gc@demo.tradepulse" });
    await signInAs(t, "sub", { email: "sub1@demo.tradepulse", contractorId });
    const company = await demoGcCompany(t);
    await t.run((ctx) => ctx.db.patch(company._id, { demoReadOnly: true }));

    for (let i = 0; i < 3; i++) await gc.as.mutation(api.judgeDemo.runs.startRun, {});
    expect(await errorData(gc.as.mutation(api.judgeDemo.runs.startRun, {}))).toMatchObject({ kind: "RateLimited" });
  }, 60_000);
});

describe("demo presentation hides shared inboxes", () => {
  test("billing agent emails are masked while @demo.tradepulse stays readable", async () => {
    const t = await seeded();
    const gc = await signInAs(t, "gc", { email: "gc@demo.tradepulse" });
    const company = await demoGcCompany(t);
    const contractorId = await t.run(async (ctx) => (await ctx.db.query("contractors").collect())[0]._id);
    const linkIds = await t.run(async (ctx) => {
      const base = {
        contractorId,
        gcCompanyId: company._id,
        status: "active" as const,
        createdBy: gc.userId,
        createdAt: Date.now(),
      };
      const shared = await ctx.db.insert("agentLinks", { ...base, agentEmail: "boldlevel182@agentmail.to" });
      const demo = await ctx.db.insert("agentLinks", { ...base, agentEmail: "agent@demo.tradepulse" });
      await ctx.db.patch(company._id, { demoReadOnly: true });
      return { shared, demo };
    });

    const links = await gc.as.query(api.agentLinks.listAgentLinks, {});
    const byId = new Map(links.map((l) => [l._id as Id<"agentLinks">, l]));
    expect(byId.get(linkIds.shared)?.agentEmail).toBe("[demo inbox]@agentmail.to");
    expect(byId.get(linkIds.demo)?.agentEmail).toBe("agent@demo.tradepulse");
  });
});

describe("historical notifications", () => {
  test("an orphaned reference suffix is tidied and gross/net stay labeled", async () => {
    const t = await seeded();
    const gc = await signInAs(t, "gc", { email: "gc@demo.tradepulse" });
    const company = await demoGcCompany(t);
    await t.run((ctx) =>
      ctx.db.insert("notifications", {
        userId: gc.userId,
        companyId: company._id,
        kind: "invite_accepted",
        title: "MISTRAL1 filed A401-DEMO-PAY [hidden]-02",
        body: "MISTRAL1 requests $30,000.00 gross, $27,000.00 net of retainage.",
        link: "#/",
        createdAt: Date.now(),
      }),
    );
    const summary = await gc.as.query(api.notifications.summary, {});
    const row = summary.latest[0];
    expect(row.title).toBe("MISTRAL1 filed A401-DEMO-PAY (reference omitted)");
    expect(row.body).toContain("$30,000.00 gross");
    expect(row.body).toContain("$27,000.00 net");
  });
});
