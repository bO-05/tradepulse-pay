import {
  ApiError,
  type ApiResponse,
  Client,
  Environment,
  OrdersController,
  PaymentsController,
} from "@paypal/paypal-server-sdk";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

/**
 * Single gateway for every PayPal HTTP call (REST helper and Server SDK).
 * Sandbox only; token cache, idempotency header, backoff, error mapping and audit live here.
 */

export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 10_000;
const SDK_TIMEOUT_MS = 30_000;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type PayPalAuditEntry = {
  operation: string;
  method: string;
  path: string;
  status: number;
  ok: boolean;
  attempts: number;
  paypalRequestId?: string;
  paypalDebugId?: string;
  resourceId?: string;
  errorName?: string;
  via: "rest" | "sdk";
};
export type PayPalAuditSink = (entry: PayPalAuditEntry) => Promise<void> | void;

export type PayPalClientConfig = {
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** Must be "sandbox" (or unset). Live PayPal is outside this app's scope. */
  environment?: string;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  audit?: PayPalAuditSink;
  baseDelayMs?: number;
};

export type PayPalRequest = {
  method: HttpMethod;
  /** Path starting with "/", e.g. "/v2/checkout/orders". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Idempotency key for writes. Generated when omitted on a write; pass a stable key to make retries safe. */
  requestId?: string;
  operation?: string;
  headers?: Record<string, string>;
};

export type PayPalResponse<T> = {
  status: number;
  data: T;
  requestId?: string;
  debugId?: string;
};

export type PayPalErrorData = {
  code: "PAYPAL_ERROR";
  operation: string;
  status: number;
  name: string;
  issues: string[];
  debugId?: string;
  message: string;
};

type CachedToken = { accessToken: string; refreshAtMs: number };

// Module scope so the cache survives across actions that reuse the same isolate.
const tokenCache = new Map<string, CachedToken>();
const tokenInflight = new Map<string, Promise<CachedToken>>();

export function clearPayPalTokenCache(): void {
  tokenCache.clear();
  tokenInflight.clear();
}

export function newPayPalRequestId(): string {
  return `tp-${crypto.randomUUID()}`;
}

const OPERATION_PATTERNS: Array<[RegExp, string]> = [
  [/^\/v1\/oauth2\/token$/, "oauth.token"],
  [/^\/v2\/checkout\/orders$/, "orders.create"],
  [/^\/v2\/checkout\/orders\/[^/]+\/(authorize|capture|confirm-payment-source)$/, "orders.$1"],
  [/^\/v2\/checkout\/orders\/[^/]+$/, "orders.$M"],
  [/^\/v2\/payments\/authorizations\/[^/]+\/(capture|void|reauthorize)$/, "authorizations.$1"],
  [/^\/v2\/payments\/authorizations\/[^/]+$/, "authorizations.$M"],
  [/^\/v2\/payments\/captures\/[^/]+\/refund$/, "captures.refund"],
  [/^\/v2\/payments\/captures\/[^/]+$/, "captures.$M"],
  [/^\/v1\/payments\/payouts$/, "payouts.create"],
  [/^\/v1\/payments\/payouts\/[^/]+$/, "payouts.$M"],
  [/^\/v1\/payments\/payouts-item\/[^/]+\/cancel$/, "payouts_item.cancel"],
  [/^\/v1\/payments\/payouts-item\/[^/]+$/, "payouts_item.$M"],
  [/^\/v2\/invoicing\/generate-next-invoice-number$/, "invoices.next_number"],
  [/^\/v2\/invoicing\/invoices$/, "invoices.$C"],
  [/^\/v2\/invoicing\/invoices\/[^/]+\/(send|cancel|remind|payments)$/, "invoices.$1"],
  [/^\/v2\/invoicing\/invoices\/[^/]+$/, "invoices.$M"],
  [/^\/v1\/notifications\/verify-webhook-signature$/, "webhooks.verify_signature"],
];

const METHOD_VERB: Record<string, string> = {
  GET: "get",
  POST: "post",
  PATCH: "update",
  PUT: "replace",
  DELETE: "delete",
};

/** Stable, secret-free operation label such as "paypal.orders.authorize". */
export function operationFor(method: string, path: string): string {
  const m = method.toUpperCase();
  const cleanPath = path.split("?")[0];
  for (const [pattern, template] of OPERATION_PATTERNS) {
    const match = cleanPath.match(pattern);
    if (match) {
      const label = template
        .replace("$1", match[1] ?? "")
        .replace("$M", METHOD_VERB[m] ?? m.toLowerCase())
        .replace("$C", m === "GET" ? "list" : "create");
      return `paypal.${label}`;
    }
  }
  return `paypal.${m.toLowerCase()} ${cleanPath}`;
}

function errorFields(body: unknown): { name?: string; message?: string; issues: string[]; descriptions: string[]; debugId?: string } {
  if (typeof body !== "object" || body === null) return { issues: [], descriptions: [] };
  const b = body as Record<string, unknown>;
  const details = Array.isArray(b.details) ? (b.details as Array<Record<string, unknown>>) : [];
  const str = (x: unknown) => (typeof x === "string" && x.length > 0 ? x : undefined);
  return {
    name: str(b.name) ?? str(b.error),
    message: str(b.message) ?? str(b.error_description),
    issues: details.map((d) => str(d.issue)).filter((x): x is string => x !== undefined),
    descriptions: details.map((d) => str(d.description)).filter((x): x is string => x !== undefined),
    debugId: str(b.debug_id),
  };
}

/** Builds the readable ConvexError raised for any failed PayPal call. */
export function payPalError(operation: string, status: number, body: unknown, debugIdHeader?: string): ConvexError<PayPalErrorData> {
  const f = errorFields(body);
  const name = f.name ?? (status >= 500 ? "PAYPAL_SERVER_ERROR" : "PAYPAL_REQUEST_FAILED");
  const detail =
    f.issues.length > 0
      ? `${f.issues.join(", ")}${f.descriptions.length > 0 ? ` - ${f.descriptions.join(" ")}` : ""}`
      : (f.message ?? "No error details returned.");
  const debugId = f.debugId ?? debugIdHeader;
  return new ConvexError<PayPalErrorData>({
    code: "PAYPAL_ERROR",
    operation,
    status,
    name,
    issues: f.issues,
    ...(debugId ? { debugId } : {}),
    message: `PayPal ${operation} failed (HTTP ${status} ${name}): ${detail}`,
  });
}

/** Runs a Server SDK call and converts its ApiError into the same readable ConvexError as request(). */
export async function withPayPalErrors<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof ApiError) {
      let body: unknown = e.result;
      if (body === undefined && typeof e.body === "string") body = parseJson(e.body);
      throw payPalError(operation, e.statusCode, body, headerValue(e.headers, "paypal-debug-id"));
    }
    throw e;
  }
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  for (const [k, val] of Object.entries(headers)) if (k.toLowerCase() === name) return val;
  return undefined;
}

function parseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function resourceIdFrom(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.id === "string") return b.id;
  const bh = b.batch_header as Record<string, unknown> | undefined;
  if (bh && typeof bh.payout_batch_id === "string") return bh.payout_batch_id;
  if (typeof b.href === "string") return b.href.split("/").pop();
  return undefined;
}

export class PayPalClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly audit?: PayPalAuditSink;
  private readonly baseDelayMs: number;
  private sdkCache?: { client: Client; orders: OrdersController; payments: PaymentsController };

  constructor(config: PayPalClientConfig) {
    const env = (config.environment ?? "sandbox").toLowerCase();
    if (env !== "sandbox") {
      throw new ConvexError({
        code: "PAYPAL_CONFIG",
        message: `PAYPAL_ENV must be "sandbox"; got "${config.environment}". Live PayPal is not supported.`,
      });
    }
    if (!config.clientId || !config.clientSecret) {
      throw new ConvexError({
        code: "PAYPAL_CONFIG",
        message: "PayPal is not configured: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the Convex deployment.",
      });
    }
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
    this.now = config.now ?? (() => Date.now());
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.audit = config.audit;
    this.baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  }

  /** Returns a cached OAuth token, fetching a new one when none is cached or it is within 5 minutes of expiry. */
  async getAccessToken(): Promise<string> {
    return (await this.token()).accessToken;
  }

  private async token(): Promise<CachedToken> {
    const cached = tokenCache.get(this.clientId);
    if (cached && this.now() < cached.refreshAtMs) return cached;
    const pending = tokenInflight.get(this.clientId);
    if (pending) return pending;
    const p = this.fetchToken().finally(() => tokenInflight.delete(this.clientId));
    tokenInflight.set(this.clientId, p);
    return p;
  }

  private invalidateToken(accessToken: string): void {
    if (tokenCache.get(this.clientId)?.accessToken === accessToken) tokenCache.delete(this.clientId);
  }

  private async fetchToken(): Promise<CachedToken> {
    const { response } = await this.sendWithBackoff("paypal.oauth.token", () =>
      this.fetchImpl(`${PAYPAL_SANDBOX_BASE_URL}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
      }),
    );
    const body = parseJson(await response.text());
    if (!response.ok) {
      throw payPalError("paypal.oauth.token", response.status, body, response.headers.get("paypal-debug-id") ?? undefined);
    }
    const b = body as { access_token?: unknown; expires_in?: unknown };
    if (typeof b.access_token !== "string" || typeof b.expires_in !== "number") {
      throw payPalError("paypal.oauth.token", response.status, { name: "INVALID_TOKEN_RESPONSE", message: "Token response is missing access_token or expires_in." });
    }
    const entry: CachedToken = {
      accessToken: b.access_token,
      refreshAtMs: this.now() + b.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS,
    };
    tokenCache.set(this.clientId, entry);
    return entry;
  }

  /**
   * Sends one logical request, retrying 429/5xx and network errors with exponential backoff
   * (at most MAX_ATTEMPTS sends). The same idempotency key is reused on every attempt.
   */
  private async sendWithBackoff(operation: string, send: () => Promise<Response>): Promise<{ response: Response; attempts: number }> {
    let lastNetworkError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response | undefined;
      try {
        response = await send();
        lastNetworkError = undefined;
      } catch (e) {
        lastNetworkError = e;
      }
      const retryable = response === undefined || isRetryable(response.status);
      if (!retryable || attempt === MAX_ATTEMPTS) {
        if (response) return { response, attempts: attempt };
        break;
      }
      let delay = this.baseDelayMs * 2 ** (attempt - 1);
      const retryAfter = Number(response?.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        delay = Math.max(delay, Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS));
      }
      // Drain the body so the connection can be reused.
      await response?.text().catch(() => undefined);
      await this.sleep(delay);
    }
    throw new ConvexError({
      code: "PAYPAL_NETWORK_ERROR",
      operation,
      message: `PayPal ${operation} failed: network error after ${MAX_ATTEMPTS} attempts (${lastNetworkError instanceof Error ? lastNetworkError.message : "unknown error"}).`,
    });
  }

  private async recordAudit(entry: PayPalAuditEntry): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit(entry);
    } catch (e) {
      // The PayPal write already happened; losing the audit row must not turn it into a reported failure.
      console.error(`PayPal audit write failed for ${entry.operation} (${entry.paypalRequestId ?? "no request id"}):`, e instanceof Error ? e.message : e);
    }
  }

  /** REST helper for endpoints the Server SDK does not cover (Payouts, Invoicing, webhook verification). */
  async request<T = unknown>(req: PayPalRequest): Promise<PayPalResponse<T>> {
    const isWrite = req.method !== "GET";
    const operation = req.operation ?? operationFor(req.method, req.path);
    const requestId = isWrite ? (req.requestId ?? newPayPalRequestId()) : req.requestId;
    const url = new URL(req.path, PAYPAL_SANDBOX_BASE_URL);
    for (const [k, val] of Object.entries(req.query ?? {})) if (val !== undefined) url.searchParams.set(k, String(val));
    const payload = req.body === undefined ? undefined : JSON.stringify(req.body);

    const sendOnce = async (accessToken: string) =>
      this.sendWithBackoff(operation, () =>
        this.fetchImpl(url.toString(), {
          method: req.method,
          headers: {
            ...req.headers,
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
          },
          body: payload,
        }),
      );

    let token = await this.getAccessToken();
    let { response, attempts } = await sendOnce(token);
    if (response.status === 401) {
      await response.text().catch(() => undefined);
      this.invalidateToken(token);
      token = await this.getAccessToken();
      const retry = await sendOnce(token);
      response = retry.response;
      attempts += retry.attempts;
    }

    const body = parseJson(await response.text());
    const debugId = response.headers.get("paypal-debug-id") ?? undefined;
    const error = response.ok ? undefined : payPalError(operation, response.status, body, debugId);
    if (isWrite) {
      await this.recordAudit({
        operation,
        method: req.method,
        path: url.pathname,
        status: response.status,
        ok: response.ok,
        attempts,
        paypalRequestId: requestId,
        paypalDebugId: debugId,
        resourceId: response.ok ? resourceIdFrom(body) : undefined,
        errorName: error?.data.name,
        via: "rest",
      });
    }
    if (error) throw error;
    return { status: response.status, data: body as T, requestId, debugId };
  }

  /** Fetch used by the Server SDK: adds PayPal-Request-Id to writes that lack one, applies backoff and audits writes. */
  private sdkFetch: FetchLike = async (input, init) => {
    const original = new Request(input, init);
    const method = original.method.toUpperCase();
    const isWrite = method !== "GET" && method !== "HEAD";
    const headers = new Headers(original.headers);
    if (isWrite && !headers.get("paypal-request-id")) headers.set("PayPal-Request-Id", newPayPalRequestId());
    const requestId = headers.get("paypal-request-id") ?? undefined;
    const bodyText = isWrite ? await original.text() : undefined;
    const path = new URL(original.url).pathname;
    const operation = operationFor(method, path);

    const { response, attempts } = await this.sendWithBackoff(operation, () =>
      this.fetchImpl(original.url, { method, headers, body: bodyText === "" ? undefined : bodyText }),
    );
    if (isWrite) {
      const parsed = parseJson(await response.clone().text());
      await this.recordAudit({
        operation,
        method,
        path,
        status: response.status,
        ok: response.ok,
        attempts,
        paypalRequestId: requestId,
        paypalDebugId: response.headers.get("paypal-debug-id") ?? undefined,
        resourceId: response.ok ? resourceIdFrom(parsed) : undefined,
        errorName: response.ok ? undefined : payPalError(operation, response.status, parsed).data.name,
        via: "sdk",
      });
    }
    return response;
  };

  /**
   * Shared @paypal/paypal-server-sdk client for Orders/Payments. It uses this module's token cache and
   * fetch wrapper, so SDK calls get the same idempotency header, backoff and audit as request().
   * Pass `paypalRequestId` on SDK writes to make retries across action runs idempotent.
   */
  sdk(): { client: Client; orders: OrdersController; payments: PaymentsController } {
    if (!this.sdkCache) {
      const client = new Client({
        environment: Environment.Sandbox,
        timeout: SDK_TIMEOUT_MS,
        clientCredentialsAuthCredentials: {
          oAuthClientId: this.clientId,
          oAuthClientSecret: this.clientSecret,
          oAuthTokenProvider: async () => {
            const t = await this.token();
            return { accessToken: t.accessToken, tokenType: "Bearer", expiry: BigInt(Math.floor(t.refreshAtMs / 1000)) };
          },
        },
        // axios' fetch adapter routes SDK traffic through sdkFetch (and works in the default Convex runtime).
        unstable_httpClientOptions: { adapter: "fetch", env: { fetch: this.sdkFetch } },
      });
      this.sdkCache = { client, orders: new OrdersController(client), payments: new PaymentsController(client) };
    }
    return this.sdkCache;
  }
}

export function createPayPalClient(config: PayPalClientConfig): PayPalClient {
  return new PayPalClient(config);
}

export type PayPalEnv = {
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_ENV?: string;
};

export type PayPalAuditContext = {
  actor: string;
  projectId?: Id<"projects">;
  agreementId?: Id<"agreements">;
};

/** Audit sink for actions: writes each PayPal write to auditLogs through an internal mutation. */
export function actionAuditSink(ctx: Pick<ActionCtx, "runMutation">, context: PayPalAuditContext): PayPalAuditSink {
  return async (entry) => {
    await ctx.runMutation(internal.payments.paypalAudit.record, { entry, ...context });
  };
}

/** Creates a client from Convex env for use inside an action, auditing writes under `context`. */
export function payPalClientForAction(
  ctx: Pick<ActionCtx, "runMutation">,
  env: PayPalEnv,
  context: PayPalAuditContext,
): PayPalClient {
  return createPayPalClient({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    environment: env.PAYPAL_ENV,
    audit: actionAuditSink(ctx, context),
  });
}

export type { ApiResponse };
