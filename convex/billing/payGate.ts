import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { PAYEE_REASON, type PayoutReceiver } from "../lib/payee";
import { isCaptureCollected } from "../payments/captureSettlement";
import { computePayoutSplit, remainingAuthorizedCents, retainagePercentFor } from "../payments/payoutMath";
import { complianceBlockers, waiverBlockers } from "./payGateHooks";

/**
 * canPay (architecture §16): a payout runs only for an approved pay app with a confirmed payee, no
 * compliance hold, the required lien waivers and enough funded tranche money. Every unmet condition
 * is reported at once with a stable code; the UI lists them and the server refuses the payment.
 */

export type PayGateCode =
  | "NOT_APPROVED"
  | "ALREADY_PAID"
  | "PAYOUT_IN_PROGRESS"
  | "PAYOUT_UNCLAIMED"
  | "PAYOUT_FAILED"
  | "NOTHING_TO_PAY"
  | "NO_PAYEE"
  | "NOT_FUNDED"
  | (string & {});

export type PayGateReason = { code: PayGateCode; message: string };

export type PayFigures = { grossCents: number; retainageCents: number; netCents: number };

export type FundingSource = {
  milestoneId: Id<"milestones">;
  name: string;
  order: number;
  fundingPaymentId: Id<"payments">;
  availableCents: number;
};

export type PayGate = {
  ok: boolean;
  reasons: PayGateReason[];
  figures: PayFigures | null;
  payeeEmail: string | null;
  tranche: FundingSource | null;
  /** Largest amount one funded tranche can still capture. */
  availableCents: number;
  sources: FundingSource[];
  payouts: Doc<"payments">[];
};

const APPROVED: ReadonlySet<string> = new Set(["approved", "approved_as_noted"]);
const CAPTURABLE: ReadonlySet<string> = new Set(["authorized", "partially_captured"]);
const IN_FLIGHT: ReadonlySet<string> = new Set(["created", "capture_pending", "pending"]);

export const NOT_APPROVED_MESSAGE = "Pay app is not approved";
export const ALREADY_PAID_MESSAGE = "Already paid";
export const PAYEE_PENDING_MESSAGE = "No confirmed payee: payee change pending GC confirmation";
export const PAYEE_MISSING_MESSAGE = "No confirmed payee: the sub has not set a payout PayPal email";

/**
 * Gross is this period's approved increment; net is the approved G702 current payment due, so the
 * retainage withheld is exactly the approved per-line retainage of this period. Pay apps without
 * G702 figures (Phase-1 rows) withhold the agreement's retainage percent from the gross.
 */
export function payFiguresFor(payApp: Doc<"payApplications">, agreement: Doc<"agreements">): PayFigures | null {
  if (!APPROVED.has(payApp.status) && payApp.status !== "paid") return null;
  const gross = payApp.finalApproval?.totalCents;
  if (gross === undefined || gross <= 0) return null;
  const approved = payApp.g703?.approved;
  if (approved !== undefined) {
    const net = approved.currentPaymentDueCents;
    if (Number.isSafeInteger(net) && net >= 0 && net <= gross) return { grossCents: gross, retainageCents: gross - net, netCents: net };
  }
  return computePayoutSplit(gross, retainagePercentFor(agreement));
}

export function payeeReasonMessage(reason: string): string {
  if (reason === PAYEE_REASON.pending) return PAYEE_PENDING_MESSAGE;
  if (reason === PAYEE_REASON.noEmail) return PAYEE_MISSING_MESSAGE;
  return `No confirmed payee: ${reason.replace(/^it /, "the sub ")}`;
}

/** Every funded tranche of the agreement with what its authorization can still capture, in tranche order. */
export async function fundingSources(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<FundingSource[]> {
  const milestones = await ctx.db
    .query("milestones")
    .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId))
    .take(50);
  const out: FundingSource[] = [];
  for (const m of milestones) {
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_milestoneId", (q) => q.eq("milestoneId", m._id))
      .take(200);
    const funded = rows.filter((p) => p.kind === "funding" && p.paypalAuthorizationId !== undefined);
    const latest = funded.length > 0 ? funded[funded.length - 1] : null;
    if (latest === null || !CAPTURABLE.has(latest.status) || latest.closingAt !== undefined) continue;
    const availableCents = remainingAuthorizedCents(latest);
    if (availableCents <= 0) continue;
    out.push({ milestoneId: m._id, name: m.name, order: m.order, fundingPaymentId: latest._id, availableCents });
  }
  return out.sort((a, b) => a.order - b.order);
}

function capturedReleaseIds(fundingRows: readonly Doc<"payments">[]): Set<string> {
  const ids = new Set<string>();
  for (const f of fundingRows) for (const c of f.captures ?? []) if (c.releasePaymentId && isCaptureCollected(c.status)) ids.add(c.releasePaymentId);
  return ids;
}

/** Blockers from earlier payout attempts for this pay app: paid, still moving, or captured but not delivered. */
async function payoutBlockers(ctx: QueryCtx, payouts: readonly Doc<"payments">[]): Promise<PayGateReason[]> {
  if (payouts.some((p) => p.status === "success")) return [{ code: "ALREADY_PAID", message: ALREADY_PAID_MESSAGE }];
  if (payouts.some((p) => IN_FLIGHT.has(p.status))) {
    return [{ code: "PAYOUT_IN_PROGRESS", message: "Payout in progress: PayPal has not finished this payment yet" }];
  }
  const unclaimed = payouts.find((p) => p.status === "unclaimed");
  if (unclaimed) {
    return [{ code: "PAYOUT_UNCLAIMED", message: `Payout unclaimed: ${unclaimed.error ?? "PayPal could not deliver the payout to the payee."}` }];
  }
  const fundingIds = [...new Set(payouts.map((p) => p.fundingPaymentId).filter((id): id is Id<"payments"> => id !== undefined))];
  const fundingRows: Doc<"payments">[] = [];
  for (const id of fundingIds) {
    const row = await ctx.db.get(id);
    if (row !== null) fundingRows.push(row);
  }
  const captured = capturedReleaseIds(fundingRows);
  const failedAfterCapture = payouts.filter((p) => captured.has(p.retryOfPaymentId ?? p._id));
  if (failedAfterCapture.length > 0) {
    const last = failedAfterCapture[failedAfterCapture.length - 1];
    return [
      {
        code: "PAYOUT_FAILED",
        message: `Payout failed: ${last.error ?? "PayPal did not deliver the payout."} The captured amount is held in the platform account; retry the payout once the payee is confirmed.`,
      },
    ];
  }
  return [];
}

export async function payAppPayouts(ctx: QueryCtx, payAppId: Id<"payApplications">): Promise<Doc<"payments">[]> {
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_payAppId", (q) => q.eq("payAppId", payAppId))
    .take(100);
  return rows.filter((p) => p.kind === "payout");
}

/**
 * Evaluates every pay condition. `receiver` resolves the confirmed payee (the read-only lookup in
 * queries; the mutation lookup, which also attaches the vendor record, where money moves).
 */
export async function evaluatePayGate(
  ctx: QueryCtx,
  payApp: Doc<"payApplications">,
  agreement: Doc<"agreements">,
  receiver: (contractorId: Id<"contractors">) => Promise<PayoutReceiver>,
): Promise<PayGate> {
  const reasons: PayGateReason[] = [];
  const payouts = await payAppPayouts(ctx, payApp._id);
  const prior = await payoutBlockers(ctx, payouts);
  const paid = payApp.status === "paid" || prior.some((r) => r.code === "ALREADY_PAID");
  if (paid) reasons.push({ code: "ALREADY_PAID", message: ALREADY_PAID_MESSAGE });
  else {
    if (!APPROVED.has(payApp.status)) reasons.push({ code: "NOT_APPROVED", message: NOT_APPROVED_MESSAGE });
    reasons.push(...prior);
  }

  const figures = payFiguresFor(payApp, agreement);
  if (!paid && APPROVED.has(payApp.status) && figures === null) {
    reasons.push({ code: "NOTHING_TO_PAY", message: "Nothing to pay: the approved amount is $0.00" });
  }

  const payee = await receiver(agreement.contractorId);
  if (!payee.ok && !paid) reasons.push({ code: "NO_PAYEE", message: payeeReasonMessage(payee.reason) });

  if (!paid) {
    reasons.push(...(await complianceBlockers(ctx, agreement)));
    reasons.push(...(await waiverBlockers(ctx, payApp, figures)));
  }

  const sources = await fundingSources(ctx, agreement._id);
  const availableCents = sources.reduce((max, s) => Math.max(max, s.availableCents), 0);
  let tranche: FundingSource | null = null;
  if (figures !== null && !paid) {
    tranche = sources.find((s) => s.availableCents >= figures.grossCents) ?? null;
    if (tranche === null) {
      reasons.push({
        code: "NOT_FUNDED",
        message:
          sources.length === 0
            ? `No funded tranche (available ${formatCents(0)})`
            : `No funded tranche covers ${formatCents(figures.grossCents)} (available ${formatCents(availableCents)})`,
      });
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    figures,
    payeeEmail: payee.ok ? payee.email : null,
    tranche,
    availableCents,
    sources,
    payouts,
  };
}
