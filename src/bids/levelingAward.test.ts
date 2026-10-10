import { describe, expect, test } from "vitest";
import type { LevelingRow } from "../../convex/lib/levelingSummary";
import { computeAwardSum } from "../../convex/lib/awardMath";
import { awardConfirmation, levelingRowAwardInput } from "./awardConfirm";
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
    veDeducts: [],
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
    expect(awardPreviewCents({ ...eastbay, veDeducts: [{ description: "Aluminum feeders", amountCents: 150_000 }] }, [0])).toBe(17_715_000);
  });

  test("every award dialog lists accepted VE deducts and shows the shared award sum (PROC-SCRUTINY-006)", () => {
    const legacyBid = {
      baseAmountCents: 17_240_000,
      alternates: [{ description: "Alt 1 – LED troffer upgrade", amountCents: 625_000 }],
      valueEngineeringAlternates: [
        { description: "Aluminum feeders", costDeductCents: 150_000, isAccepted: true },
        { description: "PVC conduit", costDeductCents: 90_000, isAccepted: false },
      ],
    };
    const legacy = awardConfirmation(legacyBid, []);
    expect(legacy.contractSumCents).toBe(17_090_000);
    expect(legacy.contractSumCents).toBe(computeAwardSum(legacyBid, []).contractSumCents);
    expect(legacy.details).toContainEqual({ label: "Accepted VE deducts", value: "Aluminum feeders (−$1,500.00)" });
    expect(legacy.details.map((d) => d.value).join(" ")).not.toContain("PVC conduit");
    expect(legacy.error).toBeNull();

    const panel = row("Eastbay Electric", 17_240_000, 1_500_000, { veDeducts: [{ description: "Aluminum feeders", amountCents: 150_000 }], veDeductCents: 150_000 });
    const confirm = awardConfirmation(levelingRowAwardInput(panel), [0]);
    expect(confirm.contractSumCents).toBe(17_715_000);
    expect(confirm.details).toEqual([
      { label: "Base bid", value: "$172,400.00" },
      { label: "Accepted alternates", value: "Alt 1 – LED troffer upgrade ($6,250.00)" },
      { label: "Accepted VE deducts", value: "Aluminum feeders (−$1,500.00)" },
      { label: "Leveling plugs", value: "Not included" },
    ]);
  });

  test("a deduct that takes the sum to $0.00 is explained before the server refuses it", () => {
    const r = awardConfirmation({ baseAmountCents: 100_000, valueEngineeringAlternates: [{ description: "Delete scope", costDeductCents: 100_000, isAccepted: true }] }, []);
    expect(r.contractSumCents).toBe(0);
    expect(r.error).toMatch(/zero or below/);
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
