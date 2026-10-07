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

/** Audit entries about money (PayPal writes, retries, watcher runs on an agreement) survive project resets. */
export function isPaymentHistory(log: { eventType: string; agreementId?: Id<"agreements"> }): boolean {
  return log.eventType === "paypal_write" || log.eventType === "payout_retry" || log.agreementId !== undefined;
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
