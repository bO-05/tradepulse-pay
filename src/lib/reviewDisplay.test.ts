import { describe, expect, test } from "vitest";
import { recordedReviewHeading, reviewText } from "./reviewDisplay";

/** Copied from the frozen Lopez settlement report; quoted history is never edited. */
const FROZEN_LOPEZ_NOTE =
  "Both billed lines exceed their funding-tranche ceilings: Rough-in capped at 50% (funded tranche only), Fixtures set at 0% (tranche still planned). No lien waiver provided and no active license check on file for Ortiz Plumbing, so both flags are set for the GC.";

describe("stored review presentation", () => {
  test("the frozen Lopez narrative is byte-for-byte unchanged", () => {
    expect(reviewText(FROZEN_LOPEZ_NOTE)).toBe(FROZEN_LOPEZ_NOTE);
  });

  test("raw rule identifiers become plain words", () => {
    const stored = "Billed while closeoutWorkBeforeEarlierTranches true; trancheCeilingPctToDate 0.05; excludedScopeNotes reviewed.";
    const shown = reviewText(stored);
    expect(shown).not.toContain("closeoutWorkBeforeEarlierTranches");
    expect(shown).not.toContain("trancheCeilingPctToDate");
    expect(shown).not.toContain("excludedScopeNotes");
    expect(shown).toContain("closeout work before earlier funding tranches true");
  });

  test("the heading names the run date without commercial words", () => {
    const heading = recordedReviewHeading(Date.parse("2026-11-08T15:57:51.024Z"));
    expect(heading).toBe("Recorded review · Nov 8, 2026");
    expect(heading).not.toMatch(/tranche|prime|G702|G703|AIA|CSI/i);
  });
});
