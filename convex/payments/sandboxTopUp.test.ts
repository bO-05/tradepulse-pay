/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { clearPayPalTokenCache } from "./paypalClient";

const modules = import.meta.glob("/convex/**/*.ts");

type Call = { method: string; path: string; requestId: string | null; body: unknown };

function fakePayPal() {
  const calls: Call[] = [];
  const approved = new Set<string>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "tok", expires_in: 32400 });
    const text = req.method === "POST" ? await req.text() : "";
    calls.push({ method: req.method, path: url.pathname, requestId: req.headers.get("PayPal-Request-Id"), body: text ? JSON.parse(text) : null });
    if (req.method === "POST" && url.pathname === "/v2/checkout/orders") {
      return json(201, {
        id: "TOPUP1",
        status: "CREATED",
        links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=TOPUP1", method: "GET" }],
      });
    }
    const m = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (req.method === "POST" && m) {
      if (!approved.has(m[1])) {
        return json(422, {
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed.",
          details: [{ issue: "ORDER_NOT_APPROVED", description: "Payer has not yet approved the Order for payment." }],
          debug_id: "dbg",
        });
      }
      return json(201, {
        id: m[1],
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [{ id: `CAP-${m[1]}`, status: "COMPLETED", amount: { currency_code: "USD", value: "50.00" } }] } }],
      });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  });
  return { calls, approved, fetchImpl, posts: () => calls.filter((c) => c.method === "POST" && c.path !== "/v1/oauth2/token") };
}

let fake: ReturnType<typeof fakePayPal>;
beforeEach(() => {
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  fake = fakePayPal();
  vi.stubGlobal("fetch", fake.fetchImpl);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearPayPalTokenCache();
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConvexError) return (e.data as { code?: string }).code;
    return String(e);
  }
  throw new Error("expected the call to fail");
}

describe("sandbox platform top-up", () => {
  test("only the GC can create or capture a top-up", async () => {
    const t = convexTest(schema, modules);
    const sub = await signInAs(t, "sub");
    const owner = await signInAs(t, "owner");
    expect(await codeOf(sub.as.action(api.payments.sandboxTopUp.createTopUpOrder, { amountCents: 5_000 }))).toBe("FORBIDDEN");
    expect(await codeOf(owner.as.action(api.payments.sandboxTopUp.captureTopUpOrder, { paypalOrderId: "X" }))).toBe("FORBIDDEN");
    expect(fake.posts()).toHaveLength(0);
  });

  test("rejects amounts outside the allowed range", async () => {
    const t = convexTest(schema, modules);
    const gc = await signInAs(t, "gc");
    expect(await codeOf(gc.as.action(api.payments.sandboxTopUp.createTopUpOrder, { amountCents: 50 }))).toBe("INVALID_AMOUNT");
    expect(await codeOf(gc.as.action(api.payments.sandboxTopUp.createTopUpOrder, { amountCents: 2_000_001 }))).toBe("INVALID_AMOUNT");
    expect(fake.posts()).toHaveLength(0);
  });

  test("refuses to run outside the sandbox", async () => {
    vi.stubEnv("PAYPAL_ENV", "live");
    const t = convexTest(schema, modules);
    const gc = await signInAs(t, "gc");
    expect(await codeOf(gc.as.action(api.payments.sandboxTopUp.createTopUpOrder, { amountCents: 5_000 }))).toBe("SANDBOX_ONLY");
  });

  test("creates a CAPTURE order with a request id, then captures once approved", async () => {
    const t = convexTest(schema, modules);
    const gc = await signInAs(t, "gc");
    const created = await gc.as.action(api.payments.sandboxTopUp.createTopUpOrder, { amountCents: 5_000 });
    expect(created.paypalOrderId).toBe("TOPUP1");
    const [create] = fake.posts();
    expect(create.requestId).toMatch(/^topup_/);
    const body = create.body as { intent: string; purchase_units: { amount: { value: string } }[] };
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0].amount.value).toBe("50.00");

    expect(await codeOf(gc.as.action(api.payments.sandboxTopUp.captureTopUpOrder, { paypalOrderId: "TOPUP1" }))).toBe("ORDER_NOT_APPROVED");
    let rows = await gc.as.query(api.payments.sandboxTopUpDb.listTopUps, {});
    expect(rows[0].status).toBe("created");

    fake.approved.add("TOPUP1");
    const res = await gc.as.action(api.payments.sandboxTopUp.captureTopUpOrder, { paypalOrderId: "TOPUP1" });
    expect(res.paypalCaptureId).toBe("CAP-TOPUP1");
    const capture = fake.posts().filter((c) => c.path.endsWith("/capture"));
    expect(capture.every((c) => c.requestId === "topup_cap_TOPUP1")).toBe(true);

    const again = await gc.as.action(api.payments.sandboxTopUp.captureTopUpOrder, { paypalOrderId: "TOPUP1" });
    expect(again.message).toMatch(/already captured/);
    expect(fake.posts().filter((c) => c.path.endsWith("/capture"))).toHaveLength(2);

    rows = await gc.as.query(api.payments.sandboxTopUpDb.listTopUps, {});
    expect(rows[0]).toMatchObject({ status: "captured", paypalCaptureId: "CAP-TOPUP1", amountCents: 5_000 });
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((a) => /orders\.create/.test(JSON.stringify(a)))).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("test-secret");
  });
});
