/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { DEMO_BILLING_AGENT_EMAIL, DEMO_CONTRACT_SUM } from "./scenario";

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
