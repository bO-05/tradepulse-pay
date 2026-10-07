/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { PAY_APP_REVIEW_FIXTURES } from "./reviewEvalFixtures";
import { evaluateFixtures, suiteProvenance } from "./reviewEvals";
import { rulesEngineJudgement } from "./reviewMath";
import type { ModelCaller } from "./reviewModel";

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

  test("a model run is scored against the expectations and labeled with its model id", async () => {
    // A model that misses the front-loaded line but gets everything else right.
    const callModel: ModelCaller = async ({ prompt }) => {
      const lineCount = prompt.split('"sovLineId"').length - 1;
      const f = PAY_APP_REVIEW_FIXTURES.find(
        (x) =>
          x.context.lines.length === lineCount &&
          x.context.lines.every((l) => prompt.includes(`"sovLineId": "${l.sovLineId}"`) && prompt.includes(`"claimedPctToDate": ${l.claimedPctToDate},`)),
      )!;
      const judgement = rulesEngineJudgement(f.context);
      judgement.lines = judgement.lines.map((l) => (l.verdict === "front_loaded" ? { ...l, verdict: "ok" } : l));
      return { judgement, modelId: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 5, rawResponse: "{}" };
    };
    const results = await evaluateFixtures({ apiKey: "k", modelId: "claude-sonnet-5-5" }, { callModel });
    expect(results.every((r) => r.run.provider === "Anthropic")).toBe(true);
    const byId = new Map(results.map((r) => [r.fixture.fixtureId, r.score]));
    expect(byId.get("payapp_overbilled")!.passed).toBe(true);
    expect(byId.get("payapp_front_loaded")).toMatchObject({ passed: false, score: 0.667, provider: "Anthropic", model: "claude-sonnet-5-5" });
    const excluded = results.find((r) => r.fixture.fixtureId === "payapp_excluded_scope")!;
    expect(excluded.run.review.lines.find((l) => l.sovLineId === "fx-sov-5")!.approvedCents).toBe(0);
  });
});

describe("eval suite run", () => {
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
    expect(await gc.as.query(api.evals.getLatestEvalRun, {})).toBeNull();
    expect(await gc.as.query(api.payApps.reviewEvals.getLatestPayAppReviewEvalRun, {})).toMatchObject({ runId: res.runId });
    const sub = await signInAs(t, "sub");
    await expect(sub.as.action(api.payApps.reviewEvals.executePayAppReviewEvalSuite, {})).rejects.toThrow(/Forbidden: role gc/);
  });
});
