import { describe, expect, test } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { acceptedIndexesFor, agreementAwardFields, computeAwardSum, excludedScopeNotesFor } from "./awardMath";
import { buildLevelingRows } from "./levelingSummary";
import { attributePlugs, cleanPlugNote, exclusionScopeText } from "./levelingPlugs";

const EASTBAY = {
  baseAmountCents: 17_240_000,
  alternates: [
    { description: "Alt 1 – LED troffer upgrade", amountCents: 625_000 },
    { description: "Alt 2 – Generator transfer switch", amountCents: 1_180_000 },
  ],
  valueEngineeringAlternates: [] as NonNullable<Doc<"bids">["valueEngineeringAlternates"]>,
};

describe("computeAwardSum", () => {
  test("base bid only: a $15,000 plug never enters the sum", () => {
    const sum = computeAwardSum(EASTBAY, []);
    expect(sum.contractSumCents).toBe(17_240_000);
    expect(sum.acceptedAlternates).toEqual([]);
    expect(sum.declinedAlternates.map((a) => a.description)).toEqual([
      "Alt 1 – LED troffer upgrade",
      "Alt 2 – Generator transfer switch",
    ]);
  });

  test("accepted Alt 1 is added exactly; Alt 2 is declined", () => {
    const sum = computeAwardSum(EASTBAY, [0]);
    expect(sum.contractSumCents).toBe(17_865_000);
    expect(sum.acceptedAlternates).toEqual([{ description: "Alt 1 – LED troffer upgrade", amountCents: 625_000 }]);
    expect(sum.declinedAlternates).toEqual([{ description: "Alt 2 – Generator transfer switch", amountCents: 1_180_000 }]);
  });

  test("an accepted VE deduct lowers the sum exactly", () => {
    const sum = computeAwardSum(
      {
        ...EASTBAY,
        valueEngineeringAlternates: [
          { description: "Aluminum feeders", costDeductCents: 150_000, isAccepted: true } as any,
          { description: "Not accepted", costDeductCents: 99_999, isAccepted: false } as any,
        ],
      },
      [0],
    );
    expect(sum.contractSumCents).toBe(17_865_000 - 150_000);
    expect(sum.veDeducts).toEqual([{ description: "Aluminum feeders", amountCents: 150_000 }]);
  });

  test("rejects alternate indexes from outside the bid and non-positive sums", () => {
    expect(() => computeAwardSum(EASTBAY, [2])).toThrow(/alternates from this bid/);
    expect(() => computeAwardSum(EASTBAY, [-1])).toThrow(/alternates from this bid/);
    expect(() => computeAwardSum({ ...EASTBAY, baseAmountCents: 0, alternates: [] }, [])).toThrow(/zero or below/);
  });

  test("agreement fields mirror cents in dollars and carry excluded-scope notes", () => {
    const fields = agreementAwardFields(computeAwardSum(EASTBAY, [0]), ["Low-voltage cabling (27 00 00)"]);
    expect(fields).toMatchObject({
      contractSum: 178_650,
      contractSumCents: 17_865_000,
      baseBidCents: 17_240_000,
      excludedScopeNotes: ["Low-voltage cabling (27 00 00)"],
    });
  });

  test("re-award keeps previously accepted alternates by description", () => {
    expect(acceptedIndexesFor(EASTBAY, [{ description: "alt 2 – generator transfer switch", amountCents: 1 }])).toEqual([1]);
    expect(acceptedIndexesFor(EASTBAY, undefined)).toEqual([]);
  });

  test("excluded-scope notes come from the bid exclusions, de-duplicated", () => {
    expect(
      excludedScopeNotesFor({
        exclusions: ["Permit fees", " permit fees ", "Low-voltage cabling (27 00 00)"],
        identifiedExclusions: [],
      }),
    ).toEqual(["Permit fees", "Low-voltage cabling (27 00 00)"]);
    expect(
      excludedScopeNotesFor({
        exclusions: [],
        identifiedExclusions: [{ description: "Fire alarm rough-in", costImpactCents: 3_000_000, severity: "major", isWaived: false }],
      }),
    ).toEqual(["Fire alarm rough-in"]);
  });
});

function bid(id: string, name: string, baseAmountCents: number, plugs: { description: string; costImpactCents: number }[], receivedAt: number) {
  return {
    _id: id,
    contractorId: `c-${id}`,
    subcontractorName: name,
    baseAmountCents,
    baseAmount: baseAmountCents / 100,
    leveledTotalCents: 0,
    leveledTotal: 0,
    leadTimePenaltyCents: 0,
    coiPenaltyCents: 0,
    identifiedExclusions: plugs.map((p) => ({ ...p, severity: "major", isWaived: false })),
    valueEngineeringAlternates: [],
    alternates: [],
    isAwarded: false,
    receivedAt,
  } as unknown as Doc<"bids">;
}

describe("buildLevelingRows", () => {
  const bids = [
    bid("eastbay", "Eastbay Electric", 17_240_000, [{ description: "Low-voltage cabling (27 00 00)", costImpactCents: 1_500_000 }], 1),
    bid("oakland", "Oakland Power", 15_890_000, [
      { description: "Fire alarm rough-in", costImpactCents: 3_000_000 },
      { description: "Permit fees", costImpactCents: 0 },
    ], 2),
    bid("golden", "Golden Gate Electric", 18_100_000, [], 3),
  ];

  test("apparent low is the lowest base; leveled low is the lowest leveled total, exact to the cent", () => {
    const rows = buildLevelingRows({ status: "leveling" } as any, bids);
    expect(rows.map((r) => [r.subcontractorName, r.leveledTotalCents])).toEqual([
      ["Golden Gate Electric", 18_100_000],
      ["Eastbay Electric", 18_740_000],
      ["Oakland Power", 18_890_000],
    ]);
    expect(rows.find((r) => r.isApparentLow)!.subcontractorName).toBe("Oakland Power");
    expect(rows.find((r) => r.isLeveledLow)!.subcontractorName).toBe("Golden Gate Electric");
    const eastbay = rows.find((r) => r.subcontractorName === "Eastbay Electric")!;
    expect(eastbay.baseAmountCents).toBe(17_240_000);
    expect(eastbay.plugTotalCents).toBe(1_500_000);
    expect(rows.find((r) => r.subcontractorName === "Oakland Power")!.exclusions[1]).toMatchObject({ description: "Permit fees", amountCents: 0 });
    expect(rows.every((r) => r.status === "under_review")).toBe(true);
  });

  test("after award the winner is awarded and the others are not awarded", () => {
    const awarded = bids.map((b) => (b._id === ("eastbay" as any) ? { ...b, isAwarded: true } : b));
    const rows = buildLevelingRows({ status: "awarded" } as any, awarded);
    expect(Object.fromEntries(rows.map((r) => [r.subcontractorName, r.status]))).toEqual({
      "Eastbay Electric": "awarded",
      "Oakland Power": "not_awarded",
      "Golden Gate Electric": "not_awarded",
    });
    const stillLeveling = buildLevelingRows({ status: "leveling" } as any, awarded);
    expect(stillLeveling.filter((r) => r.status === "not_awarded")).toHaveLength(2);
  });
});

describe("attributePlugs", () => {
  const actor = { name: "Alex Rivera (Bayview Builders)" };
  const prev = [
    { description: "Low-voltage cabling (27 00 00)", costImpactCents: 1_500_000, severity: "major", isWaived: false, plugEnteredByName: "Pat GC", plugEnteredAt: 100, plugNote: "Comparison only" },
    { description: "Permit fees", costImpactCents: 0, severity: "minor", isWaived: false },
  ] as any[];

  test("a changed plug is attributed to the acting GC; an unchanged plug keeps its attribution", () => {
    const next = [
      { ...prev[0], plugEnteredByName: "Forged", plugEnteredAt: 1 },
      { ...prev[1], costImpactCents: 250_000, plugEnteredByName: "Forged" },
    ];
    const out = attributePlugs(prev, next, actor, 500);
    expect(out[0]).toMatchObject({ plugEnteredByName: "Pat GC", plugEnteredAt: 100, plugNote: "Comparison only" });
    expect(out[1]).toMatchObject({ costImpactCents: 250_000, plugEnteredByName: actor.name, plugEnteredAt: 500 });
  });

  test("a $0 plug carries no attribution and negative plugs pass through for validation", () => {
    const out = attributePlugs(prev, [{ ...prev[1], plugEnteredByName: "Forged" }, { ...prev[1], costImpactCents: -5 }], actor, 500);
    expect(out[0].plugEnteredByName).toBeUndefined();
    expect(out[1].costImpactCents).toBe(-5);
  });

  test("parser pricing reasoning is dropped from exclusion text; the scope stays", () => {
    expect(
      exclusionScopeText(
        "Permit fees explicitly excluded from the proposal. No dollar amount is stated and no benchmark rate exists for this item, so costImpact is 0 and the GC should carry the permit fees separately.",
      ),
    ).toBe("Permit fees explicitly excluded from the proposal.");
    expect(exclusionScopeText("Low-voltage cabling (27 00 00)")).toBe("Low-voltage cabling (27 00 00)");
    expect(exclusionScopeText("Crane hoisting. By others per owner contract.")).toBe("Crane hoisting. By others per owner contract.");
  });

  test("plug notes are trimmed and bounded", () => {
    expect(cleanPlugNote("  Comparison   only ")).toBe("Comparison only");
    expect(cleanPlugNote("   ")).toBeUndefined();
    expect(() => cleanPlugNote("x".repeat(201))).toThrow(/200 characters/);
  });
});
