/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import {
  AUTH_CODE_RESERVE,
  agentmailIdempotencyKey,
  DEFAULT_DAILY_BUDGET,
  RFQ_INBOX,
  SYSTEM_INBOX,
  readDailyBudget,
  sendEmail,
  sendLimitFor,
  utcDayKey,
  type MailKind,
  type MailerCtx,
  type SendEmailRequest,
} from "./mailer";

const modules = import.meta.glob("../**/*.ts");

type Call = { url: string; headers: Record<string, string>; body: any };

function fakeAgentmail(respond: (call: Call, n: number) => Response = (_c, n) =>
  new Response(JSON.stringify({ message_id: `<msg-${n}@ses>`, thread_id: `thread-${n}` }), { status: 200 })) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return respond(call, calls.length);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function setup() {
  const t = convexTest(schema, modules);
  const ctx: MailerCtx = { runMutation: ((ref: any, args: any) => t.mutation(ref, args)) as MailerCtx["runMutation"] };
  return { t, ctx };
}

function request(kind: MailKind, n: number, extra: Partial<SendEmailRequest> = {}): SendEmailRequest {
  return {
    kind,
    from: kind === "rfq" ? "rfq" : "system",
    to: `User${n}@Example.test`,
    subject: `TradePulse Pay ${kind} ${n}`,
    text: "Hello from TradePulse Pay",
    html: "<p>Hello from TradePulse Pay</p>",
    idempotencyKey: `${kind}-${n}`,
    ...extra,
  };
}

async function outboxRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => await ctx.db.query("emailOutbox").collect());
}

beforeEach(() => {
  vi.stubEnv("AGENTMAIL_API_KEY", "test-agentmail-key");
  vi.stubEnv("EMAIL_DAILY_BUDGET", "60");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("budget helpers", () => {
  test("invites and RFQs keep a reserve of 10 for auth codes", () => {
    expect(AUTH_CODE_RESERVE).toBe(10);
    expect(sendLimitFor("auth_code", 60)).toBe(60);
    expect(sendLimitFor("invite", 60)).toBe(50);
    expect(sendLimitFor("rfq", 60)).toBe(50);
    expect(sendLimitFor("rfi_answer", 60)).toBe(50);
    expect(sendLimitFor("invite", 5)).toBe(0);
  });

  test("EMAIL_DAILY_BUDGET parsing falls back to the conservative default", () => {
    expect(readDailyBudget("60")).toBe(60);
    expect(readDailyBudget(" 30 ")).toBe(30);
    expect(readDailyBudget(undefined)).toBe(DEFAULT_DAILY_BUDGET);
    expect(readDailyBudget("lots")).toBe(DEFAULT_DAILY_BUDGET);
    expect(readDailyBudget("-4")).toBe(DEFAULT_DAILY_BUDGET);
  });

  test("the day key is the UTC calendar day", () => {
    expect(utcDayKey(Date.UTC(2026, 9, 8, 23, 59, 59))).toBe("2026-10-08");
    expect(utcDayKey(Date.UTC(2026, 9, 9, 0, 0, 1))).toBe("2026-10-09");
  });
});

describe("mailer budget guard (EMAIL_DAILY_BUDGET=60)", () => {
  test("invites send up to 50 today; the 51st is skipped_budget without calling AgentMail", async () => {
    const { t, ctx } = setup();
    const mail = fakeAgentmail();
    for (let i = 1; i <= 50; i++) {
      const res = await sendEmail(ctx, request(i % 2 ? "invite" : "rfq", i), { fetchImpl: mail.fetchImpl });
      expect(res.status, `send ${i}`).toBe("sent");
    }
    expect(mail.calls).toHaveLength(50);

    const skipped = await sendEmail(ctx, request("invite", 51), { fetchImpl: mail.fetchImpl });
    expect(skipped).toMatchObject({ status: "skipped_budget", message: expect.stringMatching(/Email limit reached/) });
    const rfqSkipped = await sendEmail(ctx, request("rfq", 52), { fetchImpl: mail.fetchImpl });
    expect(rfqSkipped.status).toBe("skipped_budget");
    expect(mail.calls).toHaveLength(50);

    const rows = await outboxRows(t);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(50);
    const skippedRows = rows.filter((r) => r.status === "skipped_budget");
    expect(skippedRows.map((r) => r.idempotencyKey).sort()).toEqual(["invite-51", "rfq-52"]);
    expect(skippedRows.every((r) => r.attempts === 0 && !r.agentmailMessageId)).toBe(true);
  }, 60_000);

  test("auth codes use the reserve up to 60; the 61st is skipped_budget", async () => {
    const { t, ctx } = setup();
    const mail = fakeAgentmail();
    for (let i = 1; i <= 50; i++) {
      expect((await sendEmail(ctx, request("invite", i), { fetchImpl: mail.fetchImpl })).status).toBe("sent");
    }
    expect((await sendEmail(ctx, request("invite", 99), { fetchImpl: mail.fetchImpl })).status).toBe("skipped_budget");
    for (let i = 51; i <= 60; i++) {
      const res = await sendEmail(ctx, request("auth_code", i), { fetchImpl: mail.fetchImpl });
      expect(res.status, `auth code ${i}`).toBe("sent");
    }
    const over = await sendEmail(ctx, request("auth_code", 61), { fetchImpl: mail.fetchImpl });
    expect(over.status).toBe("skipped_budget");
    expect(mail.calls).toHaveLength(60);

    const rows = await outboxRows(t);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(60);
    expect(rows.find((r) => r.idempotencyKey === "auth_code-61")?.status).toBe("skipped_budget");
  }, 60_000);

  test("the count is per UTC day and resets the next day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 8, 23, 50, 0)));
    const { t, ctx } = setup();
    const mail = fakeAgentmail();
    for (let i = 1; i <= 50; i++) {
      expect((await sendEmail(ctx, request("invite", i), { fetchImpl: mail.fetchImpl })).status).toBe("sent");
    }
    expect((await sendEmail(ctx, request("invite", 51), { fetchImpl: mail.fetchImpl })).status).toBe("skipped_budget");

    vi.setSystemTime(new Date(Date.UTC(2026, 9, 9, 0, 0, 5)));
    const nextDay = await sendEmail(ctx, request("invite", 52), { fetchImpl: mail.fetchImpl });
    expect(nextDay.status).toBe("sent");
    // A budget-skipped send can be retried with the same key once there is room again.
    const retried = await sendEmail(ctx, request("invite", 51), { fetchImpl: mail.fetchImpl });
    expect(retried.status).toBe("sent");

    const rows = await outboxRows(t);
    expect(rows.filter((r) => r.day === "2026-10-08" && r.status === "sent")).toHaveLength(50);
    expect(rows.filter((r) => r.day === "2026-10-09" && r.status === "sent")).toHaveLength(2);
  }, 60_000);

  test("a lower budget is honored: budget 12 allows 2 invites and 12 sends in total", async () => {
    vi.stubEnv("EMAIL_DAILY_BUDGET", "12");
    const { ctx } = setup();
    const mail = fakeAgentmail();
    expect((await sendEmail(ctx, request("invite", 1), { fetchImpl: mail.fetchImpl })).status).toBe("sent");
    expect((await sendEmail(ctx, request("invite", 2), { fetchImpl: mail.fetchImpl })).status).toBe("sent");
    expect((await sendEmail(ctx, request("invite", 3), { fetchImpl: mail.fetchImpl })).status).toBe("skipped_budget");
    for (let i = 4; i <= 13; i++) {
      expect((await sendEmail(ctx, request("auth_code", i), { fetchImpl: mail.fetchImpl })).status).toBe("sent");
    }
    expect((await sendEmail(ctx, request("auth_code", 14), { fetchImpl: mail.fetchImpl })).status).toBe("skipped_budget");
    expect(mail.calls).toHaveLength(12);
  });
});

describe("mailer AgentMail call", () => {
  test("sends from the fixed inbox with the Idempotency-Key, text and HTML, and records the ids", async () => {
    const { t, ctx } = setup();
    const mail = fakeAgentmail();
    const res = await sendEmail(ctx, request("invite", 1), { fetchImpl: mail.fetchImpl });
    expect(res).toMatchObject({ status: "sent", messageId: "<msg-1@ses>", threadId: "thread-1" });
    const rfq = await sendEmail(ctx, request("rfq", 2), { fetchImpl: mail.fetchImpl });
    expect(rfq.status).toBe("sent");

    expect(mail.calls[0].url).toBe(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(SYSTEM_INBOX)}/messages/send`);
    expect(mail.calls[1].url).toContain(encodeURIComponent(RFQ_INBOX));
    expect(mail.calls[0].headers["Idempotency-Key"]).toBe("invite-1");
    expect(mail.calls[0].headers.Authorization).toBe("Bearer test-agentmail-key");
    expect(mail.calls[0].body).toMatchObject({
      to: ["user1@example.test"],
      subject: "TradePulse Pay invite 1",
      text: expect.any(String),
      html: expect.any(String),
    });

    const [row] = (await outboxRows(t)).filter((r) => r.idempotencyKey === "invite-1");
    expect(row).toMatchObject({
      kind: "invite",
      to: "user1@example.test",
      fromInbox: SYSTEM_INBOX,
      status: "sent",
      agentmailMessageId: "<msg-1@ses>",
      threadId: "thread-1",
      attempts: 1,
    });
  });

  test("an AgentMail error is recorded failed with the error text; one call per attempt, same key on retry", async () => {
    const { t, ctx } = setup();
    let failNext = true;
    const mail = fakeAgentmail((_c, n) => {
      if (failNext) {
        failNext = false;
        return new Response(JSON.stringify({ name: "ValidationError", message: "recipient is blocked" }), { status: 403 });
      }
      return new Response(JSON.stringify({ message_id: `<msg-${n}@ses>`, thread_id: `thread-${n}` }), { status: 200 });
    });
    const req = request("invite", 7, { idempotencyKey: "invite-event-abc" });

    const first = await sendEmail(ctx, req, { fetchImpl: mail.fetchImpl });
    expect(first).toMatchObject({ status: "failed", error: expect.stringContaining("AgentMail 403") });
    expect((first as any).error).toContain("recipient is blocked");
    expect(mail.calls).toHaveLength(1);
    let [row] = await outboxRows(t);
    expect(row).toMatchObject({ status: "failed", attempts: 1, error: expect.stringContaining("recipient is blocked") });

    const second = await sendEmail(ctx, req, { fetchImpl: mail.fetchImpl });
    expect(second.status).toBe("sent");
    expect(mail.calls).toHaveLength(2);
    expect(mail.calls.map((c) => c.headers["Idempotency-Key"])).toEqual(["invite-event-abc", "invite-event-abc"]);

    // Once sent, the same event never calls AgentMail again.
    const third = await sendEmail(ctx, req, { fetchImpl: mail.fetchImpl });
    expect(third).toMatchObject({ status: "sent", messageId: "<msg-2@ses>" });
    expect(mail.calls).toHaveLength(2);
    const rows = await outboxRows(t);
    expect(rows).toHaveLength(1);
    [row] = rows;
    expect(row).toMatchObject({ status: "sent", attempts: 2 });
    expect(row.error).toBeUndefined();
  });

  test("network errors and a missing API key are recorded as failed, never as sent", async () => {
    const { t, ctx } = setup();
    const throwing = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await sendEmail(ctx, request("auth_code", 1), { fetchImpl: throwing });
    expect(res).toMatchObject({ status: "failed", error: expect.stringContaining("ECONNREFUSED") });

    vi.stubEnv("AGENTMAIL_API_KEY", "");
    const mail = fakeAgentmail();
    const noKey = await sendEmail(ctx, request("auth_code", 2), { fetchImpl: mail.fetchImpl });
    expect(noKey).toMatchObject({ status: "failed", error: expect.stringContaining("AGENTMAIL_API_KEY") });
    expect(mail.calls).toHaveLength(0);
    expect((await outboxRows(t)).map((r) => r.status)).toEqual(["failed", "failed"]);
  });

  test("failed sends do not use up the budget", async () => {
    vi.stubEnv("EMAIL_DAILY_BUDGET", "11");
    const { ctx } = setup();
    const failing = fakeAgentmail(() => new Response("boom", { status: 500 }));
    for (let i = 1; i <= 3; i++) {
      expect((await sendEmail(ctx, request("invite", i), { fetchImpl: failing.fetchImpl })).status).toBe("failed");
    }
    const ok = fakeAgentmail();
    expect((await sendEmail(ctx, request("invite", 4), { fetchImpl: ok.fetchImpl })).status).toBe("sent");
    expect((await sendEmail(ctx, request("invite", 5), { fetchImpl: ok.fetchImpl })).status).toBe("skipped_budget");
  });

  test("keys with characters AgentMail rejects are hashed to the same header value on every retry", async () => {
    const { ctx } = setup();
    const mail = fakeAgentmail(() => new Response("unavailable", { status: 503 }));
    const req = request("invite", 1, { idempotencyKey: "invite:k57abc:1791460269299" });
    await sendEmail(ctx, req, { fetchImpl: mail.fetchImpl });
    await sendEmail(ctx, req, { fetchImpl: mail.fetchImpl });
    const keys = mail.calls.map((c) => c.headers["Idempotency-Key"]);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(await agentmailIdempotencyKey("evt_123.abc-~")).toBe("evt_123.abc-~");
  });

  test("codes and tokens are redacted from the stored subject; no body is stored", async () => {
    const { t, ctx } = setup();
    const mail = fakeAgentmail();
    await sendEmail(
      ctx,
      request("auth_code", 1, { subject: "Your TradePulse Pay code is 48151623", text: "Code: 48151623", redact: ["48151623"] }),
      { fetchImpl: mail.fetchImpl }
    );
    expect(mail.calls[0].body.subject).toContain("48151623");
    const [row] = await outboxRows(t);
    expect(row.subject).toBe("Your TradePulse Pay code is [redacted]");
    expect(JSON.stringify(row)).not.toContain("48151623");
  });

  test("invalid recipients are refused before any write or call; notifications cannot be emailed", async () => {
    const { t, ctx } = setup();
    const mail = fakeAgentmail();
    const res = await sendEmail(ctx, request("invite", 1, { to: "not-an-address" }), { fetchImpl: mail.fetchImpl });
    expect(res.status).toBe("failed");
    expect(mail.calls).toHaveLength(0);
    expect(await outboxRows(t)).toHaveLength(0);

    await expect(
      t.mutation(internal.emailOutbox.reserveSend, {
        kind: "notification" as any,
        to: "a@example.test",
        fromInbox: SYSTEM_INBOX,
        subject: "x",
        idempotencyKey: "n1",
      })
    ).rejects.toThrow();
  });
});
