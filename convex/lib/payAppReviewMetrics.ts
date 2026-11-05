import { v } from "convex/values";
import { LINE_VERDICTS, type LineVerdict } from "../payApps/reviewMath";

export const verdictMetricValidator = v.object({
  verdict: v.string(),
  support: v.number(),
  tp: v.number(),
  fp: v.number(),
  fn: v.number(),
  precision: v.number(),
  recall: v.number(),
  f1: v.number(),
});

export const payAppReviewMetricsValidator = v.object({
  totalCases: v.number(),
  totalLines: v.number(),
  totalIssues: v.number(),
  lineAccuracy: v.number(),
  issuePrecision: v.number(),
  issueRecall: v.number(),
  issueF1: v.number(),
  macroF1: v.number(),
  casePassRate: v.number(),
  perVerdict: v.array(verdictMetricValidator),
});

export type VerdictMetric = {
  verdict: LineVerdict;
  support: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
};

export type PayAppReviewMetrics = {
  totalCases: number;
  totalLines: number;
  totalIssues: number;
  lineAccuracy: number;
  issuePrecision: number;
  issueRecall: number;
  issueF1: number;
  macroF1: number;
  casePassRate: number;
  perVerdict: VerdictMetric[];
};

const round = (n: number) => Math.round(n * 1000) / 1000;
const ratio = (numerator: number, denominator: number) => (denominator === 0 ? 0 : round(numerator / denominator));
const f1 = (precision: number, recall: number) =>
  precision + recall === 0 ? 0 : round((2 * precision * recall) / (precision + recall));

export function computePayAppReviewMetrics(
  results: readonly {
    fixture: { fixtureId: string; expected: Record<string, string> };
    run: { review: { lines: { sovLineId: string; verdict: string; modelVerdict?: string }[] } };
    score: { passed: boolean };
  }[],
): PayAppReviewMetrics {
  const per = new Map<LineVerdict, { tp: number; fp: number; fn: number; support: number }>();
  for (const verdict of LINE_VERDICTS) per.set(verdict, { tp: 0, fp: 0, fn: 0, support: 0 });

  let totalLines = 0;
  let correctLines = 0;
  let totalIssues = 0;
  let issueTp = 0;
  let issueFp = 0;
  let issueFn = 0;

  for (const { fixture, run } of results) {
    const predicted = new Map(run.review.lines.map((line) => [line.sovLineId, line.modelVerdict ?? line.verdict]));
    for (const [sovLineId, expected] of Object.entries(fixture.expected)) {
      totalLines++;
      const got = predicted.get(sovLineId);
      if (got === expected) correctLines++;
      const expectedIssue = expected !== "ok";
      const predictedIssue = got !== undefined && got !== "ok";
      if (expectedIssue) {
        totalIssues++;
        if (predictedIssue) issueTp++;
        else issueFn++;
      } else if (predictedIssue) {
        issueFp++;
      }

      for (const verdict of LINE_VERDICTS) {
        const cell = per.get(verdict)!;
        if (expected === verdict) cell.support++;
        if (expected === verdict && got === verdict) cell.tp++;
        else if (expected !== verdict && got === verdict) cell.fp++;
        else if (expected === verdict) cell.fn++;
      }
    }
  }

  const perVerdict = LINE_VERDICTS.map((verdict) => {
    const cell = per.get(verdict)!;
    const precision = ratio(cell.tp, cell.tp + cell.fp);
    const recall = ratio(cell.tp, cell.tp + cell.fn);
    return { verdict, ...cell, precision, recall, f1: f1(precision, recall) };
  });
  const supported = perVerdict.filter((m) => m.support > 0);
  const macroF1 = supported.length === 0 ? 0 : round(supported.reduce((sum, m) => sum + m.f1, 0) / supported.length);
  const issuePrecision = ratio(issueTp, issueTp + issueFp);
  const issueRecall = ratio(issueTp, issueTp + issueFn);

  return {
    totalCases: results.length,
    totalLines,
    totalIssues,
    lineAccuracy: ratio(correctLines, totalLines),
    issuePrecision,
    issueRecall,
    issueF1: f1(issuePrecision, issueRecall),
    macroF1,
    casePassRate: ratio(results.filter((r) => r.score.passed).length, results.length),
    perVerdict,
  };
}
