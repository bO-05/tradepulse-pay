/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: generateTextMock };
});

// The pay agent scheduled after each review has its own tests (agent/payAgent.test.ts); here it is a
// no-op so these tests see only the review's model calls, traces and license flags.
vi.mock("../agent/payAgent", async () => {
  const { internalAction } = await import("../_generated/server");
  const { v } = await import("convex/values");
  return { runPayAgent: internalAction({ args: { payAppId: v.id("payApplications") }, handler: async () => null }) };
});

const modules = import.meta.glob("/convex/**/*.ts");

beforeEach(() => {
  vi.useFakeTimers();
  generateTextMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  const agreement = await t.run(async (ctx) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_demo", (q) => q.eq("isDemoProject", true))
      .first();
    return (await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project!._id))
      .first())!;
  });
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  await gc.as.mutation(api.billing.sov.approveSov, { agreementId: agreement._id });
  // Mobilization complete and Rough-in under way: base lines are supported up to 30%.
  const { sov, excludedLineId } = await t.run(async (ctx) => {
    const milestones = await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
      .collect();
    await ctx.db.patch(milestones[0]._id, { status: "complete" });
    await ctx.db.patch(milestones[1]._id, { status: "in_progress" });
    const rows = await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id))
      .collect();
    const last = rows[rows.length - 1];
    await ctx.db.patch(last._id, { excludedScope: true, description: "Excluded scope: seismic bracing" });
    for (const m of milestones) await ctx.db.patch(m._id, { sovLineIds: m.sovLineIds.filter((id) => id !== last._id) });
    return { sov: rows, excludedLineId: last._id };
  });
  const sub1 = await signInAs(t, "sub", { email: "sub1@test.tradepulse", contractorId: agreement.contractorId });
  return { t, gc, sub1, agreement, sov, excludedLineId };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function overbilledArgs(s: Setup) {
  const [a, b] = s.sov;
  const excluded = s.sov.find((l) => l._id === s.excludedLineId)!;
  return {
    agreementId: s.agreement._id,
    periodLabel: "Pay app #1 (test)",
    lines: [
      { sovLineId: a._id, pctCompleteThisPeriod: 20, pctCompleteToDate: 20, requestedCents: Math.round(a.scheduledValueCents * 0.2) },
      { sovLineId: b._id, pctCompleteThisPeriod: 60, pctCompleteToDate: 60, requestedCents: Math.round(b.scheduledValueCents * 0.6) },
      { sovLineId: excluded._id, pctCompleteThisPeriod: 10, pctCompleteToDate: 10, requestedCents: Math.min(100_000, excluded.scheduledValueCents) },
    ],
    notes: "",
    lienWaiver: false,
  };
}

async function submitAndReview(s: Setup) {
  const payAppId = await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, overbilledArgs(s));
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  const row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
  const traces = await s.t.run(async (ctx) => (await ctx.db.query("agentTraces").collect()).filter((r) => r.caseId === payAppId));
  return { payAppId, row, traces };
}

describe("pay-app review on submit", () => {
  test("without an AI provider the offline rules engine reviews it and is labeled honestly", async () => {
    const s = await setup();
    const { row, traces } = await submitAndReview(s);
    expect(row.status).toBe("reviewed");
    expect(row.review).toMatchObject({ provider: "Offline rules engine", model: "none", engine: "Offline rules engine" });
    const [a, b] = s.sov;
    const byId = new Map(row.review!.lines.map((l) => [l.sovLineId, l]));
    expect(byId.get(a._id)!.verdict).toBe("ok");
    expect(byId.get(b._id)).toMatchObject({ verdict: "overbilled", recommendedPctToDate: 0.3 });
    expect(byId.get(b._id)!.approvedCents).toBe(Math.round(b.scheduledValueCents * 0.3));
    expect(byId.get(s.excludedLineId)).toMatchObject({ verdict: "excluded_scope", approvedCents: 0 });
    expect(row.review!.flags.lienWaiverMissing).toBe(true);
    expect(row.review!.approvedTotalCents).toBe(row.review!.lines.reduce((x, l) => x + l.approvedCents, 0));
    expect(row.review!.approvedTotalCents).toBeLessThan(row.requestedTotalCents);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ provider: "Offline rules engine", model: "none", runId: row.review!.traceRunId });
    const text = JSON.stringify({ review: row.review, trace: traces[0] }).toLowerCase();
    for (const banned of ["gpt-4o", "openai", "claude"]) expect(text).not.toContain(banned);
  });

  test("tranches that list no SOV lines set no ceiling: the 60% line is not overbilled", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const tranches = await ctx.db
        .query("milestones")
        .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", s.agreement._id))
        .collect();
      for (const m of tranches) await ctx.db.patch(m._id, { sovLineIds: [], status: "planned" });
    });
    const { row } = await submitAndReview(s);
    const b = s.sov[1];
    const line = row.review!.lines.find((l) => l.sovLineId === b._id)!;
    expect(line.verdict).not.toBe("overbilled");
    expect(line.reason).not.toMatch(/ceiling is 0%|support at most/);
    expect(row.review!.lines.find((l) => l.sovLineId === s.excludedLineId)).toMatchObject({ verdict: "excluded_scope", approvedCents: 0 });
  });

  test("Anthropic structured output drives the verdicts; code computes the cents and stores provenance", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
    const s = await setup();
    const [a, b] = s.sov;
    generateTextMock.mockImplementation(async (opts: { prompt: string }) => {
      expect(opts.prompt).toContain("trancheCeilingPctToDate");
      expect(opts.prompt).toContain(String(s.excludedLineId));
      return {
        output: {
          lines: [
            { sovLineId: a._id, verdict: "ok", recommendedPctToDate: 0.2, reason: "Within ceiling." },
            { sovLineId: b._id, verdict: "overbilled", recommendedPctToDate: 0.28, reason: "60% claimed vs 30% supported." },
            { sovLineId: s.excludedLineId, verdict: "excluded_scope", recommendedPctToDate: 0, reason: "Seismic bracing excluded." },
          ],
          lienWaiverMissing: true,
          licenseIssue: false,
          notes: "Two lines flagged.",
        },
        usage: { inputTokens: 1200, outputTokens: 300 },
        response: { modelId: "claude-sonnet-5-5" },
      };
    });
    const { row, traces } = await submitAndReview(s);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(row.review).toMatchObject({ provider: "Anthropic", model: "claude-sonnet-5-5", engine: "Anthropic claude-sonnet-5-5" });
    const line = row.review!.lines.find((l) => l.sovLineId === b._id)!;
    expect(line).toMatchObject({ verdict: "overbilled", recommendedPctToDate: 0.28 });
    expect(line.approvedCents).toBe(Math.round(b.scheduledValueCents * 0.28));
    expect(traces[0]).toMatchObject({ provider: "Anthropic", model: "claude-sonnet-5-5", inputTokens: 1200, outputTokens: 300 });
    expect(JSON.stringify(traces[0])).not.toContain("test-key-not-real");
  });

  test("licenseIssue comes from the stored license check on both paths, overriding the model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
    const s = await setup();
    const [a, b] = s.sov;
    const modelSays = (licenseIssue: boolean) =>
      generateTextMock.mockImplementationOnce(async () => ({
        output: {
          lines: [
            { sovLineId: a._id, verdict: "ok", recommendedPctToDate: 0.2, reason: "ok" },
            { sovLineId: b._id, verdict: "overbilled", recommendedPctToDate: 0.3, reason: "ceiling" },
            { sovLineId: s.excludedLineId, verdict: "excluded_scope", recommendedPctToDate: 0, reason: "excluded" },
          ],
          lienWaiverMissing: true,
          licenseIssue,
          notes: "",
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        response: { modelId: "claude-sonnet-5-5" },
      }));

    modelSays(false);
    const noCheck = await submitAndReview(s);
    expect(noCheck.row.review!.provider).toBe("Anthropic");
    expect(noCheck.row.review!.flags).toMatchObject({ licenseIssue: true, licenseStatus: "none" });

    const addCheck = (status: "active" | "expired", phase?: "running") =>
      s.t.run(async (ctx) =>
        ctx.db.insert("licenseChecks", {
          contractorId: s.agreement.contractorId,
          licenseNumber: "142881",
          state: "CA",
          status,
          rawSummary: "CSLB",
          checkedAt: Date.now(),
          ...(phase ? { phase } : {}),
        }),
      );
    await addCheck("active");
    modelSays(true);
    const res = await s.gc.as.action(api.payApps.review.rerunPayAppReview, { payAppId: noCheck.payAppId });
    expect(res.reviewed).toBe(true);
    let row = (await s.t.run(async (ctx) => ctx.db.get(noCheck.payAppId)))!;
    expect(row.review!.flags).toMatchObject({ licenseIssue: false, licenseStatus: "active" });

    // A running check is not a result; the latest completed one still counts.
    vi.advanceTimersByTime(1000);
    await addCheck("expired", "running");
    vi.unstubAllEnvs();
    await s.gc.as.action(api.payApps.review.rerunPayAppReview, { payAppId: noCheck.payAppId });
    row = (await s.t.run(async (ctx) => ctx.db.get(noCheck.payAppId)))!;
    expect(row.review!.provider).toBe("Offline rules engine");
    expect(row.review!.flags).toMatchObject({ licenseIssue: false, licenseStatus: "active" });

    vi.advanceTimersByTime(1000);
    await addCheck("expired");
    await s.gc.as.action(api.payApps.review.rerunPayAppReview, { payAppId: noCheck.payAppId });
    row = (await s.t.run(async (ctx) => ctx.db.get(noCheck.payAppId)))!;
    expect(row.review!.flags).toMatchObject({ licenseIssue: true, licenseStatus: "expired" });
  });

  test("the offline rules engine flags a missing license check", async () => {
    const s = await setup();
    const { row } = await submitAndReview(s);
    expect(row.review!.provider).toBe("Offline rules engine");
    expect(row.review!.flags).toMatchObject({ licenseIssue: true, licenseStatus: "none" });
    expect(row.review!.flags.notes).toContain("License: no license check yet.");
  });

  test("an invalid model id falls back to the rules engine without leaking the model name", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-does-not-exist");
    generateTextMock.mockRejectedValue(Object.assign(new Error("model: claude-does-not-exist not found"), { statusCode: 404 }));
    const s = await setup();
    const { row, traces } = await submitAndReview(s);
    expect(row.status).toBe("reviewed");
    expect(row.review).toMatchObject({ provider: "Offline rules engine", model: "none", fallbackReason: "AI provider returned HTTP 404." });
    expect(JSON.stringify({ review: row.review, trace: traces[0] }).toLowerCase()).not.toContain("claude");
  });
});

describe("GC review access", () => {
  test("GC sees the review on the agreement's pay apps; subs cannot list or re-run", async () => {
    const s = await setup();
    const { payAppId } = await submitAndReview(s);
    const list = await s.gc.as.query(api.payApps.review.listAgreementPayApps, { agreementId: s.agreement._id });
    expect(list).toHaveLength(1);
    expect(list[0].review).toMatchObject({ provider: "Offline rules engine" });
    expect(list[0].lines.find((l) => l.sovLineId === s.excludedLineId)!.review).toMatchObject({ verdict: "excluded_scope", approvedCents: 0 });

    expect(await s.sub1.as.query(api.payApps.review.listAgreementPayApps, { agreementId: s.agreement._id })).toEqual([]);
    await expect(s.sub1.as.action(api.payApps.review.rerunPayAppReview, { payAppId })).rejects.toThrow(/Not found/);
    const res = await s.gc.as.action(api.payApps.review.rerunPayAppReview, { payAppId });
    expect(res.reviewed).toBe(true);
    const traces = await s.t.run(async (ctx) => (await ctx.db.query("agentTraces").collect()).filter((r) => r.caseId === payAppId));
    expect(traces).toHaveLength(2);
  });

  test("a pay app withdrawn while under review keeps its withdrawn status", async () => {
    const s = await setup();
    const payAppId = await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, overbilledArgs(s));
    expect(await s.t.mutation(internal.payApps.review.beginReview, { payAppId, rerun: false })).toBe(true);
    await s.sub1.as.mutation(api.payApps.submit.withdrawPayApplication, { payAppId });
    const res = await s.t.mutation(internal.payApps.review.storeReview, {
      payAppId,
      review: {
        engine: "Offline rules engine",
        provider: "Offline rules engine",
        model: "none",
        lines: [],
        flags: { lienWaiverMissing: true, licenseIssue: false, notes: "" },
        approvedTotalCents: 0,
        reviewedAt: Date.now(),
      },
      trace: {
        runId: "r1",
        csiDivision: "26",
        contractorName: "x",
        provider: "Offline rules engine",
        model: "none",
        rawPrompt: "",
        systemPrompt: "",
        rawResponse: "",
        parsedOutput: null,
        metrics: null,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    });
    expect(res.stored).toBe(false);
    expect(await s.t.action(internal.payApps.review.reviewPayApp, { payAppId, rerun: true })).toMatchObject({ reviewed: false });
    const row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(row.status).toBe("withdrawn");
    expect(row.review).toBeUndefined();
  });
});

describe("review scenario seed", () => {
  test("creates one executed sub1 agreement with seismic bracing as excluded-scope notes and tranches linked to its SOV lines (30% ceiling)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    const first = await t.mutation(internal.payApps.reviewScenario.seedReviewScenario, {});
    const again = await t.mutation(internal.payApps.reviewScenario.seedReviewScenario, {});
    expect(first.created).toBe(true);
    expect(again).toEqual({ agreementId: first.agreementId, agreementNumber: "A401-DEMO-PAYREVIEW-01", created: false });
    const second = await t.mutation(internal.payApps.reviewScenario.seedReviewScenario, { suffix: "02" });
    expect(second).toMatchObject({ agreementNumber: "A401-DEMO-PAYREVIEW-02", created: true });
    expect(second.agreementId).not.toBe(first.agreementId);
    await expect(t.mutation(internal.payApps.reviewScenario.seedReviewScenario, { suffix: "a b" })).rejects.toThrow(/suffix/);
    const d = await t.query(internal.payApps.reviewScenario.describeReviewScenario, { agreementId: first.agreementId });
    // Excluded scope lives on the agreement as notes for the review, never as an SOV line.
    expect(d.sov.filter((s) => s.excludedScope)).toEqual([]);
    const seeded = (await t.run(async (ctx) => ctx.db.get(first.agreementId)))!;
    expect(seeded.excludedScopeNotes).toEqual([expect.stringMatching(/seismic bracing/i)]);
    expect(d.milestones.map((m) => m.status)).toEqual(["complete", "in_progress", "planned", "planned"]);
    const baseIds = d.sov.filter((s) => !s.excludedScope).map((s) => s.id as string).sort();
    for (const m of d.milestones) expect([...m.sovLineIds].sort()).toEqual(baseIds);
    const conduit = d.sov.find((s) => /conduit/i.test(s.description))!;
    const sub1 = await signInAs(t, "sub", {
      contractorId: (await t.run(async (ctx) => ctx.db.get(first.agreementId)))!.contractorId,
    });
    const payAppId = await sub1.as.mutation(api.payApps.submit.submitPayApplication, {
      agreementId: first.agreementId,
      periodLabel: "Scenario",
      lines: [{ sovLineId: conduit.id, pctCompleteThisPeriod: 60, pctCompleteToDate: 60, requestedCents: Math.round(conduit.scheduledValueCents * 0.6) }],
      notes: "",
      lienWaiver: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const row = (await t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(row.review!.lines[0]).toMatchObject({ verdict: "overbilled", recommendedPctToDate: 0.3 });
  });

  test("offline, a pay-app note billing the excluded seismic bracing zeroes that line next to the overbilled one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    const { agreementId } = await t.mutation(internal.payApps.reviewScenario.seedReviewScenario, { suffix: "EX1" });
    const d = await t.query(internal.payApps.reviewScenario.describeReviewScenario, { agreementId });
    const conduit = d.sov.find((s) => /conduit/i.test(s.description))!;
    const grounding = d.sov.find((s) => /grounding/i.test(s.description))!;
    const sub1 = await signInAs(t, "sub", { contractorId: (await t.run(async (ctx) => ctx.db.get(agreementId)))!.contractorId });
    const payAppId = await sub1.as.mutation(api.payApps.submit.submitPayApplication, {
      agreementId,
      periodLabel: "Scenario with excluded work",
      lines: [
        { sovLineId: conduit.id, pctCompleteThisPeriod: 60, pctCompleteToDate: 60, requestedCents: Math.round(conduit.scheduledValueCents * 0.6) },
        { sovLineId: grounding.id, pctCompleteThisPeriod: 20, pctCompleteToDate: 20, requestedCents: Math.round(grounding.scheduledValueCents * 0.2) },
      ],
      notes: "Conduit runs pulled. Seismic bracing hung on the grounding & bonding system.",
      lienWaiver: true,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const row = (await t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(row.review!.provider).toBe("Offline rules engine");
    const byId = new Map(row.review!.lines.map((l) => [l.sovLineId as string, l]));
    expect(byId.get(conduit.id)).toMatchObject({ verdict: "overbilled", recommendedPctToDate: 0.3 });
    expect(byId.get(grounding.id)).toMatchObject({ verdict: "excluded_scope", approvedCents: 0 });
    expect(byId.get(grounding.id)!.reason).toMatch(/seismic bracing/i);
  });
});
