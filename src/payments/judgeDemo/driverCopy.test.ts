import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { demoLineCut } from "../../../convex/judgeDemo/scenario";

const src = readFileSync(new URL("./useJudgeDemoDriver.ts", import.meta.url), "utf8");

/** The agent pay app's stored review on a funded fresh run, with the review's recommended cents. */
const reviewedLines = [
  { sovLineId: "s1", lineNo: 1, description: "1600A main switchboard & transformers", requestedCents: 572_000, review: { verdict: "overbilled", approvedCents: 22_000 } },
  { sovLineId: "s2", lineNo: 2, description: "Branch conduit & wire feeder runs", requestedCents: 468_000, review: { verdict: "excluded_scope", approvedCents: 0 } },
  { sovLineId: "s3", lineNo: 3, description: "Grounding & bonding system", requestedCents: 260_000, review: { verdict: "overbilled", approvedCents: 10_000 } },
  { sovLineId: "s4", lineNo: 4, description: "Closeout: testing, commissioning & O&M manuals", requestedCents: 50_000, review: { verdict: "out_of_sequence", approvedCents: 0 } },
];

test("the guided demo cuts the flagged line by exactly that line's dollars, never a share of the total", () => {
  const cut = demoLineCut(reviewedLines)!;
  expect(cut.lineNo).toBe(2);
  expect(cut.cutCents).toBe(reviewedLines[1].requestedCents);
  expect(cut.approvedCents).toBe(reviewedLines[1].requestedCents - cut.cutCents);
  expect(cut.reason).toContain("Line 2");
  expect(cut.reason).toContain("Branch conduit & wire feeder runs");
  expect(cut.reason).toContain("$4,680.00, the full amount");
  expect(cut.reason.toLowerCase()).not.toContain("waiver");
  expect(cut.reason.toLowerCase()).not.toContain("resubmit");

  // Only the flagged line gets a decision; every other line stays at the review's recommended cents.
  const decisions = [{ sovLineId: cut.sovLineId, action: "override" as const, amountCents: cut.approvedCents, reason: cut.reason }];
  expect(decisions.map((d) => d.sovLineId)).toEqual(["s2"]);

  // No proportional scaling: neither 10% off the request nor the removed 90% of the review total.
  const total = reviewedLines.reduce((a, l) => a + l.requestedCents, 0);
  const reviewTotal = reviewedLines.reduce((a, l) => a + (l.review?.approvedCents ?? 0), 0);
  expect(cut.cutCents).not.toBe(Math.floor(total * 0.1));
  expect(cut.cutCents).not.toBe(Math.floor(reviewTotal * 0.9));
  // Changing every other line leaves the cut on the named line unchanged.
  const biggerOtherLines = reviewedLines.map((l) => (l.sovLineId === "s2" ? l : { ...l, requestedCents: l.requestedCents * 2 }));
  expect(demoLineCut(biggerOtherLines)!.cutCents).toBe(cut.cutCents);
});

test("the driver approves through the per-line decision path and keeps no flat-percentage edit", () => {
  expect(src).toContain("api.payApps.decisions.decidePayApp");
  expect(src).toContain("decidePayApp({");
  expect(src).toContain('action: "override"');
  expect(src).toContain("demoLineCut(agent.payApp.lines)");
  expect(src).not.toContain("editProposal");
  expect(src).not.toContain("demoEditedApprovalCents");
  expect(src).not.toContain("editedAmountCents");
  expect(src).not.toContain("90%");
  expect(src).not.toContain("GC approved");
});
