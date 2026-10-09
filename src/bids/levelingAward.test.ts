import { describe, expect, test } from "vitest";
import type { LevelingRow } from "../../convex/lib/levelingSummary";
import { awardPreviewCents, levelingCsv } from "./LevelingAwardPanel";

function row(name: string, base: number, plug: number, extra: Partial<LevelingRow> = {}): LevelingRow {
  return {
    bidId: name as LevelingRow["bidId"],
    contractorId: name as LevelingRow["contractorId"],
    subcontractorName: name,
    baseAmountCents: base,
    exclusions: plug > 0 ? [{ index: 0, description: "Low-voltage cabling (27 00 00)", amountCents: plug, waived: false, note: null, enteredByName: "Dana Lee", enteredAt: 1 }] : [],
    plugTotalCents: plug,
    leadTimePenaltyCents: 0,
    coiPenaltyCents: 0,
    veDeductCents: 0,
    leveledTotalCents: base + plug,
    alternates: [
      { description: "Alt 1 – LED troffer upgrade", amountCents: 625_000 },
      { description: "Alt 2 – Generator transfer switch", amountCents: 1_180_000 },
    ],
    isApparentLow: false,
    isLeveledLow: false,
    status: "under_review",
    revisionNumber: 2,
    receivedAt: 1,
    ...extra,
  };
}

describe("award preview", () => {
  test("is base plus accepted alternates; plugs never count", () => {
    const eastbay = row("Eastbay Electric", 17_240_000, 1_500_000);
    expect(awardPreviewCents(eastbay, [])).toBe(17_240_000);
    expect(awardPreviewCents(eastbay, [0])).toBe(17_865_000);
    expect(awardPreviewCents({ ...eastbay, veDeductCents: 150_000 }, [0])).toBe(17_715_000);
  });
});

describe("leveling CSV", () => {
  test("matches the screen totals and escapes formulas", () => {
    const csv = levelingCsv([
      row("Golden Gate Electric", 18_100_000, 0, { isLeveledLow: true }),
      row("=HYPERLINK(\"x\")", 17_240_000, 1_500_000, { isApparentLow: true }),
    ]);
    const lines = csv.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toContain('"Leveled (comparison only)"');
    expect(lines[1]).toContain('"$181,000.00"');
    expect(lines[2]).toContain('"$172,400.00","$15,000.00"');
    expect(lines[2]).toContain('"$187,400.00"');
    expect(lines[2].startsWith(`"'=HYPERLINK`)).toBe(true);
    expect(lines[2]).toContain("entered by Dana Lee");
    expect(csv).not.toMatch(/deceptive/i);
  });
});
