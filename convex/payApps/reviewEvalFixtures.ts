/**
 * Pay-app review eval fixtures: one Div 26 agreement whose Mobilization is
 * complete and Rough-in is under way (milestones support 30% on base lines),
 * billed four ways. Each fixture lists the verdict expected on every line.
 */
import { buildReviewLines, type LineVerdict, type ReviewContext, type ReviewMilestone } from "./reviewMath";

const SOV = [
  { _id: "fx-sov-1", lineNo: 1, description: "1600A main switchboard & transformers", excludedScope: false, scheduledValueCents: 34_000_000 },
  { _id: "fx-sov-2", lineNo: 2, description: "Branch conduit & wire feeder runs", excludedScope: false, scheduledValueCents: 30_000_000 },
  { _id: "fx-sov-3", lineNo: 3, description: "Grounding & bonding system", excludedScope: false, scheduledValueCents: 16_000_000 },
  { _id: "fx-sov-4", lineNo: 4, description: "Closeout: testing, commissioning & O&M manuals", excludedScope: false, scheduledValueCents: 5_000_000 },
  {
    _id: "fx-sov-5",
    lineNo: 5,
    description: "Excluded scope: IBC Section 1613 engineered seismic bracing (by others)",
    excludedScope: true,
    scheduledValueCents: 5_500_000,
  },
];
const BASE_IDS = SOV.filter((s) => !s.excludedScope).map((s) => s._id);
const CONTRACT_SUM_CENTS = SOV.reduce((a, s) => a + s.scheduledValueCents, 0);
const MILESTONES: ReviewMilestone[] = [
  { milestoneId: "fx-ms-1", name: "Mobilization", order: 1, status: "complete", amountCents: 9_050_000, sovLineIds: BASE_IDS },
  { milestoneId: "fx-ms-2", name: "Rough-in", order: 2, status: "in_progress", amountCents: 36_200_000, sovLineIds: BASE_IDS },
  { milestoneId: "fx-ms-3", name: "Trim-out", order: 3, status: "planned", amountCents: 31_675_000, sovLineIds: BASE_IDS },
  { milestoneId: "fx-ms-4", name: "Closeout", order: 4, status: "planned", amountCents: 13_575_000, sovLineIds: BASE_IDS },
];
/** Line 1 and 2 were each billed 10% on the previous pay app. */
const PRIOR = new Map([
  ["fx-sov-1", { billedCents: 3_400_000, pctToDate: 10 }],
  ["fx-sov-2", { billedCents: 3_000_000, pctToDate: 10 }],
]);

type FixtureLine = { sovLineId: string; pctToDate: number; requestedCents?: number };

function fixtureContext(lines: FixtureLine[], opts: { lienWaiver: boolean; notes: string }): ReviewContext {
  const submitted = lines.map((l) => {
    const sov = SOV.find((s) => s._id === l.sovLineId)!;
    const prior = PRIOR.get(l.sovLineId) ?? { billedCents: 0, pctToDate: 0 };
    const requestedCents = l.requestedCents ?? Math.max(0, Math.round((sov.scheduledValueCents * l.pctToDate) / 100) - prior.billedCents);
    return {
      sovLineId: l.sovLineId,
      pctCompleteThisPeriod: Math.max(0, l.pctToDate - prior.pctToDate),
      pctCompleteToDate: l.pctToDate,
      requestedCents,
    };
  });
  return {
    agreement: {
      agreementNumber: "A401-EVAL-PAYREVIEW",
      subcontractorName: "Eval Electrical Subcontractor (demo)",
      projectTitle: "Eval project (demo)",
      csiDivision: "26 00 00",
      tradeName: "Electrical & Lighting Systems",
      contractSumCents: CONTRACT_SUM_CENTS,
      retainagePercent: 10,
      scopeSummary: "Furnish and install complete Div 26 electrical distribution; seismic bracing excluded by the sub.",
      mandatoryInclusions: ["Temporary power", "Crane hoisting"],
    },
    milestones: MILESTONES.map(({ name, order, status, amountCents }) => ({ name, order, status, amountCents })),
    priorPayApps: [
      { periodLabel: "Pay app #1 (demo)", status: "approved", requestedTotalCents: 6_400_000, approvedTotalCents: 6_400_000 },
    ],
    license: { licenseNumber: "DEMO-1042", status: "active", checkedAt: 0, summary: "Demo license record: active." },
    payApp: {
      periodLabel: "Pay app #2 (eval)",
      notes: opts.notes,
      lienWaiver: opts.lienWaiver,
      requestedTotalCents: submitted.reduce((a, l) => a + l.requestedCents, 0),
    },
    lines: buildReviewLines({ sov: SOV, milestones: MILESTONES, prior: PRIOR, lines: submitted }),
  };
}

export type PayAppReviewFixture = {
  fixtureId: string;
  description: string;
  context: ReviewContext;
  expected: Record<string, LineVerdict>;
  /** Lines whose approved amount must be exactly 0. */
  expectZeroApproved: string[];
};

export const PAY_APP_REVIEW_FIXTURES: PayAppReviewFixture[] = [
  {
    fixtureId: "payapp_honest",
    description: "Every line billed within the 30% the milestones support, in proportion.",
    context: fixtureContext(
      [
        { sovLineId: "fx-sov-1", pctToDate: 25 },
        { sovLineId: "fx-sov-2", pctToDate: 22 },
        { sovLineId: "fx-sov-3", pctToDate: 20 },
      ],
      { lienWaiver: true, notes: "Switchgear set, feeders pulled on levels 1-3, grounding grid in progress." },
    ),
    expected: { "fx-sov-1": "ok", "fx-sov-2": "ok", "fx-sov-3": "ok" },
    expectZeroApproved: [],
  },
  {
    fixtureId: "payapp_overbilled",
    description: "Branch conduit claims 60% to date while the milestones support 30%.",
    context: fixtureContext(
      [
        { sovLineId: "fx-sov-1", pctToDate: 25 },
        { sovLineId: "fx-sov-2", pctToDate: 60 },
        { sovLineId: "fx-sov-3", pctToDate: 20 },
      ],
      { lienWaiver: true, notes: "Conduit runs progressing." },
    ),
    expected: { "fx-sov-1": "ok", "fx-sov-2": "overbilled", "fx-sov-3": "ok" },
    expectZeroApproved: [],
  },
  {
    fixtureId: "payapp_excluded_scope",
    description: "Bills the seismic bracing line, which the sub excluded in its leveled bid.",
    context: fixtureContext(
      [
        { sovLineId: "fx-sov-1", pctToDate: 25 },
        { sovLineId: "fx-sov-2", pctToDate: 22 },
        { sovLineId: "fx-sov-3", pctToDate: 20 },
        { sovLineId: "fx-sov-5", pctToDate: 40, requestedCents: 2_000_000 },
      ],
      { lienWaiver: true, notes: "Seismic bracing installed at level 2." },
    ),
    expected: { "fx-sov-1": "ok", "fx-sov-2": "ok", "fx-sov-3": "ok", "fx-sov-5": "excluded_scope" },
    expectZeroApproved: ["fx-sov-5"],
  },
  {
    fixtureId: "payapp_front_loaded",
    description: "Grounding claims 29% while the rest of the job is near 11%.",
    context: fixtureContext(
      [
        { sovLineId: "fx-sov-1", pctToDate: 12 },
        { sovLineId: "fx-sov-2", pctToDate: 11 },
        { sovLineId: "fx-sov-3", pctToDate: 29 },
      ],
      { lienWaiver: true, notes: "Grounding materials stored on site." },
    ),
    expected: { "fx-sov-1": "ok", "fx-sov-2": "ok", "fx-sov-3": "front_loaded" },
    expectZeroApproved: [],
  },
];
