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
import { bpsToPercent } from "../lib/money";
import { attemptsFor, checkRetry } from "./payoutRetryMath";
import { retainageBpsAtProgress, retainagePercentFor } from "./payoutMath";
import { releasableRetainageCents } from "./retainageMath";
import { agreementContractSum } from "../billing/changeOrderView";
import type { ContractSumBreakdown } from "./changeOrderMath";
import { loadSovRows } from "../lib/sovLines";
import { loadTranches } from "../lib/trancheRows";
import { isReadOnlyReference } from "../lib/demoReference";
import { payoutReceiverForContractorReadOnly } from "../lib/payee";
import { agreementLedgerValidator, ledgerAgreementValidator } from "./ledgerValidators";
import { projectKindOf, type ProjectKind } from "../lib/projectKind";

/** contractSumCents is the contract sum to date (original plus approved change orders). */
function ledgerAgreementSummary(a: Doc<"agreements">, sum: ContractSumBreakdown, billedCents = 0, projectKind: ProjectKind = "commercial") {
  const basePercent = retainagePercentFor(a);
  // The rate that applies to the next application: the base rate, or the reduced rate once approved
  // billing has reached half the contract sum. Shown next to the base so "10%" is never mistaken for
  // the rate actually withheld after the reduction.
  const appliedPercent = bpsToPercent(retainageBpsAtProgress(a, billedCents, sum.toDateCents));
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
    retainagePercent: basePercent,
    retainagePercentApplied: appliedPercent,
    retainageReductionBpsAt50: a.terms?.retainageReductionBpsAt50 ?? null,
    contractSumCents: sum.toDateCents,
    originalContractSumCents: sum.originalCents,
    netChangeOrdersCents: sum.netChangeCents,
    excludedScopeNotes: a.excludedScopeNotes ?? [],
    executedAt: a.executedAt ?? null,
    projectKind,
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

function releaseSummary(p: Doc<"payments">, showReceiver: boolean, retry?: { captured: boolean; canRetryPayout: boolean }, captureId?: string) {
  return {
    paymentId: p._id,
    status: p.status,
    grossCents: p.grossCents,
    retainageCents: p.retainageCents,
    netCents: p.netCents,
    paypalCaptureId: p.paypalCaptureId ?? captureId ?? null,
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
  returns: v.array(ledgerAgreementValidator),
  handler: async (ctx) => {
    await requireRole(ctx, ["gc", "sub"]);
    const { rows } = await scopedAgreements(ctx, { parties: ["gc", "sub"], limit: 200 });
    const live = rows.filter((r) => r.agreement.status !== "superseded");
    return await Promise.all(
      live.map(async (r) =>
        ledgerAgreementSummary(r.agreement, await agreementContractSum(ctx, r.agreement), 0, projectKindOf(r.access.project)),
      ),
    );
  },
});

/**
 * One agreement's ledger. Returns null both when the agreement does not exist and when the caller
 * may not see it (another company, another sub's agreement), so ids cannot be probed. Owner
 * accounts get "Not found." for every id.
 */
export const getAgreementLedger = query({
  args: { agreementId: v.string() },
  returns: agreementLedgerValidator,
  handler: async (ctx, args) => {
    const scope = await findDocScope(ctx, "agreements", args.agreementId, { roles: ["gc", "sub"] });
    if (scope === null) return null;
    const agreement = scope.doc;
    const id = agreement._id;
    const viewer = scope.viewer;

    const sov = await loadSovRows(ctx, id);
    const milestones = await loadTranches(ctx, id);
    const billing = await loadBillingHistory(ctx, id);
    const history = await loadAgreementHistory(ctx, id);
    const { payments, retainage, changeOrders } = history;

    const sum = await agreementContractSum(ctx, agreement);
    // Latest funding attempt per milestone (payments come back in creation order).
    const latestFunding = new Map<string, Doc<"payments">>();
    for (const p of payments) if (p.kind === "funding" && p.milestoneId) latestFunding.set(p.milestoneId, p);
    const releasesByMilestone = new Map<string, Doc<"payments">[]>();
    for (const p of payments) {
      if (p.kind !== "payout" || !p.milestoneId) continue;
      releasesByMilestone.set(p.milestoneId, [...(releasesByMilestone.get(p.milestoneId) ?? []), p]);
    }
    const isGc = viewer.role === "gc";
    const readOnlyReference = isReadOnlyReference(scope.project);
    const canWrite = isGc && !readOnlyReference;
    const receiver = await payoutReceiverForContractorReadOnly(ctx, agreement.contractorId);
    const bid = await ctx.db.get(agreement.bidId);
    const retainageReleases = payments.filter((p) => p.kind === "retainage_release");
    const totals = computeLedgerTotals({
      contractSumCents: sum.toDateCents,
      payApps: billing.rows,
      payments,
      retainage,
      // Change-order invoices are between the GC and the owner; a sub's ledger never counts them.
      changeOrders: isGc ? changeOrders : [],
    });
    const summary = ledgerAgreementSummary(agreement, sum, totals.billedCents, projectKindOf(scope.project));
    const capturedReleaseIds = new Set<string>();
    const captureByRelease = new Map<string, string>();
    for (const p of payments) {
      for (const c of p.captures ?? []) if (c.releasePaymentId) {
        captureByRelease.set(c.releasePaymentId, c.captureId);
        if (isCaptureCollected(c.status)) capturedReleaseIds.add(c.releasePaymentId);
      }
    }
    const payouts = payments.filter((p) => p.kind === "payout");
    const paymentById = new Map<string, Doc<"payments">>(payments.map((p) => [p._id, p]));
    const retryInfo = (p: Doc<"payments">) => {
      const rootId = p.retryOfPaymentId ?? p._id;
      const captured = capturedReleaseIds.has(rootId);
      const attempts = attemptsFor(payouts, rootId);
      // Only the latest attempt of a release offers "Retry payout".
      const latest = attempts[attempts.length - 1];
      return { captured, canRetryPayout: canWrite && latest?._id === p._id && checkRetry(attempts, rootId, captured).ok };
    };
    return {
      agreement: summary,
      readOnlyReference,
      canViewReviews: isGc,
      canFund: canWrite,
      canRelease: canWrite,
      canReleaseRetainage: canWrite,
      excludedScopeEstimates: (bid?.identifiedExclusions ?? []).map((e) => ({
        description: e.description, amountCents: e.costImpactCents ?? null,
      })),
      retainageReleasedCents: totals.retainageReleasedCents,
      retainageReleasableCents: releasableRetainageCents(payments, retainage),
      retainagePayeeEmail:
        receiver.ok
          ? receiver.email
          : ([...retainageReleases].reverse().find((p) => p.receiverEmail !== undefined)?.receiverEmail ?? null),
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
        payAppId: (r.paymentId ? paymentById.get(r.paymentId)?.payAppId : undefined) ?? null,
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
        releases: (releasesByMilestone.get(m._id) ?? []).map((p) => releaseSummary(p, isGc || viewer.role === "sub", retryInfo(p), captureByRelease.get(p.retryOfPaymentId ?? p._id))),
      })),
      totals,
    };
  },
});
