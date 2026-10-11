import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { PayFigures } from "../billing/payGate";
import { cannotPay, payGateForMutation } from "../billing/payGateDb";
import { formatCents } from "../lib/money";
import { syncProposalForPayment } from "../payApps/proposalSync";
import { APPROVED_PAY_APP_REQUIRED_MESSAGE } from "./releaseDb";
import { assertPaymentTransition } from "./stateMachine";

/**
 * Continuing an existing release (Retry release, Retry payout) does one of two different things:
 * - reconciliation: a capture or payout POST that may already have reached PayPal is re-sent under the
 *   same PayPal-Request-Id / sender_batch_id, so PayPal returns what it already did. Always allowed.
 * - initiation: a capture or payout that was never sent is a new money write. It needs the release's
 *   approved pay app and a passing canPay right now, exactly like the first "Pay" click.
 */

export const NOT_CAPTURED_EFFECT = "Nothing was captured or paid.";
export const CAPTURED_NOT_PAID_EFFECT = "The sub was not paid; the captured amount stays in the platform account.";

export type Refusal = { code: string; message: string };

export type InitiationCheck = { refusal: Refusal; figures: null } | { refusal: null; figures: PayFigures };

/**
 * Whether a new capture or payout for `release` (the original release row) may start now: refused unless
 * its pay app is approved and passes canPay, else the approved G702 split it must pay. A confirmed
 * payee change is applied to `row` when given.
 */
export async function initiationCheck(
  ctx: MutationCtx,
  release: Doc<"payments">,
  effect: string,
  row?: Doc<"payments">,
): Promise<InitiationCheck> {
  const no = (refusal: Refusal): InitiationCheck => ({ refusal, figures: null });
  const required = { code: "APPROVED_PAY_APP_REQUIRED", message: APPROVED_PAY_APP_REQUIRED_MESSAGE.replace(NOT_CAPTURED_EFFECT, effect) };
  if (release.payAppId === undefined) return no(required);
  const payApp = await ctx.db.get(release.payAppId);
  const agreement = await ctx.db.get(release.agreementId);
  if (payApp === null || agreement === null || payApp.agreementId !== agreement._id) return no(required);
  const gate = await payGateForMutation(ctx, payApp, agreement, { continuingReleaseId: release._id });
  if (!gate.ok || gate.figures === null || gate.payeeEmail === null) {
    return no({ code: "CANNOT_PAY", message: `${cannotPay(gate.reasons).data.message}. ${effect}` });
  }
  if (gate.figures.grossCents !== release.grossCents) {
    return no({
      code: "CONFLICT",
      message: `The approved amount is now ${formatCents(gate.figures.grossCents)}, not the ${formatCents(release.grossCents)} of this release. ${effect}`,
    });
  }
  // Nothing was sent for this row yet, so it pays the payee confirmed now.
  if (row !== undefined && row.receiverEmail !== gate.payeeEmail) await ctx.db.patch(row._id, { receiverEmail: gate.payeeEmail });
  return { refusal: null, figures: gate.figures };
}

export async function initiationRefusal(
  ctx: MutationCtx,
  release: Doc<"payments">,
  effect: string,
  row?: Doc<"payments">,
): Promise<Refusal | null> {
  return (await initiationCheck(ctx, release, effect, row)).refusal;
}

/** Closes a created payment none of whose refused step was sent to PayPal. */
export async function closeUnsent(ctx: MutationCtx, row: Doc<"payments">, message: string): Promise<void> {
  assertPaymentTransition(row.kind, "created", "failed");
  await ctx.db.patch(row._id, { status: "failed", error: message, updatedAt: Date.now() });
  await syncProposalForPayment(ctx, row._id);
}

async function refuse(ctx: MutationCtx, row: Doc<"payments">, refusal: Refusal) {
  await closeUnsent(ctx, row, refusal.message);
  return { state: "refused" as const, ...refusal };
}

const mode = v.union(v.literal("reconcile"), v.literal("initiate"));
const continueResult = v.union(
  v.object({ state: v.literal("closed"), status: v.string(), error: v.optional(v.string()) }),
  v.object({ state: v.literal("refused"), code: v.string(), message: v.string() }),
  v.object({
    state: v.literal("capture"),
    mode,
    fundingPaymentId: v.id("payments"),
    grossCents: v.number(),
    requestKey: v.string(),
  }),
  v.object({ state: v.literal("payout"), mode }),
);
export type ContinueRelease = Infer<typeof continueResult>;

/**
 * Decides the next step of a release still in `created`: capture (when no capture is recorded for it)
 * or payout. A step whose POST may have reached PayPal is reconciled; a step never sent must pass
 * initiationRefusal, and a refused row is closed as failed, since nothing of that step was sent.
 */
export const continueRelease = internalMutation({
  args: { paymentId: v.id("payments") },
  returns: continueResult,
  handler: async (ctx, { paymentId }): Promise<ContinueRelease> => {
    const row = await ctx.db.get(paymentId);
    if (row === null || row.kind !== "payout") throw new ConvexError({ code: "NOT_FOUND", message: "Release not found." });
    if (row.status !== "created") return { state: "closed", status: row.status, error: row.error ?? "This release was already processed." };
    const root: Doc<"payments"> | null = row.retryOfPaymentId ? await ctx.db.get(row.retryOfPaymentId) : row;
    const fundingId: Id<"payments"> | undefined = root?.fundingPaymentId;
    if (root === null || fundingId === undefined) throw new ConvexError({ code: "INVALID_STATE", message: "This release has no funding authorization." });
    const funding = await ctx.db.get(fundingId);
    const captureRecorded = (funding?.captures ?? []).some((c) => c.releasePaymentId === root._id);

    if (row.retryOfPaymentId === undefined && !captureRecorded) {
      const next = { state: "capture" as const, fundingPaymentId: fundingId, grossCents: row.grossCents, requestKey: row.idempotencyKey };
      if (row.captureSubmittedAt !== undefined) return { ...next, mode: "reconcile" };
      const refusal = await initiationRefusal(ctx, root, NOT_CAPTURED_EFFECT, row);
      return refusal === null ? { ...next, mode: "initiate" } : await refuse(ctx, row, refusal);
    }
    if (row.payoutSubmittedAt !== undefined || row.paypalPayoutBatchId !== undefined) return { state: "payout", mode: "reconcile" };
    const refusal = await initiationRefusal(ctx, root, CAPTURED_NOT_PAID_EFFECT, row);
    return refusal === null ? { state: "payout", mode: "initiate" } : await refuse(ctx, row, refusal);
  },
});
