/**
 * Runs a pay-app review: Anthropic structured output via the AI SDK, with the
 * deterministic rules engine as the offline fallback. Returns the judgement,
 * the code-computed review and honest provenance for storage and traces.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";
import { z } from "zod";
import { formatCents } from "../lib/money";
import {
  finalizeReview,
  LINE_VERDICTS,
  OFFLINE_RULES_ENGINE,
  rulesEngineJudgement,
  type FinalReview,
  type ReviewContext,
  type ReviewJudgement,
} from "./reviewMath";

/** Model output schema: verdicts, fractions and reasons only. Dollar amounts are computed by code. */
export const reviewJudgementSchema = z.object({
  lines: z.array(
    z.object({
      sovLineId: z.string().describe("The sovLineId of the submitted line, copied exactly."),
      verdict: z.enum(LINE_VERDICTS),
      recommendedPctToDate: z
        .number()
        .min(0)
        .max(1)
        .describe("Recommended cumulative percent complete to date as a fraction between 0 and 1 (0.35 = 35%)."),
      reason: z.string().min(1).describe("One or two sentences citing the evidence."),
    }),
  ),
  lienWaiverMissing: z.boolean(),
  licenseIssue: z.boolean(),
  notes: z.string().describe("Short overall note for the general contractor."),
});

export const REVIEW_SYSTEM_PROMPT = `You review construction subcontractor pay applications (AIA G702/G703 style) for the general contractor.
For every submitted line return exactly one entry with the line's sovLineId, a verdict, a recommended cumulative percent complete to date as a FRACTION between 0 and 1, and a short reason that cites the numbers.
Never output dollar amounts; code computes all money from your fractions.

Verdicts, checked in this order:
- "excluded_scope": the line has excludedScope true (scope the subcontractor excluded in the leveled bid). Recommend 0.
- "out_of_sequence": closeout-phase work (closeout, testing, commissioning, O&M manuals, as-builts, punch list, training, start-up) billed this period while the milestones before Closeout are not complete (closeoutWorkBeforeEarlierMilestones true), or other work that clearly belongs to a later milestone than the ones under way. Recommend the previous percent to date (no new progress).
- "overbilled": claimed percent to date exceeds milestoneCeilingPctToDate, the most progress the milestone statuses support. Recommend at most milestoneCeilingPctToDate.
- "front_loaded": within the ceiling, but the claim is at least double otherLinesProgressPct (the progress of the rest of the job) and at least 15 percentage points above it, with otherLinesProgressPct above 0. Recommend about otherLinesProgressPct (never below the previous percent to date).
- "ok": none of the above. Recommend the claimed percent to date.

Also set lienWaiverMissing (true when no lien waiver was provided) and licenseIssue (true when the latest license check is expired, suspended or not found). Use the pay-app notes, prior pay apps and agreement terms as supporting evidence.`;

const pctLabel = (f: number) => `${Math.round(f * 1000) / 10}%`;

export function buildReviewPrompt(context: ReviewContext): string {
  const payload = {
    agreement: {
      ...context.agreement,
      contractSum: formatCents(context.agreement.contractSumCents),
    },
    milestones: context.milestones.map((m) => ({
      name: m.name,
      order: m.order,
      status: m.status,
      amount: formatCents(m.amountCents),
    })),
    priorPayApps: context.priorPayApps.map((p) => ({
      periodLabel: p.periodLabel,
      status: p.status,
      requested: formatCents(p.requestedTotalCents),
      approved: p.approvedTotalCents === null ? null : formatCents(p.approvedTotalCents),
    })),
    latestLicenseCheck: context.license ?? "No license check on file.",
    payApplication: {
      periodLabel: context.payApp.periodLabel,
      notes: context.payApp.notes || "(none)",
      lienWaiverProvided: context.payApp.lienWaiver,
      requestedTotal: formatCents(context.payApp.requestedTotalCents),
    },
    lines: context.lines.map((l) => ({
      sovLineId: l.sovLineId,
      lineNo: l.lineNo,
      description: l.description,
      excludedScope: l.excludedScope,
      scheduledValue: formatCents(l.scheduledValueCents),
      previouslyBilled: formatCents(l.previouslyBilledCents),
      previousPctToDate: l.previousPctToDate,
      claimedPctThisPeriod: l.claimedPctThisPeriod,
      claimedPctToDate: l.claimedPctToDate,
      requested: formatCents(l.requestedCents),
      milestoneCeilingPctToDate: l.milestoneCeilingPctToDate,
      otherLinesProgressPct: l.otherLinesProgressPct,
      closeoutWorkBeforeEarlierMilestones: l.closeoutWorkBeforeEarlierMilestones,
      summary: `claims ${pctLabel(l.claimedPctToDate)} to date; milestones support ${pctLabel(l.milestoneCeilingPctToDate)}; rest of job at ${pctLabel(l.otherLinesProgressPct)}`,
    })),
  };
  return `Review this pay application. Percent fields are fractions (0.35 = 35%).\n\n${JSON.stringify(payload, null, 2)}`;
}

export type ModelCallResult = {
  judgement: ReviewJudgement;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  rawResponse: string;
};

export type ModelCaller = (input: { system: string; prompt: string; apiKey: string; modelId: string }) => Promise<ModelCallResult>;

const MODEL_TIMEOUT_MS = 90_000;

export const callAnthropic: ModelCaller = async ({ system, prompt, apiKey, modelId }) => {
  const anthropic = createAnthropic({ apiKey });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const result = await generateText({
      model: anthropic(modelId),
      system,
      prompt,
      output: Output.object({ schema: reviewJudgementSchema, name: "pay_app_review" }),
      maxOutputTokens: 4000,
      maxRetries: 1,
      abortSignal: controller.signal,
    });
    const judgement = result.output as ReviewJudgement;
    return {
      judgement,
      modelId: result.response?.modelId || modelId,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      rawResponse: JSON.stringify(judgement),
    };
  } finally {
    clearTimeout(timer);
  }
};

export type ReviewRun = {
  review: FinalReview;
  judgement: ReviewJudgement;
  provider: string;
  model: string;
  engine: string;
  fallbackReason?: string;
  systemPrompt: string;
  prompt: string;
  rawResponse: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

/**
 * Error text safe to store and show: a short category, never the provider's
 * message (it can echo the configured model id or request details).
 */
export function describeProviderFailure(err: unknown): string {
  const status = (err as { statusCode?: unknown })?.statusCode;
  if (typeof status === "number") return `AI provider returned HTTP ${status}.`;
  const name = (err as { name?: unknown })?.name;
  if (name === "AbortError") return "AI provider timed out.";
  if (err instanceof Error && err.name === "IncompleteJudgementError") return "AI response did not cover every line.";
  if (typeof name === "string" && /NoObjectGenerated|TypeValidation|JSONParse/i.test(name)) {
    return "AI response did not match the review schema.";
  }
  return "AI provider did not respond.";
}

export async function runPayAppReview(
  context: ReviewContext,
  env: { apiKey?: string; modelId?: string },
  deps: { callModel?: ModelCaller; now?: () => number } = {},
): Promise<ReviewRun> {
  const now = deps.now ?? Date.now;
  const callModel = deps.callModel ?? callAnthropic;
  const prompt = buildReviewPrompt(context);
  const started = now();
  let fallbackReason = "No AI provider is configured.";
  if (env.apiKey && env.modelId) {
    try {
      const res = await callModel({ system: REVIEW_SYSTEM_PROMPT, prompt, apiKey: env.apiKey, modelId: env.modelId });
      const review = finalizeReview(context, res.judgement);
      return {
        review,
        judgement: res.judgement,
        provider: "Anthropic",
        model: res.modelId,
        engine: `Anthropic ${res.modelId}`,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        prompt,
        rawResponse: res.rawResponse,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        latencyMs: now() - started,
      };
    } catch (err) {
      fallbackReason = describeProviderFailure(err);
      console.warn(`Pay-app review fell back to the ${OFFLINE_RULES_ENGINE}: ${fallbackReason}`);
    }
  }
  const judgement = rulesEngineJudgement(context);
  return {
    review: finalizeReview(context, judgement),
    judgement,
    provider: OFFLINE_RULES_ENGINE,
    model: "none",
    engine: OFFLINE_RULES_ENGINE,
    fallbackReason,
    systemPrompt: `${OFFLINE_RULES_ENGINE}: deterministic verdict rules (no AI model ran).`,
    prompt,
    rawResponse: JSON.stringify(judgement),
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: now() - started,
  };
}
