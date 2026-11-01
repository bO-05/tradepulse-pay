import { v } from "convex/values";
import {
  actorTypeValidator, licenseStatusValidator, lineVerdictValidator, payAppReviewValidator,
  payAppStatusValidator, paymentStatusValidator, proposalKindValidator, proposalStatusValidator,
} from "../schema";

const nullableString = v.union(v.string(), v.null());
const nullableNumber = v.union(v.number(), v.null());

/** Explicit client projection, not a stored pay-application document or internal trace. */
export const payAppViewValidator = v.object({
  _id: v.id("payApplications"),
  agreementId: v.id("agreements"),
  periodLabel: v.string(),
  status: payAppStatusValidator,
  requestedTotalCents: v.number(),
  lienWaiver: v.boolean(),
  notes: v.string(),
  createdAt: v.number(),
  finalApproval: v.union(v.object({ totalCents: v.number(), approvedAt: v.number() }), v.null()),
  rejectedAt: nullableNumber,
  rejectionReason: nullableString,
  submittedBy: v.object({ actorType: actorTypeValidator, agentEmail: nullableString, onBehalfOf: nullableString, userEmail: nullableString }),
  judgeDemoFiledBy: nullableString,
  lines: v.array(v.object({
    sovLineId: v.id("scheduleOfValues"), lineNo: v.number(), description: v.string(),
    excludedScope: v.boolean(), scheduledValueCents: v.number(), pctCompleteThisPeriod: v.number(),
    pctCompleteToDate: v.number(), requestedCents: v.number(), finalApprovedCents: nullableNumber,
    review: v.union(v.object({
      verdict: lineVerdictValidator, recommendedPctToDate: v.number(), approvedCents: v.number(), reason: v.string(),
    }), v.null()),
  })),
  review: v.union(v.object({
    engine: v.string(), provider: v.string(), model: v.string(), fallbackReason: nullableString,
    flags: payAppReviewValidator.fields.flags, approvedTotalCents: v.number(), traceRunId: nullableString, reviewedAt: v.number(),
  }), v.null()),
});

export const inboxItemValidator = v.object({
  payApp: payAppViewValidator,
  agreement: v.object({
    _id: v.id("agreements"), agreementNumber: v.string(), projectTitle: v.string(), subcontractorName: v.string(),
    contractorId: v.id("contractors"), retainagePercent: v.number(),
  }),
  contractor: v.object({ companyName: v.string(), licenseNumber: v.string() }),
  license: v.union(v.object({ status: licenseStatusValidator, checkedAt: v.number(), checkId: v.id("licenseChecks") }), v.null()),
  proposals: v.array(v.object({
    _id: v.id("agentProposals"), kind: proposalKindValidator, status: proposalStatusValidator, source: v.string(),
    amountCents: nullableNumber, editedAmountCents: nullableNumber,
    split: v.union(v.object({ grossCents: v.number(), retainageCents: v.number(), netCents: v.number() }), v.null()),
    rationale: v.string(), flags: v.array(v.string()), licenseStatus: nullableString, milestoneName: nullableString,
    decidedAt: nullableNumber, executedAt: nullableNumber, paypalCaptureId: nullableString, error: nullableString,
    overrideLicenseHold: v.boolean(), createdAt: v.number(),
  })),
  payment: v.union(v.object({
    status: paymentStatusValidator, grossCents: v.number(), retainageCents: v.number(), netCents: v.number(),
    batchId: nullableString, receiverEmail: nullableString, error: nullableString,
  }), v.null()),
});
