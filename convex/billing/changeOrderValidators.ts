import { v } from "convex/values";
import { changeOrderScopeValidator, changeOrderStatusValidator } from "../schema";
const ns = v.union(v.string(), v.null());
const nn = v.union(v.number(), v.null());
export const coPartyValidator = v.union(v.literal("gc"), v.literal("sub"), v.literal("owner"));
export const contractSumValidator = v.object({
  originalCents: v.number(), additionsCents: v.number(), deductionsCents: v.number(), netChangeCents: v.number(), toDateCents: v.number(),
});
export const changeOrderRowValidator = v.object({
  _id: v.id("changeOrders"), scope: changeOrderScopeValidator, number: v.number(), label: v.string(), title: v.string(), description: v.string(),
  amountCents: v.number(), scheduleDays: nn, status: changeOrderStatusValidator, projectId: v.union(v.id("projects"), v.null()),
  agreementId: v.union(v.id("agreements"), v.null()), agreementNumber: ns, subcontractorName: ns,
  requestedByParty: v.union(v.literal("gc"), v.literal("sub")), rejectionReason: ns, sovLineId: v.union(v.id("scheduleOfValues"), v.null()),
  sovLineNo: nn, linkedChangeOrderId: v.union(v.id("changeOrders"), v.null()), linkedLabel: ns,
  createdAt: v.number(), submittedAt: nn, approvedAt: nn, rejectedAt: nn, judgeDemoApproval: ns,
  paypalInvoiceId: ns, paypalInvoiceStatus: ns, payerViewUrl: ns, recipientEmail: ns, error: ns,
  invoicedAt: nn, paidAt: nn, editBlockedReason: ns, canEdit: v.boolean(), canDelete: v.boolean(), canSubmit: v.boolean(),
  canWithdraw: v.boolean(), canApprove: v.boolean(), canReject: v.boolean(),
  invoice: v.object({ show: v.boolean(), enabled: v.boolean(), reason: ns }), canRefresh: v.boolean(),
});
export const changeOrderDetailValidator = changeOrderRowValidator.extend({
  approvalPreview: v.union(v.null(), v.object({
    lineNo: v.number(), contractSumToDateCents: v.number(), contractSumAfterCents: v.number(), floorProblem: ns, sovProblem: ns, message: v.string(),
  })),
});
export const projectChangeOrdersValidator = v.object({
  projectId: v.id("projects"), projectTitle: v.string(), party: coPartyValidator,
  invoicing: v.union(v.null(), v.object({ enabled: v.boolean(), reason: ns, recipientEmail: ns })),
  agreements: v.array(v.object({
    agreementId: v.id("agreements"), agreementNumber: v.string(), subcontractorName: v.string(), tradeName: v.string(),
    executed: v.boolean(), sovApproved: v.boolean(), contractSum: contractSumValidator, breakdownText: v.string(),
    canCreate: v.boolean(), changeOrders: v.array(changeOrderRowValidator),
  })),
  prime: v.union(v.null(), v.object({ contractSum: v.union(contractSumValidator, v.null()), canCreate: v.boolean(), changeOrders: v.array(changeOrderRowValidator) })),
});
export const agreementChangeOrdersValidator = v.union(v.null(), v.object({
  agreementId: v.id("agreements"), projectId: v.id("projects"), party: coPartyValidator,
  contractSum: contractSumValidator, breakdownText: v.string(), canCreate: v.boolean(), changeOrders: v.array(changeOrderRowValidator),
}));
