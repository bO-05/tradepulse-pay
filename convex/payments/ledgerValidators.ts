import { v } from "convex/values";
import { milestoneStatusValidator, paymentStatusValidator } from "../schema";

const nullableString = v.union(v.string(), v.null());
const nullableNumber = v.union(v.number(), v.null());
export const ledgerAgreementValidator = v.object({
  _id: v.id("agreements"), agreementNumber: v.string(), projectId: v.id("projects"),
  projectTitle: v.string(), subcontractorName: v.string(), contractorId: v.id("contractors"),
  csiDivision: v.string(), tradeName: v.string(), status: v.string(), retainagePercent: v.number(),
  retainagePercentApplied: v.number(), retainageReductionBpsAt50: nullableNumber,
  contractSumCents: v.number(), originalContractSumCents: v.number(), netChangeOrdersCents: v.number(),
  excludedScopeNotes: v.array(v.string()), executedAt: nullableNumber,
  projectKind: v.union(v.literal("residential"), v.literal("commercial")),
});
const fundingValidator = v.union(v.null(), v.object({
  paymentId: v.id("payments"), status: paymentStatusValidator, grossCents: v.number(),
  paypalOrderId: nullableString, paypalAuthorizationId: nullableString, authorizationExpiresAt: nullableNumber,
  honorPeriodEndsAt: nullableNumber, capturedCents: v.number(), captureCount: v.number(),
  reauthorizationCount: v.number(), reauthorizeError: nullableString, error: nullableString,
}));
const releaseValidator = v.object({
  paymentId: v.id("payments"), status: paymentStatusValidator, grossCents: v.number(), retainageCents: v.number(),
  netCents: v.number(), paypalCaptureId: nullableString, paypalPayoutBatchId: nullableString, paypalPayoutItemId: nullableString,
  paypalItemStatus: nullableString, receiverEmail: nullableString, error: nullableString,
  createdAt: v.number(), updatedAt: v.number(), retryOfPaymentId: v.union(v.id("payments"), v.null()),
  captured: v.boolean(), canRetryPayout: v.boolean(),
});
export const ledgerTotalsValidator = v.object({
  contractSumCents: v.number(), billedCents: v.number(), fundedCents: v.number(), capturedCents: v.number(),
  capturedNotPaidCents: v.number(), paidCents: v.number(), retainageHeldCents: v.number(),
  retainageReleasedCents: v.number(), changeOrdersInvoicedCents: v.number(), changeOrdersPaidCents: v.number(),
  balanceCents: v.number(),
});
export const agreementLedgerValidator = v.union(v.null(), v.object({
  agreement: ledgerAgreementValidator, readOnlyReference: v.boolean(), canViewReviews: v.boolean(),
  canFund: v.boolean(), canRelease: v.boolean(), canReleaseRetainage: v.boolean(),
  retainageReleasedCents: v.number(), retainageReleasableCents: v.number(), retainagePayeeEmail: nullableString, balanceFormula: v.string(),
  billingAttention: v.array(v.string()), historyTruncated: v.boolean(),
  excludedScopeEstimates: v.array(v.object({ description: v.string(), amountCents: nullableNumber })),
  retainageReleases: v.array(releaseValidator),
  retainageLedger: v.array(v.object({
    _id: v.id("retainageLedger"), deltaCents: v.number(), reason: v.string(),
    paymentId: v.union(v.id("payments"), v.null()), payAppId: v.union(v.id("payApplications"), v.null()), createdAt: v.number(),
  })),
  sov: v.array(v.object({
    _id: v.id("scheduleOfValues"), lineNo: v.number(), description: v.string(), csiCode: nullableString,
    scheduledValueCents: v.number(), excludedScope: v.boolean(),
  })),
  sovTotalCents: v.number(),
  milestones: v.array(v.object({
    _id: v.id("milestones"), name: v.string(), order: v.number(), plannedDate: v.number(),
    amountCents: v.number(), status: milestoneStatusValidator, funding: fundingValidator, releases: v.array(releaseValidator),
  })),
  totals: ledgerTotalsValidator,
}));
