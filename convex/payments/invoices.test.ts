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
const OWNER_EMAIL = "owner-sandbox@paypal.test";

type Call = { method: string; path: string; requestId?: string; body: unknown };

/** Fake Invoicing v2: create returns only a self link, send moves DRAFT → SENT, payments → MARKED_AS_PAID. */
function fakeInvoicing() {
  const calls: Call[] = [];
  const invoices = new Map<string, { id: string; status: string; body: any }>();
  const byRequestId = new Map<string, string>();
  const state = { n: 0, failSend: false };
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
    const self = (id: string) => ({ rel: "self", href: `https://api.sandbox.paypal.com/v2/invoicing/invoices/${id}`, method: "GET" });

    if (req.method === "POST" && url.pathname === "/v2/invoicing/invoices") {
      let id = requestId ? byRequestId.get(requestId) : undefined;
      if (!id) {
        id = `INV2-TEST-${++state.n}`;
        invoices.set(id, { id, status: "DRAFT", body });
        if (requestId) byRequestId.set(requestId, id);
      }
      return json(201, self(id));
    }
    const send = url.pathname.match(/^\/v2\/invoicing\/invoices\/([^/]+)\/send$/);
    if (req.method === "POST" && send) {
      const inv = invoices.get(send[1]);
      if (!inv) return json(404, { name: "RESOURCE_NOT_FOUND" });
      if (state.failSend) {
        state.failSend = false;
        return json(422, {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "INVALID_INVOICE_STATE", description: "Invoice can not be sent." }],
          debug_id: "dbg-send",
        });
      }
      inv.status = "SENT";
      return json(200, { href: `https://www.sandbox.paypal.com/invoice/p/#${inv.id}`, rel: "payer-view", method: "GET" });
    }
    const pay = url.pathname.match(/^\/v2\/invoicing\/invoices\/([^/]+)\/payments$/);
    if (req.method === "POST" && pay) {
      const inv = invoices.get(pay[1])!;
      inv.status = "MARKED_AS_PAID";
      return json(200, { payment_id: "EXTR-1" });
    }
    const get = url.pathname.match(/^\/v2\/invoicing\/invoices\/([^/]+)$/);
    if (req.method === "GET" && get) {
      const inv = invoices.get(get[1]);
      if (!inv) return json(404, { name: "RESOURCE_NOT_FOUND" });
      return json(200, {
        id: inv.id,
        status: inv.status,
        detail: {
          ...inv.body.detail,
          metadata: inv.status === "DRAFT" ? {} : { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${inv.id.replace(/-/g, "")}` },
        },
        primary_recipients: inv.body.primary_recipients,
        amount: { currency_code: "USD", value: inv.body.items[0].unit_amount.value },
      });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  });
  const posts = (path: RegExp) => calls.filter((c) => c.method === "POST" && path.test(c.path));
  return { fetchImpl, calls, posts, invoices, state };
}

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  const agreement = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  const owner = await signInAs(t, "owner", { email: "owner@demo.tradepulse", paypalEmail: OWNER_EMAIL });
  const sub = await signInAs(t, "sub", { contractorId: agreement.contractorId, email: "sub1@demo.tradepulse" });
  return { t, gc, owner, sub, agreement };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function changeOrders(t: Setup["t"]) {
  return await t.run(async (ctx) => await ctx.db.query("changeOrders").collect());
}

async function errorOf(p: Promise<unknown>): Promise<ConvexError<{ code: string; message: string }>> {
  try {
    await p;
  } catch (e) {
    return e as ConvexError<{ code: string; message: string }>;
  }
  throw new Error("expected the call to fail");
}

let fake: ReturnType<typeof fakeInvoicing>;

beforeEach(() => {
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret-value");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  fake = fakeInvoicing();
  vi.stubGlobal("fetch", fake.fetchImpl);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearPayPalTokenCache();
});

describe("change order invoices", () => {
  test("GC creates a change order: draft invoice to the Owner, sent, stored as invoiced with a payer link", async () => {
    const { t, gc, agreement } = await setup();
    const out = await gc.as.action(api.payments.invoices.createChangeOrder, {
      agreementId: agreement._id,
      description: "Add 4 floor boxes in the lobby",
      amountCents: 250_000,
    });
    expect(out).toMatchObject({ status: "invoiced", paypalInvoiceId: "INV2-TEST-1", alreadyInvoiced: false });
    expect(out.payerViewUrl).toBe("https://www.sandbox.paypal.com/invoice/p/#INV2TEST1");

    const creates = fake.posts(/^\/v2\/invoicing\/invoices$/);
    expect(creates).toHaveLength(1);
    const body = creates[0].body as any;
    expect(body.primary_recipients[0].billing_info.email_address).toBe(OWNER_EMAIL);
    expect(body.items[0].unit_amount).toEqual({ currency_code: "USD", value: "2500.00" });
    expect(creates[0].requestId).toMatch(/^co_.+_create$/);
    const sends = fake.posts(/\/send$/);
    expect(sends).toHaveLength(1);
    expect(sends[0].body).toEqual({ send_to_recipient: true, send_to_invoicer: false });
    expect(sends[0].requestId).toMatch(/^co_.+_send$/);
    expect(fake.invoices.get("INV2-TEST-1")!.status).toBe("SENT");

    const [co] = await changeOrders(t);
    expect(co).toMatchObject({
      number: 1,
      status: "invoiced",
      amountCents: 250_000,
      paypalInvoiceId: "INV2-TEST-1",
      paypalInvoiceStatus: "SENT",
      recipientEmail: OWNER_EMAIL,
      auditRecorded: true,
    });

    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect()).filter((a) => a.eventType === "paypal_write"),
    );
    expect(audits.map((a) => a.operation)).toEqual(["paypal.invoices.create", "paypal.invoices.send"]);
    expect(audits.map((a) => a.paypalRequestId)).toEqual([creates[0].requestId, sends[0].requestId]);
    expect(JSON.stringify(audits)).not.toContain("test-secret-value");
    expect(JSON.stringify(audits)).not.toContain("A21AAfaketoken");
  });

  test("Owner sees the invoiced change order with its link; refresh keeps it invoiced until paid, then paid", async () => {
    const { t, gc, owner, agreement } = await setup();
    const out = await gc.as.action(api.payments.invoices.createChangeOrder, {
      agreementId: agreement._id,
      number: 1,
      description: "Upsize feeder",
      amountCents: 250_000,
    });

    const list = await owner.as.query(api.payments.changeOrderDb.listForAgreement, { agreementId: agreement._id });
    expect(list!.canCreate).toBe(false);
    expect(list!.changeOrders).toHaveLength(1);
    expect(list!.changeOrders[0]).toMatchObject({ label: "CO-001", status: "invoiced", payerViewUrl: out.payerViewUrl });
    const overview = await owner.as.query(api.portal.ownerOverview, {});
    expect(overview.flatMap((p) => p.changeOrders)[0]).toMatchObject({ status: "invoiced", payerViewUrl: out.payerViewUrl });

    const before = await owner.as.action(api.payments.invoices.refreshChangeOrderStatus, { changeOrderId: out.changeOrderId });
    expect(before).toMatchObject({ status: "invoiced", paypalInvoiceStatus: "SENT", changed: false });

    fake.invoices.get(out.paypalInvoiceId!)!.status = "PAID";
    const after = await owner.as.action(api.payments.invoices.refreshChangeOrderStatus, { changeOrderId: out.changeOrderId });
    expect(after).toMatchObject({ status: "paid", paypalInvoiceStatus: "PAID", changed: true });
    const [co] = await changeOrders(t);
    expect(co.status).toBe("paid");
    expect(co.paidAt).toBeTypeOf("number");

    const gcList = await gc.as.query(api.payments.changeOrderDb.listForAgreement, { agreementId: agreement._id });
    expect(gcList!.changeOrders[0].status).toBe("paid");
  });

  test("record-payment fallback marks the invoice paid and the change order paid", async () => {
    const { t, gc, agreement } = await setup();
    const out = await gc.as.action(api.payments.invoices.createChangeOrder, {
      agreementId: agreement._id,
      description: "Extra circuits",
      amountCents: 12_345,
    });
    const res = await t.action(internal.payments.invoices.recordInvoicePaymentInternal, { changeOrderId: out.changeOrderId });
    expect(res).toMatchObject({ status: "paid", paypalInvoiceStatus: "MARKED_AS_PAID" });
    const pay = fake.posts(/\/payments$/);
    expect(pay).toHaveLength(1);
    expect((pay[0].body as any).amount).toEqual({ currency_code: "USD", value: "123.45" });
  });

  test("webhook-style status apply by invoice id is idempotent and never moves paid backwards", async () => {
    const { t, gc, agreement } = await setup();
    const out = await gc.as.action(api.payments.invoices.createChangeOrder, {
      agreementId: agreement._id,
      description: "Panel relocation",
      amountCents: 50_000,
    });
    const first = await t.mutation(internal.payments.changeOrderDb.applyInvoiceStatus, {
      paypalInvoiceId: out.paypalInvoiceId!,
      paypalInvoiceStatus: "PAID",
    });
    expect(first).toMatchObject({ status: "paid", changed: true });
    const replay = await t.mutation(internal.payments.changeOrderDb.applyInvoiceStatus, {
      paypalInvoiceId: out.paypalInvoiceId!,
      paypalInvoiceStatus: "SENT",
    });
    expect(replay).toMatchObject({ status: "paid", changed: false });
    const unknown = await t.mutation(internal.payments.changeOrderDb.applyInvoiceStatus, {
      paypalInvoiceId: "INV2-NOPE",
      paypalInvoiceStatus: "PAID",
    });
    expect(unknown).toEqual({ changeOrderId: null, status: null, changed: false });
  });

  test("a failed send leaves a draft with the error; retry sends the same invoice without creating another", async () => {
    const { t, gc, agreement } = await setup();
    fake.state.failSend = true;
    const err = await errorOf(
      gc.as.action(api.payments.invoices.createChangeOrder, { agreementId: agreement._id, description: "Trenching", amountCents: 75_000 }),
    );
    expect(err.data.code).toBe("INVOICE_FAILED");
    expect(err.data.message).toMatch(/INVALID_INVOICE_STATE/);
    let [co] = await changeOrders(t);
    expect(co).toMatchObject({ status: "draft", paypalInvoiceId: "INV2-TEST-1" });
    expect(co.error).toMatch(/Invoice not sent/);

    const draftsForOwner = await (await signInAs(t, "owner")).as.query(api.payments.changeOrderDb.listForAgreement, {
      agreementId: agreement._id,
    });
    expect(draftsForOwner!.changeOrders).toHaveLength(0);

    const retry = await gc.as.action(api.payments.invoices.sendChangeOrderInvoice, { changeOrderId: co._id });
    expect(retry).toMatchObject({ status: "invoiced", paypalInvoiceId: "INV2-TEST-1" });
    expect(fake.posts(/^\/v2\/invoicing\/invoices$/)).toHaveLength(1);
    [co] = await changeOrders(t);
    expect(co.error).toBeUndefined();

    const again = await gc.as.action(api.payments.invoices.sendChangeOrderInvoice, { changeOrderId: co._id });
    expect(again.alreadyInvoiced).toBe(true);
    expect(fake.posts(/\/send$/)).toHaveLength(2);
  });

  test("only the GC can create change orders; subs see none; the owner cannot create", async () => {
    const { t, owner, sub, agreement } = await setup();
    const args = { agreementId: agreement._id, description: "x", amountCents: 100 };
    for (const who of [owner, sub]) {
      const err = await errorOf(who.as.action(api.payments.invoices.createChangeOrder, args));
      expect(err.data.code).toBe("NOT_FOUND");
    }
    const anon = await errorOf(t.action(api.payments.invoices.createChangeOrder, args));
    expect(anon.data.code).toBe("UNAUTHENTICATED");
    expect(fake.calls).toHaveLength(0);
    expect(await changeOrders(t)).toHaveLength(0);
    const subList = await sub.as.query(api.payments.changeOrderDb.listForAgreement, { agreementId: agreement._id });
    expect(subList!.changeOrders).toEqual([]);
  });

  test("sub cannot refresh a change order status", async () => {
    const { gc, sub, agreement } = await setup();
    const out = await gc.as.action(api.payments.invoices.createChangeOrder, { agreementId: agreement._id, description: "x", amountCents: 100 });
    const err = await errorOf(sub.as.action(api.payments.invoices.refreshChangeOrderStatus, { changeOrderId: out.changeOrderId }));
    expect(err.data.code).toBe("NOT_FOUND");
  });

  test("validation: positive integer cents, non-empty description, unique number", async () => {
    const { t, gc, agreement } = await setup();
    const call = (a: { number?: number; description?: string; amountCents?: number }) =>
      errorOf(
        gc.as.action(api.payments.invoices.createChangeOrder, {
          agreementId: agreement._id,
          description: a.description ?? "ok",
          amountCents: a.amountCents ?? 100,
          ...(a.number !== undefined ? { number: a.number } : {}),
        }),
      );
    expect((await call({ amountCents: 0 })).data.code).toBe("INVALID_ARGUMENT");
    expect((await call({ amountCents: 10.5 })).data.message).toMatch(/cents|integer/i);
    expect((await call({ description: "   " })).data.code).toBe("INVALID_ARGUMENT");
    expect(fake.calls).toHaveLength(0);

    await gc.as.action(api.payments.invoices.createChangeOrder, { agreementId: agreement._id, number: 7, description: "ok", amountCents: 100 });
    expect((await call({ number: 7 })).data.code).toBe("DUPLICATE_CHANGE_ORDER");
    const next = await gc.as.action(api.payments.invoices.createChangeOrder, { agreementId: agreement._id, description: "ok", amountCents: 100 });
    const rows = await changeOrders(t);
    expect(rows.find((r) => r._id === next.changeOrderId)!.number).toBe(8);
  });

  test("no owner email on file: nothing is sent to PayPal", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    const gc = await signInAs(t, "gc");
    const agreement = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
    const err = await errorOf(
      gc.as.action(api.payments.invoices.createChangeOrder, { agreementId: agreement._id as Id<"agreements">, description: "x", amountCents: 100 }),
    );
    expect(err.data.code).toBe("NO_OWNER_EMAIL");
    expect(fake.calls).toHaveLength(0);
  });
});
