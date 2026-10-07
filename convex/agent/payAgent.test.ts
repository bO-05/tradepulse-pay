/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { agentIdProfile, syncAgentProfile } from "../lib/agentAccess";
import { signInAs } from "../lib/testIdentity";
import { clearPayPalTokenCache } from "../payments/paypalClient";
import { CSLB_FIXTURES } from "../kernel/cslbFixtures";
import { ANTHROPIC_KEY_PREFIX, CUSTOM_TOOL_NAMES, READ_ONLY_TOOLKIT_TOOLS } from "./tools";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: generateTextMock };
});

const kernelMock = vi.hoisted(() => ({ create: vi.fn(), execute: vi.fn(), deleteByID: vi.fn() }));
vi.mock("@onkernel/sdk", () => ({
  default: class {
    browsers = { create: kernelMock.create, deleteByID: kernelMock.deleteByID, playwright: { execute: kernelMock.execute } };
  },
}));
const KERNEL_FAKE_KEY = "kernel-agent-test-key-not-real";

const modules = import.meta.glob("/convex/**/*.ts");
const SUB_EMAIL = "sub1-sandbox@paypal.test";
const AGENT_EMAIL = "boldlevel182@agentmail.to";

type Call = { method: string; path: string; body: unknown };

/** Minimal PayPal sandbox: token, authorization capture and payouts. */
function fakePayPal() {
  const calls: Call[] = [];
  let n = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21AAfaketoken", expires_in: 32400 });
    const text = req.method === "GET" ? "" : await req.text();
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: url.pathname, body });
    if (req.method === "POST" && /\/v2\/payments\/authorizations\/[^/]+\/capture$/.test(url.pathname)) {
      return json(201, { id: `CAP-${++n}`, status: "COMPLETED", amount: body.amount, final_capture: body.final_capture });
    }
    if (req.method === "POST" && url.pathname === "/v1/payments/payouts") {
      return json(201, { batch_header: { payout_batch_id: `BATCH-${++n}`, batch_status: "PENDING" } });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  });
  const moneyCalls = () => calls.filter((c) => c.method === "POST" && /capture|payouts|void|refund/.test(c.path));
  return { fetchImpl, calls, moneyCalls };
}

let fake: ReturnType<typeof fakePayPal>;

beforeEach(() => {
  vi.useFakeTimers();
  generateTextMock.mockReset();
  kernelMock.create.mockReset();
  kernelMock.execute.mockReset();
  kernelMock.deleteByID.mockReset();
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret-value");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  fake = fakePayPal();
  vi.stubGlobal("fetch", fake.fetchImpl);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearPayPalTokenCache();
});

async function setup(opts: { license?: "active" | "expired" | null; funded?: boolean } = {}) {
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
  const { sov, milestones } = await t.run(async (ctx) => {
    const milestones = await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
      .collect();
    await ctx.db.patch(milestones[0]._id, { status: "complete" });
    await ctx.db.patch(milestones[1]._id, { status: "in_progress" });
    const sov = await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id))
      .collect();
    return { sov, milestones };
  });
  if (opts.funded !== false) {
    await t.run(async (ctx) => {
      await ctx.db.patch(milestones[2]._id, { status: "funded" });
      await ctx.db.insert("payments", {
        agreementId: agreement._id,
        milestoneId: milestones[2]._id,
        kind: "funding",
        status: "authorized",
        paypalOrderId: "ORDER-1",
        paypalAuthorizationId: "AUTH-1",
        authorizationExpiresAt: Date.now() + 29 * 86_400_000,
        honorPeriodEndsAt: Date.now() + 3 * 86_400_000,
        grossCents: 900_000_000,
        retainageCents: 0,
        netCents: 900_000_000,
        idempotencyKey: `fund_${milestones[2]._id}_1`,
        createdAt: Date.now(),
      });
    });
  }
  if (opts.license !== null) {
    await t.run(async (ctx) =>
      ctx.db.insert("licenseChecks", {
        contractorId: agreement.contractorId,
        licenseNumber: "142881",
        state: "CA",
        status: opts.license ?? "active",
        rawSummary: opts.license === "expired" ? "This license is expired." : "This license is current and active.",
        checkedAt: Date.now(),
      }),
    );
  }
  const sub1 = await signInAs(t, "sub", { email: "sub1@test.tradepulse", contractorId: agreement.contractorId, paypalEmail: SUB_EMAIL });
  const owner = await signInAs(t, "owner", { email: "owner@test.tradepulse" });
  return { t, gc, sub1, owner, agreement, sov, milestones };
}
type Setup = Awaited<ReturnType<typeof setup>>;

function overbilledArgs(s: Setup) {
  const [a, b] = s.sov;
  return {
    agreementId: s.agreement._id,
    periodLabel: "Pay app #1 (agent test)",
    lines: [
      { sovLineId: a._id, pctCompleteThisPeriod: 20, pctCompleteToDate: 20, requestedCents: Math.round(a.scheduledValueCents * 0.2) },
      { sovLineId: b._id, pctCompleteThisPeriod: 60, pctCompleteToDate: 60, requestedCents: Math.round(b.scheduledValueCents * 0.6) },
    ],
    notes: "",
    lienWaiver: true,
  };
}

async function submitAndRun(s: Setup, as: Setup["sub1"]["as"] = s.sub1.as) {
  const payAppId: Id<"payApplications"> = await as.mutation(api.payApps.submit.submitPayApplication, overbilledArgs(s));
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  return payAppId;
}

async function state(s: Setup, payAppId: Id<"payApplications">) {
  const st = await s.t.run(async (ctx) => {
    const payApp = (await ctx.db.get(payAppId))!;
    const proposals = await ctx.db
      .query("agentProposals")
      .withIndex("by_payAppId", (q) => q.eq("payAppId", payAppId))
      .collect();
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_agreementId", (q) => q.eq("agreementId", s.agreement._id))
      .collect();
    const ledger = await ctx.db.query("retainageLedger").collect();
    const traces = (await ctx.db.query("agentTraces").collect()).filter((r) => r.caseId === payAppId);
    const audits = await ctx.db.query("auditLogs").collect();
    const live = proposals.filter((p) => p.status !== "cancelled");
    return { payApp, proposals: live, payouts: payments.filter((p) => p.kind === "payout"), payments, ledger, traces, audits };
  });
  return { ...st, byKind: (k: string) => st.proposals.find((p) => p.kind === k) };
}

async function errorText(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const data = (e as { data?: { message?: string } }).data;
    return data?.message ?? String(e);
  }
  throw new Error("expected the call to fail");
}

describe("pay agent run", () => {
  test("offline run: pending capture and payout of the code-computed amount, no money moved, trace with checkLicense", async () => {
    const s = await setup();
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    expect(st.payApp.status).toBe("reviewed");
    const approved = st.payApp.review!.approvedTotalCents;
    expect(approved).toBeGreaterThan(0);
    expect(approved).toBeLessThan(st.payApp.requestedTotalCents);
    for (const kind of ["capture", "payout"]) {
      expect(st.byKind(kind)).toMatchObject({ status: "pending", amountCents: approved, source: "code_policy", licenseStatus: "active" });
      expect(st.byKind(kind)!.rationale.length).toBeGreaterThan(0);
      expect(st.byKind(kind)!.flags).toEqual(expect.arrayContaining(["overbilled_lines", "reduced_from_request"]));
    }
    expect(st.byKind("payout")!.flags).not.toContain("license_hold");
    expect(st.byKind("hold")).toBeUndefined();
    expect(st.payouts).toHaveLength(0);
    expect(st.ledger).toHaveLength(0);
    expect(fake.moneyCalls()).toHaveLength(0);
    expect(st.audits.filter((a) => a.eventType === "paypal_write")).toHaveLength(0);

    const trace = st.traces.find((r) => r.status.startsWith("AGENT_PROPOSED"))!;
    expect(trace).toMatchObject({ provider: "Offline rules engine", model: "none" });
    const tools = (trace.parsedOutput.toolCalls as { tool: string }[]).map((c) => c.tool);
    expect(tools[0]).toBe("checkLicense");
    expect(tools).toEqual(expect.arrayContaining(["proposeCapture", "proposePayout"]));
    expect(trace.parsedOutput.license).toMatchObject({ status: "active", licenseNumber: "142881" });
    expect(JSON.stringify(trace)).not.toMatch(new RegExp(`test-secret-value|A21AA|${ANTHROPIC_KEY_PREFIX}`));
  });

  test("Anthropic tool loop: the model sees only read-only PayPal tools and propose tools, bounded steps", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", `${ANTHROPIC_KEY_PREFIX}test-not-real`);
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
    const s = await setup();
    const [a, b] = s.sov;
    let toolNames: string[] = [];
    let bounded = false;
    generateTextMock.mockImplementation(async (opts: { tools?: Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>; stopWhen?: unknown; output?: unknown }) => {
      if (!opts.tools) {
        // The pay-app review call (structured output).
        return {
          output: {
            lines: [
              { sovLineId: a._id, verdict: "ok", recommendedPctToDate: 0.2, reason: "ok" },
              { sovLineId: b._id, verdict: "out_of_sequence", recommendedPctToDate: 0.3, reason: "billed ahead of its milestone" },
            ],
            lienWaiverMissing: false,
            licenseIssue: false,
            notes: "",
          },
          usage: { inputTokens: 10, outputTokens: 10 },
          response: { modelId: "claude-sonnet-5-5" },
        };
      }
      toolNames = Object.keys(opts.tools);
      bounded = typeof opts.stopWhen === "function" || Array.isArray(opts.stopWhen);
      const o = { toolCallId: "x", messages: [] };
      await opts.tools.checkLicense.execute({ contractorName: "Rosendin Electric, Inc.", licenseNumber: "142881" }, o);
      await opts.tools.proposePayout.execute({ rationale: "Pay the reviewed amount." }, o);
      await opts.tools.proposeReschedule.execute({ rationale: "Line 2 billed ahead of its milestone." }, o);
      return { text: "Proposed payout and reschedule.", steps: [{}, {}, {}], totalUsage: { inputTokens: 900, outputTokens: 120 }, response: { modelId: "claude-sonnet-5-5" } };
    });
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);

    expect(bounded).toBe(true);
    const allowed = new Set<string>([...READ_ONLY_TOOLKIT_TOOLS, ...CUSTOM_TOOL_NAMES]);
    expect(toolNames.filter((n) => !allowed.has(n))).toEqual([]);
    expect(toolNames).toEqual(expect.arrayContaining([...CUSTOM_TOOL_NAMES]));

    expect(st.byKind("payout")).toMatchObject({ source: "agent", status: "pending", amountCents: st.payApp.review!.approvedTotalCents });
    expect(st.byKind("reschedule")).toMatchObject({ source: "agent", status: "pending" });
    // The model skipped proposeCapture; the code policy filled it in and labeled it.
    expect(st.byKind("capture")).toMatchObject({ source: "code_policy" });
    const trace = st.traces.find((r) => r.status === "AGENT_PROPOSED")!;
    expect(trace).toMatchObject({ provider: "Anthropic", model: "claude-sonnet-5-5", inputTokens: 900, outputTokens: 120 });
    const calls = trace.parsedOutput.toolCalls as { tool: string; source: string; input: string; output: string }[];
    const check = calls.find((c) => c.tool === "checkLicense")!;
    expect(check).toMatchObject({ source: "model" });
    expect(check.input).toContain("142881");
    expect(check.output).toContain('"status":"active"');
    expect(JSON.stringify(trace)).not.toMatch(new RegExp(`${ANTHROPIC_KEY_PREFIX}|A21AA|test-secret-value`));
    expect(fake.moneyCalls()).toHaveLength(0);
  });

  test("a payout proposed before checkLicense still records one checkLicense entry with input and status, and KERNEL runs once", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", `${ANTHROPIC_KEY_PREFIX}test-not-real`);
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
    vi.stubEnv("KERNEL_API_KEY", KERNEL_FAKE_KEY);
    kernelMock.create.mockResolvedValue({ session_id: "sess_agent", browser_live_view_url: "https://live.kernel.test/v" });
    kernelMock.execute.mockResolvedValue({ success: true, result: CSLB_FIXTURES["142881"] });
    kernelMock.deleteByID.mockResolvedValue(undefined);
    const s = await setup({ license: null });
    await s.t.run(async (ctx) => ctx.db.patch(s.agreement.contractorId, { licenseNumber: "142881" }));
    const [a, b] = s.sov;
    generateTextMock.mockImplementation(async (opts: { tools?: Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }> }) => {
      if (!opts.tools) {
        return {
          output: {
            lines: [
              { sovLineId: a._id, verdict: "ok", recommendedPctToDate: 0.2, reason: "ok" },
              { sovLineId: b._id, verdict: "ok", recommendedPctToDate: 0.6, reason: "ok" },
            ],
            lienWaiverMissing: false,
            licenseIssue: false,
            notes: "",
          },
          usage: { inputTokens: 10, outputTokens: 10 },
          response: { modelId: "claude-sonnet-5-5" },
        };
      }
      const o = { toolCallId: "x", messages: [] };
      await opts.tools.proposePayout.execute({ rationale: "Pay the reviewed amount." }, o);
      await opts.tools.proposeHold.execute({ rationale: "Hold for review." }, o);
      await opts.tools.checkLicense.execute({ contractorName: "Rosendin Electric, Inc.", licenseNumber: "142881" }, o);
      return { text: "done", steps: [{}, {}], totalUsage: { inputTokens: 50, outputTokens: 5 }, response: { modelId: "claude-sonnet-5-5" } };
    });
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);

    expect(kernelMock.create).toHaveBeenCalledTimes(1);
    expect(kernelMock.deleteByID).toHaveBeenCalledWith("sess_agent");
    const trace = st.traces.find((r) => r.status.startsWith("AGENT_PROPOSED"))!;
    const calls = trace.parsedOutput.toolCalls as { tool: string; source: string; input: string; output: string }[];
    expect(calls.map((c) => c.tool).slice(0, 2)).toEqual(["checkLicense", "proposePayout"]);
    const implicit = calls[0];
    expect(implicit.source).toBe("model");
    expect(JSON.parse(implicit.input)).toMatchObject({ contractorName: "Rosendin Electric, Inc.", licenseNumber: "142881", triggeredBy: "proposePayout" });
    expect(JSON.parse(implicit.output)).toMatchObject({ status: "active", licenseNumber: "142881", cached: false });
    // The model's later explicit call reuses the run's result and is recorded as its own call.
    expect(calls.filter((c) => c.tool === "checkLicense")).toHaveLength(2);
    expect(trace.parsedOutput.license).toMatchObject({ status: "active", licenseNumber: "142881" });
    expect(JSON.stringify(trace)).not.toMatch(new RegExp(`${ANTHROPIC_KEY_PREFIX}|A21AA|test-secret-value`));
    expect(JSON.stringify(trace)).not.toContain(KERNEL_FAKE_KEY);
  });

  test("an expired license holds the payout: flagged, hold proposal, review licenseIssue, approval refused without override", async () => {
    const s = await setup({ license: "expired" });
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    expect(st.payApp.review!.flags).toMatchObject({ licenseIssue: true, licenseStatus: "expired" });
    expect(st.byKind("payout")!.flags).toEqual(expect.arrayContaining(["license_hold", "license_expired"]));
    expect(st.byKind("payout")!.rationale).toMatch(/^Held: the license is expired/);
    expect(st.byKind("hold")).toMatchObject({ status: "pending", licenseStatus: "expired" });
    expect(await errorText(s.gc.as.mutation(api.payApps.proposals.approveProposal, { proposalId: st.byKind("payout")!._id }))).toMatch(
      /held because the contractor's license is expired/,
    );
    const after = await state(s, payAppId);
    expect(after.byKind("payout")!.status).toBe("pending");
    expect(after.payouts).toHaveLength(0);
    expect(fake.moneyCalls()).toHaveLength(0);
  });
});

describe("GC approval inbox", () => {
  test("only the GC can approve, edit or reject; sub, billing agent and owner are refused and nothing changes", async () => {
    const s = await setup();
    await s.gc.as.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: s.agreement.contractorId });
    const agentUserId = await s.t.run(async (ctx) => {
      const { id, ...fields } = agentIdProfile({
        sub: "agent-sub-1",
        email: AGENT_EMAIL,
        name: "Billing Agent",
        owner_sub: "owner-sub-1",
        owner_name: "Pat Owner",
        owner_email: "pat@example.com",
      });
      const userId = await ctx.db.insert("users", fields);
      await syncAgentProfile(ctx, userId, { duringAgentIdSignIn: true });
      await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: id });
      return userId;
    });
    const agent = s.t.withIdentity({ subject: `${agentUserId}|agent-session`, email: AGENT_EMAIL });
    const payAppId = await submitAndRun(s, agent);
    const before = await state(s, payAppId);
    const payout = before.byKind("payout")!;

    for (const caller of [s.sub1.as, agent, s.owner.as]) {
      for (const call of [
        caller.mutation(api.payApps.proposals.approveProposal, { proposalId: payout._id }),
        caller.mutation(api.payApps.proposals.editProposal, { proposalId: payout._id, amountCents: 100 }),
        caller.mutation(api.payApps.proposals.rejectProposal, { proposalId: payout._id }),
        caller.mutation(api.payApps.proposals.rejectPayApp, { payAppId }),
        caller.query(api.payApps.proposals.listInbox, {}),
      ]) {
        expect(await errorText(call)).toMatch(/Forbidden/);
      }
    }
    const after = await state(s, payAppId);
    expect(after.proposals.map((p) => [p._id, p.status, p.editedAmountCents])).toEqual(before.proposals.map((p) => [p._id, p.status, p.editedAmountCents]));
    expect(after.payApp.status).toBe("reviewed");
    expect(after.payouts).toHaveLength(0);

    // Pay-agent audit entries for an agent-submitted pay app carry the billing agent and its owner.
    const agentAudits = after.audits.filter((a) => a.eventType === "agent_proposal_created" || a.eventType === "pay_agent_run");
    expect(agentAudits.length).toBeGreaterThan(0);
    for (const a of agentAudits) expect(a).toMatchObject({ agentSub: "agent-sub-1", agentEmail: AGENT_EMAIL, ownerEmail: "pat@example.com" });

    const inbox = await s.gc.as.query(api.payApps.proposals.listInbox, {});
    expect(inbox[0].payApp.submittedBy).toMatchObject({ actorType: "agent", agentEmail: AGENT_EMAIL, onBehalfOf: "Pat Owner" });
  });

  test("edit validation, then approval executes capture + payout of the edited amount with retainage", async () => {
    const s = await setup();
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    const payout = st.byKind("payout")!;
    const original = payout.amountCents!;

    expect(await errorText(s.gc.as.mutation(api.payApps.proposals.editProposal, { proposalId: payout._id, amountCents: -500 }))).toMatch(/negative/);
    expect(
      await errorText(s.gc.as.mutation(api.payApps.proposals.editProposal, { proposalId: payout._id, amountCents: st.payApp.requestedTotalCents + 1 })),
    ).toMatch(/cannot exceed/);
    await s.gc.as.mutation(api.payApps.proposals.editProposal, { proposalId: payout._id, amountCents: 123_456 });

    await s.gc.as.mutation(api.payApps.proposals.approveProposal, { proposalId: payout._id });
    const mid = await state(s, payAppId);
    expect(mid.byKind("payout")).toMatchObject({ status: "approved", decidedBy: s.gc.userId });
    expect(mid.payApp.status).toBe("approved");
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);

    const end = await state(s, payAppId);
    const capture = fake.calls.find((c) => c.method === "POST" && c.path.endsWith("/capture"))!;
    expect(capture.body).toEqual({ amount: { currency_code: "USD", value: "1234.56" }, final_capture: false });
    const payoutCall = fake.calls.find((c) => c.method === "POST" && c.path === "/v1/payments/payouts")!;
    const item = (payoutCall.body as { items: { receiver: string; amount: { value: string } }[] }).items[0];
    expect(item).toMatchObject({ receiver: SUB_EMAIL, amount: { value: "1111.10" } });

    expect(end.payouts).toHaveLength(1);
    expect(end.payouts[0]).toMatchObject({ grossCents: 123_456, retainageCents: 12_346, netCents: 111_110, proposalId: payout._id, payAppId });
    expect(end.payouts[0].paypalPayoutBatchId).toMatch(/^BATCH-/);
    expect(end.ledger.map((l) => l.deltaCents)).toEqual([12_346]);
    expect(end.byKind("payout")).toMatchObject({ status: "executed", amountCents: original, editedAmountCents: 123_456, decidedBy: s.gc.userId });
    expect(end.byKind("capture")).toMatchObject({ status: "executed", paypalCaptureId: "CAP-1", decidedBy: s.gc.userId });
    expect(end.byKind("payout")!.decidedAt).toBeGreaterThan(0);

    const portal = await s.sub1.as.query(api.portal.mySubPayApps, { paginationOpts: { numItems: 50, cursor: null } });
    expect(portal.page[0].outcome).toMatchObject({ approvedGrossCents: 123_456, retainageHeldCents: 12_346, netCents: 111_110 });
  });

  test("approval with no funded milestone is refused with a visible reason and moves nothing", async () => {
    const s = await setup({ funded: false });
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    expect(st.byKind("capture")!.flags).toContain("milestone_not_funded");
    expect(await errorText(s.gc.as.mutation(api.payApps.proposals.approveProposal, { proposalId: st.byKind("payout")!._id }))).toMatch(
      /No funded milestone/,
    );
    expect((await state(s, payAppId)).byKind("payout")!.status).toBe("pending");
  });

  test("rejecting the pay app rejects its proposals, moves nothing, refuses re-approval and the sub sees it", async () => {
    const s = await setup();
    const payAppId = await submitAndRun(s);
    await s.gc.as.mutation(api.payApps.proposals.rejectPayApp, { payAppId });
    const st = await state(s, payAppId);
    expect(st.payApp.status).toBe("rejected");
    for (const p of st.proposals) expect(p).toMatchObject({ status: "rejected", decidedBy: s.gc.userId });
    expect(await errorText(s.gc.as.mutation(api.payApps.proposals.approveProposal, { proposalId: st.byKind("payout")!._id }))).toMatch(
      /rejected; it can no longer be approved/,
    );
    expect(st.payouts).toHaveLength(0);
    expect(st.ledger).toHaveLength(0);
    expect(fake.moneyCalls()).toHaveLength(0);
    const portal = await s.sub1.as.query(api.portal.mySubPayApps, { paginationOpts: { numItems: 50, cursor: null } });
    expect(portal.page[0]).toMatchObject({ status: "rejected" });
  });

  test("the ledger Release & pay runs through a GC-approved proposal", async () => {
    const s = await setup();
    const funding = (await s.t.run(async (ctx) => ctx.db.query("payments").collect())).find((p: Doc<"payments">) => p.kind === "funding")!;
    await s.gc.as.action(api.payments.release.releaseAndPay, { milestoneId: funding.milestoneId!, amountCents: 50_000, requestKey: "ledger-key-1" });
    const rows = await s.t.run(async (ctx) => ({
      proposals: await ctx.db.query("agentProposals").collect(),
      payouts: (await ctx.db.query("payments").collect()).filter((p) => p.kind === "payout"),
    }));
    expect(rows.payouts).toHaveLength(1);
    const proposal = rows.proposals.find((p) => p._id === rows.payouts[0].proposalId)!;
    expect(proposal).toMatchObject({ source: "gc_ledger", kind: "payout", status: "executed", decidedBy: s.gc.userId, amountCents: 50_000 });
  });
});

/** A follow-up pay app billing `cents` on SOV line b only. */
function lineBArgs(s: Setup, cents: number) {
  return {
    agreementId: s.agreement._id,
    periodLabel: `Follow-up ${cents}`,
    lines: [{ sovLineId: s.sov[1]._id, pctCompleteThisPeriod: 1, pctCompleteToDate: 100, requestedCents: cents }],
    notes: "",
    lienWaiver: true,
  };
}

describe("final approved allocation", () => {
  test("a downward edit stores the final per-line split, keeps the recommendation, and frees the difference for later billing", async () => {
    const s = await setup();
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    const recommended = st.payApp.review!.lines.map((l) => ({ sovLineId: l.sovLineId, approvedCents: l.approvedCents }));
    const recommendedB = recommended.find((l) => l.sovLineId === s.sov[1]._id)!.approvedCents;
    const edited = Math.floor(st.payApp.review!.approvedTotalCents / 2) + 1;
    await s.gc.as.mutation(api.payApps.proposals.editProposal, { proposalId: st.byKind("payout")!._id, amountCents: edited });
    await s.gc.as.mutation(api.payApps.proposals.approveProposal, { proposalId: st.byKind("payout")!._id });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);

    const after = await state(s, payAppId);
    const final = after.payApp.finalApproval!;
    expect(final).toMatchObject({ totalCents: edited, approvedBy: s.gc.userId });
    expect(final.lines.reduce((a, l) => a + l.approvedCents, 0)).toBe(edited);
    for (const l of final.lines) expect(Number.isSafeInteger(l.approvedCents)).toBe(true);
    // The AI review's recommendation stays for audit.
    expect(after.payApp.review!.lines.map((l) => ({ sovLineId: l.sovLineId, approvedCents: l.approvedCents }))).toEqual(recommended);
    const finalB = final.lines.find((l) => l.sovLineId === s.sov[1]._id)!.approvedCents;
    expect(finalB).toBeLessThan(recommendedB);
    expect(after.payouts[0]).toMatchObject({ grossCents: edited });

    const inbox = await s.gc.as.query(api.payApps.proposals.listInbox, {});
    const view = inbox.find((i) => i.payApp._id === payAppId)!.payApp;
    expect(view.finalApproval).toMatchObject({ totalCents: edited });
    const viewB = view.lines.find((l) => l.sovLineId === s.sov[1]._id)!;
    expect(viewB).toMatchObject({ finalApprovedCents: finalB, review: expect.objectContaining({ approvedCents: recommendedB }) });

    const trueRemaining = s.sov[1].scheduledValueCents - finalB;
    expect(await errorText(s.sub1.as.mutation(api.payApps.submit.submitPayApplication, lineBArgs(s, trueRemaining + 1)))).toMatch(
      /exceeds the remaining scheduled value/,
    );
    const nextId = await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, lineBArgs(s, trueRemaining));
    expect(nextId).toBeTruthy();
    // The next review sees the final approved cents as previously billed.
    const inputs = await s.t.query(internal.payApps.review.loadReviewInputs, { payAppId: nextId });
    const reviewB = inputs!.context.lines.find((l) => l.sovLineId === s.sov[1]._id)!;
    expect(reviewB.previouslyBilledCents).toBe(finalB);
    expect(inputs!.context.priorPayApps.find((p) => p.periodLabel === st.payApp.periodLabel)!.approvedTotalCents).toBe(edited);

    const ledger = await s.gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: s.agreement._id });
    expect(ledger!.totals.billedCents).toBe(edited);
  });

  test("an upward edit bills the edited per-line cents, so a later application cannot overbill", async () => {
    const s = await setup();
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    const requestedB = st.payApp.lines.find((l) => l.sovLineId === s.sov[1]._id)!.requestedCents;
    const recommendedB = st.payApp.review!.lines.find((l) => l.sovLineId === s.sov[1]._id)!.approvedCents;
    expect(recommendedB).toBeLessThan(requestedB);
    await s.gc.as.mutation(api.payApps.proposals.editProposal, { proposalId: st.byKind("payout")!._id, amountCents: st.payApp.requestedTotalCents });
    await s.gc.as.mutation(api.payApps.proposals.approveProposal, { proposalId: st.byKind("payout")!._id });

    const after = await state(s, payAppId);
    expect(after.payApp.finalApproval!.lines.find((l) => l.sovLineId === s.sov[1]._id)!.approvedCents).toBe(requestedB);
    const trueRemaining = s.sov[1].scheduledValueCents - requestedB;
    expect(await errorText(s.sub1.as.mutation(api.payApps.submit.submitPayApplication, lineBArgs(s, trueRemaining + 1)))).toMatch(
      /exceeds the remaining scheduled value/,
    );
    await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, lineBArgs(s, trueRemaining));
  });

  test("an edit beyond what the lines can still bill is refused", async () => {
    const s = await setup();
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    // Another approved pay app already billed most of line b, leaving less than this one requested.
    await s.t.run(async (ctx) => {
      await ctx.db.insert("payApplications", {
        agreementId: s.agreement._id,
        subUserId: s.sub1.userId,
        periodLabel: "Earlier approved",
        lines: [{ sovLineId: s.sov[1]._id, pctCompleteThisPeriod: 30, pctCompleteToDate: 30, requestedCents: 1 }],
        requestedTotalCents: 1,
        notes: "",
        lienWaiver: true,
        status: "approved",
        submittedBy: { userId: s.sub1.userId, actorType: "human" },
        finalApproval: {
          totalCents: s.sov[1].scheduledValueCents - 100,
          lines: [{ sovLineId: s.sov[1]._id, approvedCents: s.sov[1].scheduledValueCents - 100 }],
          approvedBy: s.gc.userId,
          approvedAt: Date.now(),
        },
        createdAt: Date.now(),
      });
    });
    const requestedA = st.payApp.lines.find((l) => l.sovLineId === s.sov[0]._id)!.requestedCents;
    expect(
      await errorText(s.gc.as.mutation(api.payApps.proposals.editProposal, { proposalId: st.byKind("payout")!._id, amountCents: requestedA + 101 })),
    ).toMatch(/can still bill/);
    await s.gc.as.mutation(api.payApps.proposals.editProposal, { proposalId: st.byKind("payout")!._id, amountCents: requestedA + 100 });
  });
});

describe("rejection finalizes the pay app", () => {
  test("rejecting the capture/payout pair rejects the pay app, releases its billing and shows the reason to the sub", async () => {
    const s = await setup();
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    const requestedB = st.payApp.lines.find((l) => l.sovLineId === s.sov[1]._id)!.requestedCents;
    const res = await s.gc.as.mutation(api.payApps.proposals.rejectProposal, { proposalId: st.byKind("capture")!._id, reason: "Line 2 is not installed yet." });
    expect(res).toEqual({ rejected: 2, payAppRejected: true });
    const after = await state(s, payAppId);
    expect(after.payApp).toMatchObject({ status: "rejected", rejectionReason: "Line 2 is not installed yet." });
    expect(after.payApp.rejectedAt).toBeGreaterThan(0);
    for (const p of after.proposals) expect(p).toMatchObject({ status: "rejected", decidedBy: s.gc.userId });
    expect(after.payouts).toHaveLength(0);
    expect(fake.moneyCalls()).toHaveLength(0);

    const portal = await s.sub1.as.query(api.portal.mySubPayApps, { paginationOpts: { numItems: 50, cursor: null } });
    expect(portal.page.find((p) => p._id === payAppId)).toMatchObject({ status: "rejected", rejectionReason: "Line 2 is not installed yet." });
    // The rejected request no longer reserves line b.
    await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, lineBArgs(s, s.sov[1].scheduledValueCents));
    expect(requestedB).toBeGreaterThan(0);
  });

  test("hold path: the pay app stays reviewed while a proposal is pending, then is rejected when the last one is rejected", async () => {
    const s = await setup({ license: "expired" });
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    expect(st.byKind("hold")!.status).toBe("pending");
    const first = await s.gc.as.mutation(api.payApps.proposals.rejectProposal, { proposalId: st.byKind("payout")!._id });
    expect(first).toEqual({ rejected: 2, payAppRejected: false });
    expect((await state(s, payAppId)).payApp.status).toBe("reviewed");
    const second = await s.gc.as.mutation(api.payApps.proposals.rejectProposal, { proposalId: st.byKind("hold")!._id });
    expect(second).toEqual({ rejected: 1, payAppRejected: true });
    const after = await state(s, payAppId);
    expect(after.payApp).toMatchObject({ status: "rejected", rejectionReason: "The GC rejected the hold proposal." });
    const portal = await s.sub1.as.query(api.portal.mySubPayApps, { paginationOpts: { numItems: 50, cursor: null } });
    expect(portal.page.find((p) => p._id === payAppId)).toMatchObject({ status: "rejected", rejectionReason: "The GC rejected the hold proposal." });
    expect(fake.moneyCalls()).toHaveLength(0);
  });

  test("hold path: rejecting the hold first keeps the pay app open for the pending pair, and rejecting the pair finalizes it", async () => {
    const s = await setup({ license: "expired" });
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    expect((await s.gc.as.mutation(api.payApps.proposals.rejectProposal, { proposalId: st.byKind("hold")!._id })).payAppRejected).toBe(false);
    expect((await s.gc.as.mutation(api.payApps.proposals.rejectProposal, { proposalId: st.byKind("payout")!._id })).payAppRejected).toBe(true);
    expect((await state(s, payAppId)).payApp.status).toBe("rejected");
  });

  test("reschedule path: rejecting the pair, then accepting the reschedule, finalizes the pay app without payment", async () => {
    const s = await setup();
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    const rescheduleId = await s.t.run(async (ctx) =>
      ctx.db.insert("agentProposals", {
        payAppId,
        agreementId: s.agreement._id,
        kind: "reschedule",
        rationale: "Line 2 billed ahead of its milestone.",
        flags: [],
        status: "pending",
        source: "agent",
        agentRunId: st.byKind("payout")!.agentRunId,
        createdAt: Date.now(),
      }),
    );
    expect((await s.gc.as.mutation(api.payApps.proposals.rejectProposal, { proposalId: st.byKind("payout")!._id })).payAppRejected).toBe(false);
    await s.gc.as.mutation(api.payApps.proposals.approveProposal, { proposalId: rescheduleId });
    const after = await state(s, payAppId);
    expect(after.payApp).toMatchObject({ status: "rejected", rejectionReason: "The GC accepted the reschedule; no payment was approved." });
    expect(after.payouts).toHaveLength(0);
  });

  test("rejecting the remaining hold after the pair was approved leaves the pay app approved", async () => {
    const s = await setup({ license: "expired" });
    const payAppId = await submitAndRun(s);
    const st = await state(s, payAppId);
    await s.gc.as.mutation(api.payApps.proposals.approveProposal, { proposalId: st.byKind("payout")!._id, overrideLicenseHold: true });
    expect((await s.gc.as.mutation(api.payApps.proposals.rejectProposal, { proposalId: st.byKind("hold")!._id })).payAppRejected).toBe(false);
    expect((await state(s, payAppId)).payApp.status).toBe("approved");
  });
});
