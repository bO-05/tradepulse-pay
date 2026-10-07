/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { clearPayPalTokenCache } from "./paypalClient";

const modules = import.meta.glob("/convex/**/*.ts");

const SUB_EMAIL = "sub1-sandbox@paypal.test";
const AUTH_ID = "AUTH-1";

type Call = { method: string; path: string; requestId?: string; body: unknown };

/** Fake PayPal sandbox for captures, voids and payouts; idempotent like the real API. */
function fakePayPal() {
  const calls: Call[] = [];
  const captureByRequestId = new Map<string, string>();
  const voided = new Set<string>();
  const batches = new Map<string, { id: string; senderBatchId: string; senderItemId?: string; receiver: string; value: string }>();
  const itemStatus = new Map<string, string>();
  const state = { defaultItemStatus: "SUCCESS", dropNextPayoutResponse: false, insufficientFunds: 0, n: 0 };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21AAfaketoken", expires_in: 32400 });
    const text = req.method === "GET" ? "" : await req.text();
    const requestId = req.headers.get("paypal-request-id") ?? undefined;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: url.pathname, requestId, body });

    const cap = url.pathname.match(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/);
    if (req.method === "POST" && cap) {
      if (voided.has(cap[1])) {
        return json(422, {
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed.",
          details: [{ issue: "AUTHORIZATION_VOIDED", description: "A voided authorization cannot be captured." }],
          debug_id: "dbg-voided",
        });
      }
      let id = requestId ? captureByRequestId.get(requestId) : undefined;
      if (!id) {
        id = `CAP-${++state.n}`;
        if (requestId) captureByRequestId.set(requestId, id);
      }
      return json(201, { id, status: "COMPLETED", amount: { currency_code: "USD", value: body.amount.value }, final_capture: body.final_capture });
    }
    const vd = url.pathname.match(/^\/v2\/payments\/authorizations\/([^/]+)\/void$/);
    if (req.method === "POST" && vd) {
      voided.add(vd[1]);
      return new Response(null, { status: 204 });
    }
    if (req.method === "POST" && url.pathname === "/v1/payments/payouts") {
      const sb = body.sender_batch_header.sender_batch_id as string;
      if (state.insufficientFunds > 0) {
        state.insufficientFunds--;
        return json(422, {
          name: "INSUFFICIENT_FUNDS",
          message: "Sender does not have sufficient funds. Please add funds and retry.",
          debug_id: "dbg-funds",
        });
      }
      const existing = [...batches.values()].find((b) => b.senderBatchId === sb);
      if (existing) {
        return json(400, {
          name: "USER_BUSINESS_ERROR",
          message: "User business error.",
          debug_id: "dbg-dup",
          details: [
            {
              field: "SENDER_BATCH_ID",
              issue: "Batch with given sender_batch_id already exists",
              link: [{ href: `https://api.sandbox.paypal.com/v1/payments/payouts/${existing.id}`, rel: "self", method: "GET" }],
            },
          ],
          links: [],
        });
      }
      const id = `BATCH-${++state.n}`;
      const item = body.items[0];
      batches.set(id, { id, senderBatchId: sb, senderItemId: item.sender_item_id, receiver: item.receiver, value: item.amount.value });
      if (state.dropNextPayoutResponse) {
        state.dropNextPayoutResponse = false;
        throw new TypeError("fetch failed: connection reset");
      }
      return json(201, { batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: { sender_batch_id: sb } } });
    }
    const getBatch = url.pathname.match(/^\/v1\/payments\/payouts\/([^/]+)$/);
    if (req.method === "GET" && getBatch) {
      const b = batches.get(getBatch[1]);
      if (!b) return json(404, { name: "RESOURCE_NOT_FOUND" });
      const status = itemStatus.get(b.id) ?? state.defaultItemStatus;
      return json(200, {
        batch_header: { payout_batch_id: b.id, batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: b.senderBatchId } },
        items: [
          {
            payout_item_id: `ITEM-${b.id}`,
            transaction_status: status,
            payout_item: { sender_item_id: b.senderItemId, receiver: b.receiver, amount: { value: b.value, currency: "USD" } },
            ...(status === "UNCLAIMED" ? { errors: { name: "RECEIVER_UNREGISTERED" } } : {}),
          },
        ],
      });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  });
  const posts = (path: RegExp) => calls.filter((c) => c.method === "POST" && path.test(c.path));
  return { fetchImpl, calls, posts, voided, batches, itemStatus, state };
}

async function setup(opts: { authorizedCents?: number; capturedCents?: number } = {}) {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  const agreement = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  const milestone = await t.run(
    async (ctx) =>
      (await ctx.db
        .query("milestones")
        .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
        .first())!,
  );
  const sub = await signInAs(t, "sub", { contractorId: agreement.contractorId, paypalEmail: SUB_EMAIL, email: "sub1@demo.tradepulse" });
  const authorizedCents = opts.authorizedCents ?? milestone.amountCents;
  const fundingId = await t.run(async (ctx) => {
    await ctx.db.patch(milestone._id, { status: "funded", amountCents: authorizedCents });
    return await ctx.db.insert("payments", {
      agreementId: agreement._id,
      milestoneId: milestone._id,
      kind: "funding",
      status: "authorized",
      paypalOrderId: "ORDER-1",
      paypalAuthorizationId: AUTH_ID,
      authorizationExpiresAt: Date.now() + 29 * 86_400_000,
      honorPeriodEndsAt: Date.now() + 3 * 86_400_000,
      grossCents: authorizedCents,
      retainageCents: 0,
      netCents: authorizedCents,
      idempotencyKey: `fund_${milestone._id}_1`,
      createdAt: Date.now(),
    });
  });
  return { t, gc, sub, agreement, milestone: { ...milestone, amountCents: authorizedCents }, fundingId };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function rows(t: Setup["t"], milestoneId: Id<"milestones">) {
  return await t.run(async (ctx) => {
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_milestoneId", (q) => q.eq("milestoneId", milestoneId))
      .collect();
    const ledger = await ctx.db.query("retainageLedger").collect();
    const milestone = await ctx.db.get(milestoneId);
    const audits = await ctx.db.query("auditLogs").filter((q) => q.eq(q.field("eventType"), "paypal_write")).collect();
    return {
      funding: payments.find((p) => p.kind === "funding")!,
      payouts: payments.filter((p) => p.kind === "payout"),
      ledger,
      milestone: milestone!,
      audits,
    };
  });
}

async function errorOf(p: Promise<unknown>): Promise<ConvexError<{ code: string; message: string }>> {
  try {
    await p;
  } catch (e) {
    return e as ConvexError<{ code: string; message: string }>;
  }
  throw new Error("expected the call to fail");
}

const key = (s: string) => `test-key-${s}`;
let fake: ReturnType<typeof fakePayPal>;

beforeEach(() => {
  vi.useFakeTimers();
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

describe("release & pay: capture", () => {
  test("a partial release captures with final_capture false and pays the net of 10% retainage", async () => {
    const { t, gc, milestone } = await setup({ authorizedCents: 1_500_000 });
    const out = await gc.as.action(api.payments.release.releaseAndPay, {
      milestoneId: milestone._id,
      amountCents: 1_000_000,
      requestKey: key("partial"),
    });
    expect(out.state).toBe("pending");

    const captures = fake.posts(/\/capture$/);
    expect(captures).toHaveLength(1);
    expect(captures[0].path).toBe(`/v2/payments/authorizations/${AUTH_ID}/capture`);
    expect(captures[0].body).toEqual({ amount: { currency_code: "USD", value: "10000.00" }, final_capture: false });

    const r = await rows(t, milestone._id);
    expect(r.funding).toMatchObject({ status: "partially_captured", capturedCents: 1_000_000, paypalCaptureId: out.captureId });
    expect(r.payouts).toHaveLength(1);
    const payout = r.payouts[0];
    expect(payout).toMatchObject({
      status: "pending",
      grossCents: 1_000_000,
      retainageCents: 100_000,
      netCents: 900_000,
      receiverEmail: SUB_EMAIL,
      paypalPayoutBatchId: out.batchId,
      fundingPaymentId: r.funding._id,
    });
    expect(captures[0].requestId).toBe(`cap_${payout.idempotencyKey}`);

    const payouts = fake.posts(/^\/v1\/payments\/payouts$/);
    expect(payouts).toHaveLength(1);
    const body = payouts[0].body as {
      sender_batch_header: { sender_batch_id: string };
      items: Array<{ recipient_type: string; receiver: string; amount: { value: string; currency: string } }>;
    };
    expect(body.sender_batch_header.sender_batch_id).toBe(payout.idempotencyKey);
    expect(payouts[0].requestId).toBe(payout.idempotencyKey);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ recipient_type: "EMAIL", receiver: SUB_EMAIL, amount: { value: "9000.00", currency: "USD" } });

    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({ paymentId: payout._id, deltaCents: 100_000 });
    expect(r.ledger[0].reason.length).toBeGreaterThan(0);
    expect(r.milestone.status).toBe("in_progress");

    const ops = r.audits.map((a) => [a.operation, a.paypalRequestId, a.paypalOutcome]);
    expect(ops).toContainEqual(["paypal.authorizations.capture", `cap_${payout.idempotencyKey}`, "succeeded"]);
    expect(ops).toContainEqual(["paypal.payouts.create", payout.idempotencyKey, "succeeded"]);
  });

  test("the batch poll marks the payout paid; closing the milestone voids the remainder", async () => {
    const { t, gc, milestone } = await setup({ authorizedCents: 1_000_000 });
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 600_000, requestKey: key("p1") });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let r = await rows(t, milestone._id);
    expect(r.payouts[0]).toMatchObject({ status: "success", paypalPayoutItemId: `ITEM-${r.payouts[0].paypalPayoutBatchId}` });
    // 6,000 of 10,000 paid: not the full milestone amount.
    expect(r.milestone.status).toBe("in_progress");

    await gc.as.action(api.payments.release.closeMilestone, { milestoneId: milestone._id });
    expect(fake.posts(/\/void$/)).toHaveLength(1);
    r = await rows(t, milestone._id);
    expect(r.funding.status).toBe("voided");
    expect(r.funding.capturedCents).toBe(600_000);
    expect(r.milestone.status).toBe("complete");
    expect(r.audits.filter((a) => a.operation === "paypal.authorizations.void")).toHaveLength(1);

    const err = await errorOf(
      gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 100, requestKey: key("p2") }),
    );
    expect(err.data.code).toBe("NOT_RELEASABLE");
    expect(fake.posts(/\/capture$/)).toHaveLength(1);
  });

  test("releasing the full authorized amount is a final capture with no void, and the milestone becomes paid", async () => {
    const { t, gc, milestone } = await setup({ authorizedCents: 1_000_000 });
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 1_000_000, requestKey: key("full") });
    expect((fake.posts(/\/capture$/)[0].body as { final_capture: boolean }).final_capture).toBe(true);
    let r = await rows(t, milestone._id);
    expect(r.funding.status).toBe("captured");
    expect(r.milestone.status).toBe("complete");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    r = await rows(t, milestone._id);
    expect(r.payouts[0].status).toBe("success");
    expect(r.milestone.status).toBe("paid");
    expect(fake.posts(/\/void$/)).toHaveLength(0);
    expect(r.audits.some((a) => a.operation === "paypal.authorizations.void")).toBe(false);
  });

  test("an amount above the remaining authorization is refused before any PayPal call", async () => {
    const { t, gc, milestone } = await setup({ authorizedCents: 1_000_000 });
    const err = await errorOf(
      gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 1_000_001, requestKey: key("big") }),
    );
    expect(err.data.code).toBe("INVALID_AMOUNT");
    expect(fake.calls).toHaveLength(0);
    expect((await rows(t, milestone._id)).payouts).toHaveLength(0);
  });

  test("a PayPal 4xx on capture is readable, stored, audited, and changes no capture, payout or ledger", async () => {
    const { t, gc, milestone } = await setup({ authorizedCents: 1_000_000 });
    fake.voided.add(AUTH_ID);
    const err = await errorOf(
      gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 500_000, requestKey: key("void") }),
    );
    expect(err.data.code).toBe("CAPTURE_FAILED");
    expect(err.data.message).toMatch(/AUTHORIZATION_VOIDED/);
    expect(err.data.message).toMatch(/UNPROCESSABLE_ENTITY/);
    const r = await rows(t, milestone._id);
    expect(r.funding.status).toBe("authorized");
    expect(r.funding.paypalCaptureId).toBeUndefined();
    expect(r.funding.capturedCents).toBeUndefined();
    expect(r.funding.error).toMatch(/AUTHORIZATION_VOIDED/);
    expect(r.payouts).toHaveLength(1);
    expect(r.payouts[0]).toMatchObject({ status: "failed" });
    expect(r.payouts[0].paypalPayoutBatchId).toBeUndefined();
    expect(r.payouts[0].error).toMatch(/AUTHORIZATION_VOIDED/);
    expect(r.ledger).toHaveLength(0);
    expect(fake.posts(/^\/v1\/payments\/payouts$/)).toHaveLength(0);
    const failed = r.audits.filter((a) => a.operation === "paypal.authorizations.capture");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ httpStatus: 422, paypalOutcome: "failed" });
  });
});

describe("release & pay: idempotency", () => {
  test("a double click (same request key) yields one capture, one payout and one ledger credit", async () => {
    const { t, gc, milestone } = await setup({ authorizedCents: 1_000_000 });
    const args = { milestoneId: milestone._id, amountCents: 400_000, requestKey: key("dbl") };
    const [a, b] = await Promise.all([
      gc.as.action(api.payments.release.releaseAndPay, args),
      gc.as.action(api.payments.release.releaseAndPay, args),
    ]);
    expect([a.state, b.state].sort()).toEqual(["busy", "pending"]);
    const again = await gc.as.action(api.payments.release.releaseAndPay, args);
    expect(again.state).toBe("already_processed");
    const r = await rows(t, milestone._id);
    expect(r.payouts).toHaveLength(1);
    expect(r.funding.captures).toHaveLength(1);
    expect(r.funding.capturedCents).toBe(400_000);
    expect(r.ledger).toHaveLength(1);
    expect(fake.posts(/\/capture$/)).toHaveLength(1);
    expect(fake.batches.size).toBe(1);
  });

  test("two clicks with different keys while one release is in flight still release once", async () => {
    const { t, gc, milestone } = await setup({ authorizedCents: 1_000_000 });
    const [a, b] = await Promise.all([
      gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 400_000, requestKey: key("k1") }),
      gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 400_000, requestKey: key("k2") }),
    ]);
    expect([a.state, b.state].sort()).toEqual(["busy", "pending"]);
    const r = await rows(t, milestone._id);
    expect(r.payouts).toHaveLength(1);
    expect(fake.batches.size).toBe(1);
  });

  test("a lost payout response resolves through the duplicate sender_batch_id 400 to the existing batch", async () => {
    const { t, gc, milestone } = await setup({ authorizedCents: 1_000_000 });
    fake.state.dropNextPayoutResponse = true;
    const p = gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 1_000_000, requestKey: key("lost") });
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await p;
    const posts = fake.posts(/^\/v1\/payments\/payouts$/);
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((c) => (c.body as { sender_batch_header: { sender_batch_id: string } }).sender_batch_header.sender_batch_id)).size).toBe(1);
    expect(fake.batches.size).toBe(1);
    const [batchId] = [...fake.batches.keys()];
    expect(out.batchId).toBe(batchId);
    expect(out.message).toMatch(/not sent twice/);
    const r = await rows(t, milestone._id);
    expect(r.payouts).toHaveLength(1);
    expect(r.payouts[0]).toMatchObject({ status: "pending", paypalPayoutBatchId: batchId });
    expect(r.ledger).toHaveLength(1);
    const payoutAudits = r.audits.filter((a) => a.operation === "paypal.payouts.create");
    expect(payoutAudits).toHaveLength(1);
    expect(payoutAudits[0]).toMatchObject({ httpStatus: 400, paypalRequestId: r.payouts[0].idempotencyKey });

    // Calling the service function again makes no PayPal write.
    const before = fake.calls.length;
    const again = await t.action(internal.payments.payouts.payoutSubInternal, { paymentId: r.payouts[0]._id });
    expect(again).toMatchObject({ batchId, alreadySent: true });
    expect(fake.calls.length).toBe(before);
  });
});

test("a transient INSUFFICIENT_FUNDS payout is retried with the same sender_batch_id and then paid", async () => {
  const { t, gc, milestone } = await setup({ authorizedCents: 1_000_000 });
  fake.state.insufficientFunds = 1;
  const out = await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 1_000_000, requestKey: key("funds") });
  expect(out.state).toBe("pending");
  let r = await rows(t, milestone._id);
  expect(r.payouts[0].status).toBe("created");
  expect(r.payouts[0].error).toMatch(/INSUFFICIENT_FUNDS/);
  expect(r.ledger).toHaveLength(0);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  r = await rows(t, milestone._id);
  expect(r.payouts[0].status).toBe("success");
  expect(r.payouts[0].error).toBeUndefined();
  const posts = fake.posts(/^\/v1\/payments\/payouts$/);
  expect(posts).toHaveLength(2);
  expect(new Set(posts.map((c) => c.requestId)).size).toBe(1);
  expect(fake.batches.size).toBe(1);
  expect(r.ledger).toHaveLength(1);
  expect(fake.posts(/\/capture$/)).toHaveLength(1);
});

describe("retainage ledger", () => {
  test("payouts of $10,000 and $5,000 gross hold $1,500 and the ledger view shows it", async () => {
    const { t, gc, milestone, agreement } = await setup({ authorizedCents: 2_000_000 });
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 1_000_000, requestKey: key("a") });
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 500_000, requestKey: key("b") });
    const r = await rows(t, milestone._id);
    expect(r.ledger.map((l) => l.deltaCents).sort()).toEqual([100_000, 50_000].sort());
    expect(r.ledger.reduce((a, l) => a + l.deltaCents, 0)).toBe(150_000);
    const ledger = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(ledger?.totals.retainageHeldCents).toBe(150_000);
    expect(ledger?.canRelease).toBe(true);
    const m = ledger?.milestones.find((x) => x._id === milestone._id);
    expect(m?.releases).toHaveLength(2);
    expect(m?.funding?.capturedCents).toBe(1_500_000);
  });

  test("odd gross 333333 cents holds 33333 and pays 3000.00 (integer cents only)", async () => {
    const { t, milestone } = await setup({ authorizedCents: 1_000_000 });
    await t.action(internal.payments.release.releaseAndPayInternal, { milestoneId: milestone._id, amountCents: 333_333, requestKey: key("odd") });
    const r = await rows(t, milestone._id);
    expect(r.payouts[0]).toMatchObject({ grossCents: 333_333, retainageCents: 33_333, netCents: 300_000 });
    expect(r.ledger[0].deltaCents).toBe(33_333);
    const item = (fake.posts(/^\/v1\/payments\/payouts$/)[0].body as { items: Array<{ amount: { value: string } }> }).items[0];
    expect(item.amount.value).toBe("3000.00");
    for (const n of [r.payouts[0].grossCents, r.payouts[0].retainageCents, r.payouts[0].netCents, r.ledger[0].deltaCents]) {
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  test("an unclaimed payout is not paid and keeps its credit; a later return reverses it", async () => {
    const { t, gc, milestone, agreement } = await setup({ authorizedCents: 1_000_000 });
    fake.state.defaultItemStatus = "UNCLAIMED";
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 1_000_000, requestKey: key("unc") });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let r = await rows(t, milestone._id);
    expect(r.payouts[0]).toMatchObject({ status: "unclaimed", paypalItemStatus: "UNCLAIMED" });
    expect(r.payouts[0].error).toMatch(/Unclaimed.*RECEIVER_UNREGISTERED/);
    expect(r.milestone.status).not.toBe("paid");
    expect(r.ledger.reduce((a, l) => a + l.deltaCents, 0)).toBe(100_000);
    const ledger = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(ledger?.totals.paidCents).toBe(0);

    await t.mutation(internal.payments.payoutDb.applyPayoutStatus, { paymentId: r.payouts[0]._id, status: "returned", itemStatus: "RETURNED" });
    r = await rows(t, milestone._id);
    expect(r.payouts[0].status).toBe("returned");
    expect(r.ledger).toHaveLength(2);
    expect(r.ledger.reduce((a, l) => a + l.deltaCents, 0)).toBe(0);
    // A repeated webhook is a no-op.
    await t.mutation(internal.payments.payoutDb.applyPayoutStatus, { paymentId: r.payouts[0]._id, status: "returned", itemStatus: "RETURNED" });
    expect((await rows(t, milestone._id)).ledger).toHaveLength(2);
  });

  test("a failed payout item reverses its retainage credit", async () => {
    const { t, gc, milestone } = await setup({ authorizedCents: 1_000_000 });
    fake.state.defaultItemStatus = "FAILED";
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 500_000, requestKey: key("fail") });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await rows(t, milestone._id);
    expect(r.payouts[0].status).toBe("failed");
    expect(r.ledger.reduce((a, l) => a + l.deltaCents, 0)).toBe(0);
  });
});

describe("access and audit", () => {
  test.each(["sub", "owner", null] as const)("role %s cannot release & pay", async (role) => {
    const { t, milestone } = await setup({ authorizedCents: 1_000_000 });
    const caller = role === null ? t : (await signInAs(t, role)).as;
    const err = await errorOf(
      caller.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 100_000, requestKey: key("deny") }),
    );
    expect(String(err.data?.message ?? err.message)).toMatch(/Not authenticated|Forbidden/);
    expect(fake.calls).toHaveLength(0);
    expect((await rows(t, milestone._id)).payouts).toHaveLength(0);
  });

  test("a sub sees releases on its own agreement but no release control", async () => {
    const { gc, sub, milestone, agreement } = await setup({ authorizedCents: 1_000_000 });
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 100_000, requestKey: key("view") });
    const ledger = await sub.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(ledger?.canRelease).toBe(false);
    expect(ledger?.milestones.find((m) => m._id === milestone._id)?.releases).toHaveLength(1);
  });

  test("audit entries carry no secrets or tokens", async () => {
    const { t, gc, milestone } = await setup({ authorizedCents: 1_000_000 });
    fake.voided.add("nope");
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 600_000, requestKey: key("sec") });
    await gc.as.action(api.payments.release.closeMilestone, { milestoneId: milestone._id });
    const r = await rows(t, milestone._id);
    const blob = JSON.stringify([r.audits, r.payouts.map((p) => p.error), r.funding.error]);
    for (const s of ["test-secret-value", "A21AA", "Bearer ", "Authorization:"]) expect(blob).not.toContain(s);
    expect(new Set(r.audits.map((a) => a.operation))).toEqual(
      new Set(["paypal.authorizations.capture", "paypal.payouts.create", "paypal.authorizations.void"]),
    );
  });

  test("setPaypalEmailForTesting points a sub elsewhere and restores the env value", async () => {
    const { t } = await setup();
    vi.stubEnv("PAYPAL_SANDBOX_SUB1_EMAIL", "restored@paypal.test");
    await t.mutation(internal.profiles.setPaypalEmailForTesting, { email: "sub1@demo.tradepulse", paypalEmail: "nobody-1@example.com" });
    const read = () =>
      t.run(async (ctx) => {
        const user = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", "sub1@demo.tradepulse")).first();
        return (await ctx.db.query("userProfiles").withIndex("by_userId", (q) => q.eq("userId", user!._id)).unique())?.paypalEmail;
      });
    expect(await read()).toBe("nobody-1@example.com");
    const out = await t.mutation(internal.profiles.setPaypalEmailForTesting, { email: "sub1@demo.tradepulse" });
    expect(out.restoredFromEnv).toBe(true);
    expect(await read()).toBe("restored@paypal.test");
  });
});
