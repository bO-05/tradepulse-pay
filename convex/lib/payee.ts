import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { attachBidderVendor } from "./vendorDirectory";
import { liveVendor } from "./vendorRead";

/**
 * Payee control (architecture §14). A sub company admin sets `companies.payoutPaypalEmail`; each GC
 * relationship (vendor row) must confirm it before payouts go there. Payouts use only
 * `vendors.payoutEmailConfirmed.email`, and only while it still equals the company's current email.
 */

export type PayeeStatus = "none" | "pending" | "confirmed";

export type PayeeState = {
  status: PayeeStatus;
  /** The sub company's current payout email (what a GC member would confirm). */
  currentEmail: string | null;
  confirmedEmail: string | null;
  confirmedAt: number | null;
  confirmedByUserId: Id<"users"> | null;
};

export function payeeState(vendor: Doc<"vendors">, linkedCompany: Doc<"companies"> | null): PayeeState {
  const currentEmail = linkedCompany?.payoutPaypalEmail ?? null;
  const confirmed = vendor.payoutEmailConfirmed;
  const isConfirmed = confirmed !== undefined && currentEmail !== null && confirmed.email === currentEmail;
  return {
    status: isConfirmed ? "confirmed" : currentEmail !== null ? "pending" : "none",
    currentEmail,
    confirmedEmail: isConfirmed ? confirmed.email : null,
    confirmedAt: isConfirmed ? confirmed.confirmedAt : null,
    confirmedByUserId: isConfirmed ? confirmed.confirmedByUserId : null,
  };
}

export type PayoutReceiver = { ok: true; email: string; vendorId: Id<"vendors"> } | { ok: false; reason: string };

export function payoutBlockedMessage(subName: string, reason: string, effect: string): string {
  return `Payout blocked for ${subName}: ${reason} ${effect}`;
}

export const PAYEE_REASON = {
  noVendor: "it has no vendor record in your directory, so there is no confirmed payee.",
  notLinked: "it has no TradePulse Pay company account yet, so there is no confirmed payee. Invite it to the project first.",
  noEmail: "its company has not set a payout PayPal email yet, so there is no confirmed payee.",
  pending: "its payout PayPal email is waiting for confirmation. A GC member must confirm the payee on the vendor page.",
  changed: "its confirmed payout PayPal email changed after this payout was queued, so nothing was sent to the earlier address.",
} as const;

async function receiverForVendor(ctx: QueryCtx, vendor: Doc<"vendors">): Promise<PayoutReceiver> {
  if (vendor.linkedCompanyId === undefined) return { ok: false, reason: PAYEE_REASON.notLinked };
  const company = await ctx.db.get(vendor.linkedCompanyId);
  const state = payeeState(vendor, company);
  if (state.status === "none") return { ok: false, reason: PAYEE_REASON.noEmail };
  if (state.status === "pending" || state.confirmedEmail === null) return { ok: false, reason: PAYEE_REASON.pending };
  return { ok: true, email: state.confirmedEmail, vendorId: vendor._id };
}

/** Read-only check for screens: the confirmed payee of a contractor (bidder) row, or why there is none. */
export async function payoutReceiverForContractorReadOnly(ctx: QueryCtx, contractorId: Id<"contractors">): Promise<PayoutReceiver> {
  const contractor = await ctx.db.get(contractorId);
  const vendor = contractor?.vendorId ? await liveVendor(ctx, contractor.vendorId) : null;
  if (vendor === null) return { ok: false, reason: PAYEE_REASON.noVendor };
  return await receiverForVendor(ctx, vendor);
}

/**
 * Why a queued payout to `queuedEmail` must not be sent now, or null when that address is still the
 * contractor's currently confirmed payee. Checked right before every unsent payout POST.
 */
export async function stalePayeeReason(
  ctx: QueryCtx,
  contractorId: Id<"contractors">,
  queuedEmail: string,
): Promise<string | null> {
  const receiver = await payoutReceiverForContractorReadOnly(ctx, contractorId);
  if (!receiver.ok) return receiver.reason;
  return receiver.email === queuedEmail ? null : PAYEE_REASON.changed;
}

/**
 * The payout receiver for an agreement's contractor: its vendor's confirmed payee email. A bidder row
 * without a vendor is first attached to its GC company's directory entry (found by email or name).
 */
export async function payoutReceiverForContractor(ctx: MutationCtx, contractorId: Id<"contractors">): Promise<PayoutReceiver> {
  const vendorId = await attachBidderVendor(ctx, contractorId);
  const vendor = vendorId === null ? null : await liveVendor(ctx, vendorId);
  if (vendor === null) return { ok: false, reason: PAYEE_REASON.noVendor };
  return await receiverForVendor(ctx, vendor);
}

/** Clears every GC confirmation of the company's payee; returns the vendor rows (GC relationships). */
export async function clearPayeeConfirmations(ctx: MutationCtx, companyId: Id<"companies">): Promise<Doc<"vendors">[]> {
  const vendors = await ctx.db
    .query("vendors")
    .withIndex("by_linkedCompanyId", (q) => q.eq("linkedCompanyId", companyId))
    .take(500);
  for (const vendor of vendors) {
    if (vendor.payoutEmailConfirmed !== undefined) await ctx.db.patch(vendor._id, { payoutEmailConfirmed: undefined });
  }
  return vendors;
}
