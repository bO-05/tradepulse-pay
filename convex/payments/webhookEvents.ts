/**
 * Pure parsing of PayPal webhook payloads into the ids the dispatcher needs (architecture §6).
 * Field locations follow the PayPal event resources: Payments v2 authorizations/captures/refunds,
 * Payouts items and batches, Invoicing v2 invoices and Checkout orders.
 */

export const HANDLED_EVENT_TYPES = [
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.CANCELLED",
  "CHECKOUT.ORDER.APPROVED",
] as const;
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export function isHandledEventType(t: string): t is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(t);
}

export type ParsedWebhookEvent = {
  eventId: string;
  eventType: string;
  /** The primary PayPal id of the event resource (capture, payout item, batch, invoice, order or authorization). */
  resourceId?: string;
  resourceStatus?: string;
  orderId?: string;
  authorizationId?: string;
  captureId?: string;
  payoutItemId?: string;
  payoutBatchId?: string;
  senderItemId?: string;
  payoutErrorName?: string;
  invoiceId?: string;
};

type Obj = Record<string, unknown>;

function obj(x: unknown): Obj | undefined {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Obj) : undefined;
}

function str(x: unknown): string | undefined {
  return typeof x === "string" && x.length > 0 ? x : undefined;
}

/** The id at the end of a HATEOAS link such as `.../v2/payments/captures/{id}` with the given rel. */
function linkedId(resource: Obj, rel: string, pathPart: string): string | undefined {
  const links = Array.isArray(resource.links) ? resource.links : [];
  for (const l of links) {
    const link = obj(l);
    if (!link || link.rel !== rel) continue;
    const href = str(link.href);
    const m = href?.match(new RegExp(`/${pathPart}/([^/?#]+)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return undefined;
}

/** Returns null when the body is not a PayPal event (no string `id` and `event_type`). */
export function parseWebhookEvent(body: unknown): ParsedWebhookEvent | null {
  const event = obj(body);
  const eventId = str(event?.id);
  const eventType = str(event?.event_type);
  if (!event || !eventId || !eventType) return null;
  const resource = obj(event.resource) ?? {};
  const related = obj(obj(resource.supplementary_data)?.related_ids) ?? {};
  const out: ParsedWebhookEvent = { eventId, eventType };

  if (eventType.startsWith("PAYMENT.AUTHORIZATION.")) {
    out.authorizationId = str(resource.id);
    out.orderId = str(related.order_id);
    out.resourceId = out.authorizationId;
    out.resourceStatus = str(resource.status);
  } else if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
    // The resource is the refund; its "up" link points at the refunded capture.
    out.captureId = linkedId(resource, "up", "captures");
    out.authorizationId = str(related.authorization_id);
    out.orderId = str(related.order_id);
    out.resourceId = out.captureId ?? str(resource.id);
    out.resourceStatus = "REFUNDED";
  } else if (eventType.startsWith("PAYMENT.CAPTURE.")) {
    out.captureId = str(resource.id);
    out.authorizationId = str(related.authorization_id) ?? linkedId(resource, "up", "authorizations");
    out.orderId = str(related.order_id);
    out.resourceId = out.captureId;
    out.resourceStatus = str(resource.status);
  } else if (eventType.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    out.payoutItemId = str(resource.payout_item_id);
    out.payoutBatchId = str(resource.payout_batch_id);
    out.senderItemId = str(obj(resource.payout_item)?.sender_item_id);
    out.payoutErrorName = str(obj(resource.errors)?.name);
    out.resourceId = out.payoutItemId;
    out.resourceStatus = str(resource.transaction_status);
  } else if (eventType.startsWith("PAYMENT.PAYOUTSBATCH.")) {
    const header = obj(resource.batch_header) ?? {};
    out.payoutBatchId = str(header.payout_batch_id);
    out.resourceId = out.payoutBatchId;
    out.resourceStatus = str(header.batch_status);
  } else if (eventType.startsWith("INVOICING.INVOICE.")) {
    const invoice = obj(resource.invoice) ?? resource;
    out.invoiceId = str(invoice.id);
    out.resourceId = out.invoiceId;
    out.resourceStatus = str(invoice.status);
  } else if (eventType.startsWith("CHECKOUT.ORDER.")) {
    out.orderId = str(resource.id);
    out.resourceId = out.orderId;
    out.resourceStatus = str(resource.status);
  } else {
    out.resourceId = str(resource.id);
  }
  return out;
}

const SIGNATURE_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

export type SignatureHeaders = {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
};

/** The five paypal-* signature headers, or null when any is missing. */
export function signatureHeadersFrom(headers: Headers): SignatureHeaders | null {
  const values = SIGNATURE_HEADERS.map((h) => headers.get(h)?.trim() ?? "");
  if (values.some((x) => x === "")) return null;
  const [auth_algo, cert_url, transmission_id, transmission_sig, transmission_time] = values;
  return { auth_algo, cert_url, transmission_id, transmission_sig, transmission_time };
}
