/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { Webhook } from "svix";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";
import { RFQ_INBOX, sendEmail } from "./lib/mailer";
import { subjectTokens } from "./inboundEmail";
import {
  BLOCKED_RECIPIENT_MESSAGE,
  DEFAULT_RECIPIENT_ALLOWLIST,
  isProductionDeployment,
  recipientAllowed,
  recipientAllowlist,
} from "./lib/recipientAllowlist";
import { emailNeedsConfirmation, formatBidDue, rfqRecipientState } from "./lib/rfqEmail";
import { RFQ_BUDGET_MESSAGE } from "./rfqActions";

const modules = import.meta.glob("./**/*.ts");
const WEBHOOK_SECRET = `whsec_${btoa("tradepulse-test-webhook-secret-32b")}`;
const BIDDER = "tp-golden-gate@maxxspace.com";

type Fixture = Awaited<ReturnType<typeof buildTenancyFixture>>;

function signed(body: string, id = `msg_${Math.random()}`) {
  const now = new Date();
  return {
    "svix-id": id,
    "svix-timestamp": String(Math.floor(now.getTime() / 1000)),
    "svix-signature": new Webhook(WEBHOOK_SECRET).sign(id, now, body),
    "Content-Type": "application/json",
  };
}

type Sent = { url: string; body: any; key: string };

function agentmailStub(respond: (n: number) => Response = (n) =>
  new Response(JSON.stringify({ message_id: `<rfq-${n}@ses>`, thread_id: `thread-rfq-${n}` }), { status: 200 })) {
  const calls: Sent[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), key: (init.headers as any)["Idempotency-Key"] });
    return respond(calls.length);
  });
  return calls;
}

async function setup(opts: { email?: string; webDiscovered?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  await t.run(async (ctx) => {
    await ctx.db.patch(f.gcA.project.projectId, { state: "CA", location: "Oakland, CA" });
    await ctx.db.patch(f.gcA.project.tradePackageId, { status: "draft", bidDeadline: "2026-10-30T14:00" });
    await ctx.db.patch(f.gcA.project.contractorId, {
      companyName: "Golden Gate Electric",
      contactEmail: opts.email ?? BIDDER,
      rfqStatus: "discovered",
      ...(opts.webDiscovered
        ? { emailSource: "web_discovery" as const, licenseStatus: "Unverified — from web search result" }
        : { emailSource: "gc" as const, emailConfirmedFor: opts.email ?? BIDDER }),
    });
  });
  return { t, f };
}

async function contractorRow(t: ReturnType<typeof convexTest>, id: Id<"contractors">) {
  return await t.run(async (ctx) => await ctx.db.get(id));
}

async function outboxRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => await ctx.db.query("emailOutbox").collect());
}

function sendRfq(f: Fixture, email = BIDDER) {
  return f.gcA.admin.as.action(api.rfqActions.dispatchRfqsWithNotification, {
    tradePackageId: f.gcA.project.tradePackageId,
    recipients: [{ contractorId: f.gcA.project.contractorId, email }],
  });
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

describe("recipient allowlist (non-production deployments)", () => {
  test("defaults to test domains outside production and to no allowlist in production", () => {
    expect(isProductionDeployment("https://earnest-mongoose-745.convex.cloud")).toBe(true);
    expect(isProductionDeployment("https://exuberant-boar-323.convex.cloud")).toBe(false);
    expect(isProductionDeployment(undefined)).toBe(false);
    expect(recipientAllowlist({ cloudUrl: "https://exuberant-boar-323.convex.cloud" })).toEqual(DEFAULT_RECIPIENT_ALLOWLIST);
    expect(recipientAllowlist({ cloudUrl: "https://earnest-mongoose-745.convex.cloud" })).toBeNull();
    expect(recipientAllowlist({ allowlist: "a.com, *.b.org", cloudUrl: "https://earnest-mongoose-745.convex.cloud" })).toEqual(["a.com", "*.b.org"]);
  });

  test("matches exact domains, wildcard suffixes and single addresses only", () => {
    const dev = { cloudUrl: "https://exuberant-boar-323.convex.cloud" };
    for (const ok of ["x@maxxspace.com", "dullstreet57@agentmail.to", "a@fixture.test", "b@eastbay.example", "c@example.com", "d@example.invalid"]) {
      expect(recipientAllowed(ok, dev)).toBe(true);
    }
    for (const no of ["estimating@rosendin.com", "bids@bergelectric.com", "x@gmail.com", "x@example.com.evil.net", "x@notexample.com"]) {
      expect(recipientAllowed(no, dev)).toBe(false);
    }
    expect(recipientAllowed("estimating@rosendin.com", { cloudUrl: "https://earnest-mongoose-745.convex.cloud" })).toBe(true);
    expect(recipientAllowed("pat@acme.com", { allowlist: "pat@acme.com" })).toBe(true);
    expect(recipientAllowed("lee@acme.com", { allowlist: "pat@acme.com" })).toBe(false);
  });

  test("the mailer refuses an outside recipient before any AgentMail call and records blocked_recipient", async () => {
    const t = convexTest(schema, modules);
    const calls = agentmailStub();
    const viaAction = await t.action(internal.mailerDiagnostics.sendTestEmail, { to: "bids@bergelectric.com", idempotencyKey: "test.block.0" });
    expect(viaAction).toMatchObject({ status: "failed", blockedRecipient: true });
    const direct = await t.run(async (ctx) =>
      sendEmail(ctx as any, {
        kind: "rfq",
        from: "rfq",
        to: "Estimating@Rosendin.com",
        subject: "RFQ",
        text: "t",
        html: "<p>t</p>",
        idempotencyKey: "rfq.block.1",
      }),
    );
    expect(direct).toMatchObject({ status: "failed", blockedRecipient: true, error: BLOCKED_RECIPIENT_MESSAGE });
    expect(calls).toHaveLength(0);
    const rows = (await outboxRows(t)).filter((r) => r.idempotencyKey === "rfq.block.1");
    expect(rows).toMatchObject([{ status: "blocked_recipient", to: "estimating@rosendin.com", attempts: 0 }]);
  });

  test("production (no allowlist set) and an explicit EMAIL_RECIPIENT_ALLOWLIST change what is allowed", async () => {
    const t = convexTest(schema, modules);
    const calls = agentmailStub();
    const send = (to: string, key: string) =>
      t.action(internal.mailerDiagnostics.sendTestEmail, { to, idempotencyKey: key });

    vi.stubEnv("CONVEX_CLOUD_URL", "https://earnest-mongoose-745.convex.cloud");
    expect((await send("ops@acme.com", "k1")).status).toBe("sent");

    vi.stubEnv("CONVEX_CLOUD_URL", "https://exuberant-boar-323.convex.cloud");
    vi.stubEnv("EMAIL_RECIPIENT_ALLOWLIST", "acme.com");
    expect((await send("ops@acme.com", "k2")).status).toBe("sent");
    expect(await send("x@maxxspace.com", "k3")).toMatchObject({ status: "failed", blockedRecipient: true });
    expect(calls).toHaveLength(2);
  });
});

describe("RFQ recipients must be reviewed and confirmed", () => {
  test("web-discovered addresses are listed as 'email not confirmed' and never emailed until a GC confirms", async () => {
    const { t, f } = await setup({ email: BIDDER, webDiscovered: true });
    const calls = agentmailStub();
    const preview = await f.gcA.admin.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: f.gcA.project.tradePackageId });
    expect(preview.fromInbox).toBe(RFQ_INBOX);
    expect(preview.recipients).toMatchObject([{ contractorId: f.gcA.project.contractorId, email: BIDDER, state: "email_unconfirmed" }]);
    expect(preview.recipients[0].note).toMatch(/Email not confirmed/);

    const res: any = await sendRfq(f);
    expect(res.deliveryResults).toMatchObject([{ status: "email_unconfirmed" }]);
    expect(calls).toHaveLength(0);
    expect(await outboxRows(t)).toHaveLength(0);
    const row = await contractorRow(t, f.gcA.project.contractorId);
    expect(row?.rfqStatus).toBe("discovered");
    expect(row?.rfqEmailStatus).toBeUndefined();

    await f.gcA.admin.as.mutation(api.rfqRecipients.confirmBidderEmail, { contractorId: f.gcA.project.contractorId, email: BIDDER });
    const after = await f.gcA.admin.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: f.gcA.project.tradePackageId });
    expect(after.recipients[0].state).toBe("ready");
    const sent: any = await sendRfq(f);
    expect(sent.deliveryResults).toMatchObject([{ status: "sent" }]);
    expect(calls).toHaveLength(1);
  });

  test("editing a discovered address counts as confirming it", async () => {
    const { t, f } = await setup({ email: "info@real-electrical-company.com", webDiscovered: true });
    const row = (await contractorRow(t, f.gcA.project.contractorId))!;
    expect(emailNeedsConfirmation(row)).toBe(true);
    await f.gcA.admin.as.mutation(api.contractors.updateContractor, {
      contractorId: row._id,
      companyName: row.companyName,
      contactEmail: BIDDER,
      licenseNumber: row.licenseNumber,
      licenseStatus: row.licenseStatus,
      sourceUrl: row.sourceUrl,
    });
    const edited = (await contractorRow(t, row._id))!;
    expect(emailNeedsConfirmation(edited)).toBe(false);
    expect(edited.emailConfirmedByUserId).toBe(f.gcA.admin.userId);
  });

  test("an address changed after the GC reviewed the list is not emailed", async () => {
    const { t, f } = await setup();
    const calls = agentmailStub();
    await t.run((ctx) => ctx.db.patch(f.gcA.project.contractorId, { contactEmail: "someone-else@maxxspace.com" }));
    const res: any = await sendRfq(f, BIDDER);
    expect(res.deliveryResults).toMatchObject([{ status: "email_changed" }]);
    expect(calls).toHaveLength(0);
  });

  test("a non-allowlisted bidder address is refused by the mailer and shown as blocked_recipient", async () => {
    const { t, f } = await setup({ email: "estimating@rosendin.com" });
    const calls = agentmailStub();
    const preview = await f.gcA.admin.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: f.gcA.project.tradePackageId });
    expect(preview.recipients[0].state).toBe("blocked_recipient");
    const res: any = await sendRfq(f, "estimating@rosendin.com");
    expect(res.deliveryResults).toMatchObject([{ status: "blocked_recipient", reason: BLOCKED_RECIPIENT_MESSAGE }]);
    expect(calls).toHaveLength(0);
    expect(await contractorRow(t, f.gcA.project.contractorId)).toMatchObject({
      rfqStatus: "blocked_recipient",
      rfqEmailStatus: "blocked_recipient",
      rfqEmailError: BLOCKED_RECIPIENT_MESSAGE,
    });
    expect((await outboxRows(t))[0]).toMatchObject({ kind: "rfq", status: "blocked_recipient" });
  });

  test("recipient states for placeholders and already-sent bidders", () => {
    const allowAll = () => true;
    const base = { licenseStatus: "Active", contactEmail: BIDDER };
    expect(rfqRecipientState({ ...base, contactEmail: "not-published@verify-required.invalid" }, allowAll, true)).toBe("no_email");
    expect(rfqRecipientState({ ...base, rfqEmailStatus: "sent", rfqEmailTo: BIDDER }, allowAll, true)).toBe("already_sent");
    expect(rfqRecipientState({ ...base, rfqEmailStatus: "failed", rfqEmailTo: BIDDER }, allowAll, true)).toBe("ready");
    expect(rfqRecipientState({ ...base, rfqEmailStatus: "failed", rfqEmailTo: BIDDER }, allowAll, false)).toBe("email_unconfirmed");
  });
});

describe("RFQ status reflects the real send outcome", () => {
  test("a successful send stores the [TP-ref] token and thread id, and the email names the GC and due time zone", async () => {
    const { t, f } = await setup();
    const calls = agentmailStub();
    const res: any = await sendRfq(f);
    expect(res).toMatchObject({ emailsSent: 1, deliveryResults: [{ status: "sent" }] });
    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(calls[0].url).toContain(encodeURIComponent(RFQ_INBOX));
    expect(body.to).toEqual([BIDDER]);
    const [ref] = subjectTokens(body.subject);
    expect(body.subject).toContain("Harbor Point Dental Office TI");
    expect(body.subject).toContain("26 00 00 Electrical");
    expect(body.text).toContain("Bayview Builders Inc. invites you");
    expect(body.text).toContain("Oct 30, 2026, 2:00 PM Pacific Time (PT)");
    expect(body.text).toContain(`https://app.tradepulse.test/#/bids/${f.gcA.project.tradePackageId}`);
    expect(body.text).not.toMatch(/TradePulse Pro/);
    expect(body.html).toContain("Bayview Builders Inc.");

    const row = await contractorRow(t, f.gcA.project.contractorId);
    expect(row).toMatchObject({ rfqStatus: "sent", rfqEmailStatus: "sent", rfqRef: ref, rfqThreadId: "thread-rfq-1", rfqEmailTo: BIDDER });
    expect(row?.rfqSentAt).toBeTypeOf("number");
    const [outbox] = await outboxRows(t);
    expect(outbox).toMatchObject({
      kind: "rfq",
      status: "sent",
      agentmailMessageId: "<rfq-1@ses>",
      threadId: "thread-rfq-1",
      companyId: f.gcA.companyId,
      projectId: f.gcA.project.projectId,
    });
    expect(row?.rfqOutboxId).toBe(outbox._id);
    const threads = await t.run(async (ctx) => await ctx.db.query("emailThreads").collect());
    expect(threads).toMatchObject([{ ref, threadId: "thread-rfq-1", contractorId: f.gcA.project.contractorId }]);
    const pkg = await t.run(async (ctx) => await ctx.db.get(f.gcA.project.tradePackageId));
    expect(pkg?.status).toBe("rfqs_dispatched");

    // Sending again to the same address does not email twice.
    const again: any = await sendRfq(f);
    expect(again.deliveryResults).toMatchObject([{ status: "already_sent" }]);
    expect(calls).toHaveLength(1);
  });

  test("an AgentMail rejection is 'failed' with the error, never invited or sent, and Retry resends", async () => {
    const { t, f } = await setup({ email: "rfq-fail-1@example.invalid" });
    let fail = true;
    const calls = agentmailStub((n) =>
      fail
        ? new Response(JSON.stringify({ name: "ValidationError", message: "Recipient is blocked" }), { status: 403 })
        : new Response(JSON.stringify({ message_id: `<ok-${n}@ses>`, thread_id: `t-${n}` }), { status: 200 }),
    );
    const res: any = await sendRfq(f, "rfq-fail-1@example.invalid");
    expect(res).toMatchObject({ emailsSent: 0, deliveryResults: [{ status: "failed", reason: expect.stringContaining("403") }] });
    const row = await contractorRow(t, f.gcA.project.contractorId);
    expect(row).toMatchObject({ rfqStatus: "failed", rfqEmailStatus: "failed", rfqEmailError: expect.stringContaining("Recipient is blocked") });
    expect(row?.rfqSentAt).toBeUndefined();
    expect((await outboxRows(t))[0]).toMatchObject({ status: "failed", error: expect.stringContaining("403") });
    const logs = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).map((l) => l.title));
    expect(logs.some((l) => /invited/i.test(l))).toBe(false);

    fail = false;
    const retry: any = await sendRfq(f, "rfq-fail-1@example.invalid");
    expect(retry.deliveryResults).toMatchObject([{ status: "sent" }]);
    expect(calls[1].key).toBe(calls[0].key);
    expect(await outboxRows(t)).toHaveLength(1);
  });

  test("over the daily budget the RFQ is skipped_budget with no AgentMail call", async () => {
    vi.stubEnv("EMAIL_DAILY_BUDGET", "10");
    const { t, f } = await setup();
    const calls = agentmailStub();
    const res: any = await sendRfq(f);
    expect(res.deliveryResults).toMatchObject([{ status: "skipped_budget", reason: RFQ_BUDGET_MESSAGE }]);
    expect(calls).toHaveLength(0);
    expect(await contractorRow(t, f.gcA.project.contractorId)).toMatchObject({
      rfqStatus: "skipped_budget",
      rfqEmailStatus: "skipped_budget",
      rfqEmailError: "Email limit reached for today — copy the RFQ link instead.",
    });
    expect((await outboxRows(t))[0]).toMatchObject({ kind: "rfq", status: "skipped_budget" });
  });

  test("a signed message.bounced for the stored message id turns 'sent' into 'bounced'", async () => {
    const { t, f } = await setup({ email: "no-such-user-1@maxxspace.com" });
    agentmailStub();
    await sendRfq(f, "no-such-user-1@maxxspace.com");
    expect((await contractorRow(t, f.gcA.project.contractorId))?.rfqStatus).toBe("sent");
    const body = JSON.stringify({ type: "event", event_type: "message.bounced", event_id: "evt-bounce", bounce: { message_id: "<rfq-1@ses>" } });
    expect((await t.fetch("/agentmail/webhook", { method: "POST", body, headers: signed(body) })).status).toBe(200);
    expect(await contractorRow(t, f.gcA.project.contractorId)).toMatchObject({
      rfqStatus: "bounced",
      rfqEmailStatus: "bounced",
      rfqEmailError: expect.stringContaining("bounced"),
    });
  });
});

describe("inbound replies route to the right bidder and never leak", () => {
  async function receive(t: ReturnType<typeof convexTest>, m: Record<string, unknown>, eventId: string) {
    const body = JSON.stringify({ type: "event", event_type: "message.received", event_id: eventId, message: m });
    const res = await t.fetch("/agentmail/webhook", { method: "POST", body, headers: signed(body, eventId) });
    return (await res.json()) as any;
  }

  test("a reply on the RFQ thread is matched by thread and marks the bidder 'replied'; GC sees it, others get Not found", async () => {
    const { t, f } = await setup({ email: "boldlevel182@agentmail.to" });
    agentmailStub();
    await sendRfq(f, "boldlevel182@agentmail.to");
    const out = await receive(
      t,
      {
        inbox_id: RFQ_INBOX,
        thread_id: "thread-rfq-1",
        message_id: "<reply-1@mail>",
        in_reply_to: "<rfq-1@ses>",
        from: "Oakland Estimating <boldlevel182@agentmail.to>",
        subject: "Re: Invitation to bid",
        text: "Our proposal: base bid $158,900.00. Exclusions: permit fees.",
      },
      "evt-reply-1",
    );
    expect(out).toMatchObject({ outcome: "routed" });
    expect(await contractorRow(t, f.gcA.project.contractorId)).toMatchObject({ rfqEmailStatus: "replied" });
    const msgs = await f.gcA.admin.as.query(api.rfqRecipients.listPackageMessages, { tradePackageId: f.gcA.project.tradePackageId });
    expect(msgs).toMatchObject([{ matchMethod: "thread", contractorId: f.gcA.project.contractorId, routing: "routed" }]);

    for (const other of [f.gcB.admin, f.sub.admin, f.owner.admin, f.demo.gc]) {
      await expect(other.as.query(api.rfqRecipients.listPackageMessages, { tradePackageId: f.gcA.project.tradePackageId })).rejects.toThrow(/Not found/);
      await expect(other.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: f.gcA.project.tradePackageId })).rejects.toThrow(/Not found/);
      await expect(
        other.as.mutation(api.rfqRecipients.confirmBidderEmail, { contractorId: f.gcA.project.contractorId, email: "x@maxxspace.com" }),
      ).rejects.toThrow(/Not found/);
      await expect(
        other.as.action(api.rfqActions.dispatchRfqsWithNotification, {
          tradePackageId: f.gcA.project.tradePackageId,
          recipients: [{ contractorId: f.gcA.project.contractorId, email: "boldlevel182@agentmail.to" }],
        }),
      ).rejects.toThrow(/Not found/);
    }

    // Duplicate delivery of the same event: one inbound row, one processing run.
    const dup = await receive(
      t,
      { inbox_id: RFQ_INBOX, thread_id: "thread-rfq-1", message_id: "<reply-1@mail>", from: "boldlevel182@agentmail.to", subject: "Re", text: "x" },
      "evt-reply-1",
    );
    expect(dup.outcome).toBe("duplicate");
    const inbound = await t.run(async (ctx) => await ctx.db.query("inboundEmails").collect());
    expect(inbound).toHaveLength(1);
    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((s) => s.name.includes("processInboundEmail")),
    );
    expect(scheduled).toHaveLength(1);
  });

  test("a new message carrying only the token is matched by token; unmatched mail is unrouted and listed nowhere", async () => {
    const { t, f } = await setup({ email: "boldlevel182@agentmail.to" });
    agentmailStub();
    await sendRfq(f, "boldlevel182@agentmail.to");
    const ref = (await contractorRow(t, f.gcA.project.contractorId))!.rfqRef!;
    const byToken = await receive(
      t,
      { inbox_id: RFQ_INBOX, thread_id: "thread-new-1", message_id: "<q-1@mail>", from: "boldlevel182@agentmail.to", subject: `Question on lighting [TP-${ref}]`, text: "Is LED included?" },
      "evt-token-1",
    );
    expect(byToken).toMatchObject({ outcome: "routed" });
    const unmatched = await receive(
      t,
      { inbox_id: RFQ_INBOX, thread_id: "thread-new-2", message_id: "<k-1@mail>", from: "boldlevel182@agentmail.to", subject: "Electrical bid for Harbor Point Dental 26 00 00", text: "bid" },
      "evt-kw-1",
    );
    expect(unmatched.outcome).toBe("unrouted");
    const rows = await t.run(async (ctx) => await ctx.db.query("inboundEmails").collect());
    const unrouted = rows.find((r) => r.routing === "unrouted")!;
    expect(unrouted.projectId).toBeUndefined();
    expect(unrouted.companyId).toBeUndefined();
    expect(unrouted.tradePackageId).toBeUndefined();
    expect(unrouted.contractorId).toBeUndefined();

    const msgs = await f.gcA.admin.as.query(api.rfqRecipients.listPackageMessages, { tradePackageId: f.gcA.project.tradePackageId });
    expect(msgs.map((m) => m.matchMethod)).toEqual(["token"]);
    const sonoran = await f.gcB.admin.as.query(api.rfqRecipients.listPackageMessages, { tradePackageId: f.gcB.project.tradePackageId });
    expect(sonoran).toEqual([]);
  });

  test("a Sonoran token from a sender who bids on both packages routes only to the Sonoran bidder", async () => {
    const { t, f } = await setup({ email: "both@maxxspace.com" });
    await t.run(async (ctx) => {
      await ctx.db.patch(f.gcB.project.contractorId, { contactEmail: "both@maxxspace.com" });
      await ctx.db.insert("emailThreads", {
        ref: "SONORAN2",
        kind: "rfq",
        projectId: f.gcB.project.projectId,
        companyId: f.gcB.companyId,
        tradePackageId: f.gcB.project.tradePackageId,
        contractorId: f.gcB.project.contractorId,
        threadId: "thread-sonoran-2",
        createdAt: Date.now(),
      });
    });
    const res = await receive(
      t,
      { inbox_id: RFQ_INBOX, thread_id: "thread-x-9", message_id: "<s-1@mail>", from: "both@maxxspace.com", subject: "Bid [TP-SONORAN2]", text: "Question" },
      "evt-sonoran-2",
    );
    expect(res).toMatchObject({ outcome: "routed" });
    const [row] = await t.run(async (ctx) => await ctx.db.query("inboundEmails").collect());
    expect(row).toMatchObject({ companyId: f.gcB.companyId, contractorId: f.gcB.project.contractorId, matchMethod: "token" });
    expect((await contractorRow(t, f.gcA.project.contractorId))?.rfqEmailStatus).toBeUndefined();
    expect(await f.gcA.admin.as.query(api.rfqRecipients.listPackageMessages, { tradePackageId: f.gcA.project.tradePackageId })).toEqual([]);
  });

  test("a reply that arrives while the RFQ send is still awaiting AgentMail stays 'replied'", async () => {
    const { t, f } = await setup({ email: "boldlevel182@agentmail.to" });
    const calls: Sent[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body, key: (init.headers as any)["Idempotency-Key"] });
      const [ref] = subjectTokens(body.subject);
      const reply = await receive(
        t,
        { inbox_id: RFQ_INBOX, thread_id: "thread-early-1", message_id: "<early-1@mail>", from: "boldlevel182@agentmail.to", subject: `Re: [TP-${ref}]`, text: "We will bid." },
        "evt-early-1",
      );
      expect(reply).toMatchObject({ outcome: "routed" });
      return new Response(JSON.stringify({ message_id: "<rfq-1@ses>", thread_id: "thread-rfq-1" }), { status: 200 });
    });
    const res: any = await sendRfq(f, "boldlevel182@agentmail.to");
    expect(res.deliveryResults).toMatchObject([{ status: "sent" }]);
    expect(calls).toHaveLength(1);
    const row = await contractorRow(t, f.gcA.project.contractorId);
    expect(row).toMatchObject({ rfqEmailStatus: "replied", rfqStatus: "replied", rfqEmailTo: "boldlevel182@agentmail.to", rfqThreadId: "thread-rfq-1" });
    expect(row?.rfqRepliedAt).toBeTypeOf("number");
    expect(row?.rfqOutboxId).toBeDefined();

    // A reply to an earlier address does not hide the outcome of an RFQ to a new address.
    await t.run((ctx) => ctx.db.patch(f.gcA.project.contractorId, { contactEmail: "new-estimator@maxxspace.com", emailConfirmedFor: "new-estimator@maxxspace.com" }));
    agentmailStub(() => new Response(JSON.stringify({ name: "ValidationError", message: "Recipient is blocked" }), { status: 403 }));
    const second: any = await sendRfq(f, "new-estimator@maxxspace.com");
    expect(second.deliveryResults).toMatchObject([{ status: "failed" }]);
    expect(await contractorRow(t, f.gcA.project.contractorId)).toMatchObject({ rfqEmailStatus: "failed", rfqEmailTo: "new-estimator@maxxspace.com" });
  });
});

describe("web-discovered addresses keep their provenance through the vendor directory", () => {
  const DISCOVERED = "estimating-desk@maxxspace.com";

  async function secondPackage(t: ReturnType<typeof convexTest>, f: Fixture) {
    return await t.run(async (ctx) => {
      const pkg = (await ctx.db.get(f.gcA.project.tradePackageId))!;
      const { _id, _creationTime, ...fields } = pkg;
      return await ctx.db.insert("tradePackages", { ...fields, invitedContractorIds: [], status: "draft" });
    });
  }

  async function discover(t: ReturnType<typeof convexTest>, f: Fixture) {
    const [contractorId] = await t.mutation(internal.contractors.batchInsertContractors, {
      tradePackageId: f.gcA.project.tradePackageId,
      contractors: [
        { companyName: "Lakeside Electrical", contactEmail: DISCOVERED, licenseNumber: "1000001", licenseStatus: "Unverified — from web search result", sourceUrl: "https://lakeside.example/contact" },
      ],
    });
    const discovered = (await contractorRow(t, contractorId))!;
    expect(discovered.vendorId).toBeDefined();
    return { contractorId, vendorId: discovered.vendorId as Id<"vendors"> };
  }

  test("discovery -> directory -> another package is still 'email not confirmed' and sends nothing until confirmed", async () => {
    const { t, f } = await setup();
    const calls = agentmailStub();
    const { vendorId } = await discover(t, f);
    const pkg2 = await secondPackage(t, f);
    const { contractorIds } = await f.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg2, vendorIds: [vendorId] });
    const reused = contractorIds[0];

    const preview = await f.gcA.admin.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: pkg2 });
    expect(preview.recipients).toMatchObject([{ contractorId: reused, email: DISCOVERED, state: "email_unconfirmed" }]);
    const res: any = await f.gcA.admin.as.action(api.rfqActions.dispatchRfqsWithNotification, {
      tradePackageId: pkg2,
      recipients: [{ contractorId: reused, email: DISCOVERED }],
    });
    expect(res.deliveryResults).toMatchObject([{ status: "email_unconfirmed" }]);
    expect(calls).toHaveLength(0);
    expect(await outboxRows(t)).toHaveLength(0);

    // Confirming the address on any bidder confirms it for the directory entry, so later reuse is ready.
    await f.gcA.admin.as.mutation(api.rfqRecipients.confirmBidderEmail, { contractorId: reused, email: DISCOVERED });
    expect((await f.gcA.admin.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: pkg2 })).recipients[0].state).toBe("ready");
    const pkg3 = await secondPackage(t, f);
    await f.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg3, vendorIds: [vendorId] });
    expect((await f.gcA.admin.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: pkg3 })).recipients[0].state).toBe("ready");
  });

  test("a directory vendor built from a discovered bidder before provenance was stored is still unconfirmed", async () => {
    const { t, f } = await setup();
    const { vendorId } = await discover(t, f);
    await t.run((ctx) => ctx.db.patch(vendorId, { discoveredEmail: undefined }));
    const pkg2 = await secondPackage(t, f);
    await f.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg2, vendorIds: [vendorId] });
    expect((await f.gcA.admin.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: pkg2 })).recipients[0].state).toBe("email_unconfirmed");
  });

  test("a GC edit of the directory email replaces the discovered address and counts as confirming it", async () => {
    const { t, f } = await setup();
    const { vendorId } = await discover(t, f);
    const vendor = (await t.run(async (ctx) => await ctx.db.get(vendorId)))!;
    const fields = { name: vendor.name, trades: vendor.trades, contactName: vendor.contactName, email: vendor.email };
    // Saving the form without changing the address keeps it unconfirmed.
    await f.gcA.admin.as.mutation(api.vendors.updateVendor, { vendorId, ...fields, contactName: "Front desk" });
    const pkg2 = await secondPackage(t, f);
    await f.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg2, vendorIds: [vendorId] });
    expect((await f.gcA.admin.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: pkg2 })).recipients[0].state).toBe("email_unconfirmed");

    await f.gcA.admin.as.mutation(api.vendors.updateVendor, { vendorId, ...fields, email: "bids@maxxspace.com" });
    const pkg3 = await secondPackage(t, f);
    await f.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg3, vendorIds: [vendorId] });
    expect((await f.gcA.admin.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: pkg3 })).recipients[0]).toMatchObject({
      email: "bids@maxxspace.com",
      state: "ready",
    });
  });
});

describe("bid due date formatting", () => {
  test("uses the project's state time zone", () => {
    expect(formatBidDue("2026-10-30T14:00", "CA")).toBe("Oct 30, 2026, 2:00 PM Pacific Time (PT)");
    expect(formatBidDue("2026-10-30", "AZ")).toBe("Oct 30, 2026, end of day Arizona Time (MST)");
    expect(formatBidDue("2026-10-30", "TX")).toContain("Central Time (CT)");
  });
});
