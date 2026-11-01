import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { COMPLIANCE_HOLD_CODE, complianceHoldFor } from "../compliance/hold";

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

export async function waiverBlockers(
  _ctx: QueryCtx,
  _payApp: Doc<"payApplications">,
  _figures: { grossCents: number; netCents: number } | null,
): Promise<PayGateHookReason[]> {
  return [];
}
