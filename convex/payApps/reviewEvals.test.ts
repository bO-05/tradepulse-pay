/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { PAY_APP_REVIEW_FIXTURES } from "./reviewEvalFixtures";
import { evaluateFixtures, suiteProvenance } from "./reviewEvals";
import { rulesEngineJudgement } from "./reviewMath";
import type { ModelCaller } from "./reviewModel";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: generateTextMock };
});
afterEach(() => {
  vi.unstubAllEnvs();
  generateTextMock.mockReset();
});

const modules = import.meta.glob("/convex/**/*.ts");

describe("pay-app review eval fixtures", () => {
  test("cover honest, overbilled, excluded scope and front-loaded with expected verdicts per line", () => {
    expect(PAY_APP_REVIEW_FIXTURES.map((f) => f.fixtureId)).toEqual([
      "payapp_honest",
      "payapp_overbilled",
      "payapp_excluded_scope",
      "payapp_front_loaded",
    ]);
    for (const f of PAY_APP_REVIEW_FIXTURES) {
      expect(Object.keys(f.expected).sort()).toEqual(f.context.lines.map((l) => l.sovLineId).sort());
    }
    expect(Object.values(PAY_APP_REVIEW_FIXTURES[0].expected).every((v) => v === "ok")).toBe(true);
  });

  test("offline rules engine scores every fixture and labels itself honestly", async () => {
    const results = await evaluateFixtures({});
    expect(results.map((r) => r.score.score)).toEqual([1, 1, 1, 1]);
    expect(results.every((r) => r.score.passed)).toBe(true);
    expect(suiteProvenance(results.map((r) => r.score))).toEqual({ provider: "Offline rules engine", model: "none" });
  });

  test.each([
    { provider: "anthropic" as const, label: "Anthropic", modelId: "claude-sonnet-5-5" },
    { provider: "mistral" as const, label: "Mistral", modelId: "mistral-large-latest" },
  ])("a $label run is scored against model verdicts and labeled with its model id", async ({ provider, label, modelId }) => {
    // A model that misses the front-loaded line but gets everything else right.
    const callModel: ModelCaller = async ({ prompt, provider: selected }) => {
      expect(selected).toBe(provider);
      const lineCount = prompt.split('"sovLineId"').length - 1;
      const f = PAY_APP_REVIEW_FIXTURES.find(
        (x) =>
          x.context.lines.length === lineCount &&
          prompt.includes(JSON.stringify(x.context.payApp.notes)) &&
          x.context.lines.every((l) => prompt.includes(`"sovLineId": "${l.sovLineId}"`) && prompt.includes(`"claimedPctToDate": ${l.claimedPctToDate},`)),
      )!;
      const judgement = rulesEngineJudgement(f.context);
      judgement.lines = judgement.lines.map((l) => (l.verdict === "front_loaded" ? { ...l, verdict: "ok" } : l));
      return { judgement, modelId, inputTokens: 10, outputTokens: 5, rawResponse: "{}" };
    };
    const results = await evaluateFixtures({ apiKey: "k", modelId, provider }, { callModel });
    expect(results.every((r) => r.run.provider === label)).toBe(true);
    expect(suiteProvenance(results.map((r) => r.score))).toEqual({ provider: label, model: modelId });
    const byId = new Map(results.map((r) => [r.fixture.fixtureId, r.score]));
    expect(byId.get("payapp_overbilled")!.passed).toBe(true);
    expect(byId.get("payapp_front_loaded")).toMatchObject({ passed: false, score: 0.667, provider: label, model: modelId });
    const excluded = results.find((r) => r.fixture.fixtureId === "payapp_excluded_scope")!;
    expect(excluded.run.review.lines.find((l) => l.sovLineId === "fx-sov-3")!.approvedCents).toBe(0);
  });
});

describe("eval suite run", () => {
  test("the configured Mistral suite persists actual provider/model on every score and trace", async () => {
    vi.stubEnv("AI_PROVIDER", "mistral");
    vi.stubEnv("MISTRAL_API_KEY", "fake-mistral-eval-key");
    let fixtureIndex = 0;
    generateTextMock.mockImplementation(async (options: { model: { provider: string }; prompt: string }) => {
      expect(options.model.provider).toContain("mistral");
      const fixture = PAY_APP_REVIEW_FIXTURES[fixtureIndex++];
      expect(options.prompt).toContain(fixture.context.payApp.periodLabel);
      return { output: rulesEngineJudgement(fixture.context), response: { modelId: "mistral-large-actual" }, usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const t = convexTest(schema, modules);
    const result = await t.action(internal.payApps.reviewEvals.runPayAppReviewEvalSuite, {});
    expect(generateTextMock).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ provider: "Mistral", model: "mistral-large-actual", passedCases: 4 });
    expect(result.fixtureScores.every((score) => score.provider === "Mistral" && score.model === "mistral-large-actual")).toBe(true);
    const saved = await t.run(async (ctx) => ({
      run: await ctx.db.query("evalRuns").first(),
      traces: await ctx.db.query("agentTraces").collect(),
    }));
    expect(saved.run).toMatchObject({ provider: "Mistral", model: "mistral-large-actual" });
    expect(saved.traces).toHaveLength(4);
    expect(saved.traces.every((trace) => trace.provider === "Mistral" && trace.model === "mistral-large-actual")).toBe(true);
  });

  test("records a pay_app_review evalRuns row with per-fixture scores; the leveling view ignores it", async () => {
    const t = convexTest(schema, modules);
    const res = await t.action(internal.payApps.reviewEvals.runPayAppReviewEvalSuite, {});
    expect(res).toMatchObject({ suite: "pay_app_review", provider: "Offline rules engine", model: "none", overallScore: 100, passedCases: 4, totalCases: 4 });
    const run = await t.run(async (ctx) => ctx.db.query("evalRuns").first());
    expect(run).toMatchObject({ suite: "pay_app_review", provider: "Offline rules engine", totalCases: 4 });
    expect(run!.fixtureScores!.map((f) => [f.fixtureId, f.score])).toEqual([
      ["payapp_honest", 1],
      ["payapp_overbilled", 1],
      ["payapp_excluded_scope", 1],
      ["payapp_front_loaded", 1],
    ]);
    const traces = await t.run(async (ctx) => ctx.db.query("agentTraces").collect());
    expect(traces.filter((tr) => tr.runId === res.runId)).toHaveLength(4);
    const gc = await signInAs(t, "gc");
    const latest = await gc.as.query(api.evals.getLatestEvalRun, {});
    expect(latest).toMatchObject({ run: null, traces: [], payAppReviewRun: { runId: res.runId, suite: "pay_app_review" } });
    expect(await gc.as.query(api.payApps.reviewEvals.getLatestPayAppReviewEvalRun, {})).toMatchObject({ runId: res.runId });
    const sub = await signInAs(t, "sub");
    await expect(sub.as.action(api.payApps.reviewEvals.executePayAppReviewEvalSuite, {})).rejects.toThrow(/Forbidden: role gc/);
  });

  test("the existing executeEvalSuite entrypoint also scores the four pay-app fixtures with honest labels", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    const gc = await signInAs(t, "gc");
    const res = await gc.as.action(api.evals.executeEvalSuite, { targetEnvironment: "dev", triggeredBy: "cli_benchmark" });

    expect(res.payAppReview).toMatchObject({
      runId: `${res.runId}_payapp`,
      suite: "pay_app_review",
      provider: "Offline rules engine",
      model: "none",
      overallScore: 100,
      passedCases: 4,
      totalCases: 4,
    });
    const runs = await t.run(async (ctx) => ctx.db.query("evalRuns").collect());
    expect(runs.find((r) => r.runId === res.runId)?.suite).toBeUndefined();
    const payRun = runs.find((r) => r.runId === res.payAppReview.runId)!;
    expect(payRun).toMatchObject({ suite: "pay_app_review", provider: "Offline rules engine", model: "none", overallScore: 100, triggeredBy: "cli_benchmark" });
    expect(payRun.fixtureScores!.map((f) => [f.fixtureId, f.passed, f.provider])).toEqual([
      ["payapp_honest", true, "Offline rules engine"],
      ["payapp_overbilled", true, "Offline rules engine"],
      ["payapp_excluded_scope", true, "Offline rules engine"],
      ["payapp_front_loaded", true, "Offline rules engine"],
    ]);

    const traces = await t.run(async (ctx) =>
      ctx.db
        .query("agentTraces")
        .withIndex("by_runId", (q) => q.eq("runId", res.payAppReview.runId))
        .collect(),
    );
    const review = (id: string) => traces.find((tr) => tr.caseId === id)!.parsedOutput as { lines: { sovLineId: string; verdict: string; approvedCents: number }[] };
    expect(review("payapp_honest").lines.every((l) => l.verdict === "ok")).toBe(true);
    expect(review("payapp_overbilled").lines.some((l) => l.verdict === "overbilled")).toBe(true);
    const excludedIds = PAY_APP_REVIEW_FIXTURES.find((f) => f.fixtureId === "payapp_excluded_scope")!.expectZeroApproved;
    expect(excludedIds.length).toBeGreaterThan(0);
    for (const id of excludedIds) expect(review("payapp_excluded_scope").lines.find((l) => l.sovLineId === id)!.approvedCents).toBe(0);

    const latest = await gc.as.query(api.evals.getLatestEvalRun, {});
    expect(latest!.run!.runId).toBe(res.runId);
    expect(latest!.payAppReviewRun).toMatchObject({ runId: res.payAppReview.runId });
    const sub = await signInAs(t, "sub");
    await expect(sub.as.action(api.evals.executeEvalSuite, {})).rejects.toThrow(/Forbidden: role gc/);
  }, 60_000);
});
