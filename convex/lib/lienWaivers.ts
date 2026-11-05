import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isoDate } from "../payApps/g703Math";

/**
 * Opt-in lien-waiver gate (R6). The agreement carries the switch; signatures live in `lienWaivers`.
 * A conditional waiver covers the pay app being released, an unconditional waiver covers the prior
 * payment. This records an in-app attestation. It is not a state-specific statutory form and it is
 * not legal advice.
 */

export type LienWaiverGate = NonNullable<Doc<"agreements">["lienWaiverGate"]>;

export const LIEN_WAIVER_DISCLAIMER =
  "This records the signer's attestation in TradePulse Pay. It is not legal advice and may not match the statutory waiver form your state requires. Confirm the wording with counsel before relying on it.";

export const NO_CURRENT_AMOUNT_MESSAGE =
  "Lien-waiver gate: there is no approved payment amount, so there is no conditional waiver to sign.";

export function waiverAmountCents(payApp: Doc<"payApplications">): number {
  return payApp.finalApproval?.totalCents ?? 0;
}

export function waiverThroughDate(payApp: Doc<"payApplications">): string {
  return payApp.periodEnd ?? isoDate(new Date());
}

export function payAppLabel(payApp: Doc<"payApplications">): string {
  return payApp.applicationNo !== undefined ? `#${payApp.applicationNo}` : `"${payApp.periodLabel}"`;
}

export async function signedWaiver(
  ctx: QueryCtx,
  payAppId: Id<"payApplications">,
  kind: Doc<"lienWaivers">["kind"],
  coversPayAppId: Id<"payApplications">,
): Promise<Doc<"lienWaivers"> | null> {
  const rows = await ctx.db
    .query("lienWaivers")
    .withIndex("by_payAppId_and_kind", (q) => q.eq("payAppId", payAppId).eq("kind", kind))
    .take(10);
  return rows.find((w) => w.coversPayAppId === coversPayAppId) ?? null;
}

/**
 * The latest paid pay app before `current` whose approval happened after the gate was enabled.
 * Earlier payments are not made subject to a gate that did not exist when they were approved.
 */
export async function priorPaidPayApp(
  ctx: QueryCtx,
  agreement: Doc<"agreements">,
  current: Doc<"payApplications">,
  gate: LienWaiverGate,
): Promise<Doc<"payApplications"> | null> {
  const rows = await ctx.db
    .query("payApplications")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreement._id))
    .take(500);
  const currentNo = current.applicationNo ?? Number.MAX_SAFE_INTEGER;
  let best: Doc<"payApplications"> | null = null;
  for (const row of rows) {
    if (row._id === current._id || row.status !== "paid") continue;
    if (waiverAmountCents(row) <= 0) continue;
    if ((row.applicationNo ?? 0) >= currentNo) continue;
    const approvedAt = row.finalApproval?.approvedAt ?? row.createdAt;
    if (approvedAt < gate.enabledAt) continue;
    if (
      best === null ||
      (row.applicationNo ?? 0) > (best.applicationNo ?? 0) ||
      ((row.applicationNo ?? 0) === (best.applicationNo ?? 0) && row.createdAt > best.createdAt)
    ) {
      best = row;
    }
  }
  return best;
}

export type WaiverSlot = {
  payAppId: Id<"payApplications">;
  label: string;
  amountCents: number;
  throughDate: string;
  signed: Doc<"lienWaivers"> | null;
};

export type WaiverGateState = {
  gate: LienWaiverGate;
  current: WaiverSlot | null;
  prior: WaiverSlot | null;
  requirePriorUnconditional: boolean;
};

/** Gate state shared by the pay gate, the signing mutation and the pay-app panel query. */
export async function loadWaiverGateState(
  ctx: QueryCtx,
  agreement: Doc<"agreements">,
  payApp: Doc<"payApplications">,
): Promise<WaiverGateState | null> {
  const gate = agreement.lienWaiverGate;
  if (gate?.enabled !== true) return null;
  const amount = waiverAmountCents(payApp);
  const current =
    amount > 0
      ? {
          payAppId: payApp._id,
          label: payAppLabel(payApp),
          amountCents: amount,
          throughDate: waiverThroughDate(payApp),
          signed: await signedWaiver(ctx, payApp._id, "conditional", payApp._id),
        }
      : null;
  const priorPayApp = await priorPaidPayApp(ctx, agreement, payApp, gate);
  const prior =
    priorPayApp === null
      ? null
      : {
          payAppId: priorPayApp._id,
          label: payAppLabel(priorPayApp),
          amountCents: waiverAmountCents(priorPayApp),
          throughDate: waiverThroughDate(priorPayApp),
          signed: await signedWaiver(ctx, payApp._id, "unconditional", priorPayApp._id),
        };
  return { gate, current, prior, requirePriorUnconditional: gate.requirePriorUnconditional };
}
