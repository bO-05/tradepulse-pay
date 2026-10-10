import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { payoutReceiverForContractorReadOnly } from "../lib/payee";
import { findDocScope, requireDocScope } from "../lib/projectScope";
import { notFound } from "../lib/tenancy";
import { isCaptureCollected } from "../payments/captureSettlement";
import { attemptsFor, checkRetry } from "../payments/payoutRetryMath";
import { evaluatePayGate, type PayGate } from "./payGate";

/**
 * canPay for clients and convex-run: structured reasons for one pay app. The GC and the pay app's
 * own sub may read it; owners, other subs and other companies get "Not found.".
 */

async function gateFor(ctx: QueryCtx, payApp: Doc<"payApplications">): Promise<{ agreement: Doc<"agreements">; gate: PayGate }> {
  const agreement = await ctx.db.get(payApp.agreementId);
  if (agreement === null) throw notFound();
  const gate = await evaluatePayGate(ctx, payApp, agreement, (contractorId) => payoutReceiverForContractorReadOnly(ctx, contractorId));
  return { agreement, gate };
}

export const canPay = query({
  args: { payAppId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["gc", "sub"] });
    const { gate } = await gateFor(ctx, scope.doc);
    return {
      ok: gate.ok,
      reasons: gate.reasons,
      figures: gate.figures,
      payeeEmail: gate.payeeEmail,
      tranche: gate.tranche ? { trancheId: gate.tranche.milestoneId, name: gate.tranche.name, availableCents: gate.tranche.availableCents } : null,
      availableCents: gate.availableCents,
    };
  },
});

/** Everything the pay app's Payment panel shows: blockers, the figures, the payee, the tranche and the payout. */
export const paymentPanel = query({
  args: { payAppId: v.string() },
  handler: async (ctx, args) => {
    const scope = await findDocScope(ctx, "payApplications", args.payAppId, { roles: ["gc", "sub"] });
    if (scope === null) return null;
    const payApp = scope.doc;
    const isGc = scope.partyRole === "gc";
    const { agreement, gate } = await gateFor(ctx, payApp);

    const fundingIds = [...new Set(gate.payouts.map((p) => p.fundingPaymentId).filter((id) => id !== undefined))];
    const captured = new Set<string>();
    for (const id of fundingIds) {
      const f = await ctx.db.get(id);
      for (const c of f?.captures ?? []) if (c.releasePaymentId && isCaptureCollected(c.status)) captured.add(c.releasePaymentId);
    }
    const latest = gate.payouts.length > 0 ? gate.payouts[gate.payouts.length - 1] : null;
    let payment = null;
    if (latest !== null) {
      const rootId = latest.retryOfPaymentId ?? latest._id;
      const wasCaptured = captured.has(rootId);
      const attempts = attemptsFor(gate.payouts, rootId);
      const milestone = latest.milestoneId ? await ctx.db.get(latest.milestoneId) : null;
      payment = {
        paymentId: latest._id,
        status: latest.status,
        grossCents: latest.grossCents,
        retainageCents: latest.retainageCents,
        netCents: latest.netCents,
        receiverEmail: latest.receiverEmail ?? null,
        trancheName: milestone?.name ?? null,
        paypalPayoutBatchId: latest.paypalPayoutBatchId ?? null,
        paypalItemStatus: latest.paypalItemStatus ?? null,
        error: latest.error ?? null,
        captured: wasCaptured,
        canRetryPayout: isGc && checkRetry(attempts, rootId, wasCaptured).ok,
        updatedAt: latest.updatedAt ?? latest.createdAt,
      };
    }

    const ledger = await ctx.db
      .query("retainageLedger")
      .withIndex("by_agreementId", (q) => q.eq("agreementId", agreement._id))
      .take(500);
    const fundedTranches = await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
      .take(50);

    return {
      viewerRole: scope.partyRole,
      canPay: isGc && gate.ok,
      payAppStatus: payApp.status,
      applicationNo: payApp.applicationNo ?? null,
      subcontractorName: agreement.subcontractorName,
      agreementId: agreement._id,
      ok: gate.ok,
      reasons: gate.reasons,
      figures: gate.figures,
      payeeEmail: gate.payeeEmail,
      tranche: gate.tranche ? { trancheId: gate.tranche.milestoneId, name: gate.tranche.name, availableCents: gate.tranche.availableCents } : null,
      availableCents: gate.availableCents,
      trancheCount: fundedTranches.length,
      payment,
      retainageThisPeriodCents: gate.figures?.retainageCents ?? null,
      totalRetainageHeldCents: ledger.reduce((acc, r) => acc + r.deltaCents, 0),
    };
  },
});
