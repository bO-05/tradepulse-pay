/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { clearPayPalTokenCache } from "./paypalClient";
import { handlePayPalWebhook, verifyWithPayPal, type VerifyResult, type WebhookDeps } from "./webhook";

const modules = import.meta.glob("/convex/**/*.ts");
const WEBHOOK_ID = "WEBHOOK-TEST-1";
const SIG_HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "sig-1",
  "paypal-transmission-time": "2026-10-07T12:00:00Z",
};

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  const agreement = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  const ids = await t.run(async (ctx) => {
    const milestones = await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
      .take(2);
    const [m1, m2] = milestones;
    const now = Date.now();
    await ctx.db.patch(m1._id, { status: "in_progress", amountCents: 1_000_000 });
    await ctx.db.patch(m2._id, { status: "funded", amountCents: 500_000 });
    const fundingId = await ctx.db.insert("payments", {
      agreementId: agreement._id,
      milestoneId: m1._id,
      kind: "funding",
      status: "partially_captured",
      paypalOrderId: "ORDER-1",
      paypalAuthorizationId: "AUTH-1",
      paypalCaptureId: "CAP-1",
      grossCents: 1_000_000,
      retainageCents: 0,
      netCents: 1_000_000,
      capturedCents: 400_000,
      captures: [{ captureId: "CAP-1", amountCents: 400_000, requestKey: "k1", finalCapture: false, status: "PENDING", capturedAt: now }],
      idempotencyKey: `fund_${m1._id}_1`,
      createdAt: now,
    });
    const funding2Id = await ctx.db.insert("payments", {
      agreementId: agreement._id,
      milestoneId: m2._id,
      kind: "funding",
      status: "authorized",
      paypalOrderId: "ORDER-2",
      paypalAuthorizationId: "AUTH-2",
      grossCents: 500_000,
      retainageCents: 0,
      netCents: 500_000,
      idempotencyKey: `fund_${m2._id}_1`,
      createdAt: now,
    });
    const payoutId = await ctx.db.insert("payments", {
      agreementId: agreement._id,
      milestoneId: m1._id,
      kind: "payout",
      status: "pending",
      paypalPayoutBatchId: "BATCH-1",
      grossCents: 400_000,
      retainageCents: 40_000,
      netCents: 360_000,
      fundingPaymentId: undefined,
      idempotencyKey: "pay_k1",
      createdAt: now,
    });
    await ctx.db.insert("retainageLedger", {
      agreementId: agreement._id,
      paymentId: payoutId,
      deltaCents: 40_000,
      reason: "Retainage withheld",
      createdAt: now,
    });
    const changeOrderId = await ctx.db.insert("changeOrders", {
      agreementId: agreement._id,
      number: 1,
      description: "Add floor boxes",
      amountCents: 250_000,
      status: "invoiced",
      paypalInvoiceId: "INV2-TEST-1",
      paypalInvoiceStatus: "SENT",
      createdAt: now,
    });
    return { m1: m1._id, m2: m2._id, fundingId, funding2Id, payoutId, changeOrderId };
  });
  return { t, agreement, ...ids };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function snapshot(s: Setup) {
  return await s.t.run(async (ctx) => {
    const payments = await ctx.db.query("payments").collect();
    const strip = <T extends { updatedAt?: number }>(x: T) => ({ ...x, updatedAt: undefined });
    return {
      payments: payments.map(strip),
      ledger: await ctx.db.query("retainageLedger").collect(),
      milestones: await ctx.db.query("milestones").collect(),
      changeOrders: (await ctx.db.query("changeOrders").collect()).map((c) => ({ ...c, statusCheckedAt: undefined })),
      payApps: await ctx.db.query("payApplications").collect(),
    };
  });
}

async function events(t: Setup["t"]) {
  return await t.run(async (ctx) => await ctx.db.query("paypalEvents").collect());
}

const payoutItemEvent = (id: string, status: string, eventType: string, extra: Record<string, unknown> = {}) => ({
  id,
  event_type: eventType,
  resource_type: "payouts_item",
  resource: {
    payout_item_id: "ITEM-1",
    payout_batch_id: "BATCH-1",
    transaction_status: status,
    payout_item: { sender_item_id: "", receiver: "sub1@paypal.test" },
    ...extra,
  },
});

function deps(result: VerifyResult = { verified: true }): WebhookDeps & { verify: ReturnType<typeof vi.fn> } {
  return { webhookId: WEBHOOK_ID, verify: vi.fn(async () => result) };
}

function post(body: unknown, headers: Record<string, string> = SIG_HEADERS): Request {
  return new Request("https://example.convex.site/paypal/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctxFor(t: Setup["t"]) {
  return { runMutation: ((ref: any, args: any) => t.mutation(ref, args)) as any };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearPayPalTokenCache();
});

describe("POST /paypal/webhook verification", () => {
  let calls: Array<{ path: string; body: any }>;
  let verificationStatus: string;
  beforeEach(() => {
    calls = [];
    verificationStatus = "FAILURE";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = new URL(req.url);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21AAfaketoken", expires_in: 32400 });
        const text = await req.text();
        calls.push({ path: url.pathname, body: text ? JSON.parse(text) : undefined });
        if (url.pathname === "/v1/notifications/verify-webhook-signature") return json(200, { verification_status: verificationStatus });
        return json(404, { name: "RESOURCE_NOT_FOUND" });
      }),
    );
  });
  const realDeps = (): WebhookDeps => ({
    webhookId: WEBHOOK_ID,
    verify: (h, e, id) => verifyWithPayPal(h, e, id, { clientId: "test-client", clientSecret: "test-secret-value", environment: "sandbox" }),
  });

  test("no paypal-* headers: 400, recorded verified=false, PayPal not called, no state change", async () => {
    const s = await setup();
    const before = await snapshot(s);
    const res = await handlePayPalWebhook(ctxFor(s.t), post(payoutItemEvent("WH-FORGED-1", "FAILED", "PAYMENT.PAYOUTS-ITEM.FAILED"), {}), realDeps());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Missing PayPal signature headers/);
    expect(calls).toHaveLength(0);
    expect(await snapshot(s)).toEqual(before);
    const rows = await events(s.t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: "WH-FORGED-1", verified: false, processed: false, resourceId: "ITEM-1" });
  });

  test("fabricated headers: PayPal says FAILURE → 400, verified=false, no state change", async () => {
    const s = await setup();
    const before = await snapshot(s);
    const event = { id: "WH-FORGED-2", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-TEST-1", status: "PAID" } } };
    const res = await handlePayPalWebhook(ctxFor(s.t), post(event), realDeps());
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/v1/notifications/verify-webhook-signature");
    expect(calls[0].body).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: SIG_HEADERS["paypal-cert-url"],
      transmission_id: "tx-1",
      transmission_sig: "sig-1",
      transmission_time: "2026-10-07T12:00:00Z",
      webhook_id: WEBHOOK_ID,
      webhook_event: event,
    });
    expect(await snapshot(s)).toEqual(before);
    expect(await events(s.t)).toMatchObject([{ eventId: "WH-FORGED-2", verified: false, processed: false }]);
  });

  test("verification SUCCESS → 200 and the event is processed", async () => {
    const s = await setup();
    verificationStatus = "SUCCESS";
    const event = { id: "WH-OK-1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-TEST-1", status: "PAID" } } };
    const res = await handlePayPalWebhook(ctxFor(s.t), post(event), realDeps());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: false, changed: true });
    const co = await s.t.run(async (ctx) => await ctx.db.get(s.changeOrderId));
    expect(co?.status).toBe("paid");
    expect(await events(s.t)).toMatchObject([{ eventId: "WH-OK-1", verified: true, processed: true, resourceId: "INV2-TEST-1" }]);
  });

  test("non-JSON body → 400 recorded as unverified", async () => {
    const s = await setup();
    const res = await handlePayPalWebhook(ctxFor(s.t), post("not json"), realDeps());
    expect(res.status).toBe(400);
    expect((await events(s.t))[0]).toMatchObject({ eventId: "invalid:tx-1", verified: false, processed: false });
  });

  test("unset PAYPAL_WEBHOOK_ID → 503 and nothing processed", async () => {
    const s = await setup();
    const d = deps();
    const res = await handlePayPalWebhook(ctxFor(s.t), post(payoutItemEvent("WH-X", "SUCCESS", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED")), { ...d, webhookId: undefined });
    expect(res.status).toBe(503);
    expect(d.verify).not.toHaveBeenCalled();
    expect((await events(s.t))[0]).toMatchObject({ verified: false, processed: false });
  });

  test("verification unavailable → 503 so PayPal retries; the retry is processed", async () => {
    const s = await setup();
    const event = payoutItemEvent("WH-RETRY", "SUCCESS", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED");
    const down = await handlePayPalWebhook(ctxFor(s.t), post(event), deps({ verified: false, reason: "network", transient: true }));
    expect(down.status).toBe(503);
    const ok = await handlePayPalWebhook(ctxFor(s.t), post(event), deps());
    expect(ok.status).toBe(200);
    const rows = await events(s.t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: "WH-RETRY", verified: true, processed: true });
  });

  test("a forged delivery reusing a processed event id never downgrades the verified row", async () => {
    const s = await setup();
    const event = payoutItemEvent("WH-SAME", "SUCCESS", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED");
    await handlePayPalWebhook(ctxFor(s.t), post(event), deps());
    const forged = await handlePayPalWebhook(ctxFor(s.t), post(event, {}), realDeps());
    expect(forged.status).toBe(400);
    expect(await events(s.t)).toMatchObject([{ eventId: "WH-SAME", verified: true, processed: true }]);
  });
});

describe("webhook dispatcher (sample payloads)", () => {
  const dispatch = (t: Setup["t"], event: unknown) => t.mutation(internal.payments.webhookDb.processVerifiedEvent, { event });

  test("PAYOUTS-ITEM.SUCCEEDED settles the payout once; a replay changes nothing", async () => {
    const s = await setup();
    const event = payoutItemEvent("WH-PI-OK", "SUCCESS", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED");
    const first = await dispatch(s.t, event);
    expect(first).toMatchObject({ duplicate: false, changed: true });
    const after = await snapshot(s);
    const payout = after.payments.find((p) => p._id === s.payoutId)!;
    expect(payout).toMatchObject({ status: "success", paypalPayoutItemId: "ITEM-1", paypalItemStatus: "SUCCESS" });

    const res = await handlePayPalWebhook(ctxFor(s.t), post(event), deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true, changed: false });
    expect(await dispatch(s.t, event)).toMatchObject({ duplicate: true, changed: false });
    expect(await snapshot(s)).toEqual(after);
    expect((await events(s.t)).filter((e) => e.eventId === "WH-PI-OK")).toHaveLength(1);
  });

  test("PAYOUTS-ITEM.FAILED fails the payout and reverses retainage exactly once", async () => {
    const s = await setup();
    const event = payoutItemEvent("WH-PI-FAIL", "FAILED", "PAYMENT.PAYOUTS-ITEM.FAILED", { errors: { name: "RECEIVER_ACCOUNT_LOCKED" } });
    await dispatch(s.t, event);
    await dispatch(s.t, event);
    // A different event id for the same item (PayPal can send both) cannot move a terminal payout again.
    await dispatch(s.t, { ...event, id: "WH-PI-FAIL-2" });
    const after = await snapshot(s);
    const payout = after.payments.find((p) => p._id === s.payoutId)!;
    expect(payout.status).toBe("failed");
    expect(payout.error).toMatch(/RECEIVER_ACCOUNT_LOCKED/);
    const ledger = after.ledger.filter((l) => l.paymentId === s.payoutId);
    expect(ledger.map((l) => l.deltaCents)).toEqual([40_000, -40_000]);
  });

  test("payout items are matched by sender_item_id when the item id is not stored yet", async () => {
    const s = await setup();
    const event = payoutItemEvent("WH-PI-SENDER", "UNCLAIMED", "PAYMENT.PAYOUTS-ITEM.UNCLAIMED", {
      payout_item: { sender_item_id: s.payoutId },
    });
    expect(await dispatch(s.t, event)).toMatchObject({ changed: true });
    const p = await s.t.run(async (ctx) => await ctx.db.get(s.payoutId));
    expect(p).toMatchObject({ status: "unclaimed", paypalPayoutItemId: "ITEM-1" });
  });

  test("PAYOUTSBATCH.SUCCESS confirms without moving items; DENIED fails the batch payouts", async () => {
    const s = await setup();
    const batch = (id: string, status: string) => ({
      id,
      event_type: `PAYMENT.PAYOUTSBATCH.${status}`,
      resource: { batch_header: { payout_batch_id: "BATCH-1", batch_status: status } },
    });
    expect(await dispatch(s.t, batch("WH-B-1", "SUCCESS"))).toMatchObject({ changed: false });
    expect((await s.t.run(async (ctx) => await ctx.db.get(s.payoutId)))?.status).toBe("pending");
    expect(await dispatch(s.t, batch("WH-B-2", "DENIED"))).toMatchObject({ changed: true });
    expect((await s.t.run(async (ctx) => await ctx.db.get(s.payoutId)))?.status).toBe("failed");
    const rows = await events(s.t);
    expect(rows.every((r) => r.verified && r.processed && r.error === undefined)).toBe(true);
  });

  test("INVOICING.INVOICE.PAID / CANCELLED move the change order once and never backwards", async () => {
    const s = await setup();
    await dispatch(s.t, { id: "WH-INV-1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-TEST-1", status: "PAID" } } });
    const co = await s.t.run(async (ctx) => await ctx.db.get(s.changeOrderId));
    expect(co).toMatchObject({ status: "paid", paypalInvoiceStatus: "PAID" });
    expect(co?.paidAt).toBeTypeOf("number");
    const out = await dispatch(s.t, { id: "WH-INV-2", event_type: "INVOICING.INVOICE.CANCELLED", resource: { invoice: { id: "INV2-TEST-1", status: "CANCELLED" } } });
    expect(out.changed).toBe(false);
    expect((await s.t.run(async (ctx) => await ctx.db.get(s.changeOrderId)))?.status).toBe("paid");
  });

  test("PAYMENT.CAPTURE.COMPLETED updates the stored capture; an unknown capture of a known authorization waits for the action", async () => {
    const s = await setup();
    const capture = (id: string, captureId: string) => ({
      id,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: captureId, status: "COMPLETED", supplementary_data: { related_ids: { order_id: "ORDER-1", authorization_id: "AUTH-1" } } },
    });
    expect(await dispatch(s.t, capture("WH-C-1", "CAP-1"))).toMatchObject({ changed: true });
    const f = await s.t.run(async (ctx) => await ctx.db.get(s.fundingId));
    expect(f?.captures?.[0].status).toBe("COMPLETED");
    expect(f?.status).toBe("partially_captured");
    expect(f?.capturedCents).toBe(400_000);
    expect(await dispatch(s.t, capture("WH-C-2", "CAP-NEW"))).toMatchObject({ changed: false });
    expect((await events(s.t)).find((e) => e.eventId === "WH-C-2")?.error).toBeUndefined();
  });

  test("PAYMENT.CAPTURE.DENIED marks the capture and stores a readable error", async () => {
    const s = await setup();
    await dispatch(s.t, {
      id: "WH-C-DENY",
      event_type: "PAYMENT.CAPTURE.DENIED",
      resource: { id: "CAP-1", status: "DECLINED", supplementary_data: { related_ids: { authorization_id: "AUTH-1" } } },
    });
    const f = await s.t.run(async (ctx) => await ctx.db.get(s.fundingId));
    expect(f?.captures?.[0].status).toBe("DECLINED");
    expect(f?.error).toMatch(/denied capture CAP-1/);
  });

  test("PAYMENT.AUTHORIZATION.VOIDED voids through the state machine", async () => {
    const s = await setup();
    const voided = (id: string, auth: string) => ({ id, event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource: { id: auth, status: "VOIDED" } });
    expect(await dispatch(s.t, voided("WH-V-1", "AUTH-1"))).toMatchObject({ changed: true });
    expect(await dispatch(s.t, voided("WH-V-2", "AUTH-2"))).toMatchObject({ changed: true });
    const after = await snapshot(s);
    expect(after.payments.find((p) => p._id === s.fundingId)?.status).toBe("voided");
    expect(after.payments.find((p) => p._id === s.funding2Id)?.status).toBe("voided");
    expect(after.milestones.find((m) => m._id === s.m1)?.status).toBe("complete");
    expect(after.milestones.find((m) => m._id === s.m2)?.status).toBe("funding_expired");
    // Voided is terminal: a repeat under a new event id changes nothing.
    expect(await dispatch(s.t, voided("WH-V-3", "AUTH-1"))).toMatchObject({ changed: false });
  });

  test("AUTHORIZATION.CREATED and CHECKOUT.ORDER.APPROVED confirm without changing state", async () => {
    const s = await setup();
    const before = await snapshot(s);
    await dispatch(s.t, {
      id: "WH-A-C",
      event_type: "PAYMENT.AUTHORIZATION.CREATED",
      resource: { id: "AUTH-2", status: "CREATED", supplementary_data: { related_ids: { order_id: "ORDER-2" } } },
    });
    await dispatch(s.t, { id: "WH-O-A", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORDER-2", status: "APPROVED" } });
    expect(await snapshot(s)).toEqual(before);
    const rows = await events(s.t);
    expect(rows.map((r) => [r.eventId, r.resourceId, r.processed, r.error])).toEqual([
      ["WH-A-C", "AUTH-2", true, undefined],
      ["WH-O-A", "ORDER-2", true, undefined],
    ]);
  });

  test("unhandled verified types are recorded without errors or state changes", async () => {
    const s = await setup();
    const before = await snapshot(s);
    const out = await dispatch(s.t, { id: "WH-DISPUTE", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { id: "PP-D-1" } });
    expect(out).toMatchObject({ changed: false });
    expect(out.error).toBeUndefined();
    expect(await snapshot(s)).toEqual(before);
    expect((await events(s.t))[0]).toMatchObject({ eventType: "CUSTOMER.DISPUTE.CREATED", verified: true, processed: true });
  });

  test("handled events that match nothing are recorded with an explanatory error and change nothing", async () => {
    const s = await setup();
    const before = await snapshot(s);
    await dispatch(s.t, { id: "WH-NOMATCH", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-OTHER", status: "PAID" } } });
    expect(await snapshot(s)).toEqual(before);
    expect((await events(s.t))[0].error).toMatch(/No stored record matches INVOICING.INVOICE.PAID resource INV2-OTHER/);
  });

  test("a dispatch that throws returns 500, is recorded unprocessed, and the retry is processed", async () => {
    const s = await setup();
    const event = payoutItemEvent("WH-THROW", "SUCCESS", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED");
    let fail = true;
    const ctx = {
      runMutation: (async (ref: any, args: any) => {
        if (fail && getFunctionName(ref) === getFunctionName(internal.payments.webhookDb.processVerifiedEvent)) {
          fail = false;
          throw new Error("transient database error");
        }
        return await s.t.mutation(ref, args);
      }) as any,
    };
    const res = await handlePayPalWebhook(ctx, post(event), deps());
    expect(res.status).toBe(500);
    expect((await events(s.t))[0]).toMatchObject({ eventId: "WH-THROW", verified: true, processed: false });
    expect((await s.t.run(async (c) => await c.db.get(s.payoutId)))?.status).toBe("pending");
    const retry = await handlePayPalWebhook(ctx, post(event), deps());
    expect(retry.status).toBe(200);
    const rows = await events(s.t);
    expect(rows).toHaveLength(1);
    expect(rows[0].processed).toBe(true);
    expect(rows[0].error).toBeUndefined();
    expect((await s.t.run(async (c) => await c.db.get(s.payoutId)))?.status).toBe("success");
  });
});
