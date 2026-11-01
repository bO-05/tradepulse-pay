/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { DEMO_BILLING_AGENT_EMAIL, DEMO_CONTRACT_SUM, DEMO_EXCLUSION, DEMO_LINE_ITEMS } from "./scenario";
import { buildTenancyFixture } from "../lib/tenancyFixtures";
import { ensureDemoProjectCompliance } from "../compliance/demoSeed";
import { complianceForAgreement } from "../compliance/status";
import { buildReviewContext } from "../payApps/reviewContext";
import { contextExcludedScopeClaims, finalizeReview, rulesEngineJudgement } from "../payApps/reviewMath";

const modules = import.meta.glob("/convex/**/*.ts");

// Filing a pay app schedules the AI review; fake timers keep it from running mid-test.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const [contractorId, otherContractorId] = await t.run(async (ctx) => {
    const all = await ctx.db.query("contractors").collect();
    return [all[0]._id, all[1]._id] as const;
  });
  const gc = await signInAs(t, "gc", { email: "gc@demo.tradepulse" });
  const gc2 = await signInAs(t, "gc", { email: "gc2@test.tradepulse" });
  const sub1 = await signInAs(t, "sub", { email: "sub1@demo.tradepulse", contractorId });
  const owner = await signInAs(t, "owner", { email: "owner@test.tradepulse" });
  return { t, gc, gc2, sub1, owner, contractorId, otherContractorId };
}

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConvexError) return e.data as { code?: string; message?: string };
    return { message: String(e) };
  }
  throw new Error("expected the call to fail");
}

describe("judge demo runs", () => {
  test("history belongs to the demo GC, explicit selection survives newer shared-account runs", async () => {
    const { t, gc, gc2, sub1 } = await setup();
    const first = await gc.as.mutation(api.judgeDemo.runs.startRun, {});
    const second = await gc.as.mutation(api.judgeDemo.runs.startRun, {});
    const rows = await gc.as.query(api.judgeDemo.runs.listRuns, {});
    expect(rows.map((r) => r.runId)).toEqual([second.runId, first.runId]);
    expect(rows.every((r) => r.payAppsPaid === false && r.ownerPaid === false)).toBe(true);
    expect((await gc.as.query(api.judgeDemo.runs.getRun, { runId: first.runId }))?._id).toBe(first.runId);
    expect(await gc2.as.query(api.judgeDemo.runs.listRuns, {})).toEqual([]);
    await expect(sub1.as.query(api.judgeDemo.runs.listRuns, {})).rejects.toThrow();
    await expect(t.query(api.judgeDemo.runs.listRuns, {})).rejects.toThrow();
    const f = await buildTenancyFixture(t);
    await expect(f.gcA.admin.as.query(api.judgeDemo.runs.listRuns, {})).rejects.toThrow();
    await expect(f.gcA.admin.as.query(api.payApps.proposals.listInbox, { agreementId: first.agreementId })).rejects.toThrow();
  });

  test("agreement-scoped inbox retains an older run beyond the shared global cap", async () => {
    const { t, gc, sub1 } = await setup();
    const first = await gc.as.mutation(api.judgeDemo.runs.startRun, {});
    await gc.as.mutation(api.agreements.executeAgreement, { agreementId: first.agreementId });
    const originalId = await gc.as.mutation(api.judgeDemo.runs.fileDemoPayApp, { runId: first.runId, kind: "honest" });
    for (let group = 0; group < 2; group++) {
      const next = await gc.as.mutation(api.judgeDemo.runs.startRun, {});
      await gc.as.mutation(api.agreements.executeAgreement, { agreementId: next.agreementId });
      const nextId = await gc.as.mutation(api.judgeDemo.runs.fileDemoPayApp, { runId: next.runId, kind: "honest" });
      await t.run(async (ctx) => {
        const { _id, _creationTime, ...fields } = (await ctx.db.get(nextId))!;
        for (let i = 0; i < 32; i++) await ctx.db.insert("payApplications", { ...fields, createdAt: Date.now() + 1000 + i });
      });
    }
    expect((await gc.as.query(api.payApps.proposals.listInbox, {})).some((r) => r.payApp._id === originalId)).toBe(false);
    const scoped = await gc.as.query(api.payApps.proposals.listInbox, { agreementId: first.agreementId });
    expect(scoped.map((r) => r.payApp._id)).toEqual([originalId]);
    await expect(sub1.as.query(api.payApps.proposals.listInbox, { agreementId: first.agreementId })).rejects.toThrow();
  });

  test("a real GC cannot start a run or seed demo compliance", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    expect((await errorOf(f.gcA.admin.as.mutation(api.judgeDemo.runs.startRun, {}))).code).toBe("NOT_FOUND");
    expect(await t.run((ctx) => ctx.db.query("judgeDemoRuns").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("complianceItems").collect())).toHaveLength(0);
  });

  test("a fresh run seeds scoped compliance and uses normal award, SOV and excluded-claim review rules", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const subCompanyId = f.demo.companyIds["sub:rosendin"];
    await t.run(async (ctx) => {
      const contractorId = f.demo.project.contractorId;
      const vendorId = await ctx.db.insert("vendors", {
        companyId: f.demo.companyIds.gc, name: "Demo Rosendin", trades: ["26 00 00"],
        contactName: "Demo", email: "demo@example.invalid", linkedCompanyId: subCompanyId,
        status: "active", createdAt: Date.now(),
      });
      await ctx.db.patch(contractorId, { linkedCompanyId: subCompanyId, vendorId, licenseNumber: "1000000" });
      const userId = await ctx.db.insert("users", { email: "sub1@demo.tradepulse", emailVerificationTime: Date.now() });
      await ctx.db.insert("userProfiles", {
        userId, role: "sub", displayName: "Demo sub", contractorId, companyId: subCompanyId, createdAt: Date.now(),
      });
    });
    // Use the raw authenticated fixture accessor: no legacy test helper may repair tenancy after startRun.
    const { runId, agreementId } = await f.demo.gc.as.mutation(api.judgeDemo.runs.startRun, {});
    const before = await t.run(async (ctx) => {
      const agreement = (await ctx.db.get(agreementId))!;
      return {
        agreement, compliance: await complianceForAgreement(ctx, agreement),
        items: await ctx.db.query("complianceItems").collect(),
        licenseChecks: await ctx.db.query("licenseChecks").collect(),
      };
    });
    expect(before.compliance?.result.status).toBe("compliant");
    expect(before.items).toHaveLength(3);
    expect(before.items.every((r) => r.projectId === before.agreement.projectId &&
      r.demoRecord === true && r.status === "accepted" && r.documentId === undefined)).toBe(true);
    expect(before.items.find((r) => r.kind === "license")?.license?.verification).toBe("unverified");
    expect(before.licenseChecks).toHaveLength(0);
    expect(before.agreement).toMatchObject({
      contractSum: 55_000, contractSumCents: 5_500_000, baseBidCents: 5_500_000,
      acceptedAlternates: [], declinedAlternates: [], veDeducts: [],
      excludedScopeNotes: [DEMO_EXCLUSION.description],
    });
    expect(await t.run((ctx) => ctx.db.get(before.agreement.bidId))).toMatchObject({
      baseAmountCents: 5_500_000, leveledTotalCents: 5_950_000,
    });
    expect(await t.run((ctx) => ensureDemoProjectCompliance(ctx, f.demo.companyIds, before.agreement.projectId, f.demo.gc.userId)))
      .toEqual({ itemsCreated: 0 });
    await f.demo.gc.as.mutation(api.agreements.executeAgreement, { agreementId });
    const payAppId = await f.demo.gc.as.mutation(api.judgeDemo.runs.fileDemoPayApp, { runId, kind: "honest" });
    expect(await t.run((ctx) => ctx.db.get(payAppId))).toMatchObject({ judgeDemo: { runId } });
    const agentId = await f.demo.gc.as.mutation(api.judgeDemo.runs.fileDemoPayApp, { runId, kind: "agent" });
    const reviewInput = await t.run(async (ctx) => {
      const agreement = (await ctx.db.get(agreementId))!;
      const payApp = (await ctx.db.get(agentId))!;
      const sov = await ctx.db.query("scheduleOfValues")
        .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId)).collect();
      const milestones = await ctx.db.query("milestones")
        .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId)).collect();
      const agreementPayApps = await ctx.db.query("payApplications")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId)).collect();
      return { agreement, payApp, sov, milestones, agreementPayApps };
    });
    expect(reviewInput.sov).toHaveLength(4);
    expect(reviewInput.sov.map((line) => [line.description, line.scheduledValueCents, line.excludedScope]))
      .toEqual(DEMO_LINE_ITEMS.map((line) => [line.item, line.totalCost * 100, false]));
    expect(reviewInput.sov.reduce((sum, line) => sum + line.scheduledValueCents, 0)).toBe(5_500_000);
    expect(reviewInput.sov.some((line) => /seismic|exclusion|plug/i.test(line.description))).toBe(false);
    expect(reviewInput.milestones.find((m) => m.name === "Mobilization")?.amountCents).toBe(550_000);
    expect(reviewInput.payApp.notes).toContain("Line 2: branch conduit & wire feeder claim includes $4,500 seismic bracing");
    // No provider calls or simulated funding: review the actual freshly stored rows with normal deterministic policy.
    const context = buildReviewContext({ ...reviewInput, license: null });
    const feeder = context.lines.find((line) => line.lineNo === 2)!;
    expect(feeder.requestedCents).toBeGreaterThan(450_000);
    expect(feeder.excludedScope).toBe(false);
    const claims = contextExcludedScopeClaims(context);
    expect([...claims.byLine.keys()]).toEqual([feeder.sovLineId]);
    expect(claims.unattributed).toHaveLength(0);
    const judgement = rulesEngineJudgement(context);
    const reviewed = finalizeReview(context, judgement);
    expect(reviewed.lines.find((line) => line.sovLineId === feeder.sovLineId)).toMatchObject({
      verdict: "excluded_scope", approvedCents: 0, recommendedPctToDate: 0,
    });
    const switchboardId = context.lines.find((line) => line.lineNo === 1)!.sovLineId;
    const closeoutId = context.lines.find((line) => line.lineNo === 4)!.sovLineId;
    expect(judgement.lines.find((line) => line.sovLineId === switchboardId)?.verdict)
      .toBe("overbilled");
    expect(judgement.lines.find((line) => line.sovLineId === closeoutId)?.verdict)
      .toBe("out_of_sequence");
    expect(reviewed.flags.licenseStatus).toBe("none");
    expect(await t.run((ctx) => ctx.db.query("payments").collect())).toHaveLength(0);
    const next = await f.demo.gc.as.mutation(api.judgeDemo.runs.startRun, {});
    const after = await t.run(async (ctx) => ({
      items: await ctx.db.query("complianceItems").collect(),
      agreement: (await ctx.db.get(next.agreementId))!,
    }));
    expect(after.items).toHaveLength(6);
    expect(after.items.filter((r) => r.projectId === after.agreement.projectId)).toHaveLength(3);
    expect(after.items.filter((r) => r.projectId === before.agreement.projectId)).toEqual(before.items);
    expect(after.items.some((r) => r.projectId === f.demo.project.projectId || r.projectId === f.gcA.project.projectId)).toBe(false);
  });

  test("only the GC can start a run", async () => {
    const { t, sub1, owner } = await setup();
    expect((await errorOf(sub1.as.mutation(api.judgeDemo.runs.startRun, {}))).code).toBe("FORBIDDEN");
    expect((await errorOf(owner.as.mutation(api.judgeDemo.runs.startRun, {}))).code).toBe("FORBIDDEN");
    await expect(t.mutation(api.judgeDemo.runs.startRun, {})).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("judgeDemoRuns").collect())).toHaveLength(0);
  });

  test("startRun creates a generated demo agreement for sub1's contractor and links the billing agent", async () => {
    const { t, gc, contractorId } = await setup();
    const res = await gc.as.mutation(api.judgeDemo.runs.startRun, {});
    const agreement = await t.run((ctx) => ctx.db.get(res.agreementId));
    expect(agreement?.status).toBe("generated");
    expect(agreement?.contractorId).toBe(contractorId);
    expect(agreement?.contractSum).toBe(DEMO_CONTRACT_SUM);
    expect(res.agreementNumber).toMatch(/^A401-DEMO-PAY-\d{8}-01$/);
    const link = await t.run((ctx) =>
      ctx.db
        .query("agentLinks")
        .withIndex("by_agentEmail_and_status", (q) => q.eq("agentEmail", DEMO_BILLING_AGENT_EMAIL).eq("status", "active"))
        .first(),
    );
    expect(link?.contractorId).toBe(contractorId);
    const second = await gc.as.mutation(api.judgeDemo.runs.startRun, {});
    expect(second.agreementNumber).toMatch(/-02$/);
    const run = await gc.as.query(api.judgeDemo.runs.getRun, {});
    expect(run?._id).toBe(second.runId);
  });

  test("refuses to move a billing agent linked to another contractor", async () => {
    const { t, gc, otherContractorId } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("agentLinks", {
        agentEmail: DEMO_BILLING_AGENT_EMAIL,
        contractorId: otherContractorId,
        status: "active",
        createdBy: gc.userId,
        createdAt: Date.now(),
      }),
    );
    expect((await errorOf(gc.as.mutation(api.judgeDemo.runs.startRun, {}))).code).toBe("CONFLICT");
  });

  test("files labeled stand-in pay apps after execution, idempotently", async () => {
    const { t, gc, gc2, sub1 } = await setup();
    const { runId, agreementId } = await gc.as.mutation(api.judgeDemo.runs.startRun, {});
    expect((await errorOf(gc.as.mutation(api.judgeDemo.runs.fileDemoPayApp, { runId, kind: "honest" }))).code).toBe("INVALID_STATE");

    await gc.as.mutation(api.agreements.executeAgreement, { agreementId });
    expect((await errorOf(sub1.as.mutation(api.judgeDemo.runs.fileDemoPayApp, { runId, kind: "honest" }))).code).toBe("FORBIDDEN");
    expect((await errorOf(gc2.as.mutation(api.judgeDemo.runs.fileDemoPayApp, { runId, kind: "honest" }))).code).toBe("NOT_FOUND");
    expect(await gc2.as.query(api.judgeDemo.runs.getRun, { runId })).toBeNull();

    const honestId = await gc.as.mutation(api.judgeDemo.runs.fileDemoPayApp, { runId, kind: "honest" });
    const agentId = await gc.as.mutation(api.judgeDemo.runs.fileDemoPayApp, { runId, kind: "agent" });
    expect(await gc.as.mutation(api.judgeDemo.runs.fileDemoPayApp, { runId, kind: "honest" })).toBe(honestId);
    expect(await gc.as.mutation(api.judgeDemo.runs.fileDemoPayApp, { runId, kind: "agent" })).toBe(agentId);

    const { honest, agent, count } = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("payApplications")
        .filter((q) => q.eq(q.field("agreementId"), agreementId))
        .collect();
      return {
        honest: rows.find((r) => r._id === honestId)!,
        agent: rows.find((r) => r._id === agentId)!,
        count: rows.length,
      };
    });
    expect(count).toBe(2);
    expect(honest.judgeDemo).toEqual({ runId, filedBy: "gc@demo.tradepulse" });
    expect(honest.submittedBy.actorType).toBe("human");
    expect(honest.submittedBy.userId).toBe(sub1.userId);
    expect(agent.judgeDemo?.filedBy).toBe("gc@demo.tradepulse");
    expect(agent.submittedBy.actorType).toBe("agent");
    expect(agent.submittedBy.agentEmail).toBe(DEMO_BILLING_AGENT_EMAIL);
    expect(agent.requestedTotalCents).toBeGreaterThan(honest.requestedTotalCents);

    const run = await gc.as.query(api.judgeDemo.runs.getRun, { runId });
    expect(run?.honestPayAppId).toBe(honestId);
    expect(run?.agentPayAppId).toBe(agentId);

    // sub1 sees its pay apps, labeled as filed by the judge demo.
    const mine = await sub1.as.query(api.portal.mySubPayApps, { paginationOpts: { numItems: 20, cursor: null } });
    const labels = mine.page
      .filter((p) => p._id === honestId || p._id === agentId)
      .map((p) => p.judgeDemoFiledBy);
    expect(labels).toEqual(["gc@demo.tradepulse", "gc@demo.tradepulse"]);
  });
});
