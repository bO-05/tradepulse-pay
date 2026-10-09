/// <reference types="vite/client" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { Webhook } from "svix";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";
import { withSession } from "./lib/testIdentity";
import { buildRfiAnswerEmail } from "./lib/rfiAnswerEmail";
import { attributeDemoPlugs } from "./lib/demoPlugs";
import { pendingRfiMessage } from "./files";

const modules = import.meta.glob("./**/*.ts");
const WEBHOOK_SECRET = `whsec_${btoa("tradepulse-test-webhook-secret-32b")}`;
const BIDDER = "boldlevel182@agentmail.to";
const RFI_TEXT = "RFI: Is the fire alarm rough-in by electrical or the FA sub?";
const EDITED = "Fire alarm rough-in (boxes and conduit) is by electrical; devices and wiring by the FA sub per 28 31 00.";
const PROVIDER_KEYS = ["OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "VERTEX_API_KEY", "VERTEX_ACCESS_TOKEN", "GCP_PROJECT", "VERTEX_PROJECT_ID"];

type T = ReturnType<typeof convexTest>;
type Call = { url: string; body: any };

function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    const n = calls.length;
    return new Response(JSON.stringify({ message_id: `<out-${n}@ses>`, thread_id: n === 1 ? "thread-rfq-1" : `thread-out-${n}` }), { status: 200 });
  });
  return calls;
}

function signed(body: string, id: string) {
  const now = new Date();
  return {
    "svix-id": id,
    "svix-timestamp": String(Math.floor(now.getTime() / 1000)),
    "svix-signature": new Webhook(WEBHOOK_SECRET).sign(id, now, body),
    "Content-Type": "application/json",
  };
}

async function receive(t: T, m: Record<string, unknown>, eventId: string) {
  const body = JSON.stringify({ type: "event", event_type: "message.received", event_id: eventId, message: m });
  const res = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: signed(body, eventId) });
  return (await res.json()) as any;
}

async function runScheduled(t: T) {
  const saved = PROVIDER_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of PROVIDER_KEYS) delete process.env[k];
  vi.useFakeTimers();
  try {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

const outbox = (t: T) => t.run(async (ctx) => await ctx.db.query("emailOutbox").collect());
const conversations = (t: T) => t.run(async (ctx) => await ctx.db.query("conversations").collect());

/** Bayview package with an RFQ sent to the test bidder and an RFI reply routed into its thread. */
async function setupWithInboundRfi() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  await t.run(async (ctx) => {
    await ctx.db.patch(f.gcA.project.projectId, { state: "CA", location: "Oakland, CA", title: "Harbor Point Dental Office TI" });
    await ctx.db.patch(f.gcA.project.tradePackageId, { status: "draft", bidDeadline: "2026-10-30T14:00" });
    await ctx.db.patch(f.gcA.project.contractorId, { companyName: "Oakland Power & Light", contactEmail: BIDDER, rfqStatus: "discovered" });
  });
  const calls = stubFetch();
  await f.gcA.admin.as.action(api.rfqActions.dispatchRfqsWithNotification, {
    tradePackageId: f.gcA.project.tradePackageId,
    recipients: [{ contractorId: f.gcA.project.contractorId, email: BIDDER }],
  });
  expect(calls).toHaveLength(1);
  const ref = (await t.run(async (ctx) => await ctx.db.get(f.gcA.project.contractorId)))!.rfqRef!;
  const routed = await receive(
    t,
    {
      inbox_id: "dullstreet57@agentmail.to",
      thread_id: "thread-rfq-1",
      message_id: "<rfi-1@mail>",
      in_reply_to: "<out-1@ses>",
      from: `Oakland Estimating <${BIDDER}>`,
      subject: `Re: Invitation to bid: 26 00 00 Electrical [TP-${ref}]`,
      extracted_text: RFI_TEXT,
    },
    "evt-rfi-1",
  );
  expect(routed).toMatchObject({ outcome: "routed" });
  await runScheduled(t);
  const [convo] = await conversations(t);
  return { t, f, calls, ref, conversationId: convo._id as Id<"conversations"> };
}

beforeEach(() => {
  vi.stubEnv("AGENTMAIL_API_KEY", "test-agentmail-key");
  vi.stubEnv("EMAIL_DAILY_BUDGET", "60");
  vi.stubEnv("AGENTMAIL_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("SITE_URL", "https://app.tradepulse.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("inbound RFI produces an AI draft and sends nothing", () => {
  test("an emailed RFI routed by thread becomes a GC draft with zero mailer calls and no rfi_answer outbox row", async () => {
    const { t, f, calls, conversationId } = await setupWithInboundRfi();
    // Only the RFQ itself reached AgentMail: no reply, no LLM-triggered send.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/messages/send");
    const rows = await outbox(t);
    expect(rows.map((r) => r.kind)).toEqual(["rfq"]);

    const convo = (await t.run(async (ctx) => await ctx.db.get(conversationId)))!;
    expect(convo.inboundQuestion).toBe(RFI_TEXT);
    expect(convo.status).not.toBe("pending_analysis");
    expect(convo.autonomousReply.length).toBeGreaterThan(0);
    expect(convo.answerEmailStatus).toBeUndefined();
    expect(convo.pmCertifiedAt).toBeUndefined();
    expect(convo.sourceInboundEmailId).toBeDefined();

    const list = await f.gcA.admin.as.query(api.bidPortal.listPackageQuestions, { tradePackageId: f.gcA.project.tradePackageId });
    expect(list).toMatchObject([{ _id: conversationId, origin: "email", replyTo: BIDDER, answerEmailStatus: null, answeredAt: null, isDemo: false }]);
  });
});

describe("the GC reviews, edits and sends the answer through the mailer", () => {
  test("the edited text (not the AI draft) is replied in the thread once, recorded as rfi_answer sent, and attributed", async () => {
    const { t, f, calls, ref, conversationId } = await setupWithInboundRfi();
    const draft = (await t.run(async (ctx) => await ctx.db.get(conversationId)))!.autonomousReply;
    const res = await f.gcA.admin.as.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: EDITED });
    expect(res).toEqual({ status: "sent" });

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain(`/inboxes/${encodeURIComponent("dullstreet57@agentmail.to")}/messages/${encodeURIComponent("<rfi-1@mail>")}/reply`);
    expect(calls[1].body.text.startsWith(`${EDITED}\n\n`)).toBe(true);
    expect(calls[1].body.text).toContain(`[TP-${ref}]`);
    expect(calls[1].body.text).not.toContain(draft);
    expect(calls[1].body.labels).toContain("rfi_answer");

    const rows = (await outbox(t)).filter((r) => r.kind === "rfi_answer");
    expect(rows).toMatchObject([{ status: "sent", to: BIDDER, fromInbox: "dullstreet57@agentmail.to", companyId: f.gcA.companyId, projectId: f.gcA.project.projectId }]);
    expect(rows[0].subject).toContain(`[TP-${ref}]`);

    const convo = (await t.run(async (ctx) => await ctx.db.get(conversationId)))!;
    expect(convo).toMatchObject({ answerEmailStatus: "sent", answerText: EDITED, answeredByUserId: f.gcA.admin.userId, aiDraft: draft, status: "clarified" });
    expect(convo.answeredAt).toBeTypeOf("number");

    // A second click sends nothing.
    expect(await f.gcA.admin.as.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: EDITED })).toEqual({ status: "already_sent" });
    expect(await f.gcA.member.as.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: "Different text" })).toEqual({ status: "already_sent" });
    expect(calls).toHaveLength(2);
    expect((await outbox(t)).filter((r) => r.kind === "rfi_answer")).toHaveLength(1);
  });

  test("a definite failure can be retried with edited text; an unconfirmed send keeps its text", async () => {
    const { t, f, calls, conversationId } = await setupWithInboundRfi();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response("bad request", { status: 400 });
    });
    const failed = await f.gcA.admin.as.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: "First wording." });
    expect(failed.status).toBe("failed");
    expect((await t.run(async (ctx) => await ctx.db.get(conversationId)))!.answerEmailStatus).toBe("failed");

    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response("gateway", { status: 504 });
    });
    const unsure = await f.gcA.admin.as.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: EDITED });
    expect(unsure.status).toBe("uncertain");
    await expect(f.gcA.admin.as.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: "Changed again" })).rejects.toThrow(/not confirmed/);
  });

  test("an uncertain send stays locked through a next-day budget refusal; only the same key may reconcile it", async () => {
    const { t, f, calls, conversationId } = await setupWithInboundRfi();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response("gateway", { status: 504 });
    });
    expect((await f.gcA.admin.as.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: EDITED })).status).toBe("uncertain");
    const [first] = (await outbox(t)).filter((r) => r.kind === "rfi_answer");
    expect(first.status).toBe("uncertain");

    // The next UTC day, with the non-auth budget already used up.
    await t.run(async (ctx) => {
      await ctx.db.patch(first._id, { day: "2000-01-01", updatedAt: Date.now() - 86_400_000 });
      await ctx.db.patch(conversationId, { answerClaimedAt: Date.now() - 86_400_000 });
    });
    vi.stubEnv("EMAIL_DAILY_BUDGET", "10");
    const callsBefore = calls.length;
    const refused = await f.gcA.admin.as.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: EDITED });
    expect(refused.status).toBe("uncertain");
    expect(calls).toHaveLength(callsBefore);
    let convo = (await t.run(async (ctx) => await ctx.db.get(conversationId)))!;
    expect(convo).toMatchObject({ answerEmailStatus: "uncertain", answerText: EDITED, answerAttempt: 1 });
    expect((await outbox(t)).filter((r) => r.kind === "rfi_answer")).toMatchObject([{ _id: first._id, status: "uncertain" }]);

    // Still locked: edited text is refused and no second idempotency key is created.
    await expect(f.gcA.admin.as.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: "Changed after the refusal" })).rejects.toThrow(/not confirmed/);
    expect((await outbox(t)).filter((r) => r.kind === "rfi_answer")).toHaveLength(1);

    // Budget back: the retry reuses the original key, and AgentMail's answer for it settles the attempt.
    vi.stubEnv("EMAIL_DAILY_BUDGET", "60");
    stubFetch();
    expect(await f.gcA.admin.as.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: EDITED })).toEqual({ status: "sent" });
    const rows = (await outbox(t)).filter((r) => r.kind === "rfi_answer");
    expect(rows).toMatchObject([{ _id: first._id, status: "sent", idempotencyKey: first.idempotencyKey }]);
    convo = (await t.run(async (ctx) => await ctx.db.get(conversationId)))!;
    expect(convo).toMatchObject({ answerEmailStatus: "sent", answerText: EDITED, answerAttempt: 1 });
  });
});

describe("only GC members of the project can send RFI answers or RFQs", () => {
  test("sub, owner, another GC, a billing agent and the Demo GC get Not found and create no outbox row", async () => {
    const { t, f, calls, conversationId } = await setupWithInboundRfi();
    const agentUser = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "bot@agentmail.to", actorType: "agent", agentSub: "a1" });
      await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: "a1" });
      await ctx.db.insert("userProfiles", { userId, role: "sub", displayName: "bot", actorType: "agent", contractorId: f.gcA.project.contractorId, createdAt: 0 });
      await ctx.db.insert("agentLinks", {
        agentEmail: "bot@agentmail.to",
        contractorId: f.gcA.project.contractorId,
        gcCompanyId: f.gcA.companyId,
        subCompanyId: f.sub.companyId,
        status: "active",
        createdBy: f.gcA.admin.userId,
        createdAt: 0,
      });
      await ctx.db.patch(f.gcA.project.contractorId, { linkedCompanyId: f.sub.companyId });
      return userId;
    });
    const agent = await withSession(t, agentUser);
    const before = (await outbox(t)).length;
    for (const caller of [f.sub.admin.as, f.owner.admin.as, f.gcB.admin.as, agent, f.demo.gc.as]) {
      await expect(caller.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: EDITED })).rejects.toThrow(/Not found/);
      await expect(
        caller.action(api.rfqActions.dispatchRfqsWithNotification, {
          tradePackageId: f.gcA.project.tradePackageId,
          recipients: [{ contractorId: f.gcA.project.contractorId, email: BIDDER }],
        }),
      ).rejects.toThrow(/Not found/);
      await expect(caller.action(api.rfqActions.dispatchSingleRfqWithNotification, { contractorId: f.gcA.project.contractorId, email: BIDDER })).rejects.toThrow(/Not found/);
    }
    await expect(t.action(api.rfiAnswers.sendRfiAnswer, { conversationId, answer: EDITED })).rejects.toThrow();
    expect((await outbox(t)).length).toBe(before);
    expect(calls).toHaveLength(1);
    expect((await t.run(async (ctx) => await ctx.db.get(conversationId)))!.answerEmailStatus).toBeUndefined();
  });
});

describe("the Demo company never emails", () => {
  test("Demo RFQ, simulated RFI and recorded RFI answer make zero AgentMail calls and no outbox rows", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const calls = stubFetch();
    await t.run(async (ctx) => ctx.db.patch(f.demo.project.contractorId, { contactEmail: "estimating@rosendin.com", rfqStatus: "discovered" }));

    const rfq: any = await f.demo.gc.as.action(api.rfqActions.dispatchRfqsWithNotification, {
      tradePackageId: f.demo.project.tradePackageId,
      recipients: [{ contractorId: f.demo.project.contractorId, email: "estimating@rosendin.com" }],
    });
    expect(rfq.deliveryResults).toMatchObject([{ status: "not_sent" }]);

    await f.demo.gc.as.mutation(api.simulation.triggerJudgeSimulation, { tradePackageId: f.demo.project.tradePackageId, scenario: "rfi_inquiry" });
    await runScheduled(t);
    const simulated = (await conversations(t)).filter((c) => c.tradePackageId === f.demo.project.tradePackageId);
    expect(simulated.length).toBeGreaterThan(0);
    for (const c of simulated) expect(c.answerEmailStatus).toBeUndefined();

    const recorded = await f.demo.gc.as.action(api.rfiAnswers.sendRfiAnswer, { conversationId: simulated[0]._id, answer: "Crane by GC." });
    expect(recorded).toEqual({ status: "demo_not_sent" });
    expect((await t.run(async (ctx) => await ctx.db.get(simulated[0]._id)))).toMatchObject({ answerEmailStatus: "demo_not_sent", answerText: "Crane by GC." });

    expect(calls).toHaveLength(0);
    expect(await outbox(t)).toHaveLength(0);
  });

  test("a non-demo GC cannot run the simulation", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    await expect(
      f.gcA.admin.as.mutation(api.simulation.triggerJudgeSimulation, { tradePackageId: f.gcA.project.tradePackageId, scenario: "rfi_inquiry" }),
    ).rejects.toThrow(/Not found/);
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "_generated" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("no code path sends AI-generated email automatically", () => {
  const convexDir = join(__dirname);
  const files = sourceFiles(convexDir).map((p) => ({ p: p.slice(convexDir.length + 1), src: readFileSync(p, "utf8") }));

  test("only the known modules call the mailer, and rfi_answer is sent only by the GC action", () => {
    const callers = files.filter((f) => f.p !== "lib/mailer.ts" && /\bsendEmail\(ctx/.test(f.src)).map((f) => f.p).sort();
    expect(callers).toEqual(["lib/authEmail.ts", "invites.ts", "mailerDiagnostics.ts", "rfiAnswers.ts", "rfqActions.ts"].sort());
    const rfiAnswerSenders = files.filter((f) => /kind:\s*"rfi_answer"/.test(f.src)).map((f) => f.p);
    expect(rfiAnswerSenders).toEqual(["rfiAnswers.ts"]);
    const rfi = files.find((f) => f.p === "rfiAnswers.ts")!.src;
    // The send takes the GC-typed text and is behind a GC write guard; no confidence threshold.
    expect(rfi).toMatch(/requireProjectScopeInAction\([\s\S]*roles: \["gc"\], write: true/);
    expect(rfi).not.toMatch(/confidence/i);
    expect(rfi).not.toMatch(/executeReasoning|llmRouter/);
  });

  test("the AI pipelines never import the mailer", () => {
    for (const p of ["emailActions.ts", "llmRouter.ts", "simulation.ts", "inboundEmail.ts", "bidPortal.ts", "rfq.ts"]) {
      const src = files.find((f) => f.p === p)!.src;
      expect(src, p).not.toMatch(/lib\/mailer|sendEmail\(/);
    }
  });

  test("the email body starts with the reviewed answer verbatim", () => {
    const mail = buildRfiAnswerEmail({
      answer: EDITED,
      gcName: "Bayview Builders Inc.",
      answeredByName: "Dana Whitfield",
      projectTitle: "Harbor Point Dental Office TI",
      csiDivision: "26 00 00",
      tradeName: "Electrical",
      ref: "ABCD2345",
      inboundSubject: "Re: Invitation to bid [TP-ABCD2345]",
    });
    expect(mail.text.startsWith(EDITED)).toBe(true);
    expect(mail.subject).toBe("Re: Invitation to bid [TP-ABCD2345]");
    expect(buildRfiAnswerEmail({ ...mailInput(), inboundSubject: "RFI: fire alarm" }).subject).toBe("Re: RFI: fire alarm [TP-ABCD2345]");
  });
});

function mailInput() {
  return {
    answer: EDITED,
    gcName: "Bayview Builders Inc.",
    answeredByName: "Dana",
    projectTitle: "P",
    csiDivision: "26 00 00",
    tradeName: "Electrical",
    ref: "ABCD2345",
    inboundSubject: "",
  };
}

describe("addenda: bidders see and acknowledge them; the pending-RFI check names the package", () => {
  test("an invited sub sees the addendum with its date, acknowledges it once, and the GC sees who acknowledged", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const fileId = await t.run(async (ctx) => {
      await ctx.db.patch(f.gcA.project.tradePackageId, { status: "rfqs_dispatched" });
      return await ctx.db.insert("projectFiles", {
        projectId: f.gcA.project.projectId,
        storageId: "kg_fixture_storage",
        fileName: "Addendum 1 – revised panel schedule.pdf",
        fileType: "addendum",
        fileSize: 1000,
        uploadedBy: "Dana",
        uploadedAt: 1_790_000_000_000,
      });
    });
    const pkg = f.gcA.project.tradePackageId;
    const view = await f.sub.admin.as.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg });
    expect(view.addenda).toMatchObject([{ _id: fileId, uploadedAt: 1_790_000_000_000, acknowledgedAt: null }]);
    const first = await f.sub.admin.as.mutation(api.addenda.acknowledgeAddendum, { tradePackageId: pkg, fileId });
    const again = await f.sub.admin.as.mutation(api.addenda.acknowledgeAddendum, { tradePackageId: pkg, fileId });
    expect(again.acknowledgedAt).toBe(first.acknowledgedAt);
    const after = await f.sub.admin.as.query(api.bidPortal.getPackageForBidder, { tradePackageId: pkg });
    expect(after.addenda[0].acknowledgedAt).toBe(first.acknowledgedAt);
    const gcList = await f.gcA.admin.as.query(api.addenda.listPackageAddenda, { tradePackageId: pkg });
    expect(gcList).toMatchObject([{ _id: fileId, acknowledgments: [{ acknowledgedAt: first.acknowledgedAt }] }]);

    for (const other of [f.gcB.admin.as, f.owner.admin.as, f.demo.gc.as]) {
      await expect(other.mutation(api.addenda.acknowledgeAddendum, { tradePackageId: pkg, fileId })).rejects.toThrow(/Not found/);
      await expect(other.query(api.addenda.listPackageAddenda, { tradePackageId: pkg })).rejects.toThrow(/Not found/);
    }
    await expect(f.sub.admin.as.query(api.addenda.listPackageAddenda, { tradePackageId: pkg })).rejects.toThrow(/Not found/);
    expect(await t.run(async (ctx) => (await ctx.db.query("addendumAcknowledgments").collect()).length)).toBe(1);
  });

  test("addendum issuance checks only the covered package and names packages with pending RFIs", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { projectId, tradePackageId, contractorId } = f.gcA.project;
    const otherPkg = await t.run(async (ctx) => {
      const id = await ctx.db.insert("tradePackages", {
        projectId,
        csiDivision: "23 00 00",
        tradeName: "HVAC",
        budgetEstimate: 1,
        agentMailbox: "x@example.invalid",
        agentMailboxId: "x",
        scopeSummary: "HVAC",
        mandatoryInclusions: [],
        bidDeadline: "2026-12-01",
        status: "draft",
      });
      const c = await ctx.db.insert("contractors", {
        tradePackageId: id,
        companyName: "Lakeshore Mechanical",
        contactEmail: "ray@example.invalid",
        licenseNumber: "0",
        licenseStatus: "Unverified",
        sourceUrl: "https://example.invalid",
        rfqStatus: "sent",
      });
      const base = { autonomousReply: "draft", confidenceScore: 0.9, timestamp: 1, inboundSubject: "Q" };
      await ctx.db.insert("conversations", { ...base, tradePackageId: id, contractorId: c, threadId: "t-hvac", inboundQuestion: "Pending HVAC?", status: "escalated_to_pm" });
      await ctx.db.insert("conversations", {
        ...base,
        tradePackageId,
        contractorId,
        threadId: "t-elec",
        inboundQuestion: "Certified electrical?",
        status: "clarified",
        pmCertifiedAt: 2,
        pmCertifiedBy: "Dana",
      });
      return id;
    });
    const scoped = await f.gcA.admin.as.action(api.files.generatePreBidAddendum, { projectId, tradePackageId });
    expect(scoped).toMatchObject({ success: true, qaCount: 1 });
    await expect(f.gcA.admin.as.action(api.files.generatePreBidAddendum, { projectId })).rejects.toThrow(/1 pending RFI\(s\) in: 23 00 00 HVAC \(1\)/);
    await expect(f.gcA.admin.as.action(api.files.generatePreBidAddendum, { projectId, tradePackageId: otherPkg })).rejects.toThrow(/23 00 00 HVAC/);
    expect(pendingRfiMessage([{ csiDivision: "26 00 00", tradeName: "Electrical" }, { csiDivision: "26 00 00", tradeName: "Electrical" }])).toMatch(
      /Review 2 pending RFI\(s\) in: 26 00 00 Electrical \(2\)\./,
    );
  });
});

describe("Demo leveling plugs carry entered-by attribution", () => {
  test("the backfill attributes unattributed Demo plugs to the Demo GC, is idempotent, and leaves other companies alone", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const plug = { description: "Crane hoisting excluded", costImpactCents: 4_500_000, severity: "critical" };
    await t.run(async (ctx) => {
      await ctx.db.patch(f.demo.project.bidId, { identifiedExclusions: [plug, { description: "No plug", costImpactCents: 0, severity: "minor" }] });
      await ctx.db.patch(f.gcA.project.bidId, { identifiedExclusions: [plug] });
    });
    const actor = { userId: f.demo.gc.userId, name: "Demo GC (Austin Commercial, LP)" };
    expect(await t.run((ctx) => attributeDemoPlugs(ctx, f.demo.companyIds.gc, actor))).toBe(1);
    expect(await t.run((ctx) => attributeDemoPlugs(ctx, f.demo.companyIds.gc, actor))).toBe(0);
    expect(await t.run((ctx) => attributeDemoPlugs(ctx, f.gcA.companyId, actor))).toBe(0);
    const demoBid = (await t.run(async (ctx) => await ctx.db.get(f.demo.project.bidId)))!;
    expect(demoBid.identifiedExclusions[0]).toMatchObject({ plugEnteredByUserId: f.demo.gc.userId, plugEnteredByName: actor.name });
    expect(demoBid.identifiedExclusions[0].plugEnteredAt).toBeTypeOf("number");
    expect(demoBid.identifiedExclusions[1].plugEnteredAt).toBeUndefined();
    const realBid = (await t.run(async (ctx) => await ctx.db.get(f.gcA.project.bidId)))!;
    expect(realBid.identifiedExclusions[0].plugEnteredAt).toBeUndefined();
  });

  test("a simulator-parsed Demo bid keeps its plug with Demo GC attribution; a real company's parsed plug stays $0 and unattributed", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const parsed = (tradePackageId: Id<"tradePackages">, contractorId: Id<"contractors">) => ({
      tradePackageId,
      contractorId,
      subcontractorName: "Parsed bidder",
      baseAmountCents: 110_000_000,
      lineItems: [],
      identifiedExclusions: [{ description: "Crane hoisting excluded", costImpactCents: 4_500_000, severity: "critical" }],
      longLeadEquipmentWeeks: 0,
      coiComplianceStatus: "compliant",
      coiPenaltyCents: 0,
    });
    const freshBidder = (tradePackageId: Id<"tradePackages">) =>
      t.run(async (ctx) =>
        ctx.db.insert("contractors", {
          tradePackageId,
          companyName: "Parsed bidder",
          contactEmail: "parsed@example.invalid",
          licenseNumber: "0",
          licenseStatus: "Unverified",
          sourceUrl: "https://example.invalid",
          rfqStatus: "sent",
        }),
      );
    const demoPkg = f.demo.project.tradePackageId;
    const realPkg = f.gcA.project.tradePackageId;
    const demoBidId = await t.mutation(internal.bids.insertParsedBid, parsed(demoPkg, await freshBidder(demoPkg)));
    const realBidId = await t.mutation(internal.bids.insertParsedBid, parsed(realPkg, await freshBidder(realPkg)));
    const demoBid = (await t.run(async (ctx) => await ctx.db.get(demoBidId as Id<"bids">)))!;
    expect(demoBid.identifiedExclusions[0]).toMatchObject({ costImpactCents: 4_500_000, plugEnteredByUserId: f.demo.gc.userId });
    expect(demoBid.identifiedExclusions[0].plugEnteredAt).toBeTypeOf("number");
    const realBid = (await t.run(async (ctx) => await ctx.db.get(realBidId as Id<"bids">)))!;
    expect(realBid.identifiedExclusions[0].costImpactCents).toBe(0);
    expect(realBid.identifiedExclusions[0].plugEnteredAt).toBeUndefined();
  });
});
