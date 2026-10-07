import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalAction, internalMutation, query, type ActionCtx } from "../_generated/server";
import { requireRole, requireRoleInAction } from "../lib/roles";
import { PAY_APP_REVIEW_FIXTURES, type PayAppReviewFixture } from "./reviewEvalFixtures";
import { runPayAppReview, type ModelCaller, type ReviewRun } from "./reviewModel";

export const PAY_APP_REVIEW_SUITE = "pay_app_review";

export type FixtureScore = {
  fixtureId: string;
  score: number;
  passed: boolean;
  provider: string;
  model: string;
  checks: string[];
};

/** Score = share of lines with the expected verdict; a fixture passes when every line matches and every zero-approval holds. */
export function scoreFixture(fixture: PayAppReviewFixture, run: ReviewRun): FixtureScore {
  const byId = new Map(run.review.lines.map((l) => [l.sovLineId, l]));
  const checks: string[] = [];
  const expectedIds = Object.keys(fixture.expected);
  let matched = 0;
  for (const id of expectedIds) {
    const got = byId.get(id);
    const ok = got?.verdict === fixture.expected[id];
    if (ok) matched++;
    checks.push(`${id}: expected ${fixture.expected[id]}, got ${got?.verdict ?? "none"}${ok ? "" : " (miss)"}`);
  }
  let zeroOk = true;
  for (const id of fixture.expectZeroApproved) {
    const cents = byId.get(id)?.approvedCents;
    const ok = cents === 0;
    zeroOk &&= ok;
    checks.push(`${id}: approved ${cents ?? "none"} cents, expected 0${ok ? "" : " (miss)"}`);
  }
  const score = expectedIds.length === 0 ? 0 : Math.round((matched / expectedIds.length) * 1000) / 1000;
  return { fixtureId: fixture.fixtureId, score, passed: matched === expectedIds.length && zeroOk, provider: run.provider, model: run.model, checks };
}

/** The run's provenance: the single provider/model every fixture used, or "mixed" when some fell back. */
export function suiteProvenance(scores: readonly FixtureScore[]): { provider: string; model: string } {
  const providers = new Set(scores.map((s) => s.provider));
  const models = new Set(scores.map((s) => s.model));
  if (providers.size === 1 && models.size === 1) return { provider: scores[0].provider, model: scores[0].model };
  return { provider: "mixed", model: [...models].join(" + ") };
}

export async function evaluateFixtures(
  env: { apiKey?: string; modelId?: string },
  deps: { callModel?: ModelCaller } = {},
): Promise<{ fixture: PayAppReviewFixture; run: ReviewRun; score: FixtureScore }[]> {
  const out = [];
  for (const fixture of PAY_APP_REVIEW_FIXTURES) {
    const run = await runPayAppReview(fixture.context, env, deps);
    out.push({ fixture, run, score: scoreFixture(fixture, run) });
  }
  return out;
}

export const recordPayAppReviewEvalRun = internalMutation({
  args: {
    runId: v.string(),
    targetEnvironment: v.string(),
    triggeredBy: v.string(),
    provider: v.string(),
    model: v.string(),
    overallScore: v.number(),
    passedCases: v.number(),
    totalDurationMs: v.number(),
    fixtureScores: v.array(
      v.object({
        fixtureId: v.string(),
        score: v.number(),
        passed: v.boolean(),
        provider: v.string(),
        model: v.string(),
        checks: v.array(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("evalRuns", {
      runId: args.runId,
      targetEnvironment: args.targetEnvironment,
      triggeredBy: args.triggeredBy,
      suite: PAY_APP_REVIEW_SUITE,
      provider: args.provider,
      model: args.model,
      fixtureScores: args.fixtureScores,
      totalCases: args.fixtureScores.length,
      passedCases: args.passedCases,
      // Bid-leveling metrics do not apply to this suite.
      scopeRecallAvg: 0,
      scopePrecisionAvg: 0,
      leveledCostMape: 0,
      veAccuracyAvg: 0,
      coiF1Score: 0,
      clashRecallAvg: 0,
      aiaConformityAvg: 0,
      overallScore: args.overallScore,
      totalDurationMs: args.totalDurationMs,
      createdAt: Date.now(),
    });
  },
});

type SuiteResult = {
  runId: string;
  suite: string;
  provider: string;
  model: string;
  overallScore: number;
  passedCases: number;
  totalCases: number;
  fixtureScores: FixtureScore[];
};

async function executeSuite(ctx: ActionCtx, targetEnvironment: string, triggeredBy: string): Promise<SuiteResult> {
  const started = Date.now();
  const runId = `eval_payapp_${started}`;
  const results = await evaluateFixtures({ apiKey: process.env.ANTHROPIC_API_KEY, modelId: process.env.ANTHROPIC_MODEL });
  for (const { fixture, run, score } of results) {
    await ctx.runMutation(internal.evals.recordAgentTrace, {
      runId,
      caseId: fixture.fixtureId,
      csiDivision: fixture.context.agreement.csiDivision,
      contractorName: fixture.context.agreement.subcontractorName,
      provider: run.provider,
      model: run.model,
      rawPrompt: run.prompt,
      systemPrompt: run.systemPrompt,
      rawResponse: run.rawResponse,
      parsedOutput: run.review,
      groundTruth: { expected: fixture.expected, expectZeroApproved: fixture.expectZeroApproved },
      metrics: { score: score.score, checks: score.checks, ...(run.fallbackReason ? { fallbackReason: run.fallbackReason } : {}) },
      status: score.passed ? "PASS" : "FAIL",
      latencyMs: run.latencyMs,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      costUsd: 0,
      timestamp: Date.now(),
    });
  }
  const fixtureScores = results.map((r) => r.score);
  const overallScore = Math.round((fixtureScores.reduce((a, s) => a + s.score, 0) / fixtureScores.length) * 1000) / 10;
  const passedCases = fixtureScores.filter((s) => s.passed).length;
  const { provider, model } = suiteProvenance(fixtureScores);
  await ctx.runMutation(internal.payApps.reviewEvals.recordPayAppReviewEvalRun, {
    runId,
    targetEnvironment,
    triggeredBy,
    provider,
    model,
    overallScore,
    passedCases,
    totalDurationMs: Date.now() - started,
    fixtureScores,
  });
  return { runId, suite: PAY_APP_REVIEW_SUITE, provider, model, overallScore, passedCases, totalCases: fixtureScores.length, fixtureScores };
}

/** CLI: npx convex run payApps/reviewEvals:runPayAppReviewEvalSuite '{}' */
export const runPayAppReviewEvalSuite = internalAction({
  args: { targetEnvironment: v.optional(v.string()), triggeredBy: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SuiteResult> =>
    await executeSuite(ctx, args.targetEnvironment ?? "dev", args.triggeredBy ?? "cli_benchmark"),
});

/** GC runs the pay-app review eval suite from the app. */
export const executePayAppReviewEvalSuite = action({
  args: { targetEnvironment: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SuiteResult> => {
    await requireRoleInAction(ctx, ["gc"]);
    return await executeSuite(ctx, args.targetEnvironment ?? "dev", "judge_diagnostics");
  },
});

export const getLatestPayAppReviewEvalRun = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc"]);
    const recent = await ctx.db.query("evalRuns").withIndex("by_createdAt").order("desc").take(50);
    return recent.find((r) => r.suite === PAY_APP_REVIEW_SUITE) ?? null;
  },
});
