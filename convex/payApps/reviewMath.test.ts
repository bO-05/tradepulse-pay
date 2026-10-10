import { describe, expect, test } from "vitest";
import {
  approvedCentsFor,
  buildReviewLines,
  finalizeReview,
  IncompleteJudgementError,
  rulesEngineJudgement,
  trancheCeilingFor,
  type ReviewJudgement,
  type ReviewMilestone,
} from "./reviewMath";
import { PAY_APP_REVIEW_FIXTURES } from "./reviewEvalFixtures";
import { buildReviewPrompt } from "./reviewModel";

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

describe("trancheCeilingFor", () => {
  const ms = (status: string, amountCents: number, order: number): ReviewMilestone => ({
    milestoneId: `m${order}`,
    name: `M${order}`,
    order,
    status,
    amountCents,
    sovLineIds: ["a"],
  });
  test("complete tranches count fully, funded or in-progress ones at half", () => {
    expect(trancheCeilingFor("a", [ms("complete", 10, 1), ms("in_progress", 40, 2), ms("planned", 35, 3), ms("planned", 15, 4)])).toBe(0.3);
    expect(trancheCeilingFor("a", [ms("paid", 10, 1), ms("complete", 40, 2), ms("funded", 35, 3), ms("planned", 15, 4)])).toBe(0.675);
    expect(trancheCeilingFor("a", [ms("planned", 10, 1)])).toBe(0);
  });
  test("a line no tranche lists has no tranche ceiling", () => {
    expect(trancheCeilingFor("b", [ms("planned", 10, 1)])).toBeNull();
    expect(trancheCeilingFor("a", [{ ...ms("planned", 10, 1), sovLineIds: [] }])).toBeNull();
  });
  test("only the tranches that list the line count toward its ceiling", () => {
    const other = { ...ms("planned", 1_000, 1), sovLineIds: ["b"] };
    expect(trancheCeilingFor("a", [other, ms("complete", 10, 2), ms("planned", 10, 3)])).toBe(0.5);
  });
});

describe("funding tranches cap only the lines they list", () => {
  const f = fixture("payapp_honest");
  const sov = [
    { _id: "a", lineNo: 1, description: "Switchgear", excludedScope: false, scheduledValueCents: 1_000_000 },
    { _id: "b", lineNo: 2, description: "Branch conduit & wire", excludedScope: false, scheduledValueCents: 1_000_000 },
    { _id: "c", lineNo: 3, description: "Closeout: testing, commissioning & O&M manuals", excludedScope: false, scheduledValueCents: 100_000 },
  ];
  const contextFor = (tranches: ReviewMilestone[]) => ({
    ...f.context,
    tranches: tranches.map((m) => ({ ...m, coversLineNos: m.sovLineIds.map((id) => sov.find((s) => s._id === id)!.lineNo) })),
    lines: buildReviewLines({
      sov,
      milestones: tranches,
      prior: new Map(),
      lines: [
        { sovLineId: "a", pctCompleteThisPeriod: 40, pctCompleteToDate: 40, requestedCents: 400_000 },
        { sovLineId: "b", pctCompleteThisPeriod: 40, pctCompleteToDate: 40, requestedCents: 400_000 },
        { sovLineId: "c", pctCompleteThisPeriod: 20, pctCompleteToDate: 20, requestedCents: 20_000 },
      ],
    }),
  });
  const tranche = (order: number, name: string, status: string, sovLineIds: string[]): ReviewMilestone => ({
    milestoneId: `t${order}`,
    name,
    order,
    status,
    amountCents: 100_000,
    sovLineIds,
  });

  test("a planned tranche that lists no lines caps nothing and sequences nothing", () => {
    const context = contextFor([tranche(1, "Mobilization", "planned", []), tranche(2, "Closeout", "planned", [])]);
    expect(context.lines.map((l) => l.trancheCeilingPctToDate)).toEqual([null, null, null]);
    expect(context.lines.map((l) => l.closeoutWorkBeforeEarlierTranches)).toEqual([false, false, false]);
    const review = finalizeReview(context, rulesEngineJudgement(context));
    expect(review.lines.map((l) => l.verdict)).toEqual(["ok", "ok", "ok"]);
    expect(review.lines.map((l) => l.recommendedPctToDate)).toEqual([0.4, 0.4, 0.2]);
    expect(review.approvedTotalCents).toBe(820_000);
  });

  test("a covered line keeps the tranche ceiling while an uncovered line beside it is not capped", () => {
    const context = contextFor([tranche(1, "Mobilization", "planned", ["a"])]);
    expect(context.lines.map((l) => l.trancheCeilingPctToDate)).toEqual([0, null, null]);
    const review = finalizeReview(context, rulesEngineJudgement(context));
    expect(review.lines[0]).toMatchObject({ verdict: "overbilled", recommendedPctToDate: 0, approvedCents: 0 });
    expect(review.lines[1]).toMatchObject({ verdict: "ok", recommendedPctToDate: 0.4, approvedCents: 400_000 });
  });

  test("a model 'overbilled' on an uncovered line is held only to the 100% cap, not a tranche ceiling", () => {
    const context = contextFor([tranche(1, "Mobilization", "planned", ["a"])]);
    const judgement = rulesEngineJudgement(context);
    judgement.lines[1] = { ...judgement.lines[1], verdict: "overbilled", recommendedPctToDate: 0.4 };
    expect(finalizeReview(context, judgement).lines[1]).toMatchObject({ recommendedPctToDate: 0.4, approvedCents: 400_000 });
  });

  test("closeout work is out of sequence only against earlier tranches that list it", () => {
    const covered = contextFor([tranche(1, "Rough-in", "in_progress", ["a", "b", "c"]), tranche(2, "Closeout", "planned", ["a", "b", "c"])]);
    expect(finalizeReview(covered, rulesEngineJudgement(covered)).lines[2].verdict).toBe("out_of_sequence");
    const uncovered = contextFor([tranche(1, "Rough-in", "in_progress", ["a", "b"]), tranche(2, "Closeout", "planned", ["a", "b"])]);
    expect(finalizeReview(uncovered, rulesEngineJudgement(uncovered)).lines[2].verdict).toBe("ok");
  });

  test("the model prompt says which lines each tranche covers and gives uncovered lines no ceiling", () => {
    const prompt = buildReviewPrompt(contextFor([tranche(1, "Mobilization", "planned", ["a"])]));
    const payload = JSON.parse(prompt.slice(prompt.indexOf("{")));
    expect(payload.fundingTranches).toEqual([{ name: "Mobilization", order: 1, status: "planned", amount: "$1,000.00", coversLineNos: [1] }]);
    expect(payload.lines.map((l: { trancheCeilingPctToDate: number | null }) => l.trancheCeilingPctToDate)).toEqual([0, null, null]);
    expect(payload.lines[1].summary).toContain("no funding tranche covers this line");
    expect(prompt).not.toContain("milestone");
  });
});

describe("pay-app notes with mixed included and excluded scope", () => {
  const f = fixture("payapp_honest");
  const sov = [
    { _id: "a", lineNo: 1, description: "Seismic bracing of conduit", excludedScope: false, scheduledValueCents: 1_000_000 },
    { _id: "b", lineNo: 2, description: "Switchgear and equipment", excludedScope: false, scheduledValueCents: 1_000_000 },
  ];
  const contextWith = (notes: string) => ({
    ...f.context,
    agreement: { ...f.context.agreement, excludedScopeNotes: ["Seismic bracing of conduit and equipment"] },
    tranches: [],
    payApp: { ...f.context.payApp, notes },
    lines: buildReviewLines({
      sov,
      milestones: [],
      prior: new Map(),
      lines: [
        { sovLineId: "a", pctCompleteThisPeriod: 10, pctCompleteToDate: 10, requestedCents: 100_000 },
        { sovLineId: "b", pctCompleteThisPeriod: 10, pctCompleteToDate: 10, requestedCents: 100_000 },
      ],
    }),
  });

  test("an excluded claim on line 2 gets $0 although line 1 includes similar scope", () => {
    const context = contextWith("Line 2: equipment seismic bracing installed this period.");
    const review = finalizeReview(context, rulesEngineJudgement(context));
    expect(review.lines[0]).toMatchObject({ verdict: "ok", approvedCents: 100_000 });
    expect(review.lines[1]).toMatchObject({ verdict: "excluded_scope", approvedCents: 0 });
    expect(review.approvedTotalCents).toBe(100_000);
  });

  test("the included line's own bracing note stays billable", () => {
    const context = contextWith("Line 1: seismic bracing of conduit installed on level 2.");
    const review = finalizeReview(context, rulesEngineJudgement(context));
    expect(review.lines.map((l) => l.verdict)).toEqual(["ok", "ok"]);
    expect(review.approvedTotalCents).toBe(200_000);
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

  test("closeout work billed before earlier covering tranches is out of sequence; missing lien waiver is flagged", () => {
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

  test("an approved SOV line whose description resembles an exclusion note stays ok", () => {
    const f = fixture("payapp_honest");
    const sov = [
      { _id: "a", lineNo: 1, description: "Switchgear", excludedScope: false, scheduledValueCents: 1_000_000 },
      { _id: "lv", lineNo: 5, description: "Low-voltage & data 27 10 00", excludedScope: false, scheduledValueCents: 1_000_000 },
    ];
    const contextWith = (lvNote: string | undefined, notes: string) => ({
      ...f.context,
      agreement: { ...f.context.agreement, excludedScopeNotes: ["Low-voltage cabling (27 00 00)"] },
      payApp: { ...f.context.payApp, notes },
      lines: buildReviewLines({
        sov,
        milestones: [],
        prior: new Map(),
        lines: [
          { sovLineId: "a", pctCompleteThisPeriod: 10, pctCompleteToDate: 10, requestedCents: 100_000 },
          { sovLineId: "lv", pctCompleteThisPeriod: 10, pctCompleteToDate: 10, requestedCents: 100_000, note: lvNote },
        ],
      }),
    });
    const cleanCtx = contextWith(undefined, "Switchgear set; low-voltage and data rough-in.");
    const clean = finalizeReview(cleanCtx, rulesEngineJudgement(cleanCtx));
    expect(clean.lines.map((l) => l.verdict)).toEqual(["ok", "ok"]);
    const claimedCtx = contextWith("Low-voltage & data plus low-voltage cabling for the owner's AV system", "");
    const claimed = finalizeReview(claimedCtx, rulesEngineJudgement(claimedCtx));
    expect(claimed.lines.map((l) => l.verdict)).toEqual(["ok", "excluded_scope"]);
    expect(claimed.lines[1].approvedCents).toBe(0);
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
    const context = {
      ...f.context,
      lines: f.context.lines.map((l) => (l.sovLineId === "fx-sov-2" ? { ...l, excludedScope: true } : l)),
    };
    const review = finalizeReview(context, base());
    const line = review.lines.find((l) => l.sovLineId === "fx-sov-2")!;
    expect(line).toMatchObject({ verdict: "excluded_scope", approvedCents: 0, recommendedPctToDate: 0 });
  });

  test("a model verdict of excluded_scope on a base line approves 0 and keeps the previous percent", () => {
    const review = finalizeReview(f.context, base({ "fx-sov-1": { verdict: "excluded_scope", recommendedPctToDate: 0.25 } }));
    expect(review.lines.find((l) => l.sovLineId === "fx-sov-1")).toMatchObject({
      verdict: "excluded_scope",
      approvedCents: 0,
      recommendedPctToDate: 0.1,
    });
  });

  test("lines with nothing billed get a code-recorded OK verdict at their previous percent and $0", () => {
    const context = { ...f.context, unbilledLines: [{ sovLineId: "fx-sov-4", lineNo: 4, previousPctToDate: 0.125 }] };
    const review = finalizeReview(context, base());
    expect(review.lines.map((l) => l.sovLineId)).toEqual(["fx-sov-1", "fx-sov-2", "fx-sov-3", "fx-sov-4"]);
    expect(review.lines[3]).toMatchObject({ verdict: "ok", recommendedPctToDate: 0.125, approvedCents: 0 });
    expect(review.approvedTotalCents).toBe(review.lines.slice(0, 3).reduce((a, l) => a + l.approvedCents, 0));
  });

  test("overbilled recommendations never exceed the tranche ceiling; no line exceeds its claim", () => {
    const review = finalizeReview(
      f.context,
      base({ "fx-sov-1": { verdict: "overbilled", recommendedPctToDate: 0.9 }, "fx-sov-2": { recommendedPctToDate: 0.95 } }),
    );
    expect(review.lines.find((l) => l.sovLineId === "fx-sov-1")!.recommendedPctToDate).toBe(0.25);
    expect(review.lines.find((l) => l.sovLineId === "fx-sov-2")!.recommendedPctToDate).toBe(0.22);
  });

  test("a recommendation below the previously certified percent is held at that percent and approves 0", () => {
    const context = {
      ...f.context,
      lines: f.context.lines.map((l) => (l.sovLineId === "fx-sov-1" ? { ...l, trancheCeilingPctToDate: 0 } : l)),
    };
    const line = finalizeReview(context, base({ "fx-sov-1": { verdict: "overbilled", recommendedPctToDate: 0 } })).lines.find(
      (l) => l.sovLineId === "fx-sov-1",
    )!;
    expect(line).toMatchObject({ verdict: "overbilled", recommendedPctToDate: 0.1, approvedCents: 0 });
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
