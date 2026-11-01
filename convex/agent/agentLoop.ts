import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, type ToolSet } from "ai";
import { formatCents } from "../lib/money";
import { OFFLINE_RULES_ENGINE } from "../lib/aiLabels";
import { describeProviderFailure } from "../payApps/reviewModel";
import { workingOnBehalfOf } from "../lib/gcCompanyName";
import type { ProposeKind } from "./tools";

/** Upper bound on model steps (tool round-trips) in one pay agent run. */
export const MAX_AGENT_STEPS = 8;
const MODEL_TIMEOUT_MS = 120_000;

export function payAgentSystemPrompt(gcCompanyName: string | null | undefined): string {
  return [
    `You are the pay agent of ${workingOnBehalfOf(gcCompanyName)}, the general contractor (GC). A subcontractor pay application has already been reviewed line by line; dollar amounts were computed by code.`,
    ...PAY_AGENT_INSTRUCTIONS,
  ].join("\n");
}

const PAY_AGENT_INSTRUCTIONS = [
  "Your job is to prepare proposals for the GC. You cannot move money: every propose tool only creates a pending proposal that the GC approves, edits or rejects.",
  "Steps:",
  "1. Call checkLicense with the contractor name and license number.",
  "2. If the approved total is above $0.00: call proposeCapture, then proposePayout. If no milestone is funded yet, say so in the rationale; the GC funds one before approving.",
  "3. If the license status is anything other than active, also call proposeHold.",
  "4. If any line is out_of_sequence or front_loaded, call proposeReschedule.",
  "5. If the approved total is $0.00, call proposeHold.",
  "You may call the read-only PayPal tools (get_order, list_transactions, list_invoices, get_invoice) to cross-check, but they are optional.",
  "Never state dollar amounts of your own in a rationale. Finish with a short summary for the GC.",
];

export type AgentInputs = {
  gcCompanyName: string | null;
  payApp: { periodLabel: string; requestedTotalCents: number; lienWaiver: boolean; notes: string };
  review: { provider: string; model: string; approvedTotalCents: number; flags: { lienWaiverMissing: boolean; notes: string } };
  lines: readonly {
    lineNo: number;
    description: string;
    excludedScope: boolean;
    pctCompleteToDate: number;
    requestedCents: number;
    verdict: string;
    recommendedPctToDate: number;
    approvedCents: number;
    reason: string;
  }[];
  agreement: { agreementNumber: string; subcontractorName: string; retainagePercent: number };
  contractor: { companyName: string; licenseNumber: string };
  milestones: readonly {
    name: string;
    order: number;
    status: string;
    funding: { status: string; grossCents: number; capturedCents: number } | null;
  }[];
};

export function buildAgentPrompt(inputs: AgentInputs): string {
  const lines = inputs.lines
    .map(
      (l) =>
        `- Line ${l.lineNo} ${l.description}${l.excludedScope ? " (excluded scope)" : ""}: claimed ${l.pctCompleteToDate}% to date, requested ${formatCents(l.requestedCents)}; verdict ${l.verdict}, recommended ${Math.round(l.recommendedPctToDate * 1000) / 10}% to date, approved ${formatCents(l.approvedCents)}. ${l.reason}`,
    )
    .join("\n");
  const milestones = inputs.milestones
    .map((m) => {
      const f = m.funding;
      const funded =
        f && (f.status === "authorized" || f.status === "partially_captured")
          ? `funded, ${formatCents(f.grossCents - f.capturedCents)} still authorized`
          : f
            ? `authorization ${f.status}`
            : "not funded";
      return `- ${m.order}. ${m.name}: ${m.status}, ${funded}`;
    })
    .join("\n");
  return [
    `Agreement ${inputs.agreement.agreementNumber} with ${inputs.agreement.subcontractorName}; retainage ${inputs.agreement.retainagePercent}%.`,
    `Contractor: ${inputs.contractor.companyName}; CA license number on file: ${inputs.contractor.licenseNumber || "none"}.`,
    `Pay application "${inputs.payApp.periodLabel}": requested ${formatCents(inputs.payApp.requestedTotalCents)}; lien waiver ${inputs.payApp.lienWaiver ? "attached" : "missing"}.`,
    inputs.payApp.notes ? `Sub notes: ${inputs.payApp.notes.slice(0, 500)}` : "",
    `Review (${inputs.review.provider}${inputs.review.model !== "none" ? ` ${inputs.review.model}` : ""}): approved total ${formatCents(inputs.review.approvedTotalCents)} (computed by code).`,
    inputs.review.flags.notes ? `Review notes: ${inputs.review.flags.notes}` : "",
    "Lines:",
    lines,
    "Milestones:",
    milestones || "- none",
  ]
    .filter(Boolean)
    .join("\n");
}

export type GenerateFn = typeof generateText;

export type AgentLoopResult = {
  provider: string;
  model: string;
  text: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  fallbackReason?: string;
};

/**
 * Runs the bounded tool loop. With no key, model or a provider failure the run is labeled the offline
 * rules engine; the caller's code policy then makes the required proposals deterministically.
 */
export async function runAgentLoop(args: {
  system: string;
  prompt: string;
  tools: ToolSet;
  apiKey?: string;
  modelId?: string;
  generate?: GenerateFn;
}): Promise<AgentLoopResult> {
  if (!args.apiKey || !args.modelId) {
    return { provider: OFFLINE_RULES_ENGINE, model: "none", text: "", steps: 0, inputTokens: 0, outputTokens: 0, fallbackReason: "No AI provider is configured." };
  }
  const generate = args.generate ?? generateText;
  const anthropic = createAnthropic({ apiKey: args.apiKey });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const result = await generate({
      model: anthropic(args.modelId),
      system: args.system,
      prompt: args.prompt,
      tools: args.tools,
      stopWhen: stepCountIs(MAX_AGENT_STEPS),
      maxOutputTokens: 2000,
      maxRetries: 1,
      abortSignal: controller.signal,
    });
    return {
      provider: "Anthropic",
      model: result.response?.modelId || args.modelId,
      text: result.text ?? "",
      steps: result.steps?.length ?? 0,
      inputTokens: result.totalUsage?.inputTokens ?? result.usage?.inputTokens ?? 0,
      outputTokens: result.totalUsage?.outputTokens ?? result.usage?.outputTokens ?? 0,
    };
  } catch (err) {
    const fallbackReason = describeProviderFailure(err);
    console.warn(`Pay agent fell back to the ${OFFLINE_RULES_ENGINE}: ${fallbackReason}`);
    return { provider: OFFLINE_RULES_ENGINE, model: "none", text: "", steps: 0, inputTokens: 0, outputTokens: 0, fallbackReason };
  } finally {
    clearTimeout(timer);
  }
}

/** Default rationale the code policy uses when it makes a required proposal the model skipped. */
export function policyRationale(kind: ProposeKind): string {
  switch (kind) {
    case "capture":
      return "Code policy: capture the code-computed approved amount from the funded milestone.";
    case "payout":
      return "Code policy: pay the sub the code-computed approved amount, net of retainage.";
    case "hold":
      return "Code policy: hold payment until the issue is resolved.";
    case "reschedule":
      return "Code policy: lines were billed out of sequence or front-loaded; reschedule them to the milestones they belong to.";
  }
}
