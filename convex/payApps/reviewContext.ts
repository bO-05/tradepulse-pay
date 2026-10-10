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
  const g703Notes = new Map((payApp.g703?.lines ?? []).map((l) => [l.sovLineId as string, l.note]));
  const billed = new Set(payApp.lines.map((l) => l.sovLineId as string));
  const sovById = new Map(input.sov.map((s) => [s._id as string, s]));
  const unbilledLines = (payApp.g703?.lines ?? []).flatMap((l) => {
    const s = sovById.get(l.sovLineId);
    if (!s || billed.has(l.sovLineId)) return [];
    return [{ sovLineId: s._id as string, lineNo: s.lineNo, previousPctToDate: (prior.get(s._id)?.previousPctToDate ?? 0) / 100 }];
  });
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
    tranches: milestones.map((m) => ({
      name: m.name,
      order: m.order,
      status: m.status,
      amountCents: m.amountCents,
      coversLineNos: m.sovLineIds.flatMap((id) => sovById.get(id)?.lineNo ?? []).sort((a, b) => a - b),
    })),
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
      lines: payApp.lines.map((l) => ({ ...l, note: g703Notes.get(l.sovLineId) ?? null })),
    }),
    unbilledLines: unbilledLines.sort((a, b) => a.lineNo - b.lineNo),
  };
}
