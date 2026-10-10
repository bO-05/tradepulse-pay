import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * Extension points of the pay gate (architecture §16, §17). Compliance (COI status, holds and
 * overrides) and lien waivers (conditional waiver for this payment, unconditional waiver for the
 * previous one) report their blockers here; until those rules exist both return no blocker.
 */

export type PayGateHookReason = { code: string; message: string };

export async function complianceBlockers(_ctx: QueryCtx, _agreement: Doc<"agreements">): Promise<PayGateHookReason[]> {
  return [];
}

export async function waiverBlockers(
  _ctx: QueryCtx,
  _payApp: Doc<"payApplications">,
  _figures: { grossCents: number; netCents: number } | null,
): Promise<PayGateHookReason[]> {
  return [];
}
