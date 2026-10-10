/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { requireRole } from "./lib/roles";
import { signInAs } from "./lib/testIdentity";
import { DEMO_ACCOUNTS } from "./demoAccounts";

const modules = import.meta.glob("./**/*.ts");

function newTest() {
  return convexTest(schema, modules);
}

async function seedDemo(t: ReturnType<typeof newTest>) {
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  return await t.run(async (ctx) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_demo", (q) => q.eq("isDemoProject", true))
      .first();
    const agreement = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project!._id))
      .first();
    const bid = await ctx.db.get(agreement!.bidId);
    const contractors = await ctx.db.query("contractors").collect();
    const byName = (name: string) => contractors.find((c) => c.companyName === name)!._id;
    return {
      projectId: project!._id,
      agreement: agreement!,
      bid: bid!,
      rosendinId: byName("Rosendin Electric, Inc."),
      tdiId: byName("TDIndustries, Inc."),
    };
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireRole", () => {
  test("rejects unauthenticated callers", async () => {
    const t = newTest();
    await expect(t.run((ctx) => requireRole(ctx, ["gc"]))).rejects.toThrow(/Not authenticated/);
  });

  test("rejects a signed-in user without a role profile", async () => {
    const t = newTest();
    const { as } = await signInAs(t, null);
    await expect(as.run((ctx) => requireRole(ctx, ["gc", "sub", "owner"]))).rejects.toThrow(/no TradePulse role/);
  });

  test("treats a token subject that is not a live users session as signed out", async () => {
    const t = newTest();
    const bogus = t.withIdentity({ subject: "x|y" });
    await expect(bogus.run((ctx) => requireRole(ctx, ["gc"]))).rejects.toThrow(/Not authenticated/);
    expect(await bogus.query(api.profiles.me, {})).toBeNull();
  });

  test("rejects the wrong role and names the required one", async () => {
    const t = newTest();
    const { as: sub } = await signInAs(t, "sub");
    const { as: owner } = await signInAs(t, "owner");
    await expect(sub.run((ctx) => requireRole(ctx, ["gc"]))).rejects.toThrow(/Forbidden: role gc required/);
    await expect(owner.run((ctx) => requireRole(ctx, ["gc", "sub"]))).rejects.toThrow(/Forbidden: role gc or sub required/);
  });

  test("returns the viewer for an allowed role", async () => {
    const t = newTest();
    const { as, userId } = await signInAs(t, "owner");
    const viewer = await as.run((ctx) => requireRole(ctx, ["gc", "owner"]));
    expect(viewer.userId).toBe(userId);
    expect(viewer.role).toBe("owner");
  });

  test("with a projectId, requires the caller's company to own the project", async () => {
    const t = newTest();
    const { as, userId } = await signInAs(t, "gc");
    const { as: otherGc } = await signInAs(t, "gc");
    const projectId = await t.run(async (ctx) => {
      const companyId = await ctx.db.insert("companies", { name: "GC Co", kind: "gc", isDemo: false, createdAt: 0 });
      for (const m of await ctx.db.query("companyMembers").withIndex("by_userId", (q) => q.eq("userId", userId)).collect()) {
        await ctx.db.patch(m._id, { status: "removed" });
      }
      await ctx.db.insert("companyMembers", { companyId, userId, role: "admin", status: "active", createdAt: 0 });
      return await ctx.db.insert("projects", {
        title: "P",
        location: "Austin, TX",
        projectType: "x",
        estBudget: 1,
        targetCompletionWeeks: 1,
        specDocumentText: "s",
        isDemoProject: false,
        gcCompanyId: companyId,
        createdAt: 0,
      });
    });
    await expect(as.run((ctx) => requireRole(ctx, ["gc"], projectId))).resolves.toMatchObject({ role: "gc" });
    await expect(otherGc.run((ctx) => requireRole(ctx, ["gc"], projectId))).rejects.toThrow(/Not found/);
    await t.run((ctx) => ctx.db.delete(projectId));
    await expect(as.run((ctx) => requireRole(ctx, ["gc"], projectId))).rejects.toThrow(/Not found/);
  });
});

describe("GC-only legacy mutations", () => {
  test("award, generate, execute, void, reset, full cycle and simulation reject non-GC callers", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const { as: sub } = await signInAs(t, "sub", { contractorId: demo.rosendinId });
    const { as: owner } = await signInAs(t, "owner");
    const callers = [
      { name: "unauthenticated", c: t, err: /Not authenticated/ },
      { name: "sub", c: sub, err: /Forbidden: role gc required|Not found/ },
      { name: "owner", c: owner, err: /Forbidden: role gc required|Not found/ },
    ];
    const pkg = demo.agreement.tradePackageId;
    for (const { c, err } of callers) {
      await expect(c.mutation(api.bids.awardContract, { bidId: demo.bid._id, tradePackageId: pkg })).rejects.toThrow(err);
      await expect(c.mutation(api.bids.unawardContract, { bidId: demo.bid._id, tradePackageId: pkg })).rejects.toThrow(err);
      await expect(c.mutation(api.agreements.generateAgreement, { bidId: demo.bid._id, tradePackageId: pkg })).rejects.toThrow(err);
      await expect(c.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id })).rejects.toThrow(err);
      await expect(
        c.mutation(api.agreements.voidExecutedAgreement, { agreementId: demo.agreement._id, reason: "Testing a void reason" }),
      ).rejects.toThrow(err);
      await expect(c.mutation(api.projects.seedInitialData, { force: true })).rejects.toThrow(err);
      await expect(c.mutation(api.simulation.runFullProcurementCycle, { projectId: demo.projectId })).rejects.toThrow(err);
      await expect(
        c.mutation(api.simulation.triggerJudgeSimulation, { tradePackageId: pkg, scenario: "rfi_inquiry" }),
      ).rejects.toThrow(err);
    }
    const after = await t.run(async (ctx) => ({
      agreement: await ctx.db.get(demo.agreement._id),
      project: await ctx.db.get(demo.projectId),
    }));
    expect(after.agreement?.status).toBe("generated");
    expect(after.agreement?.executedAt).toBeUndefined();
    expect(after.project).not.toBeNull();
  });

  test("the GC can execute the demo agreement and run the full cycle", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const { as: gc } = await signInAs(t, "gc");
    await gc.mutation(api.agreements.executeAgreement, { agreementId: demo.agreement._id });
    const executed = await t.run((ctx) => ctx.db.get(demo.agreement._id));
    expect(executed?.status).toBe("executed");
    expect(typeof executed?.executedAt).toBe("number");
    const hvacPkg = await t.run(async (ctx) =>
      (await ctx.db.query("tradePackages").collect()).find((p) => p.csiDivision.startsWith("23"))!,
    );
    const cycle: any = await gc.mutation(api.simulation.runFullProcurementCycle, {
      projectId: demo.projectId,
      tradePackageId: hvacPkg._id,
    });
    expect(cycle).toBeTruthy();
  });

  test("the GC reset reseeds and relinks demo sub profiles to the new contractor ids", async () => {
    vi.stubEnv("PAYPAL_SANDBOX_SUB1_EMAIL", "sub1-sandbox@paypal.test");
    const t = newTest();
    await t.run((ctx) => ctx.db.insert("users", { email: "sub1@demo.tradepulse" }));
    const before = await seedDemo(t);
    const { as: gc } = await signInAs(t, "gc");
    await gc.mutation(api.projects.seedInitialData, { force: true });
    const profile = await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", "sub1@demo.tradepulse"))
        .first();
      return await ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", user!._id))
        .unique();
    });
    const contractor = await t.run((ctx) => ctx.db.get(profile!.contractorId as Id<"contractors">));
    expect(profile?.role).toBe("sub");
    expect(profile?.contractorId).not.toBe(before.rosendinId);
    expect(contractor?.companyName).toBe("Rosendin Electric, Inc.");
    expect(profile?.paypalEmail).toBe("sub1-sandbox@paypal.test");
  });
});

describe("demo profile linking", () => {
  test("links every demo account with its role, contractor and env PayPal email, idempotently", async () => {
    vi.stubEnv("PAYPAL_SANDBOX_SUB1_EMAIL", "s1@paypal.test");
    vi.stubEnv("PAYPAL_SANDBOX_SUB2_EMAIL", "s2@paypal.test");
    vi.stubEnv("PAYPAL_SANDBOX_SUB3_EMAIL", "s3@paypal.test");
    vi.stubEnv("PAYPAL_SANDBOX_OWNER_EMAIL", "owner@paypal.test");
    const t = newTest();
    await seedDemo(t);
    await t.run(async (ctx) => {
      for (const a of DEMO_ACCOUNTS) await ctx.db.insert("users", { email: a.email });
    });
    const first = await t.mutation(internal.demoAccounts.linkDemoProfilesInternal, {});
    const second = await t.mutation(internal.demoAccounts.linkDemoProfilesInternal, {});
    expect(second).toEqual(first);
    expect(first.every((r) => r.linked)).toBe(true);
    expect(first.filter((r) => r.role === "sub").every((r) => r.contractorLinked && r.hasPaypalEmail)).toBe(true);
    const profiles = await t.run((ctx) => ctx.db.query("userProfiles").collect());
    expect(profiles).toHaveLength(DEMO_ACCOUNTS.length);
    expect(profiles.map((p) => p.role).sort()).toEqual(["gc", "owner", "sub", "sub", "sub"]);
    const owner = profiles.find((p) => p.role === "owner");
    expect(owner?.paypalEmail).toBe("owner@paypal.test");
    expect(owner?.contractorId).toBeUndefined();
  });

  test("a demo account whose user row does not exist yet is reported, not created", async () => {
    const t = newTest();
    const result = await t.mutation(internal.demoAccounts.linkDemoProfilesInternal, {});
    expect(result.every((r) => !r.linked)).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("userProfiles").collect())).toHaveLength(0);
  });
});

describe("portal queries", () => {
  test("a sub sees only its own contractor's agreements and cannot load another sub's", async () => {
    const t = newTest();
    const demo = await seedDemo(t);
    const { as: sub1 } = await signInAs(t, "sub", { contractorId: demo.rosendinId, paypalEmail: "s1@paypal.test" });
    const { as: sub2 } = await signInAs(t, "sub", { contractorId: demo.tdiId });

    const portal1 = await sub1.query(api.portal.mySubPortal, {});
    expect(portal1.contractorName).toBe("Rosendin Electric, Inc.");
    expect(portal1.paypalEmail).toBe("s1@paypal.test");
    expect(portal1.agreements.map((a) => a._id)).toEqual([demo.agreement._id]);

    const portal2 = await sub2.query(api.portal.mySubPortal, {});
    expect(portal2.agreements).toEqual([]);
    expect(await sub2.query(api.portal.getAgreementSummary, { agreementId: demo.agreement._id })).toBeNull();
    expect(await sub1.query(api.portal.getAgreementSummary, { agreementId: demo.agreement._id })).toMatchObject({
      agreementNumber: demo.agreement.agreementNumber,
    });
    expect(await sub1.query(api.portal.getAgreementSummary, { agreementId: "not-an-id" })).toBeNull();
  });

  test("portal queries enforce roles", async () => {
    const t = newTest();
    await seedDemo(t);
    const { as: sub } = await signInAs(t, "sub");
    const { as: owner } = await signInAs(t, "owner");
    await expect(t.query(api.portal.mySubPortal, {})).rejects.toThrow(/Not authenticated/);
    await expect(owner.query(api.portal.mySubPortal, {})).rejects.toThrow(/Forbidden/);
    await expect(sub.query(api.portal.ownerOverview, {})).rejects.toThrow(/Forbidden/);
    await expect(t.query(api.portal.getAgreementSummary, { agreementId: "x" })).rejects.toThrow(/Not authenticated/);
    const overview = await owner.query(api.portal.ownerOverview, {});
    expect(overview.length).toBeGreaterThan(0);
    // Owners get the project summary and change orders, never the subcontract agreements.
    expect(overview[0].agreements).toEqual([]);
  });

  test("profiles.me reflects sign-in state and role", async () => {
    const t = newTest();
    expect(await t.query(api.profiles.me, {})).toBeNull();
    const { as: noRole } = await signInAs(t, null, { email: "x@test.tradepulse" });
    expect(await noRole.query(api.profiles.me, {})).toMatchObject({ role: null, email: "x@test.tradepulse" });
    const { as: gc } = await signInAs(t, "gc");
    expect(await gc.query(api.profiles.me, {})).toMatchObject({ role: "gc", displayName: "Test gc" });
  });
});
