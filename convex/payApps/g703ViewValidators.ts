import { v } from "convex/values";
import { projectKindValidator } from "../lib/projectKind";
import { actorTypeValidator, g702FiguresValidator, payAppDecisionValidator, payAppReviewValidator, payAppStatusValidator, roleValidator } from "../schema";

const ns = v.union(v.string(), v.null());
const nn = v.union(v.number(), v.null());
const summary = g702FiguresValidator.extend({
  scheduledValueCents: v.number(), previousWorkCents: v.number(), workThisPeriodCents: v.number(),
  storedCents: v.number(), balanceToFinishCents: v.number(),
});
const line = v.object({
  sovLineId: v.id("scheduleOfValues"), lineNo: v.number(), description: v.string(), csiCode: ns,
  scheduledValueCents: v.number(), retainageBps: v.number(), previousWorkCents: v.number(),
  previousStoredCents: v.number(), pendingCents: v.number(), workThisPeriodCents: v.number(), storedCents: v.number(),
  previousRetainageCents: v.optional(v.number()),
  note: ns, requestedWorkCents: nn, requestedStoredCents: nn,
});
const decision = v.union(v.null(), v.object({
  outcome: payAppDecisionValidator.fields.outcome, reason: ns, decidedAt: v.number(), decidedByName: v.string(),
  lines: v.array(v.object({
    sovLineId: v.id("scheduleOfValues"), lineNo: v.number(), description: v.string(),
    action: v.union(v.literal("accept"), v.literal("override"), v.literal("revise")),
    recommendedCents: nn, approvedCents: v.number(), reason: ns,
  })),
}));
export const g703ViewValidator = v.object({
  _id: v.id("payApplications"), format: v.union(v.literal("g703"), v.literal("legacy")), viewerRole: roleValidator,
  projectKind: projectKindValidator,
  status: payAppStatusValidator, applicationNo: nn, periodLabel: v.string(), periodStart: ns, periodEnd: ns, dueDate: ns,
  savedAt: nn, submittedAt: nn, notes: v.string(), submittedBy: v.object({ actorType: actorTypeValidator, isCaller: v.boolean() }),
  rejectionReason: ns, withdrawnAt: nn,
  agreement: v.object({ _id: v.id("agreements"), agreementNumber: v.string(), projectTitle: v.string(), subcontractorName: v.string() }),
  basis: v.union(v.literal("approved"), v.literal("requested"), v.literal("unverified")),
  unverifiedReason: ns, retainageBps: v.number(), lines: v.array(line), summary,
  requestedSummary: v.union(summary, v.null()),
  approvalHistory: v.object({
    submittedAt: nn, reviewedAt: nn, approvedAt: nn, approvedBy: ns, requestedGrossCents: v.number(),
    approvedGrossCents: nn, reason: ns,
  }),
  lineErrors: v.array(v.object({ sovLineId: v.string(), message: v.string() })),
  editable: v.boolean(), canSubmit: v.boolean(), canWithdraw: v.boolean(), canRevise: v.boolean(),
  canApprove: v.boolean(), canRequestRevision: v.boolean(), canReject: v.boolean(), canDiscard: v.boolean(),
  version: v.number(),
  versions: v.array(v.object({
    version: v.number(), current: v.boolean(), submittedAt: nn, requestedTotalCents: v.number(), currentPaymentDueCents: nn,
    outcome: v.union(payAppDecisionValidator.fields.outcome, v.null()), reason: ns,
    lines: v.array(v.object({
      sovLineId: v.id("scheduleOfValues"), lineNo: v.number(), description: v.string(), workThisPeriodCents: v.number(), storedCents: v.number(), note: ns,
    })),
    changes: v.array(v.object({
      sovLineId: v.string(), lineNo: v.number(), field: v.union(v.literal("E"), v.literal("F"), v.literal("note")),
      from: v.union(v.number(), v.string()), to: v.union(v.number(), v.string()),
    })),
  })),
  decision, revisionRequest: decision,
  // The review's suggested gross is visible to both parties (the sub needs the benchmark the GC
  // cut against); the per-line review detail and model internals stay GC-only in `review`.
  reviewSuggestedTotalCents: nn,
  review: v.union(v.null(), v.object({
    engine: v.string(), provider: v.string(), model: v.string(), fallbackReason: ns,
    reviewedAt: v.number(), approvedTotalCents: v.number(), flags: payAppReviewValidator.fields.flags,
    lines: v.array(v.object({
      sovLineId: v.id("scheduleOfValues"), lineNo: v.number(), description: v.string(),
      verdict: payAppReviewValidator.fields.lines.element.fields.verdict,
      recommendedPctToDate: v.number(), approvedCents: v.number(), requestedCents: v.number(), reason: v.string(),
    })),
  })),
  excludedScopeNotes: v.array(v.string()),
  changeOrders: v.array(v.object({
    _id: v.id("changeOrders"), label: v.string(), title: v.string(), amountCents: v.number(), approvedAt: nn, thisPeriod: v.boolean(),
  })),
});

const listRow = v.object({
  _id: v.id("payApplications"), applicationNo: nn, periodLabel: v.string(), periodEnd: ns, dueDate: ns,
  status: payAppStatusValidator, currentPaymentDueCents: nn, requestedTotalCents: v.number(), submittedAt: nn,
});
export const subPayAppAgreementsValidator = v.array(v.object({
  agreementId: v.id("agreements"), agreementNumber: v.string(), projectTitle: v.string(), projectKind: projectKindValidator, tradeName: v.string(),
  contractSumCents: v.number(), sovApproved: v.boolean(), blockedReason: ns, openPayApp: v.union(listRow, v.null()),
  nextApplication: v.union(v.null(), v.object({ applicationNo: v.number(), periodStart: v.string(), periodEnd: v.string(), dueDate: v.string() })),
  payApps: v.array(listRow),
}));
