/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture, type TenancyFixture } from "./lib/tenancyFixtures";
import { DEMO_NO_EMAIL_MESSAGE, sendEmail, type MailerCtx } from "./lib/mailer";

const modules = import.meta.glob("./**/*.ts");

function newTest() {
  return convexTest(schema, modules);
}

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

type Planted = { contractorId: Id<"contractors">; bidId: Id<"bids"> };

/**
 * Non-demo rows that look like demo data by name, email or phone. The old seed deleted rows like
 * these by match; the seed must now reach only rows owned by the Demo company.
 */
async function plantLookalikes(t: ReturnType<typeof newTest>, f: TenancyFixture): Promise<Planted[]> {
  return await t.run(async (ctx) => {
    const tradePackageId = f.gcA.project.tradePackageId;
    const rows: Planted[] = [];
    for (const c of [
      { companyName: "Direct Inbound Electric Supply (Direct Inbound)", contactEmail: "bids-7q2x@mailtm.test", phone: "510-555-0142" },
      { companyName: "Capital City Lone Star Drywall", contactEmail: "estimating@capitalcity.test", phone: "555-0199" },
      { companyName: "Rosendin Electric, Inc.", contactEmail: "estimating@rosendin.com", phone: "408-555-0100" },
      { companyName: "Guest Inquiry Contractor", contactEmail: "guest@inbound.agentmail.to", phone: "555-0123" },
    ]) {
      const contractorId = await ctx.db.insert("contractors", {
        tradePackageId,
        ...c,
        licenseNumber: "0",
        licenseStatus: "Unverified",
        sourceUrl: "",
        rfqStatus: "bid_received",
      });
      const bidId = await ctx.db.insert("bids", {
        tradePackageId,
        contractorId,
        subcontractorName: c.companyName,
        baseBidAmount: 48_750,
        lineItems: [],
        identifiedExclusions: [],
        longLeadEquipmentWeeks: 4,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: 48_750,
        isAwarded: false,
        receivedAt: Date.now(),
      });
      rows.push({ contractorId, bidId });
    }
    return rows;
  });
}

/** Every row id of the tables a reset could touch, for the non-demo companies only. */
async function nonDemoSnapshot(t: ReturnType<typeof newTest>, f: TenancyFixture) {
  return await t.run(async (ctx) => {
    const projectIds = [f.gcA.project.projectId, f.gcB.project.projectId];
    const out: Record<string, string[]> = { projects: [], tradePackages: [], contractors: [], bids: [], agreements: [] };
    for (const projectId of projectIds) {
      const project = await ctx.db.get(projectId);
      if (project) out.projects.push(project._id);
      const packages = await ctx.db
        .query("tradePackages")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect();
      for (const pkg of packages) {
        out.tradePackages.push(pkg._id);
        for (const c of await ctx.db.query("contractors").withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id)).collect())
          out.contractors.push(`${c._id}:${c.companyName}:${c.contactEmail}`);
        for (const b of await ctx.db.query("bids").withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id)).collect())
          out.bids.push(`${b._id}:${b.baseBidAmount}`);
      }
      for (const a of await ctx.db.query("agreements").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect())
        out.agreements.push(a._id);
    }
    for (const list of Object.values(out)) list.sort();
    return out;
  });
}

describe("demo seed and reset touch only the Demo company", () => {
  test("a forced reseed keeps non-demo contractors and bids that share demo names, emails or phones", async () => {
    const t = newTest();
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    const f = await buildTenancyFixture(t);
    const planted = await plantLookalikes(t, f);
    const before = await nonDemoSnapshot(t, f);

    await t.mutation(internal.projects.seedInitialDataInternal, { force: true });
    await f.demo.gc.as.mutation(api.projects.seedInitialData, { force: true });

    expect(await nonDemoSnapshot(t, f)).toEqual(before);
    for (const row of planted) {
      const state = await t.run(async (ctx) => ({ c: await ctx.db.get(row.contractorId), b: await ctx.db.get(row.bidId) }));
      expect(state.c).not.toBeNull();
      expect(state.b?.baseBidAmount).toBe(48_750);
    }
  });

  test("the reset rebuilds the Demo company's project under the Demo GC company", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    await f.demo.gc.as.mutation(api.projects.seedInitialData, { force: true });
    const demoProjects = await t.run(async (ctx) =>
      ctx.db
        .query("projects")
        .withIndex("by_demo", (q) => q.eq("isDemoProject", true))
        .collect(),
    );
    expect(demoProjects.length).toBeGreaterThan(0);
    for (const p of demoProjects) expect(p.gcCompanyId).toBe(f.demo.companyIds.gc);
    for (const p of demoProjects) expect(p.title).not.toContain("â€”");
  });

  test("only Demo users can run the reset; others get Not found and anonymous callers are rejected", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    expect(await errorOf(f.gcA.admin.as.mutation(api.projects.seedInitialData, { force: true }))).toEqual(NOT_FOUND);
    expect(await errorOf(f.sub.admin.as.mutation(api.projects.seedInitialData, { force: true }))).toMatchObject({
      code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/),
    });
    await expect(t.mutation(api.projects.seedInitialData, { force: true })).rejects.toThrow(/Not authenticated/);
  });
});

describe("demo-only simulation and diagnostics", () => {
  test("a non-demo GC cannot run the simulation on its own package", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const args = { tradePackageId: f.gcA.project.tradePackageId, scenario: "rfi_inquiry" as const };
    expect(await errorOf(f.gcA.admin.as.mutation(api.simulation.triggerJudgeSimulation, args))).toEqual(NOT_FOUND);
    expect(
      await errorOf(
        f.gcA.admin.as.mutation(api.simulation.runFullProcurementCycle, {
          projectId: f.gcA.project.projectId,
          tradePackageId: f.gcA.project.tradePackageId,
        }),
      ),
    ).toEqual(NOT_FOUND);
  });

  test("the guided demo and model checks read Not found for a non-demo GC", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    expect(await errorOf(f.gcA.admin.as.query(api.judgeDemo.runs.getRun, {}))).toEqual(NOT_FOUND);
    expect(await errorOf(f.gcA.admin.as.query(api.evals.getLatestEvalRun, {}))).toEqual(NOT_FOUND);
    expect(await errorOf(f.gcA.admin.as.query(api.llmRouter.getProviderAvailability, {}))).toEqual(NOT_FOUND);
    await expect(f.demo.gc.as.query(api.llmRouter.getProviderAvailability, {})).resolves.toMatchObject({
      openai: expect.any(Boolean),
    });
  });
});

describe("the Demo company never sends external email", () => {
  beforeEach(() => {
    vi.stubEnv("AGENTMAIL_API_KEY", "test-agentmail-key");
    vi.stubEnv("EMAIL_DAILY_BUDGET", "60");
  });
  afterEach(() => vi.unstubAllEnvs());

  test("mail for a Demo company or Demo project is blocked before AgentMail and leaves no sent row", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const ctx: MailerCtx = { runMutation: ((ref: any, args: any) => t.mutation(ref, args)) as MailerCtx["runMutation"] };
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ message_id: "<m@ses>", thread_id: "th" }), { status: 200 });
    }) as typeof fetch;
    const base = { kind: "rfq" as const, from: "rfq" as const, to: "estimating@rosendin.com", subject: "RFQ", text: "x", html: "<p>x</p>" };

    const byCompany = await sendEmail(ctx, { ...base, idempotencyKey: "demo-1", companyId: f.demo.companyIds.gc }, { fetchImpl });
    const byProject = await sendEmail(ctx, { ...base, idempotencyKey: "demo-2", projectId: f.demo.project.projectId }, { fetchImpl });
    expect(byCompany).toEqual({ status: "failed", error: DEMO_NO_EMAIL_MESSAGE });
    expect(byProject).toEqual({ status: "failed", error: DEMO_NO_EMAIL_MESSAGE });
    expect(calls).toBe(0);
    const rows = await t.run((c) => c.db.query("emailOutbox").collect());
    expect(rows.filter((r) => r.status === "sent")).toEqual([]);

    const real = await sendEmail(ctx, { ...base, to: "kim@eastbay.test", idempotencyKey: "real-1", companyId: f.gcA.companyId }, { fetchImpl });
    expect(real.status).toBe("sent");
    expect(calls).toBe(1);
  });
});

describe("billing agent links", () => {
  test("revoked links whose contractor was removed are hidden; active ones keep the stored name", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const gone = await t.run(async (ctx) => {
      const contractorId = await ctx.db.insert("contractors", {
        tradePackageId: f.demo.project.tradePackageId,
        companyName: "Short-lived Electric",
        contactEmail: "x@example.invalid",
        licenseNumber: "0",
        licenseStatus: "Unverified",
        sourceUrl: "",
        rfqStatus: "bid_received",
      });
      const base = { contractorId, createdBy: f.demo.gc.userId, createdAt: Date.now(), gcCompanyId: f.demo.companyIds.gc };
      await ctx.db.insert("agentLinks", { ...base, agentEmail: "old@agentmail.to", status: "revoked", revokedAt: Date.now() });
      await ctx.db.insert("agentLinks", { ...base, agentEmail: "kept@agentmail.to", contractorName: "Short-lived Electric", status: "active" });
      await ctx.db.delete(contractorId);
      return contractorId;
    });
    const rows = await f.demo.gc.as.query(api.agentLinks.listAgentLinks, {});
    expect(rows.map((r) => r.agentEmail)).toEqual(["kept@agentmail.to"]);
    expect(rows[0]).toMatchObject({ contractorId: gone, contractorName: "Short-lived Electric" });
    expect(JSON.stringify(rows)).not.toContain("Unknown contractor");
    expect(await f.gcA.admin.as.query(api.agentLinks.listAgentLinks, {})).toEqual([]);
  });
});
