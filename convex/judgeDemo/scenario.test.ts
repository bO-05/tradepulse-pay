import { describe, expect, test } from "vitest";
import { DEMO_CHANGE_ORDER, DEMO_CONTRACT_SUM, demoAgreementNumber, demoEditedApprovalCents, demoPayAppLines, type DemoSovLine } from "./scenario";

const sov: DemoSovLine[] = [
  { _id: "a", description: "1600A main switchboard & transformers", excludedScope: false, scheduledValueCents: 2_200_000, previouslyBilledCents: 0, previousPctToDate: 0, pendingRequestedCents: 0, remainingCents: 2_200_000 },
  { _id: "b", description: "Closeout: testing, commissioning & O&M manuals", excludedScope: false, scheduledValueCents: 500_000, previouslyBilledCents: 0, previousPctToDate: 0, pendingRequestedCents: 0, remainingCents: 500_000 },
  { _id: "c", description: "Seismic bracing", excludedScope: true, scheduledValueCents: 450_000, previouslyBilledCents: 0, previousPctToDate: 0, pendingRequestedCents: 0, remainingCents: 450_000 },
];

describe("judge demo scenario", () => {
  test("contract sum includes the excluded seismic line", () => {
    expect(DEMO_CONTRACT_SUM).toBe(59_500);
  });

  test("honest pay app bills 4% of base scope only", () => {
    const lines = demoPayAppLines("honest", sov);
    expect(lines).toEqual([{ sovLineId: "a", pctCompleteThisPeriod: 4, pctCompleteToDate: 4, requestedCents: 88_000 }]);
  });

  test("agent pay app overbills base, closeout and the full excluded line", () => {
    const lines = demoPayAppLines("agent", sov);
    expect(lines.map((l) => [l.sovLineId, l.pctCompleteToDate, l.requestedCents])).toEqual([
      ["a", 30, 660_000],
      ["b", 10, 50_000],
      ["c", 100, 450_000],
    ]);
  });

  test("agent lines account for what was already billed and never exceed the remaining value", () => {
    const billed = sov.map((s) => (s._id === "a" ? { ...s, previouslyBilledCents: 88_000, previousPctToDate: 4, remainingCents: 2_112_000 } : s));
    const a = demoPayAppLines("agent", billed).find((l) => l.sovLineId === "a")!;
    expect(a).toEqual({ sovLineId: "a", pctCompleteThisPeriod: 26, pctCompleteToDate: 30, requestedCents: 572_000 });
    const full = sov.map((s) => ({ ...s, previouslyBilledCents: s.scheduledValueCents, previousPctToDate: 100, remainingCents: 0 }));
    expect(demoPayAppLines("agent", full)).toEqual([]);
  });

  test("a pending honest request reduces the agent's amount without raising its previous percent", () => {
    const pending = sov.map((s) => (s._id === "a" ? { ...s, pendingRequestedCents: 88_000, remainingCents: 2_112_000 } : s));
    const a = demoPayAppLines("agent", pending).find((l) => l.sovLineId === "a")!;
    expect(a).toEqual({ sovLineId: "a", pctCompleteThisPeriod: 30, pctCompleteToDate: 30, requestedCents: 572_000 });
  });

  test("edited approval is 90% rounded down to whole dollars", () => {
    expect(demoEditedApprovalCents(123_456)).toBe(111_100);
    expect(demoEditedApprovalCents(100_000)).toBe(90_000);
    expect(demoEditedApprovalCents(150)).toBeNull();
    expect(demoEditedApprovalCents(Number.NaN)).toBeNull();
  });

  test("change order and agreement number are fixed and labeled", () => {
    expect(DEMO_CHANGE_ORDER.amountCents).toBe(185_000);
    expect(demoAgreementNumber(Date.UTC(2026, 9, 7), 3)).toBe("A401-DEMO-PAY-20261007-03");
  });
});
