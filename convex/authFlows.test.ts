/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { ACCOUNT_EXISTS_MESSAGE, INVALID_CODE_MESSAGE, INVALID_CREDENTIALS_MESSAGE } from "./lib/authErrors";
import { SYSTEM_INBOX } from "./lib/mailer";

const modules = import.meta.glob("./**/*.ts");

type Sent = { url: string; to: string[]; subject: string; text: string; html: string };
let sent: Sent[] = [];
let now = Date.UTC(2026, 9, 8, 15, 0, 0);

const STRONG = "Harbor-Point-2026";
const NEW_STRONG = "Embarcadero-455-W";
const DANA = "dana@bayview-mail.com";

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, " ");
  process.env.JWKS = JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(keys.publicKey)) }] });
  process.env.SITE_URL = "http://localhost:3150";
  process.env.CONVEX_SITE_URL = "https://test.convex.site";
});

beforeEach(() => {
  sent = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("AGENTMAIL_API_KEY", "test-key");
  vi.stubEnv("EMAIL_DAILY_BUDGET", "60");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ url: String(url), ...body });
    return new Response(JSON.stringify({ message_id: `<m${sent.length}@x>`, thread_id: `t${sent.length}` }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function setup() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
}

type T = ReturnType<typeof setup>;

const signIn = (t: T, params: Record<string, string>) => t.action(api.auth.signIn, { provider: "password", params });
const lastCode = () => {
  const match = /\b(\d{8})\b/.exec(sent.at(-1)?.text ?? "");
  if (!match) throw new Error("no code sent");
  return match[1];
};
const advance = (ms: number) => {
  now += ms;
  vi.setSystemTime(now);
};

async function errorData(promise: Promise<unknown>): Promise<{ code?: string; message?: string; kind?: string }> {
  try {
    await promise;
  } catch (err: any) {
    return err?.data ?? { message: String(err?.message ?? err) };
  }
  throw new Error("expected the call to fail");
}

async function userByEmail(t: T, email: string) {
  return await t.run(async (ctx) => await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).unique());
}

async function signUpAndVerify(t: T, email = DANA, password = STRONG) {
  expect(await signIn(t, { flow: "signUp", email, password, name: "Dana Whitfield" })).toEqual({ tokens: null });
  const result: any = await signIn(t, { flow: "email-verification", email, code: lastCode() });
  expect(result.tokens).toBeTruthy();
}

describe("sign-up and email verification", () => {
  test("sign-up emails one 8-digit code from TradePulse Pay and verifying signs in", async () => {
    const t = setup();
    advance(60_000);
    expect(await signIn(t, { flow: "signUp", email: DANA, password: STRONG, name: "Dana Whitfield" })).toEqual({ tokens: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain(`/inboxes/${encodeURIComponent(SYSTEM_INBOX)}/messages/send`);
    expect(sent[0].to).toEqual([DANA]);
    expect(sent[0].subject).toMatch(/TradePulse Pay.*verify/i);
    expect(sent[0].text).not.toMatch(/code=/);
    expect(sent[0].html).toContain(lastCode());
    const before = await userByEmail(t, DANA);
    expect(before?.name).toBe("Dana Whitfield");
    expect(before?.emailVerificationTime).toBeUndefined();

    const ok: any = await signIn(t, { flow: "email-verification", email: DANA, code: lastCode() });
    expect(ok.tokens?.token).toBeTruthy();
    expect((await userByEmail(t, DANA))?.emailVerificationTime).toBeDefined();

    const rows = await t.run(async (ctx) => await ctx.db.query("emailOutbox").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "auth_code", to: DANA, status: "sent", agentmailMessageId: "<m1@x>" });
    expect(JSON.stringify(rows[0])).not.toContain(lastCode());
  });

  test("wrong, superseded and other-address codes are rejected with a readable message", async () => {
    const t = setup();
    advance(60_000);
    await signIn(t, { flow: "signUp", email: DANA, password: STRONG, name: "Dana" });
    const first = lastCode();
    expect(await errorData(signIn(t, { flow: "email-verification", email: DANA, code: "00000000" }))).toMatchObject({
      code: "INVALID_CODE",
      message: INVALID_CODE_MESSAGE,
    });

    // Resend inside the cooldown is refused by the rate limiter; after it a new code supersedes the old.
    const tooSoon = await errorData(signIn(t, { flow: "signIn", email: DANA, password: STRONG }));
    expect(tooSoon.kind).toBe("RateLimited");
    expect(sent).toHaveLength(1);
    advance(31_000);
    expect(await signIn(t, { flow: "signIn", email: DANA, password: STRONG })).toEqual({ tokens: null });
    expect(sent).toHaveLength(2);
    const second = lastCode();
    expect(await errorData(signIn(t, { flow: "email-verification", email: DANA, code: first }))).toMatchObject({ code: "INVALID_CODE" });

    // A code is bound to the address it was sent to.
    await signIn(t, { flow: "signUp", email: "mallory@other-mail.com", password: STRONG, name: "Mallory" });
    expect(
      await errorData(signIn(t, { flow: "email-verification", email: "mallory@other-mail.com", code: second })),
    ).toMatchObject({ code: "INVALID_CODE" });
    expect((await userByEmail(t, DANA))?.emailVerificationTime).toBeUndefined();

    const ok: any = await signIn(t, { flow: "email-verification", email: DANA, code: second });
    expect(ok.tokens).toBeTruthy();
  });

  test("a refused resend keeps the emailed code valid, and a wrong password still reads as invalid", async () => {
    const t = setup();
    advance(60_000);
    await signIn(t, { flow: "signUp", email: DANA, password: STRONG, name: "Dana" });
    const first = lastCode();
    expect((await errorData(signIn(t, { flow: "signIn", email: DANA, password: STRONG }))).kind).toBe("RateLimited");
    expect(await errorData(signIn(t, { flow: "signIn", email: DANA, password: "Wrong-Password-1" }))).toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect((await errorData(signIn(t, { flow: "reset", email: DANA }))).kind).toBe("RateLimited");
    expect(sent).toHaveLength(1);
    const ok: any = await signIn(t, { flow: "email-verification", email: DANA, code: first });
    expect(ok.tokens).toBeTruthy();
  });

  test("weak passwords, missing names, mixed-case and undeliverable emails are refused before any account exists", async () => {
    const t = setup();
    for (const [params, code] of [
      [{ password: "aaaaaaaaaaaa", name: "Dana" }, "WEAK_PASSWORD"],
      [{ password: "short1!", name: "Dana" }, "WEAK_PASSWORD"],
      [{ password: STRONG, name: "  " }, "INVALID_NAME"],
    ] as const) {
      expect(await errorData(signIn(t, { flow: "signUp", email: DANA, ...params }))).toMatchObject({ code });
    }
    const mixed = await errorData(signIn(t, { flow: "signUp", email: "Dana@Bayview-Mail.com", password: STRONG, name: "Dana" }));
    expect(mixed).toMatchObject({ code: "INVALID_EMAIL", message: "Enter a valid lowercase email address." });
    expect(await errorData(signIn(t, { flow: "signUp", email: "dana@bayview.test", password: STRONG, name: "Dana" }))).toMatchObject({
      code: "INVALID_EMAIL",
    });
    const counts = await t.run(async (ctx) => ({
      users: (await ctx.db.query("users").collect()).length,
      accounts: (await ctx.db.query("authAccounts").collect()).length,
    }));
    expect(counts).toEqual({ users: 0, accounts: 0 });
    expect(sent).toHaveLength(0);
  });

  test("a duplicate sign-up says the account exists, sends nothing and keeps the password", async () => {
    const t = setup();
    advance(60_000);
    await signUpAndVerify(t);
    const sends = sent.length;
    expect(await errorData(signIn(t, { flow: "signUp", email: DANA, password: "Different-Pass-99", name: "Dana" }))).toMatchObject({
      code: "ACCOUNT_EXISTS",
      message: ACCOUNT_EXISTS_MESSAGE,
    });
    expect(sent).toHaveLength(sends);
    const accounts = await t.run(async (ctx) => await ctx.db.query("authAccounts").collect());
    expect(accounts.map((a) => a.providerAccountId)).toEqual([DANA]);
    const again: any = await signIn(t, { flow: "signIn", email: DANA, password: STRONG });
    expect(again.tokens).toBeTruthy();
  });
});

describe("sign-in errors", () => {
  test("wrong password and unknown email read the same", async () => {
    const t = setup();
    advance(60_000);
    await signUpAndVerify(t);
    const wrong = await errorData(signIn(t, { flow: "signIn", email: DANA, password: "Wrong-Password-1" }));
    const unknown = await errorData(signIn(t, { flow: "signIn", email: "nobody@bayview-mail.com", password: "Wrong-Password-1" }));
    expect(wrong).toEqual({ code: "INVALID_CREDENTIALS", message: INVALID_CREDENTIALS_MESSAGE });
    expect(unknown).toEqual(wrong);
  });

  test("seeded accounts marked verified sign in without a code", async () => {
    const t = setup();
    await t.action(internal.devFixtures.ensureIsolationGc, {});
    const result: any = await signIn(t, { flow: "signIn", email: "isolation-gc@tenancy-check.test", password: "TradePulseDemo!2026" });
    expect(result.tokens).toBeTruthy();
    expect(sent).toHaveLength(0);

    // An unverified account on a reserved domain never triggers a real send.
    await t.run(async (ctx) => {
      const account = (await ctx.db.query("authAccounts").first())!;
      await ctx.db.patch(account._id, { emailVerified: undefined });
    });
    const err = await errorData(signIn(t, { flow: "signIn", email: "isolation-gc@tenancy-check.test", password: "TradePulseDemo!2026" }));
    expect(err).toMatchObject({ code: "EMAIL_FAILED" });
    expect(sent).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("emailOutbox").collect()).length)).toBe(0);
  });

  test("the backfill marks verified users' password accounts verified", async () => {
    const t = setup();
    await t.action(internal.devFixtures.ensureIsolationGc, {});
    await t.run(async (ctx) => {
      const account = (await ctx.db.query("authAccounts").first())!;
      await ctx.db.patch(account._id, { emailVerified: undefined });
    });
    expect(await t.mutation(internal.authMigrations.backfillVerifiedPasswordAccounts, {})).toMatchObject({ patched: 1, isDone: true });
    expect(await t.mutation(internal.authMigrations.backfillVerifiedPasswordAccounts, {})).toMatchObject({ patched: 0 });
    const result: any = await signIn(t, { flow: "signIn", email: "isolation-gc@tenancy-check.test", password: "TradePulseDemo!2026" });
    expect(result.tokens).toBeTruthy();
  });
});

describe("password reset", () => {
  test("unknown address: same response, no email, no outbox row", async () => {
    const t = setup();
    advance(60_000);
    expect(await signIn(t, { flow: "reset", email: "ghost@bayview-mail.com" })).toEqual({ tokens: null });
    expect(sent).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("emailOutbox").collect()).length)).toBe(0);
  });

  test("reset rejects a weak password and a wrong code, then changes the password and ends other sessions", async () => {
    const t = setup();
    advance(60_000);
    await signUpAndVerify(t);
    await signIn(t, { flow: "signIn", email: DANA, password: STRONG });
    const user = (await userByEmail(t, DANA))!;
    const sessions = () =>
      t.run(async (ctx) => (await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", user._id)).collect()).length);
    expect(await sessions()).toBe(2);

    advance(31_000);
    expect(await signIn(t, { flow: "reset", email: DANA })).toEqual({ tokens: null });
    expect(sent.at(-1)?.subject).toMatch(/TradePulse Pay.*reset/i);
    const code = lastCode();
    expect(
      await errorData(signIn(t, { flow: "reset-verification", email: DANA, code, newPassword: "aaaaaaaaaaaa" })),
    ).toMatchObject({ code: "WEAK_PASSWORD" });
    expect(
      await errorData(signIn(t, { flow: "reset-verification", email: DANA, code: "12345678", newPassword: NEW_STRONG })),
    ).toMatchObject({ code: "INVALID_CODE" });
    expect(((await signIn(t, { flow: "signIn", email: DANA, password: STRONG })) as any).tokens).toBeTruthy();
    expect(await sessions()).toBe(3);

    const reset: any = await signIn(t, { flow: "reset-verification", email: DANA, code, newPassword: NEW_STRONG });
    expect(reset.tokens).toBeTruthy();
    expect(await sessions()).toBe(1);
    expect(await errorData(signIn(t, { flow: "signIn", email: DANA, password: STRONG }))).toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(((await signIn(t, { flow: "signIn", email: DANA, password: NEW_STRONG })) as any).tokens).toBeTruthy();
  });
});

describe("email budget", () => {
  test("a skipped send is reported honestly, never as sent", async () => {
    const t = setup();
    vi.stubEnv("EMAIL_DAILY_BUDGET", "0");
    advance(60_000);
    const err = await errorData(signIn(t, { flow: "signUp", email: DANA, password: STRONG, name: "Dana" }));
    expect(err).toMatchObject({ code: "EMAIL_LIMIT" });
    expect(sent).toHaveLength(0);
    // Refused before Convex Auth stores a code, so no account, code or outbox row is created.
    expect(await t.run(async (ctx) => (await ctx.db.query("emailOutbox").collect()).length)).toBe(0);
    expect(await userByEmail(t, DANA)).toBeNull();
    // Unknown addresses get the same answer while the budget is used up.
    expect(await errorData(signIn(t, { flow: "reset", email: "ghost@bayview-mail.com" }))).toMatchObject({ code: "EMAIL_LIMIT" });
  });
});
