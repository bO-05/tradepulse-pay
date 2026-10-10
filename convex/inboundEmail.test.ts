/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { Webhook } from "svix";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";
import { newThreadRef, parseAddress, subjectTokens } from "./inboundEmail";
import { RFQ_INBOX } from "./lib/mailer";
import { inviteEmailOutcome, inviteStatusLabel } from "./lib/inviteRules";

const modules = import.meta.glob("./**/*.ts");
const WEBHOOK_SECRET = `whsec_${btoa("tradepulse-test-webhook-secret-32b")}`;

function newTest() {
  return convexTest(schema, modules);
}

async function addThread(
  t: ReturnType<typeof newTest>,
  p: { projectId: Id<"projects">; tradePackageId: Id<"tradePackages">; contractorId: Id<"contractors"> },
  ref: string,
  threadId?: string
) {
  return await t.run(async (ctx) => {
    const project = await ctx.db.get(p.projectId);
    return await ctx.db.insert("emailThreads", {
      ref,
      kind: "rfq",
      projectId: p.projectId,
      companyId: project?.gcCompanyId,
      tradePackageId: p.tradePackageId,
      contractorId: p.contractorId,
      threadId,
      createdAt: Date.now(),
    });
  });
}

function message(overrides: Partial<{
  inboxId: string;
  threadId: string;
  messageId: string;
  from: string;
  subject: string;
  text: string;
  inReplyTo: string;
}> = {}) {
  return {
    inboxId: RFQ_INBOX,
    threadId: "thread-new",
    messageId: `<m-${Math.random()}@mail>`,
    from: "Bidder <bids@example.invalid>",
    subject: "Question",
    text: "Is crane hoisting included?",
    ...overrides,
  };
}

async function counts(t: ReturnType<typeof newTest>) {
  return await t.run(async (ctx) => ({
    inbound: (await ctx.db.query("inboundEmails").collect()).length,
    contractors: (await ctx.db.query("contractors").collect()).length,
    conversations: (await ctx.db.query("conversations").collect()).length,
    scheduled: (await ctx.db.system.query("_scheduled_functions").collect()).length,
  }));
}

describe("helpers", () => {
  test("subject tokens, refs and sender parsing", () => {
    expect(subjectTokens("RE: Invitation to bid [TP-AB12CD34] and [tp-zz99zz99]")).toEqual(["AB12CD34", "ZZ99ZZ99"]);
    expect(subjectTokens("Electrical bid 26 00 00")).toEqual([]);
    expect(newThreadRef()).toMatch(/^[A-Z0-9]{8}$/);
    expect(parseAddress("Pat Bidder <Pat@Example.TEST>")).toEqual({ email: "pat@example.test", name: "Pat Bidder" });
    expect(parseAddress("pat@example.test").email).toBe("pat@example.test");
  });
});

describe("inbound routing", () => {
  test("thread id wins over a token from another company's package", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    await addThread(t, f.gcA.project, "BAYVIEW1", "thread-bayview");
    await addThread(t, f.gcB.project, "SONORAN1", "thread-sonoran");

    const res = await t.mutation(internal.inboundEmail.ingestReceived, {
      eventId: "evt-1",
      message: message({ threadId: "thread-bayview", subject: "RE: bid [TP-SONORAN1]" }),
    });
    expect(res).toMatchObject({ outcome: "routed", matchMethod: "thread" });
    const row = await t.run(async (ctx) => await ctx.db.get((res as any).inboundId as Id<"inboundEmails">));
    expect(row).toMatchObject({
      routing: "routed",
      matchMethod: "thread",
      projectId: f.gcA.project.projectId,
      companyId: f.gcA.companyId,
      tradePackageId: f.gcA.project.tradePackageId,
      contractorId: f.gcA.project.contractorId,
    });
    expect((await counts(t)).scheduled).toBe(1);
  });

  test("a new message with only the token routes by token to the sender's contractor in that package", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    await addThread(t, f.gcA.project, "BAYVIEW1", "thread-bayview");
    const res = await t.mutation(internal.inboundEmail.ingestReceived, {
      eventId: "evt-2",
      message: message({ threadId: "thread-other", subject: "Question on lighting [TP-BAYVIEW1]" }),
    });
    expect(res).toMatchObject({ outcome: "routed", matchMethod: "token" });
    const row = await t.run(async (ctx) => await ctx.db.get((res as any).inboundId as Id<"inboundEmails">));
    expect(row?.contractorId).toBe(f.gcA.project.contractorId);
  });

  test("a token from a sender who is not a bidder on that package goes to that package's triage only", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    await addThread(t, f.gcA.project, "BAYVIEW1", "thread-bayview");
    await addThread(t, f.gcB.project, "SONORAN1", "thread-sonoran");
    // The sender bids on Bayview, not on Sonoran.
    await t.run(async (ctx) => {
      await ctx.db.patch(f.gcA.project.contractorId, { contactEmail: "bayview-bidder@example.test", emailConfirmedFor: "bayview-bidder@example.test" });
      await ctx.db.patch(f.gcB.project.contractorId, { contactEmail: "sonoran-bidder@example.test", emailConfirmedFor: "sonoran-bidder@example.test" });
    });
    const before = await counts(t);
    const res = await t.mutation(internal.inboundEmail.ingestReceived, {
      eventId: "evt-3",
      message: message({ threadId: "thread-x", from: "bayview-bidder@example.test", subject: "Bid [TP-SONORAN1]" }),
    });
    expect(res.outcome).toBe("triage");
    const row = await t.run(async (ctx) => await ctx.db.get((res as any).inboundId as Id<"inboundEmails">));
    expect(row).toMatchObject({ routing: "triage", tradePackageId: f.gcB.project.tradePackageId, companyId: f.gcB.companyId });
    expect(row?.contractorId).toBeUndefined();
    const after = await counts(t);
    expect(after.contractors).toBe(before.contractors);
    expect(after.scheduled).toBe(0);
  });

  test("unknown or malformed tokens and keyword-only subjects are stored unrouted with no tenant ids", async () => {
    const t = newTest();
    await buildTenancyFixture(t);
    for (const [i, subject] of ["Electrical bid for Harbor Point Dental 26 00 00", "Bid [TP-ZZZZZZ]", "Bid [TP-??]"].entries()) {
      const res = await t.mutation(internal.inboundEmail.ingestReceived, {
        eventId: `evt-u${i}`,
        message: message({ threadId: `thread-u${i}`, subject }),
      });
      expect(res.outcome, subject).toBe("unrouted");
    }
    const rows = await t.run(async (ctx) => await ctx.db.query("inboundEmails").collect());
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.routing).toBe("unrouted");
      expect(r.projectId ?? r.companyId ?? r.tradePackageId ?? r.contractorId).toBeUndefined();
    }
    const c = await counts(t);
    expect(c.scheduled).toBe(0);
    expect(c.conversations).toBe(0);
  });

  test("a reply on a thread this deployment did not start is ignored and not stored", async () => {
    const t = newTest();
    await buildTenancyFixture(t);
    const res = await t.mutation(internal.inboundEmail.ingestReceived, {
      eventId: "evt-prod",
      message: message({ threadId: "thread-started-by-prod", inReplyTo: "<prod-msg@ses>", subject: "RE: Invitation" }),
    });
    expect(res.outcome).toBe("ignored");
    expect((await counts(t)).inbound).toBe(0);
  });

  test("a reply on a non-RFQ thread we started (invite, code) is unrouted, never parsed", async () => {
    const t = newTest();
    await buildTenancyFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("emailOutbox", {
        kind: "invite",
        to: "x@example.test",
        fromInbox: "cleverneed464@agentmail.to",
        status: "sent",
        idempotencyKey: "invite:x",
        day: "2026-10-08",
        attempts: 1,
        threadId: "thread-invite",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const res = await t.mutation(internal.inboundEmail.ingestReceived, {
      eventId: "evt-inv",
      message: message({ threadId: "thread-invite", inReplyTo: "<inv@ses>", subject: "RE: You're invited" }),
    });
    expect(res.outcome).toBe("unrouted");
  });

  test("duplicate delivery (same event id or same message id) is stored and processed once", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    await addThread(t, f.gcA.project, "BAYVIEW1", "thread-bayview");
    const m = message({ threadId: "thread-bayview", messageId: "<dup@mail>" });
    const first = await t.mutation(internal.inboundEmail.ingestReceived, { eventId: "evt-dup", message: m });
    const again = await t.mutation(internal.inboundEmail.ingestReceived, { eventId: "evt-dup", message: m });
    const otherWebhook = await t.mutation(internal.inboundEmail.ingestReceived, { eventId: "evt-dup-2", message: m });
    expect(first.outcome).toBe("routed");
    expect(again.outcome).toBe("duplicate");
    expect(otherWebhook.outcome).toBe("duplicate");
    const c = await counts(t);
    expect(c.inbound).toBe(1);
    expect(c.scheduled).toBe(1);
  });
});

describe("every recognized RFQ thread keeps routing", () => {
  test("a reply without the token on a second outbound RFQ thread routes to the same bidder", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const threadRowId = await addThread(t, f.gcA.project, "BAYVIEW1", "thread-first-send");
    await t.mutation(internal.inboundEmail.attachThreadId, { threadRowId, threadId: "thread-second-send" });
    await t.mutation(internal.inboundEmail.attachThreadId, { threadRowId, threadId: "thread-second-send" });

    for (const [i, threadId] of ["thread-first-send", "thread-second-send"].entries()) {
      const res = await t.mutation(internal.inboundEmail.ingestReceived, {
        eventId: `evt-out-${i}`,
        message: message({ threadId, inReplyTo: "<rfq@ses>", subject: "RE: Invitation to bid" }),
      });
      expect(res, threadId).toMatchObject({ outcome: "routed", matchMethod: "thread" });
      const row = await t.run(async (ctx) => await ctx.db.get((res as any).inboundId as Id<"inboundEmails">));
      expect(row).toMatchObject({ companyId: f.gcA.companyId, contractorId: f.gcA.project.contractorId });
    }
    expect(await t.run(async (ctx) => (await ctx.db.query("emailThreadLinks").collect()).length)).toBe(1);
  });

  test("a token-routed new thread is remembered, so its token-free follow-up routes by thread", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    await addThread(t, f.gcA.project, "BAYVIEW1", "thread-bayview");
    const first = await t.mutation(internal.inboundEmail.ingestReceived, {
      eventId: "evt-tok-1",
      message: message({ threadId: "thread-bidder-new", subject: "Question on lighting [TP-BAYVIEW1]" }),
    });
    expect(first).toMatchObject({ outcome: "routed", matchMethod: "token" });

    const followUp = await t.mutation(internal.inboundEmail.ingestReceived, {
      eventId: "evt-tok-2",
      message: message({ threadId: "thread-bidder-new", inReplyTo: "<answer@ses>", subject: "RE: lighting follow-up" }),
    });
    expect(followUp).toMatchObject({ outcome: "routed", matchMethod: "thread" });
    const row = await t.run(async (ctx) => await ctx.db.get((followUp as any).inboundId as Id<"inboundEmails">));
    expect(row).toMatchObject({ projectId: f.gcA.project.projectId, contractorId: f.gcA.project.contractorId });
  });

  test("a triaged token message (unknown sender) does not claim its thread", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    await addThread(t, f.gcA.project, "BAYVIEW1", "thread-bayview");
    await t.run(async (ctx) => {
      await ctx.db.patch(f.gcA.project.contractorId, { contactEmail: "bidder@example.test", emailConfirmedFor: "bidder@example.test" });
    });
    const res = await t.mutation(internal.inboundEmail.ingestReceived, {
      eventId: "evt-tri",
      message: message({ threadId: "thread-stranger", from: "stranger@example.test", subject: "Bid [TP-BAYVIEW1]" }),
    });
    expect(res.outcome).toBe("triage");
    expect(await t.run(async (ctx) => (await ctx.db.query("emailThreadLinks").collect()).length)).toBe(0);
  });
});

describe("RFQ dispatch through the mailer", () => {
  beforeEach(() => {
    vi.stubEnv("AGENTMAIL_API_KEY", "test-agentmail-key");
    vi.stubEnv("EMAIL_DAILY_BUDGET", "60");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("sends from the RFQ inbox with a [TP-ref] subject and stores the thread for routing", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(f.gcA.project.contractorId, { contactEmail: "Bidder@Example.test", emailConfirmedFor: "bidder@example.test", rfqStatus: "discovered" });
    });
    const calls: Array<{ url: string; body: any; key: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), key: (init.headers as any)["Idempotency-Key"] });
      return new Response(JSON.stringify({ message_id: "<rfq-1@ses>", thread_id: "thread-rfq-1" }), { status: 200 });
    });

    const res: any = await f.gcA.admin.as.action(api.rfqActions.dispatchSingleRfqWithNotification, {
      contractorId: f.gcA.project.contractorId,
      email: "bidder@example.test",
    });
    expect(res).toMatchObject({ emailSent: true, emailStatus: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(encodeURIComponent(RFQ_INBOX));
    const [token] = subjectTokens(calls[0].body.subject);
    expect(token).toMatch(/^[A-Z0-9]{8}$/);
    expect(calls[0].body.to).toEqual(["bidder@example.test"]);
    expect(calls[0].key).toMatch(/^rfq\.[a-z0-9]+\.\d+$/);

    const threads = await t.run(async (ctx) => await ctx.db.query("emailThreads").collect());
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ ref: token, threadId: "thread-rfq-1", companyId: f.gcA.companyId });
    const outbox = await t.run(async (ctx) => await ctx.db.query("emailOutbox").collect());
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ kind: "rfq", status: "sent", projectId: f.gcA.project.projectId, companyId: f.gcA.companyId });

    const reply = await t.mutation(internal.inboundEmail.ingestReceived, {
      eventId: "evt-reply",
      message: message({ threadId: "thread-rfq-1", from: "bidder@example.test", inReplyTo: "<rfq-1@ses>", subject: `RE: ${calls[0].body.subject}` }),
    });
    expect(reply).toMatchObject({ outcome: "routed", matchMethod: "thread" });
  });

  test("the Demo company sends no external email", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(f.demo.project.contractorId, { contactEmail: "estimating@rosendin.example" });
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res: any = await f.demo.gc.as.action(api.rfqActions.dispatchSingleRfqWithNotification, {
      contractorId: f.demo.project.contractorId,
      email: "estimating@rosendin.example",
    });
    expect(res).toMatchObject({ emailSent: false, emailStatus: "not_sent" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await t.run(async (ctx) => await ctx.db.query("emailOutbox").collect())).toHaveLength(0);
  });
});

describe("POST /agentmail/webhook", () => {
  beforeEach(() => vi.stubEnv("AGENTMAIL_WEBHOOK_SECRET", WEBHOOK_SECRET));
  afterEach(() => vi.unstubAllEnvs());

  const event = {
    type: "event",
    event_type: "message.received",
    event_id: "evt-http-1",
    message: {
      inbox_id: RFQ_INBOX,
      thread_id: "thread-http",
      message_id: "<http-1@mail>",
      from: "Bidder <bids@example.invalid>",
      to: [RFQ_INBOX],
      subject: "Electrical bid",
      text: "Base bid $100,000",
      labels: ["received"],
      timestamp: "2026-10-08T00:00:00Z",
    },
    thread: { thread_id: "thread-http" },
  };

  function signed(body: string, secret = WEBHOOK_SECRET) {
    const id = "msg_test_1";
    const now = new Date();
    return {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(now.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(id, now, body),
      "Content-Type": "application/json",
    };
  }

  test("unsigned and tampered requests are rejected with no writes", async () => {
    const t = newTest();
    await buildTenancyFixture(t);
    const before = await counts(t);
    const body = JSON.stringify(event);

    const unsigned = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: { "Content-Type": "application/json" } });
    expect(unsigned.status).toBe(401);

    const wrongKey = await t.fetch("/agentmail/webhook", {
      method: "POST",
      body,
      headers: signed(body, `whsec_${btoa("some-other-secret-value-32-bytes!")}`),
    });
    expect(wrongKey.status).toBe(401);

    const headers = signed(body);
    const tampered = await t.fetch("/agentmail/webhook", {
      method: "POST",
      body: body.replace("Electrical bid", "Electrical bid!"),
      headers,
    });
    expect(tampered.status).toBe(401);

    expect(await counts(t)).toEqual(before);
  });

  test("without a configured secret the route refuses (503) and writes nothing", async () => {
    vi.stubEnv("AGENTMAIL_WEBHOOK_SECRET", "");
    const t = newTest();
    const body = JSON.stringify(event);
    const res = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: signed(body) });
    expect(res.status).toBe(503);
    expect((await counts(t)).inbound).toBe(0);
  });

  test("a signed event is stored once (unknown thread → unrouted) and redelivery is idempotent", async () => {
    const t = newTest();
    await buildTenancyFixture(t);
    const before = await counts(t);
    const body = JSON.stringify(event);
    const first = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: signed(body) });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "unrouted" });
    const second = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: signed(body) });
    expect(await second.json()).toMatchObject({ outcome: "duplicate" });

    const after = await counts(t);
    expect(after.inbound).toBe(before.inbound + 1);
    expect(after.contractors).toBe(before.contractors);
    expect(after.conversations).toBe(before.conversations);
  });

  test("a bounce event marks the matching outbox row", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("emailOutbox", {
        kind: "rfq",
        to: "x@example.test",
        fromInbox: RFQ_INBOX,
        status: "sent",
        idempotencyKey: "rfq:x",
        day: "2026-10-08",
        attempts: 1,
        agentmailMessageId: "<bounced@ses>",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const body = JSON.stringify({ type: "event", event_type: "message.bounced", event_id: "evt-b", bounce: { message_id: "<bounced@ses>" } });
    const res = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: signed(body) });
    expect(res.status).toBe(200);
    const [row] = await t.run(async (ctx) => await ctx.db.query("emailOutbox").collect());
    expect(row.deliveryEvent).toBe("bounced");
  });

  test("a signed bounce marks the outbox row and the invite as bounced, and the send still counts", async () => {
    vi.stubEnv("EMAIL_DAILY_BUDGET", "1");
    const t = newTest();
    const f = await buildTenancyFixture(t);
    const inviteId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("invites", {
        tokenHash: "hash-bounce",
        email: "invitee@example.test",
        kind: "teammate",
        inviterCompanyId: f.gcA.companyId,
        status: "pending",
        expiresAt: Date.now() + 86_400_000,
        emailStatus: "sent",
        tokenVersion: 2,
        createdByUserId: f.gcA.admin.userId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("emailOutbox", {
        kind: "invite",
        to: "invitee@example.test",
        fromInbox: "cleverneed464@agentmail.to",
        status: "sent",
        idempotencyKey: `invite.${id}.2`,
        day: new Date().toISOString().slice(0, 10),
        attempts: 1,
        agentmailMessageId: "<invite-bounce@ses>",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return id;
    });
    const body = JSON.stringify({ type: "event", event_type: "message.bounced", event_id: "evt-ib", bounce: { message_id: "<invite-bounce@ses>" } });
    expect((await t.fetch("/agentmail/webhook", { method: "POST", body, headers: signed(body) })).status).toBe(200);

    const [row] = await t.run(async (ctx) => await ctx.db.query("emailOutbox").collect());
    expect(row).toMatchObject({ status: "delivery_failed", deliveryEvent: "bounced", error: expect.stringContaining("bounced") });
    const invite = await t.run(async (ctx) => await ctx.db.get(inviteId));
    expect(invite).toMatchObject({ emailStatus: "bounced", emailError: expect.stringContaining("not delivered") });
    expect(inviteStatusLabel(invite!, Date.now())).toBe("Pending · Email bounced");
    expect(inviteEmailOutcome(invite!.emailStatus, invite!.emailError).text).toContain("Email bounced");
    expect(await t.query(internal.emailOutbox.authCodeBudgetExhausted, {})).toBe(true);

    // A later "delivered" for the same message never turns it back into a success.
    const late = JSON.stringify({ type: "event", event_type: "message.delivered", event_id: "evt-id", delivery: { message_id: "<invite-bounce@ses>" } });
    await t.fetch("/agentmail/webhook", { method: "POST", body: late, headers: signed(late) });
    expect((await t.run(async (ctx) => await ctx.db.query("emailOutbox").collect()))[0].status).toBe("delivery_failed");
  });

  test("a signed rejection of an RFQ marks the row failed and records it on the project activity feed", async () => {
    const t = newTest();
    const f = await buildTenancyFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("emailOutbox", {
        kind: "rfq",
        to: "bids@example.test",
        fromInbox: RFQ_INBOX,
        status: "sent",
        idempotencyKey: `rfq.${f.gcA.project.contractorId}.123`,
        day: "2026-10-08",
        attempts: 1,
        agentmailMessageId: "<rfq-reject@ses>",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const body = JSON.stringify({ type: "event", event_type: "message.rejected", event_id: "evt-rr", reject: { message_id: "<rfq-reject@ses>" } });
    expect((await t.fetch("/agentmail/webhook", { method: "POST", body, headers: signed(body) })).status).toBe(200);
    const [row] = await t.run(async (ctx) => await ctx.db.query("emailOutbox").collect());
    expect(row).toMatchObject({ status: "delivery_failed", deliveryEvent: "rejected" });
    const logs = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).filter((l) => l.eventType === "rfq_email_failed")
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ projectId: f.gcA.project.projectId, tradePackageId: f.gcA.project.tradePackageId });
  });
});
