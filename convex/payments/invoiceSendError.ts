import { ConvexError } from "convex/values";
import type { PayPalErrorData } from "./paypalClient";

/**
 * PayPal can answer an invoice send with HTTP 422 AUTH_FLOW_REQUIRED (seen in the sandbox on a
 * high-value invoice): it wants the merchant account to verify its identity first. The invoice
 * stays a DRAFT at PayPal, so a retry sends the same invoice id.
 */
export const INVOICE_AUTH_FLOW_MESSAGE =
  "PayPal could not send this invoice: PayPal asked the merchant account to verify its identity first. The invoice is saved in PayPal as a draft and nothing was charged; try again later or send a smaller invoice.";

const AUTH_FLOW_REQUIRED = "AUTH_FLOW_REQUIRED";

function payPalErrorData(e: unknown): PayPalErrorData | null {
  if (!(e instanceof ConvexError)) return null;
  const data = e.data as Partial<PayPalErrorData> | undefined;
  return data?.code === "PAYPAL_ERROR" ? (data as PayPalErrorData) : null;
}

export function isAuthFlowRequired(e: unknown): boolean {
  const data = payPalErrorData(e);
  if (data === null) return false;
  return data.name === AUTH_FLOW_REQUIRED || (data.issues ?? []).includes(AUTH_FLOW_REQUIRED);
}

function errorMessage(e: unknown): string {
  if (e instanceof ConvexError && typeof e.data === "object" && e.data !== null && typeof e.data.message === "string") {
    return e.data.message;
  }
  return e instanceof Error ? e.message : "Unknown error.";
}

/** The message stored on the owner pay app or change order and shown when an invoice create or send fails. */
export function invoiceFailureMessage(e: unknown): string {
  if (isAuthFlowRequired(e)) return INVOICE_AUTH_FLOW_MESSAGE;
  return `Invoice not sent: ${errorMessage(e)}`;
}

/** PayPal debug id of a failed call, kept on the thrown error so support can trace it (the audit entry has it too). */
export function payPalDebugIdOf(e: unknown): string | null {
  return payPalErrorData(e)?.debugId ?? null;
}
