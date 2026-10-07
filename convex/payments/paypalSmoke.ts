import { CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import { v } from "convex/values";
import { env, internalAction } from "../_generated/server";
import { toPayPalString } from "../lib/money";
import { payPalClientForAction, withPayPalErrors } from "./paypalClient";

/**
 * Live sandbox smoke check (internal only; run with `npx convex run payments/paypalSmoke:smoke`).
 * Obtains a token, optionally creates a $1.00 AUTHORIZE order through the Server SDK (audited write),
 * then GETs the order through both the REST helper and the SDK. Never returns the token.
 */
export const smoke = internalAction({
  args: {
    orderId: v.optional(v.string()),
    createOrder: v.optional(v.boolean()),
  },
  returns: v.object({
    tokenObtained: v.boolean(),
    createdOrderId: v.optional(v.string()),
    createRequestId: v.optional(v.string()),
    orderId: v.optional(v.string()),
    restStatus: v.optional(v.number()),
    sdkStatus: v.optional(v.number()),
    orderStatus: v.optional(v.string()),
    intent: v.optional(v.string()),
    amount: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const paypal = payPalClientForAction(ctx, env, { actor: "system:paypal-smoke" });
    const token = await paypal.getAccessToken();
    const result: {
      tokenObtained: boolean;
      createdOrderId?: string;
      createRequestId?: string;
      orderId?: string;
      restStatus?: number;
      sdkStatus?: number;
      orderStatus?: string;
      intent?: string;
      amount?: string;
    } = { tokenObtained: token.length > 0 };

    let orderId = args.orderId;
    if (!orderId && args.createOrder) {
      const requestId = `smoke-${crypto.randomUUID()}`;
      const created = await withPayPalErrors("paypal.orders.create", () =>
        paypal.sdk().orders.createOrder({
          paypalRequestId: requestId,
          prefer: "return=minimal",
          body: {
            intent: CheckoutPaymentIntent.Authorize,
            purchaseUnits: [
              { referenceId: "tradepulse-smoke", amount: { currencyCode: "USD", value: toPayPalString(100) } },
            ],
          },
        }),
      );
      orderId = created.result.id;
      result.createdOrderId = orderId;
      result.createRequestId = requestId;
    }
    if (!orderId) return result;
    result.orderId = orderId;

    const rest = await paypal.request<{ status?: string; intent?: string; purchase_units?: Array<{ amount?: { value?: string } }> }>({
      method: "GET",
      path: `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    });
    result.restStatus = rest.status;
    result.orderStatus = rest.data.status;
    result.intent = rest.data.intent;
    result.amount = rest.data.purchase_units?.[0]?.amount?.value;

    const sdk = await withPayPalErrors("paypal.orders.get", () => paypal.sdk().orders.getOrder({ id: orderId }));
    result.sdkStatus = sdk.statusCode;
    return result;
  },
});
