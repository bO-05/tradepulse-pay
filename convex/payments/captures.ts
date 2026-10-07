import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { env, internalAction, type ActionCtx } from "../_generated/server";
import { toPayPalString } from "../lib/money";
import type { BeginCapture, BeginVoid } from "./releaseDb";
import { payPalClientForAction, type PayPalErrorData } from "./paypalClient";

/**
 * Capture and void against a milestone's funding authorization (architecture §4 step 2), through
 * the Server SDK Payments controller. captureApproved is the service function approveProposal calls.
 */

export function paypalErrorData(e: unknown): PayPalErrorData | null {
  if (e instanceof ConvexError && (e.data as { code?: unknown } | undefined)?.code === "PAYPAL_ERROR") {
    return e.data as PayPalErrorData;
  }
  return null;
}

export type CaptureResult = { captureId: string; finalCapture: boolean; alreadyCaptured: boolean };

/**
 * Captures `amountCents` from the funding payment's authorization. final_capture is true only when the
 * amount equals what remains authorized. `requestKey` is the PayPal-Request-Id seed: repeating it returns
 * the stored capture without a second PayPal write. A PayPal 4xx stores the error and throws CAPTURE_FAILED.
 */
export async function captureApproved(
  ctx: ActionCtx,
  args: {
    paymentId: Id<"payments">;
    amountCents: number;
    requestKey: string;
    actor: string;
    releasePaymentId?: Id<"payments">;
  },
): Promise<CaptureResult> {
  const begun: BeginCapture = await ctx.runMutation(internal.payments.releaseDb.beginCapture, {
    fundingPaymentId: args.paymentId,
    amountCents: args.amountCents,
    requestKey: args.requestKey,
  });
  if (begun.state === "done") return { captureId: begun.captureId, finalCapture: begun.finalCapture, alreadyCaptured: true };

  const paypal = payPalClientForAction(ctx, env, {
    actor: args.actor,
    projectId: begun.projectId,
    agreementId: begun.agreementId,
  });
  const fail = async (message: string) => {
    await ctx.runMutation(internal.payments.releaseDb.recordCaptureFailure, {
      fundingPaymentId: args.paymentId,
      error: message,
      releasePaymentId: args.releasePaymentId,
    });
  };
  let out;
  try {
    out = await paypal.sdkWrite("paypal.authorizations.capture", `cap_${args.requestKey}`, (sdk, paypalRequestId) =>
      sdk.payments.captureAuthorizedPayment({
        authorizationId: begun.authorizationId,
        paypalRequestId,
        prefer: "return=representation",
        body: {
          amount: { currencyCode: "USD", value: toPayPalString(args.amountCents) },
          finalCapture: begun.finalCapture,
        },
      }),
    );
  } catch (e) {
    const data = paypalErrorData(e);
    // After a network error PayPal may have applied the capture; the same request key retries safely.
    if (data !== null && data.status < 500) {
      const message = `Capture rejected by PayPal: ${data.message} Nothing was captured or paid.`;
      await fail(message);
      throw new ConvexError({ code: "CAPTURE_FAILED", message, paypalName: data.name, issues: data.issues });
    }
    throw e;
  }
  const capture = out.response.result;
  if (!capture?.id || (capture.status !== "COMPLETED" && capture.status !== "PENDING")) {
    const message = `Capture failed: PayPal returned capture status ${capture?.status ?? "missing"}. The sub was not paid.`;
    await fail(message);
    throw new ConvexError({ code: "CAPTURE_FAILED", message });
  }
  await ctx.runMutation(internal.payments.releaseDb.recordCapture, {
    fundingPaymentId: args.paymentId,
    captureId: capture.id,
    captureStatus: capture.status,
    amountCents: args.amountCents,
    requestKey: args.requestKey,
    finalCapture: begun.finalCapture,
    releasePaymentId: args.releasePaymentId,
    auditRecorded: out.auditRecorded,
  });
  return { captureId: capture.id, finalCapture: begun.finalCapture, alreadyCaptured: false };
}

/** Voids the uncaptured remainder of a partially captured milestone authorization. */
export async function voidRemainder(
  ctx: ActionCtx,
  args: { milestoneId: Id<"milestones">; actor: string },
): Promise<{ voided: boolean; alreadyVoided: boolean }> {
  const begun: BeginVoid = await ctx.runMutation(internal.payments.releaseDb.beginVoid, { milestoneId: args.milestoneId });
  if (begun.state === "done") return { voided: true, alreadyVoided: true };
  const paypal = payPalClientForAction(ctx, env, {
    actor: args.actor,
    projectId: begun.projectId,
    agreementId: begun.agreementId,
  });
  let auditRecorded: boolean;
  try {
    const out = await paypal.sdkWrite("paypal.authorizations.void", begun.idempotencyKey, (sdk, paypalRequestId) =>
      sdk.payments.voidPayment({ authorizationId: begun.authorizationId, paypalRequestId }),
    );
    auditRecorded = out.auditRecorded;
  } catch (e) {
    const data = paypalErrorData(e);
    if (data !== null && data.status < 500) {
      const message = `Void rejected by PayPal: ${data.message}`;
      await ctx.runMutation(internal.payments.releaseDb.recordVoidFailure, { fundingPaymentId: begun.fundingPaymentId, error: message });
      throw new ConvexError({ code: "VOID_FAILED", message, paypalName: data.name, issues: data.issues });
    }
    throw e;
  }
  await ctx.runMutation(internal.payments.releaseDb.recordVoid, { fundingPaymentId: begun.fundingPaymentId, auditRecorded });
  return { voided: true, alreadyVoided: false };
}

/** CLI / scheduler entry point for captureApproved (e.g. `npx convex run payments/captures:captureApprovedInternal`). */
export const captureApprovedInternal = internalAction({
  args: {
    paymentId: v.id("payments"),
    amountCents: v.number(),
    requestKey: v.string(),
    actor: v.optional(v.string()),
  },
  returns: v.object({ captureId: v.string(), finalCapture: v.boolean(), alreadyCaptured: v.boolean() }),
  handler: async (ctx, args): Promise<CaptureResult> =>
    await captureApproved(ctx, { ...args, actor: args.actor ?? "system:internal" }),
});
