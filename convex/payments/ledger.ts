import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireRole } from "../lib/roles";
import { scopedAgreements } from "../lib/agreementScope";
import { findDocScope } from "../lib/projectScope";
import { loadBillingHistory, unresolvedApprovalMessage } from "../payApps/billingHistory";
import { isCaptureCollected } from "./captureSettlement";
import { HISTORY_TRUNCATED_MESSAGE, loadAgreementHistory } from "./agreementHistory";
import { BALANCE_FORMULA, computeLedgerTotals } from "./ledgerTotals";
import { attemptsFor, checkRetry } from "./payoutRetryMath";
import { retainagePercentFor } from "./payoutMath";
import { releasableRetainageCents } from "./retainageMath";
import { agreementContractSumCents } from "./sov";

function ledgerAgreementSummary(a: Doc<"agreements">) {
  return {
    _id: a._id,
    agreementNumber: a.agreementNumber,
    projectId: a.projectId,
    projectTitle: a.projectTitle,
    subcontractorName: a.subcontractorName,
    contractorId: a.contractorId,
    csiDivision: a.csiDivision,
    tradeName: a.tradeName,
    status: a.status,
    retainagePercent: retainagePercentFor(a),
    contractSumCents: agreementContractSumCents(a),
    executedAt: a.executedAt ?? null,
  };
}

function fundingSummary(p: Doc<"payments"> | undefined) {
  if (p === undefined) return null;
  return {
    paymentId: p._id,
    status: p.status,
    grossCents: p.grossCents,
    paypalOrderId: p.paypalOrderId ?? null,
    paypalAuthorizationId: p.paypalAuthorizationId ?? null,
    authorizationExpiresAt: p.authorizationExpiresAt ?? null,
    honorPeriodEndsAt: p.honorPeriodEndsAt ?? null,
    capturedCents: p.capturedCents ?? 0,
    captureCount: p.captures?.length ?? 0,
    reauthorizationCount: p.reauthorizationCount ?? 0,
    reauthorizeError: p.reauthorizeError ?? null,
    error: p.error ?? null,
  };
}

function releaseSummary(p: Doc<"payments">, showReceiver: boolean, retry?: { captured: boolean; canRetryPayout: boolean }) {
  return {
    paymentId: p._id,
    status: p.status,
    grossCents: p.grossCents,
    retainageCents: p.retainageCents,
    netCents: p.netCents,
    paypalPayoutBatchId: p.paypalPayoutBatchId ?? null,
    paypalPayoutItemId: p.paypalPayoutItemId ?? null,
    paypalItemStatus: p.paypalItemStatus ?? null,
    receiverEmail: showReceiver ? (p.receiverEmail ?? null) : null,
    error: p.error ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt ?? p.createdAt,
    retryOfPaymentId: p.retryOfPaymentId ?? null,
    captured: retry?.captured ?? false,
    canRetryPayout: retry?.canRetryPayout ?? false,
  };
}

/** Payments workspace list: the GC sees its projects' live agreements, a sub only its own vendor's. */
export const listLedgerAgreements = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc", "sub"]);
    const { rows } = await scopedAgreements(ctx, { parties: ["gc", "sub"], limit: 200 });
    return rows.filter((r) => r.agreement.status !== "superseded").map((r) => ledgerAgreementSummary(r.agreement));
  },
});

/**
 * One agreement's ledger. Returns null both when the agreement does not exist and when the caller
 * may not see it (another company, another sub's agreement), so ids cannot be probed.
 */
export const getAgreementLedger = query({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const scope = await findDocScope(ctx, "agreements", args.agreementId);
    if (scope === null) return null;
    const agreement = scope.doc;
    const id = agreement._id;
    const viewer = scope.viewer;

    const sov = await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", id))
      .take(500);
    const milestones = await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", id))
      .take(50);
    const billing = await loadBillingHistory(ctx, id);
    const history = await loadAgreementHistory(ctx, id);
    const { payments, retainage, changeOrders } = history;

    const summary = ledgerAgreementSummary(agreement);
    // Latest funding attempt per milestone (payments come back in creation order).
    const latestFunding = new Map<string, Doc<"payments">>();
    for (const p of payments) if (p.kind === "funding" && p.milestoneId) latestFunding.set(p.milestoneId, p);
    const releasesByMilestone = new Map<string, Doc<"payments">[]>();
    for (const p of payments) {
      if (p.kind !== "payout" || !p.milestoneId) continue;
      releasesByMilestone.set(p.milestoneId, [...(releasesByMilestone.get(p.milestoneId) ?? []), p]);
    }
    const isGc = viewer.role === "gc";
    const retainageReleases = payments.filter((p) => p.kind === "retainage_release");
    const totals = computeLedgerTotals({
      contractSumCents: summary.contractSumCents,
      payApps: billing.rows,
      payments,
      retainage,
      changeOrders,
    });
    const capturedReleaseIds = new Set<string>();
    for (const p of payments) {
      for (const c of p.captures ?? []) if (c.releasePaymentId && isCaptureCollected(c.status)) capturedReleaseIds.add(c.releasePaymentId);
    }
    const payouts = payments.filter((p) => p.kind === "payout");
    const retryInfo = (p: Doc<"payments">) => {
      const rootId = p.retryOfPaymentId ?? p._id;
      const captured = capturedReleaseIds.has(rootId);
      const attempts = attemptsFor(payouts, rootId);
      // Only the latest attempt of a release offers "Retry payout".
      const latest = attempts[attempts.length - 1];
      return { captured, canRetryPayout: isGc && latest?._id === p._id && checkRetry(attempts, rootId, captured).ok };
    };
    return {
      agreement: summary,
      canFund: isGc,
      canRelease: isGc,
      canReleaseRetainage: isGc,
      retainageReleasedCents: totals.retainageReleasedCents,
      retainageReleasableCents: releasableRetainageCents(payments, retainage),
      balanceFormula: BALANCE_FORMULA,
      // Approved pay apps whose final amount is unknown are left out of billed; listed so it is not silent.
      billingAttention: [
        ...billing.unresolved.map(unresolvedApprovalMessage),
        ...(history.truncated ? [HISTORY_TRUNCATED_MESSAGE] : []),
      ],
      historyTruncated: history.truncated,
      retainageReleases: retainageReleases.map((p) => releaseSummary(p, isGc || viewer.role === "sub")),
      retainageLedger: retainage.map((r) => ({
        _id: r._id,
        deltaCents: r.deltaCents,
        reason: r.reason,
        paymentId: r.paymentId ?? null,
        createdAt: r.createdAt,
      })),
      sov: sov.map((line) => ({
        _id: line._id,
        lineNo: line.lineNo,
        description: line.description,
        csiCode: line.csiCode ?? null,
        scheduledValueCents: line.scheduledValueCents,
        excludedScope: line.excludedScope,
      })),
      sovTotalCents: sov.reduce((acc, line) => acc + line.scheduledValueCents, 0),
      milestones: milestones.map((m) => ({
        _id: m._id,
        name: m.name,
        order: m.order,
        plannedDate: m.plannedDate,
        amountCents: m.amountCents,
        status: m.status,
        funding: fundingSummary(latestFunding.get(m._id)),
        releases: (releasesByMilestone.get(m._id) ?? []).map((p) => releaseSummary(p, isGc || viewer.role === "sub", retryInfo(p))),
      })),
      totals,
    };
  },
});
