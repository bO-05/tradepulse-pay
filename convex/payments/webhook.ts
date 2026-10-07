import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import { env, httpAction, type ActionCtx } from "../_generated/server";
import { createPayPalClient, type PayPalClientConfig, type PayPalErrorData } from "./paypalClient";
import { parseWebhookEvent, signatureHeadersFrom } from "./webhookEvents";

/**
 * POST /paypal/webhook (architecture §6). Every delivery is verified with PayPal's
 * /v1/notifications/verify-webhook-signature before anything is processed; unverified deliveries are
 * recorded with verified=false and answered 400. Simulator events fail verification by design.
 */

const MAX_BODY_BYTES = 256 * 1024;

export type VerifyResult = { verified: true } | { verified: false; reason: string; transient: boolean };

export type WebhookDeps = {
  webhookId?: string;
  verify: (headers: Headers, event: unknown, webhookId: string) => Promise<VerifyResult>;
};

/** Asks PayPal whether the paypal-* headers sign this event for our webhook id. */
export async function verifyWithPayPal(
  headers: Headers,
  event: unknown,
  webhookId: string,
  config: Pick<PayPalClientConfig, "clientId" | "clientSecret" | "environment" | "fetch">,
): Promise<VerifyResult> {
  const sig = signatureHeadersFrom(headers);
  if (sig === null) return { verified: false, reason: "Missing PayPal signature headers.", transient: false };
  try {
    // No audit sink: verification changes nothing at PayPal and runs for every (possibly forged) delivery.
    const paypal = createPayPalClient(config);
    const { data } = await paypal.request<{ verification_status?: string }>({
      method: "POST",
      path: "/v1/notifications/verify-webhook-signature",
      operation: "paypal.webhooks.verify",
      body: { ...sig, webhook_id: webhookId, webhook_event: event },
    });
    if (data?.verification_status === "SUCCESS") return { verified: true };
    return { verified: false, reason: `PayPal verification_status ${data?.verification_status ?? "missing"}.`, transient: false };
  } catch (e) {
    const d = e instanceof ConvexError ? (e.data as Partial<PayPalErrorData> & { code?: string }) : undefined;
    const status = typeof d?.status === "number" ? d.status : 0;
    const transient = status === 0 || status === 429 || status >= 500;
    const reason = d?.message ?? (e instanceof Error ? e.message : "verification request failed");
    return { verified: false, reason: `Signature verification failed: ${reason}`, transient };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function errorMessage(e: unknown): string {
  if (e instanceof ConvexError) {
    const d = e.data as { message?: string } | string;
    return typeof d === "string" ? d : (d?.message ?? "dispatch failed");
  }
  return e instanceof Error ? e.message : "dispatch failed";
}

export async function handlePayPalWebhook(
  ctx: Pick<ActionCtx, "runMutation">,
  req: Request,
  deps: WebhookDeps,
): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return json(413, { error: "Payload too large." });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const parsed = parseWebhookEvent(body);
  const transmissionId = req.headers.get("paypal-transmission-id")?.trim();
  const rejectedId = parsed?.eventId ?? `invalid:${transmissionId || crypto.randomUUID()}`;
  const reject = async (status: number, reason: string) => {
    await ctx.runMutation(internal.payments.webhookDb.recordUnverifiedEvent, {
      eventId: rejectedId.slice(0, 200),
      eventType: (parsed?.eventType ?? "unknown").slice(0, 200),
      resourceId: parsed?.resourceId?.slice(0, 200),
      error: reason.slice(0, 500),
    });
    return json(status, { error: reason });
  };

  if (parsed === null) return await reject(400, "Body is not a PayPal webhook event.");
  if (!deps.webhookId) {
    return await reject(503, "Webhook verification is not configured (PAYPAL_WEBHOOK_ID is unset).");
  }
  const check = await deps.verify(req.headers, body, deps.webhookId);
  if (!check.verified) {
    // 503 makes PayPal retry a genuine event when verification itself was unavailable.
    return await reject(check.transient ? 503 : 400, check.reason);
  }

  try {
    const out = await ctx.runMutation(internal.payments.webhookDb.processVerifiedEvent, { event: body });
    return json(200, { ok: true, eventId: out.eventId, duplicate: out.duplicate, changed: out.changed });
  } catch (e) {
    const reason = errorMessage(e);
    console.error(`PayPal webhook ${parsed.eventType} ${parsed.eventId} failed: ${reason}`);
    await ctx.runMutation(internal.payments.webhookDb.recordProcessingFailure, {
      eventId: parsed.eventId,
      eventType: parsed.eventType,
      resourceId: parsed.resourceId,
      error: reason.slice(0, 500),
    });
    return json(500, { error: "Event could not be processed; PayPal will retry." });
  }
}

export const paypalWebhook = httpAction(async (ctx, req) => {
  return await handlePayPalWebhook(ctx, req, {
    webhookId: env.PAYPAL_WEBHOOK_ID,
    verify: (headers, event, webhookId) =>
      verifyWithPayPal(headers, event, webhookId, {
        clientId: env.PAYPAL_CLIENT_ID,
        clientSecret: env.PAYPAL_CLIENT_SECRET,
        environment: env.PAYPAL_ENV,
      }),
  });
});
