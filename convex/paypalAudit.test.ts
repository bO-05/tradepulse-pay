/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("paypalAudit.record", () => {
  test("stores a paypal_write auditLogs row with request id and no secrets", async () => {
    const t = convexTest(schema, modules);
    const id = await t.mutation(internal.payments.paypalAudit.record, {
      actor: "gc@demo.tradepulse",
      entry: {
        operation: "paypal.orders.create",
        method: "POST",
        path: "/v2/checkout/orders",
        status: 201,
        ok: true,
        attempts: 1,
        paypalRequestId: "pay_abc",
        resourceId: "ORDER-9",
        via: "rest",
      },
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({
      eventType: "paypal_write",
      operation: "paypal.orders.create",
      httpStatus: 201,
      paypalRequestId: "pay_abc",
      paypalResourceId: "ORDER-9",
      title: "PayPal paypal.orders.create succeeded",
    });
    expect(row?.description).toContain("PayPal-Request-Id pay_abc");
  });
});
