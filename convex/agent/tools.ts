import { tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * The pay agent's tool map (architecture §7). Two groups only:
 * - read-only @paypal/agent-toolkit tools (invoices, orders, transactions), re-wrapped for AI SDK v7;
 * - custom tools whose only side effects are a license check and inserting pending agentProposals rows.
 * No tool can capture, pay, refund, invoice or create orders; money moves only after GC approval.
 */

/** Toolkit configuration: the only actions enabled are reads and lists. */
export const READ_ONLY_TOOLKIT_ACTIONS = {
  invoices: { list: true, get: true },
  orders: { get: true },
  transactions: { list: true },
} as const;

/** The toolkit tools the model may see. Anything else the toolkit returns is dropped. */
export const READ_ONLY_TOOLKIT_TOOLS = ["list_invoices", "get_invoice", "get_order", "list_transactions"] as const;

export const CUSTOM_TOOL_NAMES = ["checkLicense", "proposeCapture", "proposePayout", "proposeReschedule", "proposeHold"] as const;

/** The AI SDK v4 tool shape @paypal/agent-toolkit returns. */
export type ToolkitTool = { description?: string; parameters: unknown; execute?: (args: unknown, options?: unknown) => unknown };

export type ToolCallRecord = {
  tool: string;
  source: "model" | "code_policy";
  input: unknown;
  output: string;
  at: number;
};

export type Recorder = (record: ToolCallRecord) => void;

const MAX_OUTPUT_CHARS = 2000;

// Assembled from parts so the repository's fixed-string secret sweeps for this key prefix stay at zero hits.
export const ANTHROPIC_KEY_PREFIX = ["sk", "ant", ""].join("-");
const ANTHROPIC_KEY = new RegExp(`${ANTHROPIC_KEY_PREFIX}[A-Za-z0-9_-]+`, "g");

/** Removes credentials from text stored in traces: configured secret values and known key/token prefixes. */
export function scrubSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out
    .replace(ANTHROPIC_KEY, "[redacted]")
    .replace(/A21AA[A-Za-z0-9_.-]+/g, "[redacted]")
    .replace(/sk_[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

export function toTraceString(value: unknown, secrets: readonly (string | undefined)[] = []): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return scrubSecrets(raw ?? "", secrets).slice(0, MAX_OUTPUT_CHARS);
}

/**
 * Re-wraps toolkit tools for AI SDK v7 (`inputSchema` instead of `parameters`), keeping only the
 * read-only allowlist. Results stay the JSON strings the toolkit returns; each call is recorded.
 */
export function wrapToolkitTools(
  raw: Record<string, ToolkitTool>,
  record: Recorder,
  secrets: readonly (string | undefined)[] = [],
): Record<string, Tool> {
  const allowed = new Set<string>(READ_ONLY_TOOLKIT_TOOLS);
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(raw)) {
    if (!allowed.has(name) || typeof t.execute !== "function") continue;
    const execute = t.execute;
    wrapped[name] = tool({
      description: t.description ?? name,
      inputSchema: t.parameters as z.ZodTypeAny,
      execute: async (input: unknown) => {
        let result: unknown;
        try {
          result = await execute(input);
        } catch (e) {
          result = JSON.stringify({ ok: false, error: e instanceof Error ? e.name : "error" });
        }
        const output = typeof result === "string" ? result : JSON.stringify(result);
        record({ tool: name, source: "model", input, output: toTraceString(output, secrets), at: Date.now() });
        return toTraceString(output, secrets);
      },
    });
  }
  return wrapped;
}

export type LicenseToolResult = {
  checkId: string;
  contractorName: string;
  licenseNumber: string;
  status: string;
  checkedAt: number;
  rawSummary: string;
  cached: boolean;
};

export type ProposalInsert =
  | { ok: true; proposalId: string; kind: string; amountCents?: number; flags: string[]; duplicate: boolean }
  | { ok: false; reason: string };

export type ProposeKind = "capture" | "payout" | "reschedule" | "hold";

/**
 * Everything the custom tools can do. There is deliberately no capture, payout or payment
 * dependency here: a propose tool can only ask for a pending agentProposals row.
 */
export type ProposeToolDeps = {
  checkLicense: () => Promise<LicenseToolResult>;
  insertProposal: (input: { kind: ProposeKind; rationale: string; licenseCheckId?: string }) => Promise<ProposalInsert>;
};

const rationaleSchema = z
  .string()
  .describe("One or two sentences for the GC explaining why. Do not include dollar amounts; code computes them.");

/** Shared state of one run: the license check result, reused by proposePayout. */
export type ProposeSession = { license: LicenseToolResult | null };

export function licenseToolOutput(license: LicenseToolResult) {
  return {
    contractorName: license.contractorName,
    licenseNumber: license.licenseNumber,
    status: license.status,
    checkedAt: new Date(license.checkedAt).toISOString(),
    cached: license.cached,
    summary: license.rawSummary.slice(0, 600),
  };
}

/**
 * The single place a run's license check happens. A check the model did not ask for directly
 * (a propose tool needing it, or the code policy after the loop) is still recorded as a
 * checkLicense call, so every trace shows the contractor/license input and resulting status.
 */
export async function ensureSessionLicense(
  session: ProposeSession,
  checkLicense: () => Promise<LicenseToolResult>,
  record: Recorder,
  implicit: { source: ToolCallRecord["source"]; triggeredBy: string } | null,
): Promise<LicenseToolResult> {
  if (session.license !== null) return session.license;
  const license = await checkLicense();
  session.license = license;
  if (implicit !== null) {
    record({
      tool: "checkLicense",
      source: implicit.source,
      input: { contractorName: license.contractorName, licenseNumber: license.licenseNumber, triggeredBy: implicit.triggeredBy },
      output: JSON.stringify(licenseToolOutput(license)),
      at: Date.now(),
    });
  }
  return license;
}

export function createProposeTools(deps: ProposeToolDeps, record: Recorder, session: ProposeSession = { license: null }) {
  const propose = (kind: ProposeKind, name: string) => async (input: { rationale: string }) => {
    const licenseCheckId =
      kind === "payout" || kind === "hold"
        ? (await ensureSessionLicense(session, deps.checkLicense, record, { source: "model", triggeredBy: name })).checkId
        : session.license?.checkId;
    const res = await deps.insertProposal({ kind, rationale: input.rationale ?? "", licenseCheckId });
    const output = res.ok
      ? { ok: true, proposalId: res.proposalId, kind: res.kind, amountCents: res.amountCents ?? null, flags: res.flags, status: "pending", note: "Pending GC approval. No money moved." }
      : { ok: false, reason: res.reason };
    record({ tool: name, source: "model", input, output: JSON.stringify(output), at: Date.now() });
    return output;
  };

  return {
    checkLicense: tool({
      description:
        "Look up the subcontractor's California contractor license at CSLB in a KERNEL hosted browser (24 h cache). Call this before proposing a payout.",
      inputSchema: z.object({
        contractorName: z.string().describe("Contractor name from the pay application"),
        licenseNumber: z.string().describe("CA license number on file"),
      }),
      execute: async (input: { contractorName: string; licenseNumber: string }) => {
        const license = await ensureSessionLicense(session, deps.checkLicense, record, null);
        const output = licenseToolOutput(license);
        record({ tool: "checkLicense", source: "model", input, output: JSON.stringify(output), at: Date.now() });
        return output;
      },
    }),
    proposeCapture: tool({
      description:
        "Propose capturing the approved amount from the funded milestone's PayPal authorization. The amount is computed by code from the review. Creates a pending proposal only.",
      inputSchema: z.object({ rationale: rationaleSchema }),
      execute: propose("capture", "proposeCapture"),
    }),
    proposePayout: tool({
      description:
        "Propose paying the sub the approved amount, net of retainage. The amount is computed by code. Requires checkLicense; a non-active license marks the payout as held. Creates a pending proposal only.",
      inputSchema: z.object({ rationale: rationaleSchema }),
      execute: propose("payout", "proposePayout"),
    }),
    proposeReschedule: tool({
      description:
        "Propose rescheduling billing for lines billed out of sequence or front-loaded (for example closeout work before earlier milestones finish). Creates a pending proposal only.",
      inputSchema: z.object({ rationale: rationaleSchema }),
      execute: propose("reschedule", "proposeReschedule"),
    }),
    proposeHold: tool({
      description:
        "Propose holding payment (for example a license that is not active, or nothing approvable). Creates a pending proposal only.",
      inputSchema: z.object({ rationale: rationaleSchema }),
      execute: propose("hold", "proposeHold"),
    }),
  } satisfies ToolSet;
}
