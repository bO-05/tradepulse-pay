import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  CUSTOM_TOOL_NAMES,
  READ_ONLY_TOOLKIT_ACTIONS,
  READ_ONLY_TOOLKIT_TOOLS,
  createProposeTools,
  scrubSecrets,
  wrapToolkitTools,
  type LicenseToolResult,
  type ToolCallRecord,
  type ToolkitTool,
} from "./tools";

const LICENSE: LicenseToolResult = {
  checkId: "check-1",
  contractorName: "Rosendin Electric, Inc.",
  licenseNumber: "142881",
  status: "active",
  checkedAt: 1_760_000_000_000,
  rawSummary: "This license is current and active.",
  cached: false,
};

// The tool `execute` signature needs an options argument; these tests call it directly.
const opts = { toolCallId: "t1", messages: [] } as never;

describe("propose-only custom tools", () => {
  test("the custom tool map is exactly checkLicense and the four propose tools", () => {
    const tools = createProposeTools({ checkLicense: vi.fn(), insertProposal: vi.fn() }, () => {});
    expect(Object.keys(tools).sort()).toEqual([...CUSTOM_TOOL_NAMES].sort());
  });

  test("each propose tool only inserts a pending proposal; payout and hold run the license check first", async () => {
    const checkLicense = vi.fn(async () => LICENSE);
    const insertProposal = vi.fn(async (i: { kind: string }) => ({
      ok: true as const,
      proposalId: `p-${i.kind}`,
      kind: i.kind,
      amountCents: 1000,
      flags: [],
      duplicate: false,
    }));
    const calls: ToolCallRecord[] = [];
    const tools = createProposeTools({ checkLicense, insertProposal }, (r) => calls.push(r));

    const out = await tools.proposePayout.execute!({ rationale: "Pay the approved amount." }, opts);
    expect(checkLicense).toHaveBeenCalledTimes(1);
    expect(insertProposal).toHaveBeenCalledWith({ kind: "payout", rationale: "Pay the approved amount.", licenseCheckId: "check-1" });
    expect(out).toMatchObject({ ok: true, status: "pending", note: expect.stringMatching(/No money moved/) });

    for (const name of ["proposeCapture", "proposeReschedule", "proposeHold"] as const) {
      await tools[name].execute!({ rationale: "r" }, opts);
    }
    await tools.checkLicense.execute!({ contractorName: "Rosendin", licenseNumber: "142881" }, opts);
    // One license check per run, reused by every tool.
    expect(checkLicense).toHaveBeenCalledTimes(1);
    expect(insertProposal.mock.calls.map((c) => c[0].kind)).toEqual(["payout", "capture", "reschedule", "hold"]);
    expect(calls.map((c) => c.tool)).toEqual(["checkLicense", "proposePayout", "proposeCapture", "proposeReschedule", "proposeHold", "checkLicense"]);
    // The check proposePayout triggered is recorded with its input and resulting status.
    expect(calls[0]).toMatchObject({
      source: "model",
      input: { contractorName: "Rosendin Electric, Inc.", licenseNumber: "142881", triggeredBy: "proposePayout" },
    });
    expect(JSON.parse(calls[0].output)).toMatchObject({ status: "active", licenseNumber: "142881" });
  });

  test("an explicit checkLicense first is recorded once and not repeated by later payout or hold", async () => {
    const checkLicense = vi.fn(async () => LICENSE);
    const insertProposal = vi.fn(async (i: { kind: string }) => ({ ok: true as const, proposalId: `p-${i.kind}`, kind: i.kind, flags: [], duplicate: false }));
    const calls: ToolCallRecord[] = [];
    const tools = createProposeTools({ checkLicense, insertProposal }, (r) => calls.push(r));
    await tools.checkLicense.execute!({ contractorName: "Rosendin", licenseNumber: "142881" }, opts);
    await tools.proposePayout.execute!({ rationale: "r" }, opts);
    await tools.proposeHold.execute!({ rationale: "r" }, opts);
    expect(checkLicense).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.tool)).toEqual(["checkLicense", "proposePayout", "proposeHold"]);
    expect(calls[0].input).toEqual({ contractorName: "Rosendin", licenseNumber: "142881" });
  });

  test("tools.ts and proposalDb.ts never reach a money-moving function", () => {
    const src = ["./tools.ts", "./proposalDb.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
    for (const banned of ["captureApproved", "payoutSub", "startRelease", "releaseAndPay", "voidRemainder", "\"payments\", {", "retainageLedger\", {"]) {
      expect(src).not.toContain(banned);
    }
    const db = readFileSync(new URL("./proposalDb.ts", import.meta.url), "utf8");
    const inserts = [...db.matchAll(/ctx\.db\.insert\("(\w+)"/g)].map((m) => m[1]);
    expect(new Set(inserts)).toEqual(new Set(["agentProposals", "auditLogs", "agentTraces"]));
  });
});

describe("read-only PayPal toolkit wrapping", () => {
  test("only list/get invoice, get order and list transactions survive, wrapped with inputSchema", async () => {
    const t = (name: string): ToolkitTool => ({
      description: name,
      parameters: z.object({ id: z.string().optional() }),
      execute: vi.fn(async () => JSON.stringify({ name })),
    });
    const raw = Object.fromEntries(
      ["list_invoices", "get_invoice", "get_order", "list_transactions", "create_invoice", "send_invoice", "pay_order", "create_order", "create_refund", "cancel_sent_invoice"].map(
        (n) => [n, t(n)],
      ),
    );
    const calls: ToolCallRecord[] = [];
    const wrapped = wrapToolkitTools(raw, (r) => calls.push(r));
    expect(Object.keys(wrapped).sort()).toEqual([...READ_ONLY_TOOLKIT_TOOLS].sort());
    expect(wrapped.get_order.inputSchema).toBeDefined();
    const out = await wrapped.get_order.execute!({ id: "ORDER-1" }, opts);
    expect(out).toBe(JSON.stringify({ name: "get_order" }));
    expect(calls[0]).toMatchObject({ tool: "get_order", input: { id: "ORDER-1" } });
  });

  test("the toolkit configuration enables no write actions", () => {
    expect(READ_ONLY_TOOLKIT_ACTIONS).toEqual({
      invoices: { list: true, get: true },
      orders: { get: true },
      transactions: { list: true },
    });
  });
});

describe("scrubSecrets", () => {
  test("removes configured secrets and known token prefixes", () => {
    const text = "key sk-ant-api03-abc token A21AAxyz.123 kernel sk_live_12345678 Bearer abc.def value s3cr3t-value";
    const out = scrubSecrets(text, ["s3cr3t-value"]);
    for (const s of ["sk-ant-", "A21AA", "sk_live", "abc.def", "s3cr3t-value"]) expect(out).not.toContain(s);
  });
});
