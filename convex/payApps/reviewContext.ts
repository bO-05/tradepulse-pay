import type { Doc } from "../_generated/dataModel";
import { agreementContractSumCents } from "../payments/sov";
import { retainagePercentFor } from "../payments/payoutMath";
import { buildReviewLines, type ReviewContext } from "./reviewMath";
import { APPROVED_PAY_APP_STATUSES, approvedTotalFor, sovBaselineByLine } from "./validation";

/**
 * Assembles what the reviewer sees from stored rows. Only pay apps created
 * before this one count as prior billing, so re-running a review gives the
 * same previously billed amounts.
 */
export function buildReviewContext(input: {
  payApp: Doc<"payApplications">;
  agreement: Doc<"agreements">;
  sov: readonly Doc<"scheduleOfValues">[];
  milestones: readonly Doc<"milestones">[];
  agreementPayApps: readonly Doc<"payApplications">[];
  license: Doc<"licenseChecks"> | null;
  gcCompanyName?: string | null;
}): ReviewContext {
  const { payApp, agreement } = input;
  const earlier = input.agreementPayApps.filter(
    (p) => p._id !== payApp._id && (p.createdAt < payApp.createdAt || (p.createdAt === payApp.createdAt && p._creationTime < payApp._creationTime)),
  );
  const prior = sovBaselineByLine(earlier, input.sov);
  const milestones = [...input.milestones].sort((a, b) => a.order - b.order);
  return {
    gcCompanyName: input.gcCompanyName ?? null,
    agreement: {
      agreementNumber: agreement.agreementNumber,
      subcontractorName: agreement.subcontractorName,
      projectTitle: agreement.projectTitle,
      csiDivision: agreement.csiDivision,
      tradeName: agreement.tradeName,
      contractSumCents: agreementContractSumCents(agreement),
      retainagePercent: retainagePercentFor(agreement),
      scopeSummary: agreement.scopeSummary,
      mandatoryInclusions: agreement.mandatoryInclusions,
      excludedScopeNotes: agreement.excludedScopeNotes ?? [],
    },
    milestones: milestones.map((m) => ({ name: m.name, order: m.order, status: m.status, amountCents: m.amountCents })),
    priorPayApps: earlier.map((p) => ({
      periodLabel: p.periodLabel,
      status: p.status,
      requestedTotalCents: p.requestedTotalCents,
      approvedTotalCents: APPROVED_PAY_APP_STATUSES.has(p.status) ? approvedTotalFor(p) : (p.review?.approvedTotalCents ?? null),
    })),
    license: input.license
      ? {
          licenseNumber: input.license.licenseNumber,
          status: input.license.status,
          checkedAt: input.license.checkedAt,
          summary: input.license.rawSummary.slice(0, 500),
        }
      : null,
    payApp: {
      periodLabel: payApp.periodLabel,
      notes: payApp.notes,
      lienWaiver: payApp.lienWaiver,
      requestedTotalCents: payApp.requestedTotalCents,
    },
    lines: buildReviewLines({
      sov: input.sov.map((s) => ({
        _id: s._id,
        lineNo: s.lineNo,
        description: s.description,
        excludedScope: s.excludedScope,
        scheduledValueCents: s.scheduledValueCents,
      })),
      milestones: milestones.map((m) => ({
        milestoneId: m._id,
        name: m.name,
        order: m.order,
        status: m.status,
        amountCents: m.amountCents,
        sovLineIds: m.sovLineIds,
      })),
      prior,
      lines: payApp.lines,
    }),
  };
}
