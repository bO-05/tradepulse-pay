/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { decideHonorPeriodAction, reauthorizeRequestId } from "./honorPeriodMath";
import { clearPayPalTokenCache } from "./paypalClient";

const modules = import.meta.glob("/convex/**/*.ts");
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 4, 10, 12);

describe("decideHonorPeriodAction", () => {
  const base = {
    kind: "funding",
    status: "authorized",
    paypalAuthorizationId: "AUTH-1",
    honorPeriodEndsAt: NOW - 1,
    authorizationExpiresAt: NOW + 20 * DAY,
  };

  test("reauthorizes an uncaptured authorization past its honor period and before expiry", () => {
    expect(decideHonorPeriodAction(base, NOW)).toEqual({ action: "reauthorize" });
  });

  test("waits while the honor period is running", () => {
    expect(decideHonorPeriodAction({ ...base, honorPeriodEndsAt: NOW + 1 }, NOW).action).toBe("skip");
  });

  test("expires at or past the expiry, also for a partly captured authorization", () => {
    expect(decideHonorPeriodAction({ ...base, authorizationExpiresAt: NOW }, NOW)).toEqual({ action: "expire" });
    expect(decideHonorPeriodAction({ ...base, status: "partially_captured", authorizationExpiresAt: NOW - 1 }, NOW)).toEqual({
      action: "expire",
    });
  });

  test("never touches captured, voided, expired or failed rows, or non-funding rows", () => {
    for (const status of ["captured", "voided", "expired", "failed", "created", "approved"]) {
      expect(decideHonorPeriodAction({ ...base, status, authorizationExpiresAt: NOW - 1 }, NOW).action).toBe("skip");
    }
    expect(decideHonorPeriodAction({ ...base, kind: "payout" }, NOW).action).toBe("skip");
    expect(decideHonorPeriodAction({ ...base, paypalAuthorizationId: undefined }, NOW).action).toBe("skip");
  });

  test("reauthorizes at most once and backs off after a rejection", () => {
    expect(decideHonorPeriodAction({ ...base, reauthorizationCount: 1 }, NOW).action).toBe("skip");
    expect(decideHonorPeriodAction({ ...base, reauthorizeRetryAfter: NOW + 1 }, NOW).action).toBe("skip");
    expect(decideHonorPeriodAction({ ...base, reauthorizeRetryAfter: NOW - 1 }, NOW).action).toBe("reauthorize");
  });

  test("a partly captured authorization is only watched for expiry", () => {
    expect(decideHonorPeriodAction({ ...base, status: "partially_captured" }, NOW).action).toBe("skip");
  });

  test("request ids are stable per attempt", () => {
    expect(reauthorizeRequestId("fund_m1_1", 1)).toBe("fund_m1_1_reauth_1");
    expect(reauthorizeRequestId("fund_m1_1", 2)).toBe("fund_m1_1_reauth_2");
  });
});

type Call = { method: string; path: string; requestId?: string; body: unknown };

function fakePayPal() {
  const calls: Call[] = [];
  const state = { reject: false, n: 0 };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21AAfaketoken", expires_in: 32400 });
    const text = req.method === "GET" ? "" : await req.text();
    calls.push({
      method: req.method,
      path: url.pathname,
      requestId: req.headers.get("paypal-request-id") ?? undefined,
      body: text ? JSON.parse(text) : undefined,
    });
    if (req.method === "POST" && /^\/v2\/payments\/authorizations\/[^/]+\/reauthorize$/.test(url.pathname)) {
      if (state.reject) {
        return json(422, {
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
          details: [{ issue: "REAUTHORIZATION_TOO_SOON", description: "A reauthorize cannot be attempted within the honor period." }],
          debug_id: "dbg-reauth",
        });
      }
      const created = new Date(Date.now()).toISOString();
      const expires = new Date(Date.now() + 29 * DAY).toISOString();
      return json(201, { id: `REAUTH-${++state.n}`, status: "CREATED", create_time: created, expiration_time: expires });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  });
  const reauths = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/reauthorize"));
  return { fetchImpl, calls, reauths, state };
}

async function setup(row: { status?: string; honorPeriodEndsAt: number; authorizationExpiresAt: number; capturedCents?: number }) {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const agreement = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  const milestone = await t.run(
    async (ctx) =>
      (await ctx.db
        .query("milestones")
        .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
        .first())!,
  );
  const paymentId = await t.run(async (ctx) => {
    await ctx.db.patch(milestone._id, { status: "funded", amountCents: 1_000_000 });
    return await ctx.db.insert("payments", {
      agreementId: agreement._id,
      milestoneId: milestone._id,
      kind: "funding",
      status: (row.status ?? "authorized") as "authorized",
      paypalOrderId: "ORDER-1",
      paypalAuthorizationId: "AUTH-1",
      authorizationExpiresAt: row.authorizationExpiresAt,
      honorPeriodEndsAt: row.honorPeriodEndsAt,
      grossCents: 1_000_000,
      capturedCents: row.capturedCents,
      retainageCents: 0,
      netCents: 1_000_000,
      idempotencyKey: `fund_${milestone._id}_1`,
      createdAt: Date.now(),
    });
  });
  const read = () =>
    t.run(async (ctx) => ({
      payment: (await ctx.db.get(paymentId))!,
      milestone: (await ctx.db.get(milestone._id))!,
      cron: await ctx.db
        .query("auditLogs")
        .filter((q) => q.eq(q.field("eventType"), "cron_executed"))
        .collect(),
      writes: await ctx.db
        .query("auditLogs")
        .filter((q) => q.eq(q.field("eventType"), "paypal_write"))
        .collect(),
    }));
  return { t, gc, agreement, milestone, paymentId, read };
}

let fake: ReturnType<typeof fakePayPal>;
beforeEach(() => {
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret-value");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  fake = fakePayPal();
  vi.stubGlobal("fetch", fake.fetchImpl);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearPayPalTokenCache();
});

describe("honor-period watcher", () => {
  test("a backdated authorization is reauthorized with a request id; the new id and honor period are stored", async () => {
    const s = await setup({ honorPeriodEndsAt: Date.now() + 3 * DAY, authorizationExpiresAt: Date.now() + 29 * DAY });
    await s.t.mutation(internal.payments.testing.backdateAuthorization, {
      paymentId: s.paymentId,
      honorPeriodEndsAt: Date.now() - 60_000,
    });
    const out = await s.t.action(internal.payments.honorPeriod.watchAuthorizations, { paymentId: s.paymentId });
    expect(out.results).toEqual([expect.objectContaining({ outcome: "reauthorized", authorizationId: "AUTH-1", newAuthorizationId: "REAUTH-1" })]);

    const [call] = fake.reauths();
    expect(fake.reauths()).toHaveLength(1);
    expect(call.path).toBe("/v2/payments/authorizations/AUTH-1/reauthorize");
    expect(call.body).toEqual({ amount: { currency_code: "USD", value: "10000.00" } });
    expect(call.requestId).toBe(`fund_${s.milestone._id}_1_reauth_1`);

    const r = await s.read();
    expect(r.payment).toMatchObject({
      status: "authorized",
      paypalAuthorizationId: "REAUTH-1",
      previousAuthorizationIds: ["AUTH-1"],
      reauthorizationCount: 1,
    });
    expect(r.payment.honorPeriodEndsAt!).toBeGreaterThan(Date.now() + 2 * DAY);
    expect(r.cron.map((a) => a.operation)).toEqual(["honor_period.reauthorize"]);
    expect(r.writes).toEqual([expect.objectContaining({ operation: "paypal.authorizations.reauthorize", paypalOutcome: "succeeded" })]);

    // A second run does not reauthorize again (PayPal allows one reauthorization).
    const again = await s.t.action(internal.payments.honorPeriod.watchAuthorizations, { paymentId: s.paymentId });
    expect(again.results[0].outcome).toBe("skipped");
    expect(fake.reauths()).toHaveLength(1);
  });

  test("a PayPal rejection is logged and the original authorization stays intact", async () => {
    fake.state.reject = true;
    const s = await setup({ honorPeriodEndsAt: Date.now() - 60_000, authorizationExpiresAt: Date.now() + 29 * DAY });
    const before = await s.read();
    const out = await s.t.action(internal.payments.honorPeriod.watchAuthorizations, { paymentId: s.paymentId });
    expect(out.results[0]).toMatchObject({ outcome: "rejected", issues: ["REAUTHORIZATION_TOO_SOON"] });

    const r = await s.read();
    expect(r.payment).toMatchObject({
      status: "authorized",
      paypalAuthorizationId: "AUTH-1",
      honorPeriodEndsAt: before.payment.honorPeriodEndsAt,
      authorizationExpiresAt: before.payment.authorizationExpiresAt,
      reauthorizeAttempts: 1,
    });
    expect(r.payment.reauthorizationCount).toBeUndefined();
    expect(r.payment.reauthorizeError).toMatch(/REAUTHORIZATION_TOO_SOON/);
    expect(r.milestone.status).toBe("funded");
    expect(r.cron).toEqual([expect.objectContaining({ operation: "honor_period.reauthorize_rejected", httpStatus: 422 })]);
    expect(r.writes).toEqual([expect.objectContaining({ operation: "paypal.authorizations.reauthorize", paypalOutcome: "failed" })]);

    // Backoff: the next hourly run does not call PayPal again right away.
    await s.t.action(internal.payments.honorPeriod.watchAuthorizations, { paymentId: s.paymentId });
    expect(fake.reauths()).toHaveLength(1);
    // After backdating again, the retry uses a new request id.
    await s.t.mutation(internal.payments.testing.backdateAuthorization, { paymentId: s.paymentId });
    await s.t.action(internal.payments.honorPeriod.watchAuthorizations, { paymentId: s.paymentId });
    expect(fake.reauths().map((c) => c.requestId)).toEqual([
      `fund_${s.milestone._id}_1_reauth_1`,
      `fund_${s.milestone._id}_1_reauth_2`,
    ]);
  });

  test("an expired authorization marks the payment expired and the milestone funding_expired, without a PayPal call", async () => {
    const s = await setup({ honorPeriodEndsAt: Date.now() - 26 * DAY, authorizationExpiresAt: Date.now() + DAY });
    await s.t.mutation(internal.payments.testing.backdateAuthorization, {
      paymentId: s.paymentId,
      authorizationExpiresAt: Date.now() - 60_000,
    });
    const out = await s.t.action(internal.payments.honorPeriod.watchAuthorizations, { paymentId: s.paymentId });
    expect(out.results[0].outcome).toBe("expired");
    expect(fake.calls).toHaveLength(0);
    const r = await s.read();
    expect(r.payment.status).toBe("expired");
    expect(r.payment.error).toMatch(/Funding expired/);
    expect(r.milestone.status).toBe("funding_expired");
    expect(r.cron.map((a) => a.operation)).toEqual(["honor_period.expire"]);

    // A capture on the expired authorization is refused with a readable message and no PayPal call.
    await expect(
      s.gc.as.action(api.payments.release.releaseAndPay, { milestoneId: s.milestone._id, amountCents: 100_000, requestKey: "test-key-expired" }),
    ).rejects.toThrow(/expired/i);
    expect(fake.calls.filter((c) => c.path.endsWith("/capture"))).toHaveLength(0);
  });

  test("a partly captured authorization that expires completes the milestone", async () => {
    const s = await setup({
      status: "partially_captured",
      capturedCents: 400_000,
      honorPeriodEndsAt: Date.now() - 30 * DAY,
      authorizationExpiresAt: Date.now() - 1,
    });
    await s.t.action(internal.payments.honorPeriod.watchAuthorizations, { paymentId: s.paymentId });
    const r = await s.read();
    expect(r.payment.status).toBe("expired");
    expect(r.milestone.status).toBe("complete");
  });

  test("captured and voided authorizations are skipped with no PayPal call and no log", async () => {
    for (const status of ["captured", "voided"]) {
      const s = await setup({ status, honorPeriodEndsAt: Date.now() - DAY, authorizationExpiresAt: Date.now() - 1 });
      const out = await s.t.action(internal.payments.honorPeriod.watchAuthorizations, { paymentId: s.paymentId });
      expect(out.results[0].outcome).toBe("skipped");
      const r = await s.read();
      expect(r.payment.status).toBe(status);
      expect(r.cron).toHaveLength(0);
    }
    expect(fake.calls).toHaveLength(0);
  });

  test("the cron run (no paymentId) visits every open authorization", async () => {
    const s = await setup({ honorPeriodEndsAt: Date.now() - 60_000, authorizationExpiresAt: Date.now() + 20 * DAY });
    const out = await s.t.action(internal.payments.honorPeriod.watchAuthorizations, {});
    expect(out.results.map((r) => r.outcome)).toEqual(["reauthorized"]);
  });

  test("backdateAuthorization refuses non-funding rows", async () => {
    const s = await setup({ honorPeriodEndsAt: Date.now(), authorizationExpiresAt: Date.now() + DAY });
    const payoutId = await s.t.run(async (ctx) =>
      ctx.db.insert("payments", {
        agreementId: s.agreement._id,
        kind: "payout",
        status: "failed",
        grossCents: 1,
        retainageCents: 0,
        netCents: 1,
        idempotencyKey: "x",
        createdAt: Date.now(),
      }),
    );
    await expect(s.t.mutation(internal.payments.testing.backdateAuthorization, { paymentId: payoutId })).rejects.toThrow(/not found/i);
  });
});
