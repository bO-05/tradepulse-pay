import { describe, expect, test } from "vitest";
import { DEMO_CHANGE_ORDER, DEMO_CONTRACT_SUM, DEMO_EXCLUSION, DEMO_LINE_ITEMS, DEMO_PAY_APP_TEXT, demoAgreementNumber, demoLineCut, demoPayAppLines, type DemoSovLine } from "./scenario";

const sov: DemoSovLine[] = [
  { _id: "a", description: "1600A main switchboard & transformers", excludedScope: false, scheduledValueCents: 2_200_000, previouslyBilledCents: 0, previousPctToDate: 0, pendingRequestedCents: 0, remainingCents: 2_200_000 },
  { _id: "b", description: "Closeout: testing, commissioning & O&M manuals", excludedScope: false, scheduledValueCents: 500_000, previouslyBilledCents: 0, previousPctToDate: 0, pendingRequestedCents: 0, remainingCents: 500_000 },
  { _id: "c", description: "Seismic bracing", excludedScope: true, scheduledValueCents: 450_000, previouslyBilledCents: 0, previousPctToDate: 0, pendingRequestedCents: 0, remainingCents: 450_000 },
];

/** The agent's stored review on a funded fresh run: line 2 is refused as excluded scope, the rest remain. */
const AGENT_REVIEWED_LINES = [
  { sovLineId: "a", lineNo: 1, description: "1600A main switchboard & transformers", requestedCents: 572_000, review: { verdict: "overbilled", approvedCents: 22_000 } },
  { sovLineId: "b", lineNo: 2, description: "Branch conduit & wire feeder runs", requestedCents: 468_000, review: { verdict: "excluded_scope", approvedCents: 0 } },
  { sovLineId: "c", lineNo: 3, description: "Grounding & bonding system", requestedCents: 260_000, review: { verdict: "overbilled", approvedCents: 10_000 } },
  { sovLineId: "d", lineNo: 4, description: "Closeout: testing, commissioning & O&M manuals", requestedCents: 50_000, review: { verdict: "out_of_sequence", approvedCents: 0 } },
];

describe("judge demo scenario", () => {
  test("contract sum contains only base scope, never the comparison-only exclusion plug", () => {
    expect(DEMO_CONTRACT_SUM).toBe(55_000);
    expect(DEMO_CONTRACT_SUM).toBe(DEMO_LINE_ITEMS.reduce((sum, line) => sum + line.totalCost, 0));
    expect(DEMO_CONTRACT_SUM + DEMO_EXCLUSION.costImpact).toBe(59_500);
  });

  test("agent notes attribute excluded work to the existing feeder line, not a fictitious SOV line", () => {
    expect(DEMO_LINE_ITEMS[1].item).toBe("Branch conduit & wire feeder runs");
    expect(DEMO_PAY_APP_TEXT.agent.notes).toContain("Line 2: branch conduit & wire feeder claim includes $4,500 seismic bracing");
    expect(DEMO_PAY_APP_TEXT.agent.notes).toContain("not added to the contract");
    expect(DEMO_PAY_APP_TEXT.agent.notes).not.toContain("full seismic bracing line");
  });

  test("waiver fixture notes never claim an uploaded legal document", () => {
    expect(DEMO_PAY_APP_TEXT.honest.notes).toContain("no legal document uploaded");
    expect(DEMO_PAY_APP_TEXT.honest.notes).not.toContain("waiver attached");
  });

  test("honest pay app bills 4% of base scope only", () => {
    const lines = demoPayAppLines("honest", sov);
    expect(lines).toEqual([{ sovLineId: "a", pctCompleteThisPeriod: 4, pctCompleteToDate: 4, requestedCents: 88_000 }]);
  });

  test("legacy SOV fixtures still support base, closeout and explicit excluded-line claims", () => {
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

  test("the GC cut equals the flagged line's own dollars, not a share of the pay-app total", () => {
    const cut = demoLineCut(AGENT_REVIEWED_LINES)!;
    expect(cut.lineNo).toBe(2);
    expect(cut.sovLineId).toBe("b");
    // The named line asked for $4,680.00; the cut is that whole line, so it is approved at zero.
    expect(cut.cutCents).toBe(468_000);
    expect(cut.approvedCents).toBe(468_000 - cut.cutCents);
    expect(cut.approvedCents).toBe(0);
    expect(cut.reason).toContain("Line 2");
    expect(cut.reason).toContain("Branch conduit & wire feeder runs");
    expect(cut.reason).toContain("$4,680.00");
    expect(cut.reason).toContain("$4,680.00, the full amount");
    expect(cut.reason).not.toContain("%");
  });

  test("the cut follows the named line instead of a flat percentage of the total", () => {
    const total = AGENT_REVIEWED_LINES.reduce((a, l) => a + l.requestedCents, 0);
    const cut = demoLineCut(AGENT_REVIEWED_LINES)!;
    expect(total).toBe(1_350_000);
    expect(cut.cutCents).not.toBe(Math.floor(total * 0.1));
    const smaller = AGENT_REVIEWED_LINES.map((l) => (l.sovLineId === "b" ? { ...l, requestedCents: 300_000 } : l));
    expect(demoLineCut(smaller)!.cutCents).toBe(300_000);
    const reviewTotal = AGENT_REVIEWED_LINES.reduce((a, l) => a + (l.review?.approvedCents ?? 0), 0);
    expect(reviewTotal).toBe(32_000);
    // N-10's removed shortcut paid 90% of the review total; the named line is the only line cut.
    expect(cut.cutCents).not.toBe(Math.floor(reviewTotal * 0.9));
  });

  test("only the flagged line gets an override; the others stay at the review's recommended cents", () => {
    const cut = demoLineCut(AGENT_REVIEWED_LINES)!;
    const decisions = [{ sovLineId: cut.sovLineId, action: "override" as const, amountCents: cut.approvedCents, reason: cut.reason }];
    expect(decisions).toHaveLength(1);
    expect(decisions[0].amountCents).toBe(0);
    expect(AGENT_REVIEWED_LINES.filter((l) => l.sovLineId !== cut.sovLineId).map((l) => l.review!.approvedCents)).toEqual([22_000, 10_000, 0]);
  });

  test("nothing flagged means no override rather than a flat cut", () => {
    const allOk = AGENT_REVIEWED_LINES.map((l) => ({ ...l, review: { verdict: "ok", approvedCents: l.requestedCents } }));
    expect(demoLineCut(allOk)).toBeNull();
  });

  test("change order and agreement number are fixed and labeled", () => {
    expect(DEMO_CHANGE_ORDER.amountCents).toBe(185_000);
    expect(demoAgreementNumber(Date.UTC(2026, 9, 7), 3)).toBe("A401-DEMO-PAY-20261007-03");
  });
});
