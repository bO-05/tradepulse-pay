import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { payoutReceiverForContractor } from "../lib/payee";
import { evaluatePayGate, type PayGate, type PayGateReason } from "./payGate";

/** canPay where money moves: the payee lookup may attach the vendor record, and a refusal lists every reason. */

export function cannotPay(reasons: readonly PayGateReason[]): ConvexError<{ code: string; message: string; reasons: PayGateReason[] }> {
  return new ConvexError({
    code: "CANNOT_PAY",
    message: `Payment blocked: ${reasons.map((r) => r.message).join("; ")}`,
    reasons: [...reasons],
  });
}

export async function payGateForMutation(ctx: MutationCtx, payApp: Doc<"payApplications">, agreement: Doc<"agreements">): Promise<PayGate> {
  return await evaluatePayGate(ctx, payApp, agreement, (contractorId) => payoutReceiverForContractor(ctx, contractorId));
}

