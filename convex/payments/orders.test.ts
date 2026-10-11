/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { DAY_MS } from "./funding";
import { clearPayPalTokenCache } from "./paypalClient";

const modules = import.meta.glob("/convex/**/*.ts");

type Call = { method: string; path: string; requestId?: string; body: unknown };

const AUTH_CREATE_TIME = "2026-10-07T12:00:00Z";
const AUTH_EXPIRATION_TIME = "2026-11-05T12:00:00Z";

/**
 * Fake PayPal sandbox: idempotent on PayPal-Request-Id like the real API. `forgetRequestIds` models the
 * finite request-key retention: after it, a repeated authorize gets 422 ORDER_ALREADY_AUTHORIZED.
 */
function fakePayPal(
  opts: {
    declineAuthorize?: (orderId: string) => boolean;
    loseAuthorizeResponse?: (orderId: string) => boolean;
    conflictAuthorize?: (orderId: string) => boolean;
  } = {},
) {
  const calls: Call[] = [];
  const ordersByRequestId = new Map<string, string>();
  const authByRequestId = new Map<string, string>();
  const authByOrderId = new Map<string, string>();
  let n = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const authStatusByOrderId = new Map<string, string>();
  const authorizedOrder = (orderId: string, authId: string) => ({
    id: orderId,
    intent: "AUTHORIZE",
    status: "COMPLETED",
    purchase_units: [
      {
        payments: {
          authorizations: [
            {
              id: authId,
              status: authStatusByOrderId.get(orderId) ?? "CREATED",
              amount: { currency_code: "USD", value: "0.00" },
              create_time: AUTH_CREATE_TIME,
              expiration_time: AUTH_EXPIRATION_TIME,
            },
          ],
        },
      },
    ],
  });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "tok", expires_in: 32400 });
    const text = req.method === "GET" ? "" : await req.text();
    const requestId = req.headers.get("paypal-request-id") ?? undefined;
    calls.push({ method: req.method, path: url.pathname, requestId, body: text ? JSON.parse(text) : undefined });
    if (req.method === "POST" && url.pathname === "/v2/checkout/orders") {
      let id = requestId ? ordersByRequestId.get(requestId) : undefined;
      if (!id) {
        id = `ORDER-${++n}`;
        if (requestId) ordersByRequestId.set(requestId, id);
      }
      return json(201, { id, status: "CREATED" });
    }
    const get = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)$/);
    if (req.method === "GET" && get) {
      const authId = authByOrderId.get(get[1]);
      if (authId) return json(200, authorizedOrder(get[1], authId));
      return json(200, { id: get[1], intent: "AUTHORIZE", status: "APPROVED", purchase_units: [{}] });
    }
    const m = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/);
    if (req.method === "POST" && m) {
      const orderId = m[1];
      if (opts.declineAuthorize?.(orderId)) {
        return json(422, {
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed.",
          details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument presented was declined." }],
          debug_id: "dbg-decline",
        });
      }
      if (opts.conflictAuthorize?.(orderId)) {
        return json(409, { name: "RESOURCE_CONFLICT", message: "A previous request with this id is still in progress." });
      }
      let authId = requestId ? authByRequestId.get(requestId) : undefined;
      if (!authId) {
        if (authByOrderId.has(orderId)) {
          return json(422, {
            name: "UNPROCESSABLE_ENTITY",
            message: "The requested action could not be performed.",
            details: [{ issue: "ORDER_ALREADY_AUTHORIZED", description: "Order already authorized." }],
            debug_id: "dbg-already",
          });
        }
        authId = `AUTH-${orderId}`;
        authByOrderId.set(orderId, authId);
        if (requestId) authByRequestId.set(requestId, authId);
      }
      if (opts.loseAuthorizeResponse?.(orderId)) throw new TypeError("fetch failed");
      return json(201, authorizedOrder(orderId, authId));
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  });
  const posts = (path: RegExp) => calls.filter((c) => c.method === "POST" && path.test(c.path));
  /** Authorizes the order at PayPal without the app seeing the response. */
  const authorizeOutOfBand = (orderId: string) => authByOrderId.set(orderId, `AUTH-${orderId}`);
  const forgetRequestIds = () => authByRequestId.clear();
  return { fetchImpl, calls, posts, authByOrderId, authStatusByOrderId, authorizeOutOfBand, forgetRequestIds };
}

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  const agreement = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  const milestones = await t.run((ctx) =>
    ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
      .collect(),
  );
  return { t, gc, agreement, milestone: milestones[0], milestones };
}

async function fundingRows(t: Awaited<ReturnType<typeof setup>>["t"], milestoneId: Id<"milestones">) {
  return await t.run((ctx) =>
    ctx.db
      .query("payments")
      .withIndex("by_milestoneId", (q) => q.eq("milestoneId", milestoneId))
      .collect(),
  );
}

async function errorOf(p: Promise<unknown>): Promise<ConvexError<{ code: string; message: string; issues?: string[] }>> {
  try {
    await p;
  } catch (e) {
    return e as ConvexError<{ code: string; message: string }>;
  }
  throw new Error("expected the call to fail");
}

let fake: ReturnType<typeof fakePayPal>;

beforeEach(() => {
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  fake = fakePayPal({
    declineAuthorize: (id) => declined.has(id),
    loseAuthorizeResponse: (id) => lostResponse.has(id),
    conflictAuthorize: (id) => conflicted.has(id),
  });
  vi.stubGlobal("fetch", fake.fetchImpl);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearPayPalTokenCache();
  declined.clear();
  lostResponse.clear();
  conflicted.clear();
});
const declined = new Set<string>();
const lostResponse = new Set<string>();
const conflicted = new Set<string>();

describe("createFundingOrder", () => {
  test("GC creates an AUTHORIZE order for the milestone amount with the payment's idempotency key", async () => {
    const { t, gc, milestone, agreement } = await setup();
    const out = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });

    const rows = await fundingRows(t, milestone._id);
    expect(rows).toHaveLength(1);
    const p = rows[0];
    expect(p).toMatchObject({
      kind: "funding",
      status: "created",
      paypalOrderId: out.orderId,
      grossCents: milestone.amountCents,
      agreementId: agreement._id,
      auditRecorded: true,
    });
    expect(p.idempotencyKey.length).toBeGreaterThan(0);

    const creates = fake.posts(/^\/v2\/checkout\/orders$/);
    expect(creates).toHaveLength(1);
    expect(creates[0].requestId).toBe(p.idempotencyKey);
    const body = creates[0].body as { intent: string; purchase_units: Array<{ amount: { value: string; currency_code: string } }> };
    expect(body.intent).toBe("AUTHORIZE");
    expect(body.purchase_units[0].amount).toEqual({
      currency_code: "USD",
      value: centsAsDecimalText(milestone.amountCents),
    });
    expect(body.purchase_units[0].amount.value).toMatch(/^\d+\.\d{2}$/);

    const m = await t.run((ctx) => ctx.db.get(milestone._id));
    expect(m?.status).toBe("funding");
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.filter((a) => a.operation === "paypal.orders.create" && a.paypalRequestId === p.idempotencyKey)).toHaveLength(1);
  });

  test("a second click reuses the open order; concurrent clicks yield one order and one payment", async () => {
    const { t, gc, milestone, milestones } = await setup();
    const first = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    const again = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    expect(again).toEqual({ ...first, reused: true });
    expect(fake.posts(/^\/v2\/checkout\/orders$/)).toHaveLength(1);

    const other = milestones[1];
    const [a, b] = await Promise.all([
      gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: other._id }),
      gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: other._id }),
    ]);
    expect(a.orderId).toBe(b.orderId);
    expect(await fundingRows(t, other._id)).toHaveLength(1);
    const keys = new Set(fake.posts(/^\/v2\/checkout\/orders$/).slice(1).map((c) => c.requestId));
    expect(keys.size).toBe(1);
  });

  test.each(["sub", "owner", null] as const)("role %s cannot create funding orders", async (role) => {
    const { t, milestone } = await setup();
    const caller = role === null ? t : (await signInAs(t, role)).as;
    const err = await errorOf(caller.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id }));
    expect(String(err.data?.message ?? err.message)).toMatch(/Not authenticated|Forbidden|Not found/);
    expect(fake.calls).toHaveLength(0);
    expect(await fundingRows(t, milestone._id)).toHaveLength(0);
  });
});

describe("authorizeFundingOrder", () => {
  test("stores the authorization id, 29-day expiry and 3-day honor period; the milestone is funded", async () => {
    const { t, gc, milestone } = await setup();
    const { orderId } = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    const res = await gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId });

    expect(res.alreadyAuthorized).toBe(false);
    const [p] = await fundingRows(t, milestone._id);
    expect(p.status).toBe("authorized");
    expect(p.paypalAuthorizationId).toBe(`AUTH-${orderId}`);
    expect(p.authorizationExpiresAt).toBe(Date.parse(AUTH_EXPIRATION_TIME));
    expect(p.honorPeriodEndsAt).toBe(Date.parse(AUTH_CREATE_TIME) + 3 * DAY_MS);
    expect(p.auditRecorded).toBe(true);
    const auth = fake.posts(/\/authorize$/);
    expect(auth).toHaveLength(1);
    expect(auth[0].requestId).toBe(`${p.idempotencyKey}_auth`);
    expect((await t.run((ctx) => ctx.db.get(milestone._id)))?.status).toBe("funded");
  });

  test("a repeated onApprove returns the stored authorization without a second PayPal write", async () => {
    const { t, gc, milestone } = await setup();
    const { orderId } = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    const [a, b] = await Promise.all([
      gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId }),
      gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId }),
    ]);
    expect(a.paypalAuthorizationId).toBe(b.paypalAuthorizationId);
    const c = await gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId });
    expect(c.alreadyAuthorized).toBe(true);
    const authorizePosts = fake.posts(/\/authorize$/);
    expect(new Set(authorizePosts.map((x) => x.requestId)).size).toBe(1);
    expect(authorizePosts.length).toBeLessThanOrEqual(2);

    const rows = await fundingRows(t, milestone._id);
    expect(rows.filter((r) => r.status === "authorized")).toHaveLength(1);

    const err = await errorOf(gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id }));
    expect(err.data.code).toBe("ALREADY_FUNDED");
    expect(fake.posts(/^\/v2\/checkout\/orders$/)).toHaveLength(1);
  });

  test("a declined card fails the attempt with a readable error; a retry funds exactly once", async () => {
    const { t, gc, milestone } = await setup();
    const first = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    declined.add(first.orderId);
    const err = await errorOf(gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId: first.orderId }));
    expect(err).toBeInstanceOf(ConvexError);
    expect(err.data.code).toBe("FUNDING_DECLINED");
    expect(err.data.message).toContain("Card declined");
    expect(err.data.message).toContain("INSTRUMENT_DECLINED");

    let rows = await fundingRows(t, milestone._id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("INSTRUMENT_DECLINED");
    expect(rows[0].paypalAuthorizationId).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(milestone._id)))?.status).toBe("planned");
    const failedAudit = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).filter((a) => a.operation === "paypal.orders.authorize"),
    );
    expect(failedAudit).toEqual([expect.objectContaining({ httpStatus: 422, paypalOutcome: "failed" })]);

    // Re-approving the failed order does not reach PayPal again.
    const closed = await errorOf(gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId: first.orderId }));
    expect(closed.data.code).toBe("FUNDING_CLOSED");
    expect(fake.posts(/\/authorize$/)).toHaveLength(1);

    const retry = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    expect(retry.orderId).not.toBe(first.orderId);
    await gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId: retry.orderId });
    rows = await fundingRows(t, milestone._id);
    expect(rows.map((r) => r.status).sort()).toEqual(["authorized", "failed"]);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
    expect((await t.run((ctx) => ctx.db.get(milestone._id)))?.status).toBe("funded");
  });

  test("422 ORDER_ALREADY_AUTHORIZED recovers the existing authorization; no second order is possible", async () => {
    const { t, gc, milestone } = await setup();
    const { orderId } = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    fake.authorizeOutOfBand(orderId);

    const res = await gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId });
    expect(res.paypalAuthorizationId).toBe(`AUTH-${orderId}`);
    expect(res.authorizationExpiresAt).toBe(Date.parse(AUTH_EXPIRATION_TIME));
    const rows = await fundingRows(t, milestone._id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "authorized", paypalAuthorizationId: `AUTH-${orderId}` });
    expect(rows[0].error).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(milestone._id)))?.status).toBe("funded");
    expect(fake.calls.filter((c) => c.method === "GET" && c.path === `/v2/checkout/orders/${orderId}`)).toHaveLength(1);

    const err = await errorOf(gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id }));
    expect(err.data.code).toBe("ALREADY_FUNDED");
    expect(fake.posts(/^\/v2\/checkout\/orders$/)).toHaveLength(1);
  });

  test("ORDER_ALREADY_AUTHORIZED with only a voided authorization closes the attempt and allows a retry", async () => {
    const { t, gc, milestone } = await setup();
    const { orderId } = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    fake.authorizeOutOfBand(orderId);
    fake.authStatusByOrderId.set(orderId, "VOIDED");
    const err = await errorOf(gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId }));
    expect(err.data.code).toBe("FUNDING_DECLINED");
    expect(err.data.message).toContain("VOIDED");
    expect((await fundingRows(t, milestone._id))[0]).toMatchObject({ status: "failed" });
    expect((await t.run((ctx) => ctx.db.get(milestone._id)))?.status).toBe("planned");
    const retry = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    expect(retry.orderId).not.toBe(orderId);
  });

  test("a lost authorize response, then a retry after key retention, records exactly one authorization", async () => {
    const { t, gc, milestone } = await setup();
    const { orderId } = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    lostResponse.add(orderId);
    const lost = await errorOf(gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId }));
    expect(lost.data.code).toBe("PAYPAL_NETWORK_ERROR");
    expect((await fundingRows(t, milestone._id))[0].status).toBe("approved");
    const blocked = await errorOf(gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id }));
    expect(blocked.data.code).toBe("FUNDING_IN_PROGRESS");

    lostResponse.delete(orderId);
    fake.forgetRequestIds();
    const res = await gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId });
    expect(res.paypalAuthorizationId).toBe(`AUTH-${orderId}`);
    expect(fake.authByOrderId.size).toBe(1);
    const rows = await fundingRows(t, milestone._id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "authorized", paypalAuthorizationId: `AUTH-${orderId}` });
    expect((await t.run((ctx) => ctx.db.get(milestone._id)))?.status).toBe("funded");
    expect(fake.posts(/^\/v2\/checkout\/orders$/)).toHaveLength(1);
  }, 15_000);

  test("a conflicting duplicate authorize leaves the attempt open so the in-flight success can record", async () => {
    const { t, gc, milestone } = await setup();
    const { orderId } = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    conflicted.add(orderId);
    const err = await errorOf(gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId }));
    expect(err.data.code).toBe("FUNDING_IN_PROGRESS");
    expect((await fundingRows(t, milestone._id))[0].status).toBe("approved");
    expect((await t.run((ctx) => ctx.db.get(milestone._id)))?.status).toBe("funding");

    conflicted.delete(orderId);
    const res = await gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId });
    expect(res.paypalAuthorizationId).toBe(`AUTH-${orderId}`);
    const rows = await fundingRows(t, milestone._id);
    expect(rows.map((r) => r.status)).toEqual(["authorized"]);
  });

  test.each(["sub", "owner", null] as const)("role %s cannot authorize", async (role) => {
    const { t, gc, milestone } = await setup();
    const { orderId } = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    const caller = role === null ? t : (await signInAs(t, role)).as;
    const err = await errorOf(caller.action(api.payments.orders.authorizeFundingOrder, { orderId }));
    expect(String(err.data?.message ?? err.message)).toMatch(/Not authenticated|Forbidden|Not found/);
    expect(fake.posts(/\/authorize$/)).toHaveLength(0);
    expect((await fundingRows(t, milestone._id))[0].status).toBe("created");
  });
});

describe("audit flag on the payments row", () => {
  test("an unrecorded audit is stored as auditRecorded false and stays false", async () => {
    const { t, gc, milestone } = await setup();
    const prepared = await t.mutation(internal.payments.funding.prepareFundingOrder, {
      milestoneId: milestone._id,
      userId: gc.userId,
    });
    await t.mutation(internal.payments.funding.recordFundingOrderCreated, {
      paymentId: prepared.paymentId,
      paypalOrderId: "ORDER-X",
      auditRecorded: false,
    });
    await t.mutation(internal.payments.funding.beginAuthorization, { paypalOrderId: "ORDER-X" });
    await t.mutation(internal.payments.funding.recordAuthorization, {
      paymentId: prepared.paymentId,
      paypalAuthorizationId: "AUTH-X",
      authorizationExpiresAt: 2,
      honorPeriodEndsAt: 1,
      auditRecorded: true,
    });
    const p = await t.run((ctx) => ctx.db.get(prepared.paymentId));
    expect(p).toMatchObject({ status: "authorized", auditRecorded: false });
  });
});

describe("audit flag on duplicate authorization results", () => {
  test("an audited success followed by an unaudited duplicate leaves auditRecorded false", async () => {
    const { t, gc, milestone } = await setup();
    const prepared = await t.mutation(internal.payments.funding.prepareFundingOrder, {
      milestoneId: milestone._id,
      userId: gc.userId,
    });
    await t.mutation(internal.payments.funding.recordFundingOrderCreated, {
      paymentId: prepared.paymentId,
      paypalOrderId: "ORDER-Y",
      auditRecorded: true,
    });
    await t.mutation(internal.payments.funding.beginAuthorization, { paypalOrderId: "ORDER-Y" });
    const record = (auditRecorded: boolean) =>
      t.mutation(internal.payments.funding.recordAuthorization, {
        paymentId: prepared.paymentId,
        paypalAuthorizationId: "AUTH-Y",
        authorizationExpiresAt: 2,
        honorPeriodEndsAt: 1,
        auditRecorded,
      });
    await record(true);
    expect(await t.run((ctx) => ctx.db.get(prepared.paymentId))).toMatchObject({ status: "authorized", auditRecorded: true });
    await record(false);
    await record(true);
    expect(await t.run((ctx) => ctx.db.get(prepared.paymentId))).toMatchObject({
      status: "authorized",
      paypalAuthorizationId: "AUTH-Y",
      auditRecorded: false,
    });
  });
});

describe("ledger funding summary", () => {
  test("GC sees canFund and the latest attempt; a sub does not get canFund", async () => {
    const { t, gc, agreement, milestone } = await setup();
    const { orderId } = await gc.as.action(api.payments.orders.createFundingOrder, { milestoneId: milestone._id });
    await gc.as.action(api.payments.orders.authorizeFundingOrder, { orderId });
    const ledger = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(ledger?.canFund).toBe(true);
    const row = ledger?.milestones.find((m) => m._id === milestone._id);
    expect(row?.status).toBe("funded");
    expect(row?.funding).toMatchObject({ status: "authorized", paypalAuthorizationId: `AUTH-${orderId}` });

    const sub = await signInAs(t, "sub", { contractorId: agreement.contractorId });
    const subLedger = await sub.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(subLedger?.canFund).toBe(false);
  });
});

// Independent oracle for the PayPal amount string (digit slicing, no float math).
function centsAsDecimalText(cents: number): string {
  const digits = String(cents).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
