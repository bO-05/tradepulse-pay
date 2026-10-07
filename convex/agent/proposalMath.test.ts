import { describe, expect, test } from "vitest";
import { checkEditedAmount, chooseCaptureMilestone, effectiveAmount, planProposals, requiredKinds, type PlanInput, type PlanMilestone } from "./proposalMath";

const funded = (id: string, order: number, grossCents: number, capturedCents = 0, lines: string[] = []): PlanMilestone => ({
  milestoneId: id,
  name: `M${order}`,
  order,
  status: "funded",
  sovLineIds: lines,
  funding: { status: capturedCents > 0 ? "partially_captured" : "authorized", grossCents, capturedCents },
});

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    requestedTotalCents: 333_000_00,
    lienWaiver: true,
    approvedTotalCents: 232_000_00,
    lines: [
      { sovLineId: "a", verdict: "ok", approvedCents: 100_000_00, requestedCents: 100_000_00 },
      { sovLineId: "b", verdict: "overbilled", approvedCents: 132_000_00, requestedCents: 228_000_00 },
      { sovLineId: "c", verdict: "excluded_scope", approvedCents: 0, requestedCents: 5_000_00 },
    ],
    milestones: [funded("m3", 3, 300_000_00, 0, ["a", "b"])],
    retainagePercent: 10,
    licenseStatus: "active",
    ...over,
  };
}

describe("planProposals", () => {
  test("overbilled pay app: capture and payout of the code-computed approved total with a 10% retainage split", () => {
    const plan = planProposals(input());
    expect(plan.approvedTotalCents).toBe(232_000_00);
    expect(plan.captureMilestoneId).toBe("m3");
    expect(plan.payoutSplit).toEqual({ grossCents: 232_000_00, retainageCents: 23_200_00, netCents: 208_800_00 });
    expect(plan.reviewFlags).toEqual(expect.arrayContaining(["overbilled_lines", "excluded_scope_lines", "reduced_from_request"]));
    expect(plan.licenseHold).toBe(false);
    expect(plan.payoutFlags.some((f) => f.startsWith("license_"))).toBe(false);
    expect(requiredKinds(plan)).toEqual(["capture", "payout"]);
  });

  test.each(["expired", "not_found", "unverified", "none"] as const)("a %s license holds the payout and requires a hold proposal", (licenseStatus) => {
    const plan = planProposals(input({ licenseStatus }));
    expect(plan.licenseHold).toBe(true);
    expect(plan.payoutFlags).toEqual(expect.arrayContaining(["license_hold", `license_${licenseStatus}`]));
    expect(requiredKinds(plan)).toEqual(["capture", "payout", "hold"]);
  });

  test("no funded milestone still proposes capture and payout, flagged; out-of-sequence lines add a reschedule", () => {
    const plan = planProposals(
      input({
        milestones: [{ ...funded("m1", 1, 0), funding: null }],
        lines: [{ sovLineId: "z", verdict: "out_of_sequence", approvedCents: 10_00, requestedCents: 50_00 }],
        approvedTotalCents: 10_00,
      }),
    );
    expect(plan.captureMilestoneId).toBeNull();
    expect(plan.captureFlags).toContain("milestone_not_funded");
    expect(requiredKinds(plan)).toEqual(["capture", "payout", "reschedule"]);
  });

  test("nothing approved: only a hold", () => {
    const plan = planProposals(input({ approvedTotalCents: 0 }));
    expect(plan.payoutSplit).toBeNull();
    expect(requiredKinds(plan)).toEqual(["hold"]);
  });
});

describe("chooseCaptureMilestone", () => {
  test("prefers the earliest funded milestone covering a billed line with enough authorization left", () => {
    const ms = [funded("m4", 4, 500_00, 0, ["b"]), funded("m2", 2, 100_00, 50_00, ["b"]), funded("m3", 3, 500_00, 0, ["x"])];
    expect(chooseCaptureMilestone(ms, ["b"], 100_00)?.milestoneId).toBe("m4");
    expect(chooseCaptureMilestone(ms, ["b"], 40_00)?.milestoneId).toBe("m2");
    expect(chooseCaptureMilestone(ms, ["q"], 100_00)?.milestoneId).toBe("m3");
    expect(chooseCaptureMilestone(ms, ["b"], 600_00)).toBeNull();
  });
});

describe("checkEditedAmount", () => {
  test("accepts whole cents above zero up to the requested total", () => {
    expect(checkEditedAmount(1, 100)).toEqual({ ok: true, amountCents: 1 });
    expect(checkEditedAmount(100, 100)).toEqual({ ok: true, amountCents: 100 });
  });
  test("rejects negative, zero, fractional and above-request amounts with a message", () => {
    expect(checkEditedAmount(-500, 100)).toMatchObject({ ok: false, message: expect.stringMatching(/negative/) });
    expect(checkEditedAmount(0, 100)).toMatchObject({ ok: false });
    expect(checkEditedAmount(1.5, 100)).toMatchObject({ ok: false });
    expect(checkEditedAmount(101, 100)).toMatchObject({ ok: false, message: expect.stringMatching(/exceed/) });
  });
  test("the GC edit wins over the computed amount", () => {
    expect(effectiveAmount({ amountCents: 500, editedAmountCents: 200 })).toBe(200);
    expect(effectiveAmount({ amountCents: 500 })).toBe(500);
  });
});
