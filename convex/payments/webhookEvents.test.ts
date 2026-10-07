import { describe, expect, test } from "vitest";
import { isHandledEventType, parseWebhookEvent, signatureHeadersFrom } from "./webhookEvents";

describe("parseWebhookEvent", () => {
  test("rejects bodies without an id and event_type", () => {
    expect(parseWebhookEvent(undefined)).toBeNull();
    expect(parseWebhookEvent({ id: "WH-1" })).toBeNull();
    expect(parseWebhookEvent({ event_type: "PAYMENT.CAPTURE.COMPLETED" })).toBeNull();
    expect(parseWebhookEvent([1, 2])).toBeNull();
  });

  test("capture completed: capture id, authorization and order from related_ids", () => {
    const e = parseWebhookEvent({
      id: "WH-CAP",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP-1",
        status: "COMPLETED",
        supplementary_data: { related_ids: { order_id: "ORD-1", authorization_id: "AUTH-1" } },
      },
    });
    expect(e).toMatchObject({ eventId: "WH-CAP", resourceId: "CAP-1", captureId: "CAP-1", authorizationId: "AUTH-1", orderId: "ORD-1", resourceStatus: "COMPLETED" });
  });

  test("capture refunded: the refunded capture comes from the refund's up link", () => {
    const e = parseWebhookEvent({
      id: "WH-REF",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "REF-1",
        status: "COMPLETED",
        links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/CAP-9" }],
      },
    });
    expect(e).toMatchObject({ resourceId: "CAP-9", captureId: "CAP-9", resourceStatus: "REFUNDED" });
  });

  test("payout item: item id, batch id, sender item id, status and error name", () => {
    const e = parseWebhookEvent({
      id: "WH-PI",
      event_type: "PAYMENT.PAYOUTS-ITEM.FAILED",
      resource: {
        payout_item_id: "ITEM-1",
        payout_batch_id: "BATCH-1",
        transaction_status: "FAILED",
        payout_item: { sender_item_id: "pay123" },
        errors: { name: "RECEIVER_ACCOUNT_LOCKED" },
      },
    });
    expect(e).toMatchObject({
      resourceId: "ITEM-1",
      payoutItemId: "ITEM-1",
      payoutBatchId: "BATCH-1",
      senderItemId: "pay123",
      resourceStatus: "FAILED",
      payoutErrorName: "RECEIVER_ACCOUNT_LOCKED",
    });
  });

  test("payout batch, invoice, order and authorization ids", () => {
    expect(
      parseWebhookEvent({ id: "a", event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS", resource: { batch_header: { payout_batch_id: "B", batch_status: "SUCCESS" } } }),
    ).toMatchObject({ resourceId: "B", payoutBatchId: "B", resourceStatus: "SUCCESS" });
    expect(
      parseWebhookEvent({ id: "b", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-X", status: "PAID" } } }),
    ).toMatchObject({ resourceId: "INV2-X", invoiceId: "INV2-X", resourceStatus: "PAID" });
    expect(parseWebhookEvent({ id: "c", event_type: "INVOICING.INVOICE.CANCELLED", resource: { id: "INV2-Y", status: "CANCELLED" } })).toMatchObject({
      invoiceId: "INV2-Y",
    });
    expect(parseWebhookEvent({ id: "d", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORD-2", status: "APPROVED" } })).toMatchObject({
      resourceId: "ORD-2",
      orderId: "ORD-2",
    });
    expect(
      parseWebhookEvent({
        id: "e",
        event_type: "PAYMENT.AUTHORIZATION.VOIDED",
        resource: { id: "AUTH-2", status: "VOIDED", supplementary_data: { related_ids: { order_id: "ORD-3" } } },
      }),
    ).toMatchObject({ resourceId: "AUTH-2", authorizationId: "AUTH-2", orderId: "ORD-3", resourceStatus: "VOIDED" });
  });

  test("handled types match architecture §6", () => {
    expect(isHandledEventType("PAYMENT.PAYOUTS-ITEM.SUCCEEDED")).toBe(true);
    expect(isHandledEventType("INVOICING.INVOICE.PAID")).toBe(true);
    expect(isHandledEventType("CUSTOMER.DISPUTE.CREATED")).toBe(false);
  });
});

describe("signatureHeadersFrom", () => {
  const full = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tid",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-10-07T00:00:00Z",
  };
  test("maps the five paypal-* headers", () => {
    expect(signatureHeadersFrom(new Headers(full))).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: full["paypal-cert-url"],
      transmission_id: "tid",
      transmission_sig: "sig",
      transmission_time: "2026-10-07T00:00:00Z",
    });
  });
  test("null when any header is missing or blank", () => {
    expect(signatureHeadersFrom(new Headers())).toBeNull();
    expect(signatureHeadersFrom(new Headers({ ...full, "paypal-transmission-sig": " " }))).toBeNull();
  });
});
