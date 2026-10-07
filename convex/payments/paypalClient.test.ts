import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MAX_ATTEMPTS,
  PAYPAL_SANDBOX_BASE_URL,
  clearPayPalTokenCache,
  createPayPalClient,
  operationFor,
  withPayPalErrors,
  type PayPalAuditEntry,
  type PayPalErrorData,
} from "./paypalClient";

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret-value";
const TOKEN_A = "access-token-AAA";
const TOKEN_B = "access-token-BBB";

type Recorded = { url: string; method: string; headers: Record<string, string>; body: string };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Fake PayPal: answers the OAuth endpoint with successive tokens and every other
 * call from `responders` (in order; the last one repeats).
 */
function fakePayPal(opts: {
  tokens?: Array<{ access_token: string; expires_in: number }>;
  responders?: Array<(req: Recorded) => Response>;
}) {
  const tokens = opts.tokens ?? [{ access_token: TOKEN_A, expires_in: 32400 }];
  const responders = opts.responders ?? [() => json(200, { id: "ORDER-1", status: "CREATED" })];
  const tokenCalls: Recorded[] = [];
  const apiCalls: Recorded[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const rec: Recorded = {
      url: req.url,
      method: req.method,
      headers: Object.fromEntries(req.headers),
      body: req.method === "GET" ? "" : await req.text(),
    };
    if (rec.url.endsWith("/v1/oauth2/token")) {
      const t = tokens[Math.min(tokenCalls.length, tokens.length - 1)];
      tokenCalls.push(rec);
      return json(200, { ...t, token_type: "Bearer", scope: "test" });
    }
    const responder = responders[Math.min(apiCalls.length, responders.length - 1)];
    apiCalls.push(rec);
    return responder(rec);
  });
  return { fetchImpl, tokenCalls, apiCalls };
}

function makeClient(fake: ReturnType<typeof fakePayPal>, extra: { now?: () => number } = {}) {
  const audits: PayPalAuditEntry[] = [];
  const sleeps: number[] = [];
  const client = createPayPalClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    environment: "sandbox",
    fetch: fake.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    audit: (entry) => {
      audits.push(entry);
    },
    now: extra.now,
  });
  return { client, audits, sleeps };
}

async function catchError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected promise to reject");
}

afterEach(() => {
  clearPayPalTokenCache();
});

describe("OAuth token cache", () => {
  test("a second REST request reuses the cached token", async () => {
    const fake = fakePayPal({});
    const { client } = makeClient(fake);

    await client.request({ method: "GET", path: "/v2/checkout/orders/ORDER-1" });
    await client.request({ method: "GET", path: "/v2/checkout/orders/ORDER-1" });

    expect(fake.tokenCalls).toHaveLength(1);
    expect(fake.tokenCalls[0].method).toBe("POST");
    expect(fake.tokenCalls[0].url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v1/oauth2/token`);
    expect(fake.tokenCalls[0].headers.authorization).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
    expect(fake.tokenCalls[0].body).toBe("grant_type=client_credentials");
    expect(fake.apiCalls.map((c) => c.headers.authorization)).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_A}`]);
  });

  test("the cache is shared by client instances with the same credentials", async () => {
    const fake = fakePayPal({});
    await makeClient(fake).client.getAccessToken();
    await makeClient(fake).client.getAccessToken();
    expect(fake.tokenCalls).toHaveLength(1);
  });

  test("a token within 5 minutes of expiry is refreshed", async () => {
    let now = 1_000_000;
    const fake = fakePayPal({
      tokens: [
        { access_token: TOKEN_A, expires_in: 3600 },
        { access_token: TOKEN_B, expires_in: 3600 },
      ],
    });
    const { client } = makeClient(fake, { now: () => now });

    await client.request({ method: "GET", path: "/v2/checkout/orders/ORDER-1" });
    now += (3600 - 5 * 60 - 1) * 1000; // 5 min + 1 s before expiry: still cached
    await client.request({ method: "GET", path: "/v2/checkout/orders/ORDER-1" });
    expect(fake.tokenCalls).toHaveLength(1);

    now += 2 * 1000; // now inside the 5-minute window
    await client.request({ method: "GET", path: "/v2/checkout/orders/ORDER-1" });
    expect(fake.tokenCalls).toHaveLength(2);
    expect(fake.apiCalls.map((c) => c.headers.authorization)).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_B}`,
    ]);
  });

  test("concurrent requests share one token fetch", async () => {
    const fake = fakePayPal({});
    const { client } = makeClient(fake);
    await Promise.all([client.getAccessToken(), client.getAccessToken(), client.getAccessToken()]);
    expect(fake.tokenCalls).toHaveLength(1);
  });

  test("a 401 drops the cached token and retries once with a fresh one", async () => {
    const fake = fakePayPal({
      tokens: [
        { access_token: TOKEN_A, expires_in: 32400 },
        { access_token: TOKEN_B, expires_in: 32400 },
      ],
      responders: [
        () => json(401, { error: "invalid_token", error_description: "Token signature verification failed" }),
        () => json(200, { id: "ORDER-1" }),
      ],
    });
    const { client } = makeClient(fake);
    const res = await client.request({ method: "GET", path: "/v2/checkout/orders/ORDER-1" });
    expect(res.status).toBe(200);
    expect(fake.tokenCalls).toHaveLength(2);
    expect(fake.apiCalls[1].headers.authorization).toBe(`Bearer ${TOKEN_B}`);
  });

  test("a non-sandbox environment is refused", () => {
    expect(() =>
      createPayPalClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, environment: "live" }),
    ).toThrow(/sandbox/);
  });

  test("missing credentials raise a readable ConvexError", () => {
    const err = (() => {
      try {
        createPayPalClient({ clientId: "", clientSecret: CLIENT_SECRET });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<{ message: string }>).data.message).toMatch(/PAYPAL_CLIENT_ID/);
  });
});

describe("PayPal-Request-Id on writes", () => {
  test("REST POST sends the caller's idempotency key and audits it", async () => {
    const fake = fakePayPal({ responders: [() => json(201, { id: "ORDER-9", status: "CREATED" })] });
    const { client, audits } = makeClient(fake);

    const res = await client.request<{ id: string }>({
      method: "POST",
      path: "/v2/checkout/orders",
      body: { intent: "AUTHORIZE" },
      requestId: "pay_abc123",
    });

    expect(res.status).toBe(201);
    expect(res.data.id).toBe("ORDER-9");
    expect(res.requestId).toBe("pay_abc123");
    expect(fake.apiCalls[0].headers["paypal-request-id"]).toBe("pay_abc123");
    expect(fake.apiCalls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(fake.apiCalls[0].body)).toEqual({ intent: "AUTHORIZE" });
    expect(audits).toEqual([
      expect.objectContaining({
        operation: "paypal.orders.create",
        method: "POST",
        path: "/v2/checkout/orders",
        status: 201,
        ok: true,
        attempts: 1,
        paypalRequestId: "pay_abc123",
        resourceId: "ORDER-9",
        via: "rest",
      }),
    ]);
  });

  test("REST POST without a key gets a generated one; GET is not audited", async () => {
    const fake = fakePayPal({ responders: [() => json(201, { id: "X" })] });
    const { client, audits } = makeClient(fake);

    await client.request({ method: "POST", path: "/v2/payments/authorizations/AUTH-1/void" });
    await client.request({ method: "GET", path: "/v2/payments/authorizations/AUTH-1" });

    const generated = fake.apiCalls[0].headers["paypal-request-id"];
    expect(generated).toMatch(/^tp-[0-9a-f-]{36}$/);
    expect(fake.apiCalls[1].headers["paypal-request-id"]).toBeUndefined();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ operation: "paypal.authorizations.void", paypalRequestId: generated });
  });

  test("Server SDK POSTs carry PayPal-Request-Id and use the shared token cache", async () => {
    const fake = fakePayPal({
      responders: [() => json(201, { id: "ORDER-7", status: "COMPLETED" }, { "paypal-debug-id": "dbg-7" })],
    });
    const { client, audits } = makeClient(fake);
    const { orders, payments } = client.sdk();

    await client.getAccessToken();
    await orders.authorizeOrder({ id: "ORDER-7", paypalRequestId: "fund_m1" });
    await payments.voidPayment({ authorizationId: "AUTH-7" });
    await payments.captureAuthorizedPayment({
      authorizationId: "AUTH-8",
      paypalRequestId: "cap_p1",
      body: { amount: { currencyCode: "USD", value: "6.00" }, finalCapture: false },
    });

    expect(fake.tokenCalls).toHaveLength(1);
    expect(fake.apiCalls.map((c) => c.method)).toEqual(["POST", "POST", "POST"]);
    expect(fake.apiCalls.map((c) => c.headers.authorization)).toEqual(Array(3).fill(`Bearer ${TOKEN_A}`));
    expect(fake.apiCalls[0].headers["paypal-request-id"]).toBe("fund_m1");
    expect(fake.apiCalls[1].headers["paypal-request-id"]).toMatch(/^tp-/);
    expect(fake.apiCalls[2].headers["paypal-request-id"]).toBe("cap_p1");
    expect(JSON.parse(fake.apiCalls[2].body)).toEqual({ amount: { currency_code: "USD", value: "6.00" }, final_capture: false });
    expect(audits.map((a) => [a.operation, a.via, a.paypalRequestId?.slice(0, 3)])).toEqual([
      ["paypal.orders.authorize", "sdk", "fun"],
      ["paypal.authorizations.void", "sdk", "tp-"],
      ["paypal.authorizations.capture", "sdk", "cap"],
    ]);
    expect(audits[0].paypalDebugId).toBe("dbg-7");
  });

  test("audit entries never contain tokens or secrets", async () => {
    const fake = fakePayPal({
      responders: [() => json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] })],
    });
    const { client, audits } = makeClient(fake);
    await catchError(client.request({ method: "POST", path: "/v2/checkout/orders/O/authorize", requestId: "k1" }));
    await catchError(client.sdk().orders.captureOrder({ id: "O", paypalRequestId: "k2" }));

    expect(audits).toHaveLength(2);
    const serialized = JSON.stringify(audits);
    for (const secret of [TOKEN_A, CLIENT_SECRET, CLIENT_ID, "Bearer", "Basic"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(audits.every((a) => a.ok === false && a.errorName === "UNPROCESSABLE_ENTITY")).toBe(true);
  });
});

describe("backoff on 429 / 5xx", () => {
  test("429 then 503 is retried with increasing delays and then succeeds", async () => {
    const fake = fakePayPal({
      responders: [
        () => json(429, { name: "RATE_LIMIT_REACHED" }),
        () => json(503, { name: "SERVICE_UNAVAILABLE" }),
        () => json(201, { id: "ORDER-2" }),
      ],
    });
    const { client, sleeps, audits } = makeClient(fake);

    const res = await client.request({ method: "POST", path: "/v2/checkout/orders", requestId: "same-key" });

    expect(res.status).toBe(201);
    expect(fake.apiCalls).toHaveLength(3);
    expect(new Set(fake.apiCalls.map((c) => c.headers["paypal-request-id"]))).toEqual(new Set(["same-key"]));
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
    expect(audits[0]).toMatchObject({ status: 201, attempts: 3, ok: true });
  });

  test("stops after 3 attempts and raises a ConvexError", async () => {
    const fake = fakePayPal({ responders: [() => json(500, { name: "INTERNAL_SERVER_ERROR", message: "boom" })] });
    const { client, sleeps } = makeClient(fake);

    const err = await catchError(client.request({ method: "GET", path: "/v2/checkout/orders/O" }));

    expect(MAX_ATTEMPTS).toBe(3);
    expect(fake.apiCalls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<{ status: number; name: string }>).data).toMatchObject({
      status: 500,
      name: "INTERNAL_SERVER_ERROR",
    });
  });

  test("Retry-After is honoured when larger than the backoff delay", async () => {
    const fake = fakePayPal({
      responders: [() => json(429, { name: "RATE_LIMIT_REACHED" }, { "retry-after": "2" }), () => json(200, {})],
    });
    const { client, sleeps } = makeClient(fake);
    await client.request({ method: "GET", path: "/v1/payments/payouts/B1" });
    expect(sleeps).toEqual([2000]);
  });

  test("Server SDK calls get the same backoff", async () => {
    const fake = fakePayPal({
      responders: [() => json(502, { name: "BAD_GATEWAY" }), () => json(200, { id: "ORDER-3", status: "APPROVED" })],
    });
    const { client, sleeps } = makeClient(fake);
    const res = await client.sdk().orders.getOrder({ id: "ORDER-3" });
    expect(res.statusCode).toBe(200);
    expect(res.result.status).toBe("APPROVED");
    expect(fake.apiCalls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  test("a network failure is retried, then surfaces as a ConvexError", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v1/oauth2/token")) return json(200, { access_token: TOKEN_A, expires_in: 32400 });
      throw new TypeError("fetch failed");
    });
    const sleeps: number[] = [];
    const client = createPayPalClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    });
    const err = await catchError(client.request({ method: "GET", path: "/v2/checkout/orders/O" }));
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<{ code: string }>).data.code).toBe("PAYPAL_NETWORK_ERROR");
    expect(fetchImpl).toHaveBeenCalledTimes(1 + MAX_ATTEMPTS);
  });
});

describe("4xx error mapping", () => {
  test("REST 4xx raises a readable ConvexError with name and details[].issue, without retrying", async () => {
    const fake = fakePayPal({
      responders: [
        () =>
          json(
            422,
            {
              name: "UNPROCESSABLE_ENTITY",
              message: "The requested action could not be performed.",
              debug_id: "dbg-422",
              details: [{ issue: "ORDER_NOT_APPROVED", description: "Payer has not yet approved the Order." }],
            },
            { "paypal-debug-id": "dbg-422" },
          ),
      ],
    });
    const { client, sleeps } = makeClient(fake);

    const err = await catchError(
      client.request({ method: "POST", path: "/v2/checkout/orders/O/authorize", requestId: "k" }),
    );

    expect(fake.apiCalls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<PayPalErrorData>).data;
    expect(data).toMatchObject({
      code: "PAYPAL_ERROR",
      status: 422,
      name: "UNPROCESSABLE_ENTITY",
      issues: ["ORDER_NOT_APPROVED"],
      debugId: "dbg-422",
      operation: "paypal.orders.authorize",
    });
    expect(data.message).toBe(
      "PayPal paypal.orders.authorize failed (HTTP 422 UNPROCESSABLE_ENTITY): ORDER_NOT_APPROVED - Payer has not yet approved the Order.",
    );
  });

  test("OAuth errors use error / error_description", async () => {
    const fetchImpl = vi.fn(async () =>
      json(401, { error: "invalid_client", error_description: "Client Authentication failed" }),
    );
    const client = createPayPalClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetch: fetchImpl });
    const err = await catchError(client.getAccessToken());
    expect((err as ConvexError<{ message: string; name: string }>).data).toMatchObject({
      name: "invalid_client",
      message: expect.stringContaining("Client Authentication failed"),
    });
    expect(JSON.stringify((err as ConvexError<PayPalErrorData>).data)).not.toContain(CLIENT_SECRET);
  });

  test("Server SDK 4xx maps to the same readable ConvexError via withPayPalErrors", async () => {
    const fake = fakePayPal({
      responders: [
        () =>
          json(422, {
            name: "UNPROCESSABLE_ENTITY",
            message: "The requested action could not be performed.",
            details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED", description: "Authorization has been previously captured." }],
          }),
      ],
    });
    const { client } = makeClient(fake);
    const err = await catchError(
      withPayPalErrors("paypal.authorizations.capture", () =>
        client.sdk().payments.captureAuthorizedPayment({ authorizationId: "A", paypalRequestId: "k" }),
      ),
    );
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<PayPalErrorData>).data).toMatchObject({
      status: 422,
      name: "UNPROCESSABLE_ENTITY",
      issues: ["AUTHORIZATION_ALREADY_CAPTURED"],
      message: expect.stringContaining("AUTHORIZATION_ALREADY_CAPTURED"),
    });
  });
});

describe("operationFor", () => {
  test.each([
    ["POST", "/v2/checkout/orders", "paypal.orders.create"],
    ["POST", "/v2/checkout/orders/5O1/authorize", "paypal.orders.authorize"],
    ["POST", "/v2/payments/authorizations/0VF/capture", "paypal.authorizations.capture"],
    ["POST", "/v2/payments/authorizations/0VF/reauthorize", "paypal.authorizations.reauthorize"],
    ["POST", "/v1/payments/payouts", "paypal.payouts.create"],
    ["POST", "/v2/invoicing/invoices", "paypal.invoices.create"],
    ["POST", "/v2/invoicing/invoices/INV2-1/send", "paypal.invoices.send"],
    ["POST", "/v1/notifications/verify-webhook-signature", "paypal.webhooks.verify_signature"],
    ["GET", "/v2/checkout/orders/5O1", "paypal.orders.get"],
  ])("%s %s -> %s", (method, path, op) => {
    expect(operationFor(method, path)).toBe(op);
  });
});

type NetworkErrorData = {
  code: string;
  attempts: number;
  errorClass: string;
  paypalRequestId?: string;
  auditRecorded?: boolean;
  message: string;
};

/** Client whose audit sink fails the first `failures` calls (Infinity = always). */
function clientWithFlakyAudit(fetchImpl: ReturnType<typeof fakePayPal>["fetchImpl"] | ((input: string | URL | Request, init?: RequestInit) => Promise<Response>), failures: number) {
  const audits: PayPalAuditEntry[] = [];
  const sleeps: number[] = [];
  let calls = 0;
  const client = createPayPalClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetch: fetchImpl,
    sleep: async (ms) => void sleeps.push(ms),
    audit: async (entry) => {
      calls++;
      if (calls <= failures) throw new Error("auditLogs insert failed");
      audits.push(entry);
    },
  });
  return { client, audits, sleeps, auditCalls: () => calls };
}

function networkDownFetch() {
  const apiCalls: Recorded[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.url.endsWith("/v1/oauth2/token")) return json(200, { access_token: TOKEN_A, expires_in: 32400 });
    apiCalls.push({ url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: await req.text() });
    throw new TypeError("fetch failed");
  });
  return { fetchImpl, apiCalls };
}

function brokenBody(status: number): Response {
  const stream = new ReadableStream({
    start(c) {
      c.error(new TypeError("terminated"));
    },
  });
  return new Response(stream, { status, headers: { "content-type": "application/json" } });
}

describe("audit persistence failures", () => {
  test("REST: a sink that rejects once is retried; one audit row and the PayPal result are returned", async () => {
    const fake = fakePayPal({ responders: [() => json(201, { id: "BATCH-1" })] });
    const { client, audits } = clientWithFlakyAudit(fake.fetchImpl, 1);
    const res = await client.request<{ id: string }>({ method: "POST", path: "/v1/payments/payouts", requestId: "po_1" });
    expect(res.data.id).toBe("BATCH-1");
    expect(res.auditRecorded).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ paypalRequestId: "po_1", outcome: "succeeded" });
    expect(fake.apiCalls).toHaveLength(1);
    expect(client.unrecordedAudits).toHaveLength(0);
  });

  test("REST: a sink that always rejects returns the result with auditRecorded false and no second send", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const fake = fakePayPal({ responders: [() => json(201, { id: "BATCH-2" })] });
      const { client, audits, auditCalls } = clientWithFlakyAudit(fake.fetchImpl, Infinity);
      const res = await client.request<{ id: string }>({ method: "POST", path: "/v1/payments/payouts", requestId: "po_2" });
      expect(res.status).toBe(201);
      expect(res.data.id).toBe("BATCH-2");
      expect(res.auditRecorded).toBe(false);
      expect(fake.apiCalls).toHaveLength(1);
      expect(audits).toHaveLength(0);
      expect(auditCalls()).toBe(2);
      expect(client.unrecordedAudits).toEqual([expect.objectContaining({ paypalRequestId: "po_2", resourceId: "BATCH-2" })]);
      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("paypal.payouts.create");
      expect(logged).toContain("po_2");
      expect(logged).toContain("BATCH-2");
      expect(logged).toContain("status=201");
      for (const secret of [TOKEN_A, CLIENT_SECRET, CLIENT_ID]) expect(logged).not.toContain(secret);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("SDK: a sink that rejects once is retried; one audit row and the SDK result are returned", async () => {
    const fake = fakePayPal({ responders: [() => json(201, { id: "ORDER-5", status: "COMPLETED" })] });
    const { client, audits } = clientWithFlakyAudit(fake.fetchImpl, 1);
    const res = await client.sdk().orders.authorizeOrder({ id: "ORDER-5", paypalRequestId: "fund_5" });
    expect(res.result.id).toBe("ORDER-5");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ via: "sdk", paypalRequestId: "fund_5", resourceId: "ORDER-5" });
    expect(fake.apiCalls).toHaveLength(1);
  });

  test("SDK: a sink that always rejects still returns the result, records it as unrecorded, and sends once", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const fake = fakePayPal({ responders: [() => json(201, { id: "ORDER-6", status: "COMPLETED" })] });
      const { client, audits } = clientWithFlakyAudit(fake.fetchImpl, Infinity);
      const res = await client.sdk().orders.authorizeOrder({ id: "ORDER-6", paypalRequestId: "fund_6" });
      expect(res.result.status).toBe("COMPLETED");
      expect(fake.apiCalls).toHaveLength(1);
      expect(audits).toHaveLength(0);
      expect(client.unrecordedAudits).toEqual([expect.objectContaining({ via: "sdk", paypalRequestId: "fund_6" })]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  test("sdkWrite: a sink that always rejects returns the unchanged SDK result with auditRecorded false after one send", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const fake = fakePayPal({ responders: [() => json(201, { id: "ORDER-8", status: "COMPLETED" })] });
      const { client, audits, auditCalls } = clientWithFlakyAudit(fake.fetchImpl, Infinity);
      const out = await client.sdkWrite("paypal.orders.authorize", "fund_8_auth", (sdk, id) =>
        sdk.orders.authorizeOrder({ id: "ORDER-8", paypalRequestId: id }),
      );
      expect(out.auditRecorded).toBe(false);
      expect(out.paypalRequestId).toBe("fund_8_auth");
      expect(out.response.statusCode).toBe(201);
      expect(out.response.result).toMatchObject({ id: "ORDER-8", status: "COMPLETED" });
      expect(fake.apiCalls).toHaveLength(1);
      expect(fake.apiCalls[0].headers["paypal-request-id"]).toBe("fund_8_auth");
      expect(audits).toHaveLength(0);
      expect(auditCalls()).toBe(2);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("sdkWrite: a healthy sink reports auditRecorded true", async () => {
    const fake = fakePayPal({ responders: [() => json(201, { id: "ORDER-9", status: "CREATED" })] });
    const { client, audits } = clientWithFlakyAudit(fake.fetchImpl, 0);
    const out = await client.sdkWrite("paypal.orders.create", "fund_9", (sdk, id) =>
      sdk.orders.createOrder({ paypalRequestId: id, body: { intent: "AUTHORIZE" as never, purchaseUnits: [] } }),
    );
    expect(out.auditRecorded).toBe(true);
    expect(out.response.result.id).toBe("ORDER-9");
    expect(audits).toEqual([expect.objectContaining({ paypalRequestId: "fund_9", outcome: "succeeded", via: "sdk" })]);
  });

  test("sdkWrite: a 4xx carries the request id and auditRecorded on the readable error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const fake = fakePayPal({
        responders: [
          () => json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED", description: "Declined." }] }),
        ],
      });
      const { client } = clientWithFlakyAudit(fake.fetchImpl, Infinity);
      const err = await catchError(
        client.sdkWrite("paypal.orders.authorize", "fund_10_auth", (sdk, id) => sdk.orders.authorizeOrder({ id: "O10", paypalRequestId: id })),
      );
      expect(err).toBeInstanceOf(ConvexError);
      expect((err as ConvexError<PayPalErrorData>).data).toMatchObject({
        code: "PAYPAL_ERROR",
        status: 422,
        issues: ["INSTRUMENT_DECLINED"],
        paypalRequestId: "fund_10_auth",
        auditRecorded: false,
      });
      expect(fake.apiCalls).toHaveLength(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("indeterminate writes", () => {
  test("REST POST network failure x3: 3 sends, one indeterminate audit, readable ConvexError with the request id", async () => {
    const net = networkDownFetch();
    const { client, audits } = clientWithFlakyAudit(net.fetchImpl, 0);
    const err = await catchError(client.request({ method: "POST", path: "/v1/payments/payouts", requestId: "po_net" }));

    expect(net.apiCalls).toHaveLength(MAX_ATTEMPTS);
    expect(new Set(net.apiCalls.map((c) => c.headers["paypal-request-id"]))).toEqual(new Set(["po_net"]));
    expect(audits).toEqual([
      expect.objectContaining({
        operation: "paypal.payouts.create",
        outcome: "indeterminate",
        ok: false,
        status: 0,
        attempts: 3,
        paypalRequestId: "po_net",
        errorName: "TypeError",
        via: "rest",
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(TOKEN_A);
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<NetworkErrorData>).data).toMatchObject({
      code: "PAYPAL_NETWORK_ERROR",
      attempts: 3,
      paypalRequestId: "po_net",
      auditRecorded: true,
      message: expect.stringContaining("network error after 3 attempts"),
    });

    // A caller retry with the returned request id reuses the same PayPal-Request-Id.
    const retryId = (err as ConvexError<NetworkErrorData>).data.paypalRequestId;
    await catchError(client.request({ method: "POST", path: "/v1/payments/payouts", requestId: retryId }));
    expect(new Set(net.apiCalls.map((c) => c.headers["paypal-request-id"]))).toEqual(new Set(["po_net"]));
  });

  test("REST body-read failure on a write is audited as indeterminate", async () => {
    const fake = fakePayPal({ responders: [() => brokenBody(201)] });
    const { client, audits } = clientWithFlakyAudit(fake.fetchImpl, 0);
    const err = await catchError(client.request({ method: "POST", path: "/v2/invoicing/invoices/INV-1/send", requestId: "inv_1" }));
    expect(fake.apiCalls).toHaveLength(1);
    expect(audits).toEqual([expect.objectContaining({ outcome: "indeterminate", paypalRequestId: "inv_1", attempts: 1 })]);
    expect((err as ConvexError<NetworkErrorData>).data).toMatchObject({
      code: "PAYPAL_NETWORK_ERROR",
      paypalRequestId: "inv_1",
      message: expect.stringContaining("response body could not be read"),
    });
  });

  test("REST GET network failure is not audited", async () => {
    const net = networkDownFetch();
    const { client, audits } = clientWithFlakyAudit(net.fetchImpl, 0);
    await catchError(client.request({ method: "GET", path: "/v1/payments/payouts/B" }));
    expect(audits).toHaveLength(0);
  });

  test("SDK POST network failure x3: 3 sends, one indeterminate audit, readable ConvexError via withPayPalErrors", async () => {
    const net = networkDownFetch();
    const { client, audits } = clientWithFlakyAudit(net.fetchImpl, 0);
    const err = await catchError(
      withPayPalErrors("paypal.authorizations.capture", () =>
        client.sdk().payments.captureAuthorizedPayment({ authorizationId: "A1", paypalRequestId: "cap_net" }),
      ),
    );
    expect(net.apiCalls).toHaveLength(MAX_ATTEMPTS);
    expect(new Set(net.apiCalls.map((c) => c.headers["paypal-request-id"]))).toEqual(new Set(["cap_net"]));
    expect(audits).toEqual([
      expect.objectContaining({
        operation: "paypal.authorizations.capture",
        outcome: "indeterminate",
        attempts: 3,
        paypalRequestId: "cap_net",
        via: "sdk",
      }),
    ]);
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<NetworkErrorData>).data).toMatchObject({ code: "PAYPAL_NETWORK_ERROR", paypalRequestId: "cap_net" });
  });

  test("SDK body-read failure on a write is audited as indeterminate", async () => {
    const fake = fakePayPal({ responders: [() => brokenBody(201)] });
    const { client, audits } = clientWithFlakyAudit(fake.fetchImpl, 0);
    const err = await catchError(
      withPayPalErrors("paypal.orders.capture", () => client.sdk().orders.captureOrder({ id: "O1", paypalRequestId: "cap_body" })),
    );
    expect(fake.apiCalls).toHaveLength(1);
    expect(audits).toEqual([expect.objectContaining({ outcome: "indeterminate", paypalRequestId: "cap_body", via: "sdk" })]);
    expect((err as ConvexError<NetworkErrorData>).data).toMatchObject({ code: "PAYPAL_NETWORK_ERROR" });
  });
});

describe("one retry budget across 401 refresh and 429/5xx", () => {
  const twoTokens = [
    { access_token: TOKEN_A, expires_in: 32400 },
    { access_token: TOKEN_B, expires_in: 32400 },
  ];

  test("REST 401 then 429 then 500: 3 sends total, backoff continues", async () => {
    const fake = fakePayPal({
      tokens: twoTokens,
      responders: [
        () => json(401, { error: "invalid_token" }),
        () => json(429, { name: "RATE_LIMIT_REACHED" }),
        () => json(500, { name: "INTERNAL_SERVER_ERROR" }),
        () => json(201, { id: "never" }),
      ],
    });
    const { client, sleeps, audits } = makeClient(fake);
    const err = await catchError(client.request({ method: "POST", path: "/v1/payments/payouts", requestId: "po_b" }));
    expect(fake.apiCalls).toHaveLength(3);
    expect(fake.apiCalls.map((c) => c.headers.authorization)).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`, `Bearer ${TOKEN_B}`]);
    expect(sleeps).toEqual([1000]);
    expect((err as ConvexError<PayPalErrorData>).data).toMatchObject({ status: 500, paypalRequestId: "po_b" });
    expect(audits).toEqual([expect.objectContaining({ status: 500, attempts: 3, outcome: "failed" })]);
  });

  test("REST 401 then repeated 503: 3 sends total", async () => {
    const fake = fakePayPal({
      tokens: twoTokens,
      responders: [() => json(401, { error: "invalid_token" }), () => json(503, { name: "SERVICE_UNAVAILABLE" })],
    });
    const { client } = makeClient(fake);
    await catchError(client.request({ method: "POST", path: "/v1/payments/payouts", requestId: "po_c" }));
    expect(fake.apiCalls).toHaveLength(3);
  });

  test("REST 429 then 401 then 503s: 3 sends total and only one token refresh", async () => {
    const fake = fakePayPal({
      tokens: twoTokens,
      responders: [
        () => json(429, { name: "RATE_LIMIT_REACHED" }),
        () => json(401, { error: "invalid_token" }),
        () => json(503, { name: "SERVICE_UNAVAILABLE" }),
      ],
    });
    const { client, sleeps } = makeClient(fake);
    await catchError(client.request({ method: "POST", path: "/v1/payments/payouts", requestId: "po_d" }));
    expect(fake.apiCalls).toHaveLength(3);
    expect(fake.tokenCalls).toHaveLength(2);
    expect(sleeps).toEqual([500]);
  });

  test("SDK 401 then 429 then 500: at most 3 sends total", async () => {
    const fake = fakePayPal({
      tokens: twoTokens,
      responders: [
        () => json(401, { name: "AUTHENTICATION_FAILURE" }),
        () => json(429, { name: "RATE_LIMIT_REACHED" }),
        () => json(500, { name: "INTERNAL_SERVER_ERROR" }),
        () => json(201, { id: "never" }),
      ],
    });
    const { client } = makeClient(fake);
    await catchError(
      withPayPalErrors("paypal.orders.capture", () => client.sdk().orders.captureOrder({ id: "O2", paypalRequestId: "cap_b" })),
    );
    expect(fake.apiCalls.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });

  test("SDK 429 then 500 then 500: exactly 3 sends", async () => {
    const fake = fakePayPal({
      responders: [() => json(429, { name: "RATE_LIMIT_REACHED" }), () => json(500, { name: "INTERNAL_SERVER_ERROR" })],
    });
    const { client, audits } = makeClient(fake);
    await catchError(
      withPayPalErrors("paypal.orders.capture", () => client.sdk().orders.captureOrder({ id: "O3", paypalRequestId: "cap_c" })),
    );
    expect(fake.apiCalls).toHaveLength(3);
    expect(audits).toEqual([expect.objectContaining({ status: 500, attempts: 3, via: "sdk" })]);
  });
});
