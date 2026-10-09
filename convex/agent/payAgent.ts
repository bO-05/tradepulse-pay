"use node";

// Node runtime: @paypal/agent-toolkit/ai-sdk only bundles and runs in Convex's Node runtime.
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import type { LicenseCheckResult } from "../kernel/licenseCheck";
import { buildAgentPrompt, payAgentSystemPrompt, policyRationale, runAgentLoop, MAX_AGENT_STEPS } from "./agentLoop";
import {
  createProposeTools,
  ensureSessionLicense,
  READ_ONLY_TOOLKIT_ACTIONS,
  scrubSecrets,
  toTraceString,
  wrapToolkitTools,
  type LicenseToolResult,
  type ProposeKind,
  type ProposeSession,
  type ToolCallRecord,
  type ToolkitTool,
} from "./tools";

/**
 * The pay agent (architecture §7): after a pay app is reviewed, an AI SDK v7 tool loop checks the
 * contractor's license and prepares capture / payout / reschedule / hold proposals for the GC.
 * Its tools can read PayPal and insert pending agentProposals rows; nothing here moves money.
 */

function secretValues(): string[] {
  return [
    process.env.ANTHROPIC_API_KEY,
    process.env.KERNEL_API_KEY,
    process.env.PAYPAL_CLIENT_SECRET,
    process.env.PAYPAL_CLIENT_ID,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
}

function readOnlyToolkitTools(record: (r: ToolCallRecord) => void, secrets: string[]) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return {};
  try {
    const toolkit = new PayPalAgentToolkit({
      clientId,
      clientSecret,
      configuration: {
        actions: Object.fromEntries(Object.entries(READ_ONLY_TOOLKIT_ACTIONS).map(([k, a]) => [k, { ...a }])),
        context: { sandbox: true },
      },
    });
    return wrapToolkitTools(toolkit.getTools() as unknown as Record<string, ToolkitTool>, record, secrets);
  } catch (e) {
    console.warn(`PayPal agent toolkit unavailable: ${e instanceof Error ? e.name : "error"}`);
    return {};
  }
}

type RunResult =
  | { ran: false; reason: string }
  | { ran: true; runId: string; provider: string; proposals: string[] };

async function runAgent(ctx: ActionCtx, payAppId: Id<"payApplications">): Promise<RunResult> {
  const runId = `pay_agent_${payAppId}_${Date.now()}`;
  const started: boolean = await ctx.runMutation(internal.agent.proposalDb.beginAgentRun, { payAppId, runId });
  if (!started) return { ran: false as const, reason: "Pay application is not reviewed." };
  const inputs = await ctx.runQuery(internal.agent.proposalDb.loadAgentInputs, { payAppId });
  if (inputs === null) return { ran: false as const, reason: "Pay application not found." };

  const secrets = secretValues();
  const calls: ToolCallRecord[] = [];
  const record = (r: ToolCallRecord) => calls.push(r);
  const session: ProposeSession = { license: null };

  const checkLicense = async (): Promise<LicenseToolResult> => {
    const res: LicenseCheckResult = await ctx.runAction(internal.kernel.licenseCheck.checkLicenseNow, {
      contractorId: inputs.agreement.contractorId,
      trigger: "pay_agent",
    });
    await ctx.runMutation(internal.agent.proposalDb.syncReviewLicense, { payAppId, checkId: res.checkId });
    return {
      checkId: res.checkId,
      contractorName: inputs.contractor.companyName,
      licenseNumber: res.licenseNumber,
      status: res.status,
      checkedAt: res.checkedAt,
      rawSummary: res.rawSummary,
      cached: res.cached,
    };
  };
  const insertProposal = async (input: { kind: ProposeKind; rationale: string; licenseCheckId?: string }, source: "agent" | "code_policy" = "agent") =>
    await ctx.runMutation(internal.agent.proposalDb.insertAgentProposal, {
      payAppId,
      runId,
      kind: input.kind,
      rationale: input.rationale,
      source,
      licenseCheckId: input.licenseCheckId as Id<"licenseChecks"> | undefined,
    });

  const proposeTools = createProposeTools({ checkLicense, insertProposal: (i) => insertProposal(i, "agent") }, record, session);
  const tools = { ...readOnlyToolkitTools(record, secrets), ...proposeTools };
  const prompt = buildAgentPrompt(inputs);
  const system = payAgentSystemPrompt(inputs.gcCompanyName);
  const started_ = Date.now();
  const loop = await runAgentLoop({
    system,
    prompt,
    tools,
    apiKey: process.env.ANTHROPIC_API_KEY,
    modelId: process.env.ANTHROPIC_MODEL,
  });

  // Code policy: the license is always checked, and any proposal the plan requires but the model
  // skipped is made deterministically and labeled as such in the trace.
  const license = await ensureSessionLicense(session, checkLicense, record, { source: "code_policy", triggeredBy: "code_policy" });
  const { required, made } = await ctx.runQuery(internal.agent.proposalDb.requiredProposalKinds, {
    payAppId,
    runId,
    licenseCheckId: license.checkId as Id<"licenseChecks">,
  });
  for (const kind of required as ProposeKind[]) {
    if (made.includes(kind)) continue;
    const input = { kind, rationale: policyRationale(kind), licenseCheckId: license.checkId };
    const res = await insertProposal(input, "code_policy");
    calls.push({
      tool: `propose${kind[0].toUpperCase()}${kind.slice(1)}`,
      source: "code_policy",
      input: { rationale: input.rationale },
      output: JSON.stringify(res),
      at: Date.now(),
    });
  }
  const latencyMs = Date.now() - started_;

  const proposals: string[] = (
    await ctx.runQuery(internal.agent.proposalDb.requiredProposalKinds, {
      payAppId,
      runId,
      licenseCheckId: license.checkId as Id<"licenseChecks">,
    })
  ).made;
  await ctx.runMutation(internal.agent.proposalDb.storeAgentTrace, {
    payAppId,
    trace: {
      runId,
      csiDivision: inputs.agreement.csiDivision,
      contractorName: inputs.contractor.companyName,
      provider: loop.provider,
      model: loop.model,
      rawPrompt: scrubSecrets(prompt, secrets),
      systemPrompt: system,
      rawResponse: toTraceString(loop.text, secrets),
      parsedOutput: {
        kind: "pay_agent",
        toolCalls: calls.map((c) => ({ tool: c.tool, source: c.source, input: toTraceString(c.input, secrets), output: toTraceString(c.output, secrets), at: c.at })),
        proposalKinds: proposals,
        license: {
          checkId: license.checkId,
          licenseNumber: license.licenseNumber,
          status: license.status,
          checkedAt: license.checkedAt,
        },
        tools: Object.keys(tools),
      },
      metrics: {
        steps: loop.steps,
        maxSteps: MAX_AGENT_STEPS,
        toolCallCount: calls.length,
        ...(loop.fallbackReason ? { fallbackReason: loop.fallbackReason } : {}),
      },
      latencyMs,
      inputTokens: loop.inputTokens,
      outputTokens: loop.outputTokens,
    },
  });
  return { ran: true as const, runId, provider: loop.provider, proposals };
}

/** Scheduled after a review is stored; also runnable from the CLI for a reviewed pay app. */
export const runPayAgent = internalAction({
  args: { payAppId: v.id("payApplications") },
  handler: async (ctx, { payAppId }): Promise<RunResult> => await runAgent(ctx, payAppId),
});
