import { CheckoutPaymentIntent, type ApiResponse, type Order } from "@paypal/paypal-server-sdk";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import { action, env } from "../_generated/server";
import { toPayPalString } from "../lib/money";
import { requireRoleInAction } from "../lib/roles";
import {
  authorizationWindow,
  fundingFailureMessage,
  type BeginAuthorization,
  type PreparedFunding,
} from "./funding";
import { payPalClientForAction, type PayPalErrorData } from "./paypalClient";

/**
 * Milestone funding with Orders v2 intent AUTHORIZE (architecture §4 step 1). GC only.
 * createFundingOrder backs the JS SDK createOrder callback; authorizeFundingOrder backs onApprove.
 */

function paypalErrorData(e: unknown): PayPalErrorData | null {
  if (e instanceof ConvexError && (e.data as { code?: unknown } | undefined)?.code === "PAYPAL_ERROR") {
    return e.data as PayPalErrorData;
  }
  return null;
}

const createdOrderValidator = v.object({ paymentId: v.id("payments"), orderId: v.string(), reused: v.boolean() });
const authorizedValidator = v.object({
  paymentId: v.id("payments"),
  paypalAuthorizationId: v.string(),
  authorizationExpiresAt: v.number(),
  honorPeriodEndsAt: v.number(),
  alreadyAuthorized: v.boolean(),
});

export const createFundingOrder = action({
  args: { milestoneId: v.id("milestones") },
  returns: createdOrderValidator,
  handler: async (ctx, { milestoneId }): Promise<Infer<typeof createdOrderValidator>> => {
    const viewer = await requireRoleInAction(ctx, ["gc"]);
    const prepared: PreparedFunding = await ctx.runMutation(internal.payments.funding.prepareFundingOrder, {
      milestoneId,
      userId: viewer.userId,
    });
    if (prepared.paypalOrderId !== undefined) {
      return { paymentId: prepared.paymentId, orderId: prepared.paypalOrderId, reused: true };
    }

    const paypal = payPalClientForAction(ctx, env, {
      actor: prepared.actor,
      projectId: prepared.projectId,
      agreementId: prepared.agreementId,
    });
    let orderId: string | undefined;
    let auditRecorded: boolean;
    try {
      const out = await paypal.sdkWrite("paypal.orders.create", prepared.idempotencyKey, (sdk, paypalRequestId) =>
        sdk.orders.createOrder({
          paypalRequestId,
          prefer: "return=minimal",
          body: {
            intent: CheckoutPaymentIntent.Authorize,
            purchaseUnits: [
              {
                referenceId: milestoneId,
                customId: prepared.paymentId,
                description: `${prepared.agreementNumber} · ${prepared.milestoneName}`.slice(0, 127),
                amount: { currencyCode: "USD", value: toPayPalString(prepared.amountCents) },
              },
            ],
          },
        }),
      );
      orderId = out.response.result.id;
      auditRecorded = out.auditRecorded;
    } catch (e) {
      const data = paypalErrorData(e);
      // Only a definitive PayPal rejection closes the attempt; after a network error the same key is retried.
      if (data !== null && data.status < 500) {
        await ctx.runMutation(internal.payments.funding.recordFundingFailure, {
          paymentId: prepared.paymentId,
          error: data.message,
          auditRecorded: data.auditRecorded,
        });
      }
      throw e;
    }
    if (!orderId) {
      await ctx.runMutation(internal.payments.funding.recordFundingFailure, {
        paymentId: prepared.paymentId,
        error: "PayPal did not return an order id.",
        auditRecorded,
      });
      throw new ConvexError({ code: "PAYPAL_ERROR", message: "PayPal did not return an order id. The milestone was not funded." });
    }
    await ctx.runMutation(internal.payments.funding.recordFundingOrderCreated, {
      paymentId: prepared.paymentId,
      paypalOrderId: orderId,
      auditRecorded,
    });
    return { paymentId: prepared.paymentId, orderId, reused: false };
  },
});

export const authorizeFundingOrder = action({
  args: { orderId: v.string() },
  returns: authorizedValidator,
  handler: async (ctx, { orderId }): Promise<Infer<typeof authorizedValidator>> => {
    const viewer = await requireRoleInAction(ctx, ["gc"]);
    const begun: BeginAuthorization = await ctx.runMutation(internal.payments.funding.beginAuthorization, { paypalOrderId: orderId });
    if (begun.state === "done") {
      return {
        paymentId: begun.paymentId,
        paypalAuthorizationId: begun.paypalAuthorizationId,
        authorizationExpiresAt: begun.authorizationExpiresAt,
        honorPeriodEndsAt: begun.honorPeriodEndsAt,
        alreadyAuthorized: true,
      };
    }

    const paypal = payPalClientForAction(ctx, env, {
      actor: `user:${viewer.userId}`,
      projectId: begun.projectId,
      agreementId: begun.agreementId,
    });
    let out: { response: ApiResponse<Order>; auditRecorded: boolean };
    try {
      out = await paypal.sdkWrite("paypal.orders.authorize", `${begun.idempotencyKey}_auth`, (sdk, paypalRequestId) =>
        sdk.orders.authorizeOrder({ id: orderId, paypalRequestId, prefer: "return=representation" }),
      );
    } catch (e) {
      const data = paypalErrorData(e);
      if (data !== null && data.status < 500) {
        const message = fundingFailureMessage(data);
        await ctx.runMutation(internal.payments.funding.recordFundingFailure, {
          paymentId: begun.paymentId,
          error: message,
          auditRecorded: data.auditRecorded,
        });
        throw new ConvexError({ code: "FUNDING_DECLINED", message, issues: data.issues, paypalName: data.name });
      }
      throw e;
    }

    const authorization = out.response.result.purchaseUnits?.[0]?.payments?.authorizations?.[0];
    if (!authorization?.id || authorization.status === "DENIED") {
      const message = `Funding failed: PayPal returned authorization status ${authorization?.status ?? "missing"}. The milestone was not funded.`;
      await ctx.runMutation(internal.payments.funding.recordFundingFailure, {
        paymentId: begun.paymentId,
        error: message,
        auditRecorded: out.auditRecorded,
      });
      throw new ConvexError({ code: "FUNDING_DECLINED", message });
    }
    const window = authorizationWindow({
      createTime: authorization.createTime,
      expirationTime: authorization.expirationTime,
      now: Date.now(),
    });
    await ctx.runMutation(internal.payments.funding.recordAuthorization, {
      paymentId: begun.paymentId,
      paypalAuthorizationId: authorization.id,
      authorizationExpiresAt: window.authorizationExpiresAt,
      honorPeriodEndsAt: window.honorPeriodEndsAt,
      auditRecorded: out.auditRecorded,
    });
    return {
      paymentId: begun.paymentId,
      paypalAuthorizationId: authorization.id,
      authorizationExpiresAt: window.authorizationExpiresAt,
      honorPeriodEndsAt: window.honorPeriodEndsAt,
      alreadyAuthorized: false,
    };
  },
});
