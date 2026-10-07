import {
  createAiHarness,
  directLlmRunner,
  type AgAiHarness,
  type AgAiHarnessSetupParams,
  type AgAnyAiAgentDefinition,
  type AgBuiltInAgentId,
  type AgLlmAdapter,
} from "ag-studio";
import { describePaySummary, type PaySummary } from "./payAgentTools";

export const PAY_AGENT_ID = "tradepulse-pay";
export const PAY_AGENT_NAME = "TradePulse pay agent";
export const BUILT_IN_AGENT_IDS: readonly AgBuiltInAgentId[] = ["lead", "data", "page", "planning", "widget"];

const PAY_AGENT_PREAMBLE = `## TradePulse payments
You are the ${PAY_AGENT_NAME} for a construction general contractor. You answer questions about
subcontract payments (retainage held, amounts paid, billed, funded, contract balance) and build
dashboard views of them.

Rules for payment questions:
1. Always call get_payment_ledger first, filtered by the subcontractor or agreement the user names.
2. Quote dollar figures exactly as the tool returns them. Never compute, round, estimate or invent an
   amount; if a figure is not in the tool output, say so.
3. Say the figure comes from the TradePulse payment ledger.
4. You cannot approve, fund, capture or pay anything. Point the user to the Payments workspace for that.

For dashboard changes (charts, tables, KPIs, filters) follow the orchestration rules below and
delegate to the built-in agents with delegate_to. You may also delegate to 'lead' for a whole
dashboard build.

`;

/** The custom agent: AG's lead orchestrator extended with a Convex-backed ledger tool. */
export function payAgentDefinition(lead: AgAnyAiAgentDefinition, loadPaySummary: () => Promise<PaySummary>): AgAnyAiAgentDefinition {
  return {
    ...lead,
    id: PAY_AGENT_ID,
    name: PAY_AGENT_NAME,
    description: "Answers TradePulse payment and retainage questions from the Convex ledger and delegates dashboard work to AG's agents.",
    instructions: (ctx, params) => PAY_AGENT_PREAMBLE + (lead.instructions?.(ctx, params) ?? ""),
    tools: (ctx, params) => [
      ctx.api.defineAiTool({
        name: "get_payment_ledger",
        description:
          "Live TradePulse payment ledger from Convex: per agreement, retainage held and released, net paid, billed, funded, captured, contract sum and balance, already formatted in dollars. Optionally filter by subcontractor name, agreement number, trade or project.",
        params: (s) =>
          s.object({
            query: s.string({ description: "Subcontractor name, agreement number, trade or project to filter by. Omit for all agreements." }).optional(),
          }),
        execute: async (args, toolCtx) => {
          try {
            return toolCtx.success(describePaySummary(await loadPaySummary(), args.query));
          } catch (err) {
            return toolCtx.error(`Could not load the payment ledger: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      }),
      ...(lead.tools?.(ctx, params) ?? []).filter((t) => t.name !== "delegate_to"),
      ctx.tools.delegateTo(BUILT_IN_AGENT_IDS),
    ],
  };
}

/**
 * Studio's harness: the TradePulse pay agent as the user-facing primary, plus AG's five built-in
 * agents as delegates. Every agent runs Studio's own loop against the Convex /ai/studio proxy.
 */
export function createTradePulseHarness(
  { api }: AgAiHarnessSetupParams,
  deps: { adapter: AgLlmAdapter; loadPaySummary: () => Promise<PaySummary> },
): AgAiHarness {
  return createAiHarness(api, ({ builtIn }) => ({
    agents: [
      directLlmRunner({ ...payAgentDefinition(builtIn.lead, deps.loadPaySummary), adapter: deps.adapter }),
      ...BUILT_IN_AGENT_IDS.map((id) => directLlmRunner({ ...builtIn[id], adapter: deps.adapter })),
    ],
    primary: PAY_AGENT_ID,
    promptStarters: [
      { label: "Retainage held", prompt: "How much retainage is held for each subcontractor?" },
      { label: "Net paid chart", prompt: "Add a bar chart of net paid by subcontractor" },
    ],
  }));
}
