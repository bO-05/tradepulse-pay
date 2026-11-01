import { verifyAgentMailWebhook, WebhookVerificationError } from "@agentmail/convex";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const DELIVERY_EVENTS: Record<string, string> = {
  "message.delivered": "delivered",
  "message.bounced": "bounced",
  "message.complained": "complained",
  "message.rejected": "rejected",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value) return value;
  return "";
}

/** POST /agentmail/webhook: Svix signature verified before any read or write. */
export const agentmailWebhook = httpAction(async (ctx, req) => {
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
  if (!secret) return json(503, { error: "Webhook verification is not configured." });

  const raw = await req.text();
  let event: any;
  try {
    event = verifyAgentMailWebhook(secret, raw, {
      "svix-id": req.headers.get("svix-id") ?? "",
      "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
      "svix-signature": req.headers.get("svix-signature") ?? "",
    });
  } catch (err) {
    if (err instanceof WebhookVerificationError) return json(401, { error: "Invalid or missing webhook signature." });
    throw err;
  }

  const eventType = String(event?.event_type ?? "");
  const eventId = firstString(event?.event_id, req.headers.get("svix-id"));

  if (eventType === "message.received" && event?.message) {
    const m = event.message;
    const result = await ctx.runMutation(internal.inboundEmail.ingestReceived, {
      eventId,
      message: {
        inboxId: firstString(m.inbox_id),
        threadId: firstString(m.thread_id, event.thread?.thread_id),
        messageId: firstString(m.message_id),
        from: firstString(m.from),
        subject: firstString(m.subject),
        text: firstString(m.extracted_text, m.text, m.preview),
        inReplyTo: firstString(m.in_reply_to) || undefined,
        attachments: Array.isArray(m.attachments) ? m.attachments : undefined,
      },
    });
    return json(200, { ok: true, outcome: result.outcome });
  }

  const delivery = DELIVERY_EVENTS[eventType];
  if (delivery) {
    const messageId = firstString(
      event?.message?.message_id,
      event?.send?.message_id,
      event?.delivery?.message_id,
      event?.bounce?.message_id,
      event?.complaint?.message_id,
      event?.reject?.message_id
    );
    if (messageId) {
      await ctx.runMutation(internal.emailOutbox.recordDeliveryEvent, { agentmailMessageId: messageId, event: delivery });
    }
    return json(200, { ok: true });
  }

  return json(200, { ok: true, ignored: eventType || "unknown" });
});
