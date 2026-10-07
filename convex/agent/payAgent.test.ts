/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { agentIdProfile, syncAgentProfile } from "../lib/agentAccess";
import { signInAs } from "../lib/testIdentity";
import { clearPayPalTokenCache } from "../payments/paypalClient";
import { CUSTOM_TOOL_NAMES, READ_ONLY_TOOLKIT_TOOLS } from "./tools";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: generateTextMock };
});

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
    expect(JSON.stringify(trace)).not.toMatch(/test-secret-value|A21AA|sk-ant-/);
  });

  test("Anthropic tool loop: the model sees only read-only PayPal tools and propose tools, bounded steps", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-not-real");
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
    expect(JSON.stringify(trace)).not.toMatch(/sk-ant-|A21AA|test-secret-value/);
    expect(fake.moneyCalls()).toHaveLength(0);
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
    for (const a of agentAudits) expect(a).toMatchObject({ agentSub: "agent-sub-1", ownerEmail: "pat@example.com" });

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

    const portal = await s.sub1.as.query(api.portal.mySubPortal, {});
    expect(portal.payApplications[0].outcome).toMatchObject({ approvedGrossCents: 123_456, retainageHeldCents: 12_346, netCents: 111_110 });
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
    const portal = await s.sub1.as.query(api.portal.mySubPortal, {});
    expect(portal.payApplications[0]).toMatchObject({ status: "rejected" });
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
