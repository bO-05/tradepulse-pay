import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { COMPLIANCE_HOLD_CODE, complianceHoldFor } from "../compliance/hold";
import { loadWaiverGateState, NO_CURRENT_AMOUNT_MESSAGE } from "../lib/lienWaivers";
import { formatCents } from "../lib/money";

/**
 * Extension points of the pay gate (architecture §16, §17). Compliance (COI status, holds and
 * overrides) and lien waivers (conditional waiver for this payment, unconditional waiver for the
 * previous one) report their blockers here.
 */

export type PayGateHookReason = { code: string; message: string };

/** The compliance hold of the agreement's vendor, unless a GC admin overrode it for this pay app. */
export async function complianceBlockers(
  ctx: QueryCtx,
  agreement: Doc<"agreements">,
  payApp: Doc<"payApplications">,
): Promise<PayGateHookReason[]> {
  if (payApp.complianceOverride !== undefined) return [];
  const hold = await complianceHoldFor(ctx, agreement);
  return hold.holdMessage === null ? [] : [{ code: COMPLIANCE_HOLD_CODE, message: hold.holdMessage }];
}

/**
 * Opt-in lien-waiver gate: the sub's conditional waiver must match this payment, and (when the
 * agreement asks for it) the prior payment needs its unconditional waiver. Gate off means no
 * blocker, which is the default for every existing agreement.
 */
export async function waiverBlockers(
  ctx: QueryCtx,
  agreement: Doc<"agreements">,
  payApp: Doc<"payApplications">,
  figures: { grossCents: number; netCents: number } | null,
): Promise<PayGateHookReason[]> {
  const state = await loadWaiverGateState(ctx, agreement, payApp);
  if (state === null) return [];
  if (state.current === null || figures === null) {
    return [{ code: "LIEN_WAIVER_AMOUNT_UNKNOWN", message: NO_CURRENT_AMOUNT_MESSAGE }];
  }
  const reasons: PayGateHookReason[] = [];
  const current = state.current;
  if (current.signed === null) {
    reasons.push({
      code: "LIEN_WAIVER_MISSING",
      message: `Lien waiver: the sub has not signed the conditional waiver for ${formatCents(current.amountCents)}.`,
    });
  } else if (current.signed.amountCents !== current.amountCents) {
    reasons.push({
      code: "LIEN_WAIVER_AMOUNT_CHANGED",
      message: `Lien waiver: the signed conditional waiver covers ${formatCents(current.signed.amountCents)}, but this payment is ${formatCents(current.amountCents)}. The sub must sign a new waiver.`,
    });
  }
  if (state.requirePriorUnconditional && state.prior !== null) {
    const prior = state.prior;
    if (prior.signed === null) {
      reasons.push({
        code: "LIEN_WAIVER_MISSING",
        message: `Lien waiver: the sub has not signed the unconditional waiver for the prior payment (pay app ${prior.label}, ${formatCents(prior.amountCents)}).`,
      });
    } else if (prior.signed.amountCents !== prior.amountCents) {
      reasons.push({
        code: "LIEN_WAIVER_AMOUNT_CHANGED",
        message: `Lien waiver: the unconditional waiver for pay app ${prior.label} covers ${formatCents(prior.signed.amountCents)}, but that payment was ${formatCents(prior.amountCents)}.`,
      });
    }
  }
  return reasons;
}
