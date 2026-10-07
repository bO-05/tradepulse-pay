import { describe, expect, test } from "vitest";
import {
  approvedCentsFor,
  buildReviewLines,
  finalizeReview,
  IncompleteJudgementError,
  milestoneCeilingFor,
  rulesEngineJudgement,
  type ReviewJudgement,
  type ReviewMilestone,
} from "./reviewMath";
import { PAY_APP_REVIEW_FIXTURES } from "./reviewEvalFixtures";

const fixture = (id: string) => PAY_APP_REVIEW_FIXTURES.find((f) => f.fixtureId === id)!;

describe("approvedCentsFor", () => {
  test("clamp(round(scheduled × pct) − previously billed, 0, requested)", () => {
    // 30,000,000 × 0.30 = 9,000,000 − 3,000,000 billed = 6,000,000, below the 15,000,000 requested.
    expect(
      approvedCentsFor({ scheduledValueCents: 30_000_000, recommendedPctToDate: 0.3, previouslyBilledCents: 3_000_000, requestedCents: 15_000_000 }),
    ).toBe(6_000_000);
    // Capped at what was requested.
    expect(
      approvedCentsFor({ scheduledValueCents: 30_000_000, recommendedPctToDate: 0.5, previouslyBilledCents: 0, requestedCents: 1_000 }),
    ).toBe(1_000);
    // Never negative when earlier billing already exceeds the recommendation.
    expect(
      approvedCentsFor({ scheduledValueCents: 30_000_000, recommendedPctToDate: 0.05, previouslyBilledCents: 3_000_000, requestedCents: 500_000 }),
    ).toBe(0);
  });

  test("rounds half up on exact cents", () => {
    // 12,345 × 0.5 = 6,172.5 → 6,173
    expect(approvedCentsFor({ scheduledValueCents: 12_345, recommendedPctToDate: 0.5, previouslyBilledCents: 0, requestedCents: 99_999 })).toBe(6_173);
    // 45,000,000 × 0.35 is 15,749,999.999… in floating point; integer math gives exactly 15,750,000.
    expect(approvedCentsFor({ scheduledValueCents: 45_000_000, recommendedPctToDate: 0.35, previouslyBilledCents: 0, requestedCents: 99_000_000 })).toBe(15_750_000);
  });

  test("matches Math.round(scheduled × pct) for every basis point on a real line", () => {
    for (let bps = 0; bps <= 10_000; bps += 7) {
      const pct = bps / 10_000;
      const expected = Math.min(Math.max(Math.round(18_500_000 * pct) - 2_312_500, 0), 9_000_000);
      expect(approvedCentsFor({ scheduledValueCents: 18_500_000, recommendedPctToDate: pct, previouslyBilledCents: 2_312_500, requestedCents: 9_000_000 })).toBe(expected);
    }
  });
});

describe("milestoneCeilingFor", () => {
  const ms = (status: string, amountCents: number, order: number): ReviewMilestone => ({
    milestoneId: `m${order}`,
    name: `M${order}`,
    order,
    status,
    amountCents,
    sovLineIds: ["a"],
  });
  test("complete milestones count fully, funded or in-progress ones at half", () => {
    expect(milestoneCeilingFor("a", [ms("complete", 10, 1), ms("in_progress", 40, 2), ms("planned", 35, 3), ms("planned", 15, 4)])).toBe(0.3);
    expect(milestoneCeilingFor("a", [ms("paid", 10, 1), ms("complete", 40, 2), ms("funded", 35, 3), ms("planned", 15, 4)])).toBe(0.675);
    expect(milestoneCeilingFor("a", [ms("planned", 10, 1)])).toBe(0);
  });
  test("a line no milestone covers is unconstrained", () => {
    expect(milestoneCeilingFor("b", [ms("planned", 10, 1)])).toBe(1);
  });
});

describe("rules engine on the eval fixtures", () => {
  for (const f of PAY_APP_REVIEW_FIXTURES) {
    test(`${f.fixtureId} gets the expected verdict on every line`, () => {
      const review = finalizeReview(f.context, rulesEngineJudgement(f.context));
      for (const [id, verdict] of Object.entries(f.expected)) {
        expect(review.lines.find((l) => l.sovLineId === id)?.verdict).toBe(verdict);
      }
      for (const id of f.expectZeroApproved) expect(review.lines.find((l) => l.sovLineId === id)?.approvedCents).toBe(0);
    });
  }

  test("overbilled line is cut to the 30% ceiling and the total drops below requested", () => {
    const f = fixture("payapp_overbilled");
    const review = finalizeReview(f.context, rulesEngineJudgement(f.context));
    const line = review.lines.find((l) => l.sovLineId === "fx-sov-2")!;
    expect(line.recommendedPctToDate).toBe(0.3);
    // 30,000,000 × 0.30 − 3,000,000 previously billed
    expect(line.approvedCents).toBe(6_000_000);
    expect(review.approvedTotalCents).toBe(review.lines.reduce((a, l) => a + l.approvedCents, 0));
    expect(review.approvedTotalCents).toBeLessThan(f.context.payApp.requestedTotalCents);
  });

  test("closeout work billed before earlier milestones is out of sequence; missing lien waiver is flagged", () => {
    const f = fixture("payapp_honest");
    const context = {
      ...f.context,
      payApp: { ...f.context.payApp, lienWaiver: false },
      lines: buildReviewLines({
        sov: [
          { _id: "a", lineNo: 1, description: "Switchgear", excludedScope: false, scheduledValueCents: 1_000_000 },
          { _id: "b", lineNo: 2, description: "Closeout: testing, commissioning & O&M manuals", excludedScope: false, scheduledValueCents: 100_000 },
        ],
        milestones: [
          { milestoneId: "1", name: "Mobilization", order: 1, status: "complete", amountCents: 100, sovLineIds: ["a", "b"] },
          { milestoneId: "2", name: "Rough-in", order: 2, status: "in_progress", amountCents: 400, sovLineIds: ["a", "b"] },
          { milestoneId: "3", name: "Closeout", order: 3, status: "planned", amountCents: 100, sovLineIds: ["a", "b"] },
        ],
        prior: new Map(),
        lines: [
          { sovLineId: "a", pctCompleteThisPeriod: 20, pctCompleteToDate: 20, requestedCents: 200_000 },
          { sovLineId: "b", pctCompleteThisPeriod: 25, pctCompleteToDate: 25, requestedCents: 25_000 },
        ],
      }),
    };
    const review = finalizeReview(context, rulesEngineJudgement(context));
    expect(review.lines.map((l) => l.verdict)).toEqual(["ok", "out_of_sequence"]);
    expect(review.lines[1].approvedCents).toBe(0);
    expect(review.flags.lienWaiverMissing).toBe(true);
  });
});

describe("finalizeReview applies code policy to model output", () => {
  const f = fixture("payapp_excluded_scope");
  const base = (overrides: Partial<Record<string, Partial<ReviewJudgement["lines"][number]>>> = {}): ReviewJudgement => ({
    lines: f.context.lines.map((l) => ({
      sovLineId: l.sovLineId,
      verdict: "ok" as const,
      recommendedPctToDate: l.claimedPctToDate,
      reason: "Looks fine.",
      ...overrides[l.sovLineId],
    })),
    lienWaiverMissing: true,
    licenseIssue: false,
    notes: "note",
  });

  test("an excluded-scope SOV line is always excluded_scope with 0 approved, whatever the model said", () => {
    const review = finalizeReview(f.context, base());
    const line = review.lines.find((l) => l.sovLineId === "fx-sov-5")!;
    expect(line).toMatchObject({ verdict: "excluded_scope", approvedCents: 0, recommendedPctToDate: 0 });
  });

  test("overbilled recommendations never exceed the milestone ceiling; no line exceeds its claim", () => {
    const review = finalizeReview(
      f.context,
      base({ "fx-sov-1": { verdict: "overbilled", recommendedPctToDate: 0.9 }, "fx-sov-2": { recommendedPctToDate: 0.95 } }),
    );
    expect(review.lines.find((l) => l.sovLineId === "fx-sov-1")!.recommendedPctToDate).toBe(0.25);
    expect(review.lines.find((l) => l.sovLineId === "fx-sov-2")!.recommendedPctToDate).toBe(0.22);
  });

  test("the lien waiver flag is the submitted fact, not the model's guess", () => {
    expect(finalizeReview(f.context, base()).flags.lienWaiverMissing).toBe(false);
  });

  const withLicense = (status: string | null) => ({
    ...f.context,
    license: status === null ? null : { licenseNumber: "142881", status, checkedAt: 1, summary: "CSLB" },
  });

  test.each([
    [null, "none"],
    ["unverified", "unverified"],
    ["expired", "expired"],
    ["suspended", "suspended"],
    ["inactive", "inactive"],
    ["not_found", "not_found"],
    ["something-new", "unverified"],
  ])("license %s is an issue whatever the model says (status %s)", (status, shown) => {
    for (const modelFlag of [false, true]) {
      const flags = finalizeReview(withLicense(status), { ...base(), licenseIssue: modelFlag }).flags;
      expect(flags).toMatchObject({ licenseIssue: true, licenseStatus: shown });
    }
  });

  test("only an active CSLB result clears the license flag, even if the model raises it", () => {
    const flags = finalizeReview(withLicense("active"), { ...base(), licenseIssue: true }).flags;
    expect(flags).toMatchObject({ licenseIssue: false, licenseStatus: "active" });
  });

  test("the rules engine path agrees with the AI path on the license flag", () => {
    for (const status of [null, "unverified", "expired", "active"]) {
      const ctx = withLicense(status);
      const offline = finalizeReview(ctx, rulesEngineJudgement(ctx)).flags;
      const ai = finalizeReview(ctx, { ...base(), licenseIssue: false }).flags;
      expect(offline.licenseIssue).toBe(ai.licenseIssue);
      expect(offline.licenseStatus).toBe(ai.licenseStatus);
    }
    expect(rulesEngineJudgement(withLicense(null)).notes).toContain("License: no license check yet.");
  });

  test("a judgement that skips a submitted line is rejected", () => {
    const j = base();
    j.lines = j.lines.slice(1);
    expect(() => finalizeReview(f.context, j)).toThrow(IncompleteJudgementError);
  });

  test("recommended fractions are stored to basis points and reproduce approved cents", () => {
    const review = finalizeReview(f.context, base({ "fx-sov-1": { recommendedPctToDate: 0.2345678 } }));
    const line = review.lines.find((l) => l.sovLineId === "fx-sov-1")!;
    const ctx = f.context.lines.find((l) => l.sovLineId === "fx-sov-1")!;
    expect(line.recommendedPctToDate).toBe(0.2346);
    expect(line.approvedCents).toBe(
      Math.min(Math.max(Math.round(ctx.scheduledValueCents * line.recommendedPctToDate) - ctx.previouslyBilledCents, 0), ctx.requestedCents),
    );
  });
});
