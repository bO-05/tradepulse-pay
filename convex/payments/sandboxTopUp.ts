import { CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { action, env } from "../_generated/server";
import { formatCents, toPayPalString } from "../lib/money";
import { requireRoleInAction } from "../lib/roles";
import { payPalClientForAction } from "./paypalClient";
import { MAX_TOP_UP_CENTS, MIN_TOP_UP_CENTS } from "./sandboxTopUpDb";

/**
 * Sandbox-only setup step, GC only: tops up the platform's sandbox business balance with a CAPTURE order
 * paid by the guest test card. PayPal keeps ~3.5% + $0.49 of every capture, so after paying subs 90% the
 * platform holds less than the retainage it owes, and a retainage release would fail with
 * INSUFFICIENT_FUNDS. The top-up is not linked to any agreement and never counts in ledger totals.
 */

function assertSandbox() {
  if ((env.PAYPAL_ENV ?? "sandbox") !== "sandbox") {
    throw new ConvexError({ code: "SANDBOX_ONLY", message: "Platform top-ups exist only for the PayPal sandbox." });
  }
}

export const createTopUpOrder = action({
  args: { amountCents: v.number() },
  returns: v.object({ paypalOrderId: v.string(), approveUrl: v.string() }),
  handler: async (ctx, { amountCents }): Promise<{ paypalOrderId: string; approveUrl: string }> => {
    assertSandbox();
    const viewer = await requireRoleInAction(ctx, ["gc"]);
    if (!Number.isSafeInteger(amountCents) || amountCents < MIN_TOP_UP_CENTS || amountCents > MAX_TOP_UP_CENTS) {
      throw new ConvexError({
        code: "INVALID_AMOUNT",
        message: `Enter a top-up between ${formatCents(MIN_TOP_UP_CENTS)} and ${formatCents(MAX_TOP_UP_CENTS)}.`,
      });
    }
    const actor: string = await ctx.runQuery(internal.payments.release.actorForUser, { userId: viewer.userId });
    const paypal = payPalClientForAction(ctx, env, { actor });
    const siteUrl = (env.SITE_URL ?? "http://localhost:3150").replace(/\/$/, "");
    const requestId = `topup_${viewer.userId}_${Date.now()}`;
    const out = await paypal.sdkWrite("paypal.orders.create", requestId, (sdk, paypalRequestId) =>
      sdk.orders.createOrder({
        paypalRequestId,
        prefer: "return=minimal",
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              referenceId: "sandbox_platform_top_up",
              description: "Sandbox only: platform balance top-up for retainage releases",
              amount: { currencyCode: "USD", value: toPayPalString(amountCents) },
            },
          ],
          applicationContext: { returnUrl: `${siteUrl}/`, cancelUrl: `${siteUrl}/` },
        },
      }),
    );
    const order = out.response.result;
    const approveUrl = order.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href;
    if (!order.id || !approveUrl) {
      throw new ConvexError({ code: "PAYPAL_ERROR", message: "PayPal did not return an order id and approve link for the top-up." });
    }
    await ctx.runMutation(internal.payments.sandboxTopUpDb.recordTopUpCreated, {
      paypalOrderId: order.id,
      amountCents,
      approveUrl,
      userId: viewer.userId,
    });
    return { paypalOrderId: order.id, approveUrl };
  },
});

export const captureTopUpOrder = action({
  args: { paypalOrderId: v.string() },
  returns: v.object({ status: v.string(), paypalCaptureId: v.union(v.string(), v.null()), message: v.string() }),
  handler: async (ctx, { paypalOrderId }): Promise<{ status: string; paypalCaptureId: string | null; message: string }> => {
    assertSandbox();
    const viewer = await requireRoleInAction(ctx, ["gc"]);
    const row: Doc<"sandboxTopUps"> | null = await ctx.runQuery(internal.payments.sandboxTopUpDb.topUpByOrder, { paypalOrderId });
    if (row === null) throw new ConvexError({ code: "NOT_FOUND", message: "Top-up order not found." });
    if (row.status === "captured") {
      return { status: "captured", paypalCaptureId: row.paypalCaptureId ?? null, message: "This top-up was already captured." };
    }
    const actor: string = await ctx.runQuery(internal.payments.release.actorForUser, { userId: viewer.userId });
    const paypal = payPalClientForAction(ctx, env, { actor });
    let capture: { id?: string; status?: string } | undefined;
    try {
      const out = await paypal.sdkWrite("paypal.orders.capture", `topup_cap_${paypalOrderId}`, (sdk, paypalRequestId) =>
        sdk.orders.captureOrder({ id: paypalOrderId, paypalRequestId, prefer: "return=representation" }),
      );
      capture = out.response.result.purchaseUnits?.[0]?.payments?.captures?.[0];
    } catch (e) {
      const data = e instanceof ConvexError ? (e.data as { code?: string; message?: string; issues?: string[] }) : null;
      // ORDER_NOT_APPROVED means the buyer has not finished checkout yet; the order stays open.
      if (data?.issues?.includes("ORDER_NOT_APPROVED")) {
        throw new ConvexError({
          code: "ORDER_NOT_APPROVED",
          message: "PayPal says the top-up checkout is not approved yet. Finish paying in the PayPal tab, then capture again.",
        });
      }
      if (data?.code === "PAYPAL_ERROR") {
        await ctx.runMutation(internal.payments.sandboxTopUpDb.recordTopUpOutcome, {
          topUpId: row._id,
          status: "failed",
          error: data.message ?? "PayPal refused the capture.",
        });
      }
      throw e;
    }
    if (!capture?.id || (capture.status !== "COMPLETED" && capture.status !== "PENDING")) {
      const error = `PayPal returned capture status ${capture?.status ?? "missing"}.`;
      await ctx.runMutation(internal.payments.sandboxTopUpDb.recordTopUpOutcome, { topUpId: row._id, status: "failed", error });
      throw new ConvexError({ code: "PAYPAL_ERROR", message: error });
    }
    await ctx.runMutation(internal.payments.sandboxTopUpDb.recordTopUpOutcome, {
      topUpId: row._id,
      status: "captured",
      paypalCaptureId: capture.id,
    });
    return {
      status: "captured",
      paypalCaptureId: capture.id,
      message: `Captured ${formatCents(row.amountCents)} into the sandbox platform account (PayPal keeps its fee; funds can take ~15 s to become available).`,
    };
  },
});
