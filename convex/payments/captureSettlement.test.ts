/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { seedCompliantAgreement } from "../lib/testCompliance";
import { signInAs } from "../lib/testIdentity";
import { clearPayPalTokenCache } from "./paypalClient";
import { payFromTranche } from "../lib/testPayApp";
import { isCaptureCollected } from "./captureSettlement";

/**
 * Capture settlement: PENDING captures hold the payout until COMPLETED, DENIED captures fail the release,
 * event-first settlements are applied when the capture is stored, refunds of older captures still match,
 * and closing a milestone excludes new releases.
 */

const modules = import.meta.glob("/convex/**/*.ts");
const SUB_EMAIL = "sub1-sandbox@paypal.test";
const AUTH_ID = "AUTH-1";

type Call = { method: string; path: string; requestId?: string; body: unknown };

function fakePayPal() {
  const calls: Call[] = [];
  const captureByRequestId = new Map<string, string>();
  const captureStatusById = new Map<string, string>();
  const batches = new Map<string, { id: string; senderBatchId: string; senderItemId?: string }>();
  const state = { captureStatus: "COMPLETED", nextCaptureId: undefined as string | undefined, n: 0 };
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
      let id = requestId ? captureByRequestId.get(requestId) : undefined;
      if (!id) {
        id = state.nextCaptureId ?? `CAP-${++state.n}`;
        state.nextCaptureId = undefined;
        if (requestId) captureByRequestId.set(requestId, id);
        captureStatusById.set(id, state.captureStatus);
      }
      return json(201, { id, status: captureStatusById.get(id), amount: { currency_code: "USD", value: body.amount.value } });
    }
    const getCap = url.pathname.match(/^\/v2\/payments\/captures\/([^/]+)$/);
    if (req.method === "GET" && getCap) {
      const status = captureStatusById.get(getCap[1]);
      if (!status) return json(404, { name: "RESOURCE_NOT_FOUND" });
      return json(200, { id: getCap[1], status });
    }
    if (req.method === "POST" && /\/void$/.test(url.pathname)) return new Response(null, { status: 204 });
    if (req.method === "POST" && url.pathname === "/v1/payments/payouts") {
      const sb = body.sender_batch_header.sender_batch_id as string;
      // Real PayPal deduplicates sender_batch_id even when two actions POST concurrently.
      const existing = [...batches.values()].find((b) => b.senderBatchId === sb);
      if (existing) {
        return json(400, {
          name: "USER_BUSINESS_ERROR",
          message: "User business error.",
          details: [{
            issue: "Batch with given sender_batch_id already exists",
            link: [{ rel: "self", href: `https://api.sandbox.paypal.com/v1/payments/payouts/${existing.id}`, method: "GET" }],
          }],
        });
      }
      const id = `BATCH-${++state.n}`;
      batches.set(id, { id, senderBatchId: sb, senderItemId: body.items[0].sender_item_id });
      return json(201, { batch_header: { payout_batch_id: id, batch_status: "PENDING" } });
    }
    const getBatch = url.pathname.match(/^\/v1\/payments\/payouts\/([^/]+)$/);
    if (req.method === "GET" && getBatch) {
      const b = batches.get(getBatch[1]);
      if (!b) return json(404, { name: "RESOURCE_NOT_FOUND" });
      return json(200, {
        batch_header: { payout_batch_id: b.id, batch_status: "SUCCESS" },
        items: [{ payout_item_id: `ITEM-${b.id}`, transaction_status: "SUCCESS", payout_item: { sender_item_id: b.senderItemId } }],
      });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  });
  const posts = (path: RegExp) => calls.filter((c) => c.method === "POST" && path.test(c.path));
  return { fetchImpl, calls, posts, state, captureStatusById, batches };
}

async function setup(authorizedCents = 1_000_000) {
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
  await signInAs(t, "sub", { contractorId: agreement.contractorId, paypalEmail: SUB_EMAIL, email: "sub1@demo.tradepulse" });
  await t.run((ctx) => seedCompliantAgreement(ctx, agreement._id));
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
  return { t, gc, milestoneId: milestone._id, fundingId };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function rows(t: Setup["t"], milestoneId: Id<"milestones">) {
  return await t.run(async (ctx) => {
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_milestoneId", (q) => q.eq("milestoneId", milestoneId))
      .collect();
    return {
      funding: payments.find((p) => p.kind === "funding")!,
      payouts: payments.filter((p) => p.kind === "payout"),
      ledger: await ctx.db.query("retainageLedger").collect(),
      events: await ctx.db.query("paypalEvents").collect(),
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

const dispatch = (t: Setup["t"], event: unknown) => t.mutation(internal.payments.webhookDb.processVerifiedEvent, { event });
const captureEvent = (id: string, type: "COMPLETED" | "DENIED", captureId: string) => ({
  id,
  event_type: `PAYMENT.CAPTURE.${type}`,
  resource: {
    id: captureId,
    status: type === "DENIED" ? "DECLINED" : "COMPLETED",
    supplementary_data: { related_ids: { authorization_id: AUTH_ID } },
  },
});

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

const payoutPosts = () => fake.posts(/^\/v1\/payments\/payouts$/);

test.each(["PENDING", "DENIED", "DECLINED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED", "", "UNKNOWN"])(
  "capture status %s does not prove collected funds",
  (status) => {
    expect(isCaptureCollected(status)).toBe(false);
    expect(isCaptureCollected("COMPLETED")).toBe(true);
  },
);

describe("PENDING captures hold the payout", () => {
  test("a refunded capture cannot fund a payout retry", async () => {
    const { t, gc, milestoneId, fundingId } = await setup();
    fake.state.captureStatus = "PENDING";
    const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-refund-retry" });
    await t.mutation(internal.payments.captureSettlement.applyCaptureSettlement, {
      fundingPaymentId: fundingId,
      captureId: out.captureId!,
      status: "REFUNDED",
    });
    // A failed payout with a refunded funding capture must not become a new money write.
    await t.run((ctx) => ctx.db.patch(out.paymentId, { status: "failed" }));
    await expect(gc.as.action(api.payments.payoutRetry.retryPayout, { paymentId: out.paymentId })).rejects.toThrow();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await rows(t, milestoneId);
    expect(r.payouts).toHaveLength(1);
    expect(payoutPosts()).toHaveLength(0);
    expect(r.ledger).toHaveLength(0);
  });

  test("PENDING → no payout; a COMPLETED webhook pays exactly once", async () => {
    const { t, gc, milestoneId } = await setup();
    fake.state.captureStatus = "PENDING";
    const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-pend1" });
    expect(out).toMatchObject({ state: "pending", status: "capture_pending" });
    expect(out.message).toMatch(/Capture pending/);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    let r = await rows(t, milestoneId);
    expect(payoutPosts()).toHaveLength(0);
    expect(r.payouts[0].status).toBe("capture_pending");
    expect(r.funding.captures?.[0].status).toBe("PENDING");
    expect(r.ledger).toHaveLength(0);
    const pendingLedger = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: r.funding.agreementId });
    expect(pendingLedger?.totals).toMatchObject({ capturedCents: 0, capturedNotPaidCents: 0, paidCents: 0 });
    const pendingReconciliation = await t.query(internal.payments.reconcile.ledgerReconciliation, { agreementId: r.funding.agreementId });
    expect(pendingReconciliation?.rawSums).toMatchObject({ capturedCents: 0, capturedNotPaidCents: 0 });
    expect(pendingReconciliation?.mismatches).toEqual([]);

    // A repeat click does not pay while the capture is pending.
    const again = await gc.as.action(api.payments.release.resumeRelease, { paymentId: r.payouts[0]._id });
    expect(again.state).toBe("already_processed");
    expect(payoutPosts()).toHaveLength(0);

    await dispatch(t, captureEvent("WH-P-1", "COMPLETED", out.captureId!));
    await dispatch(t, captureEvent("WH-P-2", "COMPLETED", out.captureId!));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    r = await rows(t, milestoneId);
    expect(payoutPosts()).toHaveLength(1);
    expect(r.payouts[0].status).toBe("success");
    expect(r.funding.captures?.[0].status).toBe("COMPLETED");
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({ paymentId: r.payouts[0]._id, deltaCents: 60_000 });
    const settledLedger = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: r.funding.agreementId });
    expect(settledLedger?.totals).toMatchObject({ capturedCents: 600_000, capturedNotPaidCents: 0,
      paidCents: 540_000, retainageHeldCents: 60_000 });
    const settledReconciliation = await t.query(internal.payments.reconcile.ledgerReconciliation, { agreementId: r.funding.agreementId });
    expect(settledReconciliation?.mismatches).toEqual([]);
  });

  test("PENDING → DENIED fails the release with no payout and no retainage credit", async () => {
    const { t, gc, milestoneId } = await setup();
    fake.state.captureStatus = "PENDING";
    const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-deny1" });
    await dispatch(t, captureEvent("WH-D-1", "DENIED", out.captureId!));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await rows(t, milestoneId);
    expect(payoutPosts()).toHaveLength(0);
    expect(r.payouts[0].status).toBe("failed");
    expect(r.payouts[0].error).toMatch(/denied/i);
    expect(r.funding.captures?.[0].status).toBe("DECLINED");
    expect(r.ledger).toHaveLength(0);
    const deniedLedger = await gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: r.funding.agreementId });
    expect(deniedLedger?.totals).toMatchObject({ capturedCents: 0, capturedNotPaidCents: 0, paidCents: 0 });
    // A denied capture collected nothing, so "Retry payout" is not offered.
    await expect(gc.as.action(api.payments.payoutRetry.retryPayout, { paymentId: r.payouts[0]._id })).rejects.toThrow();
    expect(payoutPosts()).toHaveLength(0);
  });

  test("a sub that switches its payout email while the capture is PENDING is not paid at the old address on COMPLETED", async () => {
    const { t, gc, milestoneId } = await setup();
    fake.state.captureStatus = "PENDING";
    const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-swap1" });
    expect(out.status).toBe("capture_pending");
    await t.run(async (ctx) => {
      const payout = (await ctx.db.get(out.paymentId))!;
      const agreement = (await ctx.db.get(payout.agreementId))!;
      const contractor = (await ctx.db.get(agreement.contractorId))!;
      const vendor = (await ctx.db.get(contractor.vendorId!))!;
      await ctx.db.patch(vendor.linkedCompanyId!, { payoutPaypalEmail: "new-b@paypal.test" });
      await ctx.db.patch(vendor._id, { payoutEmailConfirmed: undefined });
    });

    await dispatch(t, captureEvent("WH-S-1", "COMPLETED", out.captureId!));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await rows(t, milestoneId);
    expect(payoutPosts()).toHaveLength(0);
    expect(r.payouts[0].status).toBe("failed");
    expect(r.payouts[0].error).toMatch(/^Payout blocked for .*waiting for confirmation/);
    expect(r.ledger).toHaveLength(0);
  });

  test("Refresh status GETs the capture and pays once it is COMPLETED", async () => {
    const { t, gc, milestoneId } = await setup();
    fake.state.captureStatus = "PENDING";
    const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-refr1" });
    const still = await gc.as.action(api.payments.release.refreshCaptureStatus, { paymentId: out.paymentId });
    expect(still).toMatchObject({ captureStatus: "PENDING", status: "capture_pending" });
    expect(payoutPosts()).toHaveLength(0);

    fake.captureStatusById.set(out.captureId!, "COMPLETED");
    const done = await gc.as.action(api.payments.release.refreshCaptureStatus, { paymentId: out.paymentId });
    expect(done.captureStatus).toBe("COMPLETED");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fake.calls.some((c) => c.method === "GET" && c.path === `/v2/payments/captures/${out.captureId}`)).toBe(true);
    expect(payoutPosts()).toHaveLength(1);
    expect((await rows(t, milestoneId)).payouts[0].status).toBe("success");
  });

  test("a COMPLETED capture still pays out in one call", async () => {
    const { t, gc, milestoneId } = await setup();
    const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-norm1" });
    expect(out.state).toBe("pending");
    expect(out.status).toBe("pending");
    expect(payoutPosts()).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await rows(t, milestoneId)).payouts[0].status).toBe("success");
  });
});

describe("closing a milestone excludes releases", () => {
  test("close is refused while a release is in flight (capture pending)", async () => {
    const { t, gc, milestoneId } = await setup();
    fake.state.captureStatus = "PENDING";
    await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-close1" });
    const err = await errorOf(gc.as.action(api.payments.release.closeMilestone, { milestoneId }));
    expect(err.data.code).toBe("RELEASE_IN_PROGRESS");
    expect(fake.posts(/\/void$/)).toHaveLength(0);
  });

  test("a release is refused while the milestone is closing", async () => {
    const { t, gc, milestoneId, fundingId } = await setup();
    await payFromTranche(t, gc.as, { milestoneId, amountCents: 400_000, requestKey: "test-key-close2" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // The closing marker is set before the void call reaches PayPal.
    const begun = await t.mutation(internal.payments.releaseDb.beginVoid, { milestoneId });
    expect(begun.state).toBe("void");
    const err = await errorOf(
      payFromTranche(t, gc.as, { milestoneId, amountCents: 100_000, requestKey: "test-key-close3" }),
    );
    // A closing tranche is no funding source, so canPay refuses before any capture.
    expect(err.data.code).toBe("CANNOT_PAY");
    expect(err.data.message).toMatch(/No funded tranche/);
    expect(fake.posts(/\/capture$/)).toHaveLength(1);
    const r = await rows(t, milestoneId);
    expect(r.payouts).toHaveLength(1);

    // A rejected void clears the marker so releases can continue.
    await t.mutation(internal.payments.releaseDb.recordVoidFailure, { fundingPaymentId: fundingId, error: "Void rejected" });
    const ok = await payFromTranche(t, gc.as, { milestoneId, amountCents: 100_000, requestKey: "test-key-close4" });
    expect(ok.state).toBe("pending");
  });

  test("a capture PayPal applied after the void is recorded, not dropped", async () => {
    const { t, gc, milestoneId, fundingId } = await setup();
    await payFromTranche(t, gc.as, { milestoneId, amountCents: 400_000, requestKey: "test-key-late1" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run(async (ctx) => ctx.db.patch(fundingId, { status: "voided" }));
    await t.mutation(internal.payments.releaseDb.recordCapture, {
      fundingPaymentId: fundingId,
      captureId: "CAP-LATE",
      captureStatus: "COMPLETED",
      amountCents: 100_000,
      requestKey: "pay_late",
      finalCapture: false,
      auditRecorded: true,
    });
    const r = await rows(t, milestoneId);
    expect(r.funding.status).toBe("voided");
    expect(r.funding.captures?.map((c) => c.captureId)).toContain("CAP-LATE");
    expect(r.funding.capturedCents).toBe(500_000);
  });
});

describe("event-first capture settlement", () => {
  test("a COMPLETED event before recordCapture is applied when the PENDING capture is stored", async () => {
    const { t, gc, milestoneId } = await setup();
    await dispatch(t, captureEvent("WH-E-1", "COMPLETED", "CAP-EARLY"));
    let r = await rows(t, milestoneId);
    expect(r.events.find((e) => e.eventId === "WH-E-1")).toMatchObject({ verified: true, processed: false });

    fake.state.captureStatus = "PENDING";
    fake.state.nextCaptureId = "CAP-EARLY";
    const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-early1" });
    expect(out.captureId).toBe("CAP-EARLY");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    r = await rows(t, milestoneId);
    expect(r.funding.captures?.[0].status).toBe("COMPLETED");
    expect(payoutPosts()).toHaveLength(1);
    expect(r.payouts[0].status).toBe("success");
    expect(r.events.find((e) => e.eventId === "WH-E-1")?.processed).toBe(true);
  });

  test("a DENIED event before recordCapture fails the release once the capture is stored", async () => {
    const { t, gc, milestoneId } = await setup();
    await dispatch(t, captureEvent("WH-E-2", "DENIED", "CAP-EARLY2"));
    fake.state.captureStatus = "PENDING";
    fake.state.nextCaptureId = "CAP-EARLY2";
    await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-early2" }).catch(() => null);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await rows(t, milestoneId);
    expect(payoutPosts()).toHaveLength(0);
    expect(r.payouts[0].status).toBe("failed");
    expect(r.ledger).toHaveLength(0);
    expect(r.events.find((e) => e.eventId === "WH-E-2")?.processed).toBe(true);
  });
});

describe("refunds of older captures", () => {
  test.each(["REFUNDED", "PARTIALLY_REFUNDED"])(
    "a delayed COMPLETED event cannot resurrect a %s capture and trigger a payout",
    async (refundStatus) => {
      const { t, gc, milestoneId, fundingId } = await setup();
      fake.state.captureStatus = "PENDING";
      const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: `test-key-late-${refundStatus}` });
      await t.mutation(internal.payments.captureSettlement.applyCaptureSettlement, {
        fundingPaymentId: fundingId,
        captureId: out.captureId!,
        status: refundStatus,
      });
      await dispatch(t, captureEvent(`WH-LATE-${refundStatus}`, "COMPLETED", out.captureId!));
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const r = await rows(t, milestoneId);
      expect(r.funding.captures?.[0].status).toBe(refundStatus);
      expect(r.payouts[0].status).toBe("capture_pending");
      expect(payoutPosts()).toHaveLength(0);
      expect(r.ledger).toHaveLength(0);
    },
  );

  test("a refund of the first of two captures (up link only) resolves the funding payment", async () => {
    const { t, gc, milestoneId } = await setup();
    const first = await payFromTranche(t, gc.as, { milestoneId, amountCents: 300_000, requestKey: "test-key-ref1" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const second = await payFromTranche(t, gc.as, { milestoneId, amountCents: 300_000, requestKey: "test-key-ref2" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(first.captureId).not.toBe(second.captureId);

    const out = await dispatch(t, {
      id: "WH-R-1",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "REFUND-1",
        status: "COMPLETED",
        links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${first.captureId}`, method: "GET" }],
      },
    });
    expect(out).toMatchObject({ changed: true });
    expect(out.error).toBeUndefined();
    const r = await rows(t, milestoneId);
    expect(r.funding.captures?.find((c) => c.captureId === first.captureId)?.status).toBe("REFUNDED");
    expect(r.funding.captures?.find((c) => c.captureId === second.captureId)?.status).toBe("COMPLETED");
    expect(r.funding.error).toMatch(/refunded/);
  });
});

describe("capture status never moves back to PENDING", () => {
  const capturePosts = () => fake.posts(/\/v2\/payments\/authorizations\/[^/]+\/capture$/);

  test("a stale PENDING refresh applied after the COMPLETED webhook does not undo settlement", async () => {
    const { t, gc, milestoneId } = await setup();
    fake.state.captureStatus = "PENDING";
    const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-stale1" });
    expect(out.status).toBe("capture_pending");
    const captureId = out.captureId!;

    // Hold the PENDING GET response that "Refresh status" has already read.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const reachedGet = new Promise<void>((resolve) => (held = resolve));
    const inner = fake.fetchImpl.getMockImplementation()!;
    let paused = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const res = await inner(input, init);
        const path = new URL(new Request(input, init).url).pathname;
        if (!paused && path === `/v2/payments/captures/${captureId}`) {
          paused = true;
          held();
          await gate;
        }
        return res;
      }),
    );
    const refresh = gc.as.action(api.payments.release.refreshCaptureStatus, { paymentId: out.paymentId });
    await reachedGet;

    fake.captureStatusById.set(captureId, "COMPLETED");
    await dispatch(t, captureEvent("WH-STALE-1", "COMPLETED", captureId));
    let r = await rows(t, milestoneId);
    expect(r.funding.captures?.[0].status).toBe("COMPLETED");
    expect(r.payouts[0].status).toBe("created");

    release();
    const refreshed = await refresh;
    expect(refreshed.captureStatus).toBe("COMPLETED");
    r = await rows(t, milestoneId);
    expect(r.funding.captures?.[0].status).toBe("COMPLETED");

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    r = await rows(t, milestoneId);
    expect(r.funding.captures).toHaveLength(1);
    expect(r.funding.captures?.[0].status).toBe("COMPLETED");
    expect(capturePosts()).toHaveLength(1);
    expect(payoutPosts()).toHaveLength(1);
    expect(r.payouts).toHaveLength(1);
    expect(r.payouts[0].status).toBe("success");
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({ paymentId: r.payouts[0]._id, deltaCents: 60_000 });
  });

  test.each(["COMPLETED", "DECLINED", "REFUNDED", "PARTIALLY_REFUNDED"])(
    "a later PENDING refresh or webhook keeps a %s capture terminal",
    async (terminal) => {
      const { t, gc, milestoneId, fundingId } = await setup();
      const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: `test-key-term-${terminal}` });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const captureId = out.captureId!;
      await t.run(async (ctx) => {
        const f = (await ctx.db.get(fundingId))!;
        await ctx.db.patch(fundingId, { captures: f.captures!.map((c) => ({ ...c, status: terminal })) });
      });

      const applied = await t.mutation(internal.payments.captureSettlement.applyCaptureSettlement, {
        fundingPaymentId: fundingId,
        captureId,
        status: "PENDING",
      });
      expect(applied).toEqual({ changed: false, status: terminal });

      // Webhooks go through the same guard; here a capture event whose resource still reads PENDING.
      await dispatch(t, {
        id: `WH-PEND-${terminal}`,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: { id: captureId, status: "PENDING", supplementary_data: { related_ids: { authorization_id: AUTH_ID } } },
      });
      fake.captureStatusById.set(captureId, "PENDING");
      const refreshed = await gc.as.action(api.payments.release.refreshCaptureStatus, { paymentId: out.paymentId });
      expect(refreshed.captureStatus).toBe(terminal);
      const r = await rows(t, milestoneId);
      expect(r.funding.captures?.[0].status).toBe(terminal);
      expect(payoutPosts()).toHaveLength(1);
    },
  );

  test("a release left created with a collected capture is paid by Retry release without a new capture", async () => {
    const { t, gc, milestoneId } = await setup();
    fake.state.captureStatus = "PENDING";
    const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-stuck1" });
    // The COMPLETED webhook moves the release to created; timers stay paused until after manual resume.
    await dispatch(t, captureEvent("WH-STUCK-1", "COMPLETED", out.captureId!));
    expect((await rows(t, milestoneId)).payouts[0].status).toBe("created");

    await gc.as.action(api.payments.release.resumeRelease, { paymentId: out.paymentId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await rows(t, milestoneId);
    expect(capturePosts()).toHaveLength(1);
    expect(payoutPosts()).toHaveLength(1);
    expect(r.payouts[0].status).toBe("success");
    expect(r.ledger).toHaveLength(1);
  });

  test("concurrent scheduled-style payout and manual resume reconcile one batch and credit retainage once", async () => {
    const { t, gc, milestoneId } = await setup();
    fake.state.captureStatus = "PENDING";
    const out = await payFromTranche(t, gc.as, { milestoneId, amountCents: 600_000, requestKey: "test-key-concurrent-resume" });
    await dispatch(t, captureEvent("WH-CONCURRENT-1", "COMPLETED", out.captureId!));

    // Force both actions past their durable send gate before either gets a POST response.
    let releasePosts!: () => void;
    const bothPosting = new Promise<void>((resolve) => { releasePosts = resolve; });
    const inner = fake.fetchImpl.getMockImplementation()!;
    let posting = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.method === "POST" && new URL(req.url).pathname === "/v1/payments/payouts") {
        posting += 1;
        if (posting === 2) releasePosts();
        await bothPosting;
      }
      return await inner(input, init);
    }));
    await Promise.all([
      gc.as.action(api.payments.release.resumeRelease, { paymentId: out.paymentId }),
      t.action(internal.payments.payouts.payoutSubInternal, { paymentId: out.paymentId }),
    ]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const r = await rows(t, milestoneId);
    expect(capturePosts()).toHaveLength(1);
    expect(payoutPosts()).toHaveLength(2);
    expect(new Set(payoutPosts().map((p) => p.requestId)).size).toBe(1);
    expect(fake.batches.size).toBe(1);
    expect(r.payouts).toHaveLength(1);
    expect(r.payouts[0]).toMatchObject({ status: "success", paypalPayoutBatchId: [...fake.batches.keys()][0] });
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0].deltaCents).toBe(60_000);
  });
});
