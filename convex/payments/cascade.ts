import { ConvexError } from "convex/values";
import type { Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Cascade deletes for the per-agreement payment tables. Every code path that deletes an agreement
 * (demo reseed, project / package / bid delete, simulation reset) goes through deleteAgreement so no
 * SOV, milestone, pay-app, proposal, payment, retainage or change-order row outlives its agreement and
 * dashboard or ledger totals never count a deleted agreement. auditLogs and paypalEvents are history
 * and are kept; agentLinks are remapped by the reseed instead (lib/agentLinkRemap.ts).
 */

const BATCH = 200;

const MONEY_ALREADY_MOVED_MESSAGE =
  "This cannot be deleted or voided because PayPal payments, retainage, a pay application or a paid change order already reference it. Keep the financial trail; use a change order, credit or archive instead.";

/**
 * True when a payment or retainage row exists. A submitted or approved pay application is a billing
 * record but not money; voiding an agreement with one is still allowed so the GC can correct a
 * mistaken execution, while the SOV and pay-app history are kept.
 */
export async function agreementHasPaymentsOrRetainage(
  ctx: MutationCtx,
  agreementId: Id<"agreements">,
): Promise<boolean> {
  const payment = await ctx.db
    .query("payments")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
    .first();
  if (payment !== null) return true;
  const retainage = await ctx.db
    .query("retainageLedger")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
    .first();
  return retainage !== null;
}

/** True when any financial record exists, including pay applications and paid change orders. */
export async function agreementHasFinancialHistory(
  ctx: MutationCtx,
  agreementId: Id<"agreements">,
): Promise<boolean> {
  if (await agreementHasPaymentsOrRetainage(ctx, agreementId)) return true;
  const payApp = await ctx.db
    .query("payApplications")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
    .first();
  if (payApp !== null) return true;
  const changeOrders = await ctx.db
    .query("changeOrders")
    .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", agreementId))
    .take(BATCH);
  return changeOrders.some((co) => co.status === "paid" || co.paypalInvoiceStatus?.toUpperCase() === "PAID");
}

/** The user-facing refusal for a delete or void that would erase financial records. */
export function moneyHistoryRefusal(action: "delete" | "void", detail: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "FINANCIAL_HISTORY",
    message: `${MONEY_ALREADY_MOVED_MESSAGE} ${detail} (Attempted ${action}.)`,
  });
}

async function deleteAll(ctx: MutationCtx, load: () => Promise<{ _id: Id<TableNames> }[]>): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await load();
    if (rows.length === 0) return deleted;
    for (const r of rows) await ctx.db.delete(r._id);
    deleted += rows.length;
  }
}

export async function deleteAgreementPaymentRows(ctx: MutationCtx, agreementId: Id<"agreements">): Promise<number> {
  let n = 0;
  n += await deleteAll(ctx, () =>
    ctx.db.query("scheduleOfValues").withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId)).take(BATCH),
  );
  n += await deleteAll(ctx, () =>
    ctx.db.query("milestones").withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId)).take(BATCH),
  );
  n += await deleteAll(ctx, () =>
    ctx.db.query("payApplications").withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId)).take(BATCH),
  );
  n += await deleteAll(ctx, () =>
    ctx.db.query("agentProposals").withIndex("by_agreementId_and_status", (q) => q.eq("agreementId", agreementId)).take(BATCH),
  );
  n += await deleteAll(ctx, () =>
    ctx.db.query("payments").withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId)).take(BATCH),
  );
  n += await deleteAll(ctx, () =>
    ctx.db.query("retainageLedger").withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId)).take(BATCH),
  );
  n += await deleteAll(ctx, () =>
    ctx.db.query("changeOrders").withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", agreementId)).take(BATCH),
  );
  return n;
}

/** Deletes an agreement and every per-agreement payment row that references it. */
export async function deleteAgreementCascade(ctx: MutationCtx, agreementId: Id<"agreements">): Promise<void> {
  await deleteAgreementPaymentRows(ctx, agreementId);
  if ((await ctx.db.get(agreementId)) !== null) await ctx.db.delete(agreementId);
}

/** Deletes a contractor's cached license checks; call before deleting the contractor. */
export async function deleteContractorPaymentRows(ctx: MutationCtx, contractorId: Id<"contractors">): Promise<number> {
  return await deleteAll(ctx, () =>
    ctx.db
      .query("licenseChecks")
      .withIndex("by_contractorId_and_checkedAt", (q) => q.eq("contractorId", contractorId))
      .take(BATCH),
  );
}

/** Deletes a contractor together with its license checks. */
export async function deleteContractorCascade(ctx: MutationCtx, contractorId: Id<"contractors">): Promise<void> {
  await deleteContractorPaymentRows(ctx, contractorId);
  if ((await ctx.db.get(contractorId)) !== null) await ctx.db.delete(contractorId);
}
