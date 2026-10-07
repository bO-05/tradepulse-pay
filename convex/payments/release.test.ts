/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { clearPayPalTokenCache } from "./paypalClient";
import { RESUME_RELEASE_AFTER_MS } from "./retainageMath";

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

describe("retry payout of a captured release", () => {
  async function failedRelease() {
    const s = await setup({ authorizedCents: 1_000_000 });
    fake.state.defaultItemStatus = "FAILED";
    await s.gc.as.action(api.payments.release.releaseAndPay, { milestoneId: s.milestone._id, amountCents: 1_000_000, requestKey: key("rt") });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    fake.state.defaultItemStatus = "SUCCESS";
    const r = await rows(s.t, s.milestone._id);
    expect(r.payouts[0].status).toBe("failed");
    return { ...s, original: r.payouts[0] };
  }

  test("the ledger counts a captured-but-failed release as captured, not paid, and offers a retry", async () => {
    const { t, gc, agreement, milestone, original } = await failedRelease();
    const ledger = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(ledger?.totals).toMatchObject({ capturedCents: 1_000_000, paidCents: 0, capturedNotPaidCents: 1_000_000, retainageHeldCents: 0 });
    const release = ledger?.milestones.find((m) => m._id === milestone._id)?.releases.find((x) => x.paymentId === original._id);
    expect(release).toMatchObject({ captured: true, canRetryPayout: true });
    const rec = await t.query(internal.payments.reconcile.ledgerReconciliation, { agreementId: agreement._id });
    expect(rec?.mismatches).toEqual([]);
    expect(rec?.rawSums.capturedNotPaidCents).toBe(1_000_000);
  });

  test("a GC retry sends a new batch <key>_r1 for the same net, pays once and credits retainage once", async () => {
    const { t, gc, agreement, milestone, original } = await failedRelease();
    const capturesBefore = fake.posts(/\/capture$/).length;
    const out = await gc.as.action(api.payments.payoutRetry.retryPayout, { paymentId: original._id });
    expect(out.idempotencyKey).toBe(`${original.idempotencyKey}_r1`);
    const posts = fake.posts(/^\/v1\/payments\/payouts$/);
    const last = posts[posts.length - 1];
    expect((last.body as { sender_batch_header: { sender_batch_id: string } }).sender_batch_header.sender_batch_id).toBe(
      `${original.idempotencyKey}_r1`,
    );
    expect((last.body as { items: Array<{ amount: { value: string } }> }).items[0].amount.value).toBe("9000.00");
    expect(fake.posts(/\/capture$/)).toHaveLength(capturesBefore);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await rows(t, milestone._id);
    const retry = r.payouts.find((p) => p.retryOfPaymentId === original._id)!;
    expect(retry).toMatchObject({ status: "success", netCents: 900_000, retainageCents: 100_000 });
    expect(r.ledger.reduce((a, l) => a + l.deltaCents, 0)).toBe(100_000);
    expect(r.milestone.status).toBe("paid");

    const audit = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .filter((q) => q.eq(q.field("eventType"), "payout_retry"))
        .collect(),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].description).toContain(`${original.idempotencyKey}_r1`);

    const ledger = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(ledger?.totals).toMatchObject({ capturedCents: 1_000_000, paidCents: 900_000, capturedNotPaidCents: 0, retainageHeldCents: 100_000 });

    // Retrying again (on the original or the retry) is refused: it will not be paid twice.
    for (const id of [original._id, retry._id]) {
      const err = await errorOf(gc.as.action(api.payments.payoutRetry.retryPayout, { paymentId: id }));
      expect(err.data.code).toBe("ALREADY_PAID");
    }
    expect(fake.posts(/^\/v1\/payments\/payouts$/)).toHaveLength(posts.length);

    const rec = await t.query(internal.payments.reconcile.ledgerReconciliation, { agreementId: agreement._id });
    expect(rec?.mismatches).toEqual([]);
    expect(rec?.rawSums).toMatchObject({ capturedCents: 1_000_000, paidCents: 900_000, retainageHeldCents: 100_000 });
  });

  test("a retry is refused while a payout for that release is in flight, and when nothing was captured", async () => {
    const { t, gc, milestone } = await setup({ authorizedCents: 1_000_000 });
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 500_000, requestKey: key("fl") });
    const pending = (await rows(t, milestone._id)).payouts[0];
    expect(pending.status).toBe("pending");
    expect((await errorOf(gc.as.action(api.payments.payoutRetry.retryPayout, { paymentId: pending._id }))).data.code).toBe("PAYOUT_IN_FLIGHT");

    const s2 = await setup({ authorizedCents: 1_000_000 });
    fake.voided.add(AUTH_ID);
    await errorOf(s2.gc.as.action(api.payments.release.releaseAndPay, { milestoneId: s2.milestone._id, amountCents: 100_000, requestKey: key("nc") }));
    const failed = (await rows(s2.t, s2.milestone._id)).payouts[0];
    expect((await errorOf(s2.gc.as.action(api.payments.payoutRetry.retryPayout, { paymentId: failed._id }))).data.code).toBe("NOT_CAPTURED");
  });

  test("a second failure allows _r2; subs, owners and anonymous callers cannot retry", async () => {
    const { t, gc, original } = await failedRelease();
    fake.state.defaultItemStatus = "FAILED";
    await gc.as.action(api.payments.payoutRetry.retryPayout, { paymentId: original._id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    fake.state.defaultItemStatus = "SUCCESS";
    const second = await gc.as.action(api.payments.payoutRetry.retryPayout, { paymentId: original._id });
    expect(second.idempotencyKey).toBe(`${original.idempotencyKey}_r2`);

    const before = fake.calls.length;
    for (const role of ["sub", "owner", null] as const) {
      const caller = role === null ? t : (await signInAs(t, role)).as;
      const err = await errorOf(caller.action(api.payments.payoutRetry.retryPayout, { paymentId: original._id }));
      expect(String(err.data?.message ?? err.message)).toMatch(/Not authenticated|Forbidden/);
    }
    expect(fake.calls.length).toBe(before);
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

describe("retainage release", () => {
  async function withBalance() {
    const s = await setup({ authorizedCents: 2_000_000 });
    await s.gc.as.action(api.payments.release.releaseAndPay, { milestoneId: s.milestone._id, amountCents: 1_000_000, requestKey: key("ra") });
    await s.gc.as.action(api.payments.release.releaseAndPay, { milestoneId: s.milestone._id, amountCents: 500_000, requestKey: key("rb") });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    return s;
  }
  async function releaseRows(t: Setup["t"], agreementId: Id<"agreements">) {
    return await t.run(async (ctx) => {
      const payments = await ctx.db
        .query("payments")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
        .collect();
      const ledger = await ctx.db
        .query("retainageLedger")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
        .collect();
      const audits = await ctx.db.query("auditLogs").filter((q) => q.eq(q.field("eventType"), "paypal_write")).collect();
      return {
        releases: payments.filter((p) => p.kind === "retainage_release"),
        ledger,
        balance: ledger.reduce((a, l) => a + l.deltaCents, 0),
        audits,
      };
    });
  }
  const payoutPosts = () => fake.posts(/^\/v1\/payments\/payouts$/);

  test("pays the sub exactly the ledger balance in one payout and brings the balance to 0", async () => {
    const { t, gc, agreement } = await withBalance();
    expect((await releaseRows(t, agreement._id)).balance).toBe(150_000);
    const before = payoutPosts().length;

    const out = await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id });
    expect(out).toMatchObject({ state: "pending", amountCents: 150_000 });
    const posts = payoutPosts().slice(before);
    expect(posts).toHaveLength(1);
    const body = posts[0].body as {
      sender_batch_header: { sender_batch_id: string };
      items: Array<{ receiver: string; amount: { value: string; currency: string } }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ receiver: SUB_EMAIL, amount: { value: "1500.00", currency: "USD" } });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await releaseRows(t, agreement._id);
    expect(r.releases).toHaveLength(1);
    expect(r.releases[0]).toMatchObject({
      status: "success",
      grossCents: 150_000,
      netCents: 150_000,
      retainageCents: 0,
      receiverEmail: SUB_EMAIL,
      paypalPayoutBatchId: out.batchId,
    });
    expect(body.sender_batch_header.sender_batch_id).toBe(r.releases[0].idempotencyKey);
    expect(posts[0].requestId).toBe(r.releases[0].idempotencyKey);
    const debits = r.ledger.filter((l) => l.paymentId === r.releases[0]._id);
    expect(debits.map((l) => l.deltaCents)).toEqual([-150_000]);
    expect(r.balance).toBe(0);
    expect(r.audits.filter((a) => a.paypalRequestId === r.releases[0].idempotencyKey)).toHaveLength(1);

    const ledger = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(ledger?.totals.retainageHeldCents).toBe(0);
    expect(ledger?.retainageReleasedCents).toBe(150_000);
    expect(ledger?.retainageReleases).toHaveLength(1);
    expect(ledger?.canReleaseRetainage).toBe(true);
    expect(ledger?.totals.paidCents).toBe(900_000 + 450_000 + 150_000);
  });

  test("a second release after success is a no-op with no PayPal call and no ledger row", async () => {
    const { t, gc, agreement } = await withBalance();
    await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const callsBefore = fake.calls.length;
    const before = await releaseRows(t, agreement._id);

    const again = await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id });
    expect(again.state).toBe("nothing_to_release");
    expect(fake.calls).toHaveLength(callsBefore);
    const after = await releaseRows(t, agreement._id);
    expect(after.releases).toHaveLength(1);
    expect(after.ledger).toHaveLength(before.ledger.length);
    expect(after.audits).toHaveLength(before.audits.length);
    expect(after.balance).toBe(0);
  });

  test("a zero balance releases nothing and makes no PayPal call or audit entry", async () => {
    const { t, gc, agreement } = await setup();
    const out = await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id });
    expect(out).toMatchObject({ state: "nothing_to_release", amountCents: 0 });
    expect(fake.calls).toHaveLength(0);
    const r = await releaseRows(t, agreement._id);
    expect(r.releases).toHaveLength(0);
    expect(r.audits).toHaveLength(0);
  });

  test("a release interrupted before PayPal answered is resumed with the same batch: one payout, one debit", async () => {
    const { t, gc, agreement } = await withBalance();
    const before = payoutPosts().length;
    // An earlier click created the release row but its action died before recording the batch.
    const begun = await t.mutation(internal.payments.retainageDb.beginRetainageRelease, { agreementId: agreement._id });
    expect(begun.state).toBe("new");
    fake.state.dropNextPayoutResponse = true;
    const p = gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id });
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await p;
    expect(out.message).toMatch(/not sent twice/);
    const again = await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id });
    expect(again.state).toBe("nothing_to_release");

    const posts = payoutPosts().slice(before);
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map((c) => (c.body as { sender_batch_header: { sender_batch_id: string } }).sender_batch_header.sender_batch_id)).size).toBe(1);
    const r = await releaseRows(t, agreement._id);
    expect(r.releases).toHaveLength(1);
    expect(r.releases[0]._id).toBe(out.paymentId);
    expect(r.ledger.filter((l) => l.paymentId === r.releases[0]._id).map((l) => l.deltaCents)).toEqual([-150_000]);
    expect(r.balance).toBe(0);
  });

  test("retainage credited by an unclaimed source payout is not releasable, so its later return cannot drive the ledger negative", async () => {
    const { t, gc, milestone, agreement } = await setup({ authorizedCents: 2_000_000 });
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 1_000_000, requestKey: key("ok") });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    fake.state.defaultItemStatus = "UNCLAIMED";
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 500_000, requestKey: key("unc") });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const unclaimed = (await rows(t, milestone._id)).payouts.find((p) => p.status === "unclaimed")!;
    expect(unclaimed.grossCents).toBe(500_000);
    expect((await releaseRows(t, agreement._id)).balance).toBe(150_000);

    const view = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(view?.totals.retainageHeldCents).toBe(150_000);
    expect(view?.retainageReleasableCents).toBe(100_000);

    fake.state.defaultItemStatus = "SUCCESS";
    const out = await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id });
    expect(out.amountCents).toBe(100_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await releaseRows(t, agreement._id)).balance).toBe(50_000);
    // The unclaimed credit is still not releasable.
    expect((await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id })).state).toBe("nothing_to_release");

    await t.mutation(internal.payments.payoutDb.applyPayoutStatus, { paymentId: unclaimed._id, status: "returned", itemStatus: "RETURNED" });
    const r = await releaseRows(t, agreement._id);
    expect(r.balance).toBe(0);
    let running = 0;
    for (const l of [...r.ledger].sort((a, b) => a._creationTime - b._creationTime)) {
      running += l.deltaCents;
      expect(running).toBeGreaterThanOrEqual(0);
    }
  });

  test("an unclaimed source payout that is later claimed becomes releasable", async () => {
    const { t, gc, milestone, agreement } = await setup({ authorizedCents: 1_000_000 });
    fake.state.defaultItemStatus = "UNCLAIMED";
    await gc.as.action(api.payments.release.releaseAndPay, { milestoneId: milestone._id, amountCents: 500_000, requestKey: key("cl") });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const before = payoutPosts().length;
    expect((await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id })).state).toBe("nothing_to_release");
    expect(payoutPosts()).toHaveLength(before);

    const source = (await rows(t, milestone._id)).payouts[0];
    await t.mutation(internal.payments.payoutDb.applyPayoutStatus, { paymentId: source._id, status: "success", itemStatus: "SUCCESS" });
    fake.state.defaultItemStatus = "SUCCESS";
    const out = await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id });
    expect(out.amountCents).toBe(50_000);
  });

  test("an interrupted created release offers resume only once it is stale, and resuming reuses the row and key", async () => {
    const { t, gc, sub, agreement } = await withBalance();
    const begun = await t.mutation(internal.payments.retainageDb.beginRetainageRelease, { agreementId: agreement._id });
    expect(begun.state).toBe("new");
    if (begun.state !== "new") throw new Error("expected a new release");
    const row = (await releaseRows(t, agreement._id)).releases[0];

    let view = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(view?.retainageReleases[0]).toMatchObject({ status: "created", updatedAt: row.createdAt });
    // Too early: the action that created it may still be talking to PayPal.
    const early = await errorOf(gc.as.action(api.payments.retainage.resumeRetainageRelease, { paymentId: begun.paymentId }));
    expect(early.data.code).toBe("RELEASE_IN_PROGRESS");

    vi.advanceTimersByTime(RESUME_RELEASE_AFTER_MS + 1_000);
    for (const role of ["sub", "owner", null] as const) {
      const caller = role === null ? t : role === "sub" ? sub.as : (await signInAs(t, role)).as;
      const err = await errorOf(caller.action(api.payments.retainage.resumeRetainageRelease, { paymentId: begun.paymentId }));
      expect(String(err.data?.message ?? err.message)).toMatch(/Not authenticated|Forbidden/);
    }
    const before = payoutPosts().length;
    const out = await gc.as.action(api.payments.retainage.resumeRetainageRelease, { paymentId: begun.paymentId });
    expect(out).toMatchObject({ paymentId: begun.paymentId, amountCents: 150_000 });
    const posts = payoutPosts().slice(before);
    expect(posts).toHaveLength(1);
    expect((posts[0].body as { sender_batch_header: { sender_batch_id: string } }).sender_batch_header.sender_batch_id).toBe(row.idempotencyKey);

    // Resuming again hits the stored batch: no second POST, no second debit.
    await gc.as.action(api.payments.retainage.resumeRetainageRelease, { paymentId: begun.paymentId });
    expect(payoutPosts().slice(before)).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await releaseRows(t, agreement._id);
    expect(r.releases).toHaveLength(1);
    expect(r.releases[0].status).toBe("success");
    expect(r.ledger.filter((l) => l.paymentId === row._id).map((l) => l.deltaCents)).toEqual([-150_000]);
    expect(r.balance).toBe(0);
    view = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(view?.retainageReleasableCents).toBe(0);
  });

  test("resuming a release whose batch PayPal created before the interruption resolves the duplicate 400", async () => {
    const { t, gc, agreement } = await withBalance();
    const begun = await t.mutation(internal.payments.retainageDb.beginRetainageRelease, { agreementId: agreement._id });
    if (begun.state !== "new") throw new Error("expected a new release");
    const row = (await releaseRows(t, agreement._id)).releases[0];
    // PayPal accepted the batch, but the response never reached the action.
    fake.batches.set("BATCH-PRE", { id: "BATCH-PRE", senderBatchId: row.idempotencyKey, senderItemId: row._id, receiver: SUB_EMAIL, value: "1500.00" });
    vi.advanceTimersByTime(RESUME_RELEASE_AFTER_MS + 1_000);

    const out = await gc.as.action(api.payments.retainage.resumeRetainageRelease, { paymentId: begun.paymentId });
    expect(out.batchId).toBe("BATCH-PRE");
    expect(out.message).toMatch(/not sent twice/);
    expect(fake.batches.size).toBe(3);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await releaseRows(t, agreement._id);
    expect(r.releases[0]).toMatchObject({ status: "success", paypalPayoutBatchId: "BATCH-PRE" });
    expect(r.ledger.filter((l) => l.paymentId === row._id).map((l) => l.deltaCents)).toEqual([-150_000]);
    expect(r.balance).toBe(0);
  });

  test("a failed release puts the retainage back on hold so it can be released again", async () => {
    const { t, gc, agreement } = await withBalance();
    fake.state.defaultItemStatus = "FAILED";
    await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let r = await releaseRows(t, agreement._id);
    expect(r.releases[0].status).toBe("failed");
    expect(r.releases[0].error).toMatch(/held again/);
    expect(r.balance).toBe(150_000);

    fake.state.defaultItemStatus = "SUCCESS";
    const out = await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id });
    expect(out.amountCents).toBe(150_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    r = await releaseRows(t, agreement._id);
    expect(r.releases.map((p) => p.status)).toEqual(["failed", "success"]);
    expect(new Set(r.releases.map((p) => p.idempotencyKey)).size).toBe(2);
    expect(r.balance).toBe(0);
  });

  test.each(["sub", "owner", null] as const)("role %s cannot release retainage", async (role) => {
    const { t, agreement } = await withBalance();
    const callsBefore = fake.calls.length;
    const caller = role === null ? t : (await signInAs(t, role)).as;
    const err = await errorOf(caller.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id }));
    expect(String(err.data?.message ?? err.message)).toMatch(/Not authenticated|Forbidden/);
    expect(fake.calls).toHaveLength(callsBefore);
    expect((await releaseRows(t, agreement._id)).releases).toHaveLength(0);
  });

  test("a sub sees the release on its ledger but no release control", async () => {
    const { t, gc, sub, agreement } = await withBalance();
    await gc.as.action(api.payments.retainage.releaseRetainage, { agreementId: agreement._id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const ledger = await sub.as.query(api.payments.ledger.getAgreementLedger, { agreementId: agreement._id });
    expect(ledger?.canReleaseRetainage).toBe(false);
    expect(ledger?.retainageReleases).toHaveLength(1);
    expect(ledger?.totals.retainageHeldCents).toBe(0);
  });
});
