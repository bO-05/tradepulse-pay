import { describe, expect, test } from "vitest";
import { validateBidTerms, type BidTermsInput } from "./bidTerms";

const TODAY = "2026-05-01";
const valid: BidTermsInput = {
  baseAmountCents: 17_490_000,
  alternates: [
    { description: "Alt 1 – LED troffer upgrade", amountCents: 625_000 },
    { description: "Alt 2 – Generator transfer switch", amountCents: 1_180_000 },
  ],
  exclusions: ["Permit fees", "Low-voltage cabling (27 00 00)"],
  inclusions: ["Temporary power", "Fire alarm rough-in"],
  unitPrices: [{ item: "Additional duplex receptacle", unit: "each", unitPriceCents: 18_500 }],
  qualifications: "Normal working hours.",
  validUntil: "2026-12-31",
};

const errorsOf = (input: Partial<BidTermsInput>) => {
  const r = validateBidTerms({ ...valid, ...input }, { today: TODAY });
  return r.ok ? {} : r.errors;
};

describe("validateBidTerms", () => {
  test("accepts a complete bid and keeps every value in cents", () => {
    const r = validateBidTerms(valid, { today: TODAY });
    expect(r).toEqual({ ok: true, terms: valid });
  });

  test("the base bid must be a positive whole number of cents", () => {
    expect(errorsOf({ baseAmountCents: null }).base).toBe("Enter the base bid amount.");
    expect(errorsOf({ baseAmountCents: 0 }).base).toBe("The base bid must be more than $0.00.");
    expect(errorsOf({ baseAmountCents: -10_000 }).base).toBe("The base bid must be more than $0.00.");
    expect(errorsOf({ baseAmountCents: 1724.5 }).base).toMatch(/dollar amount/);
    expect(errorsOf({ baseAmountCents: 100_000_000_001 }).base).toMatch(/can't be more/);
  });

  test("an alternate needs a description and a non-zero amount; deducts are allowed", () => {
    expect(errorsOf({ alternates: [{ description: "", amountCents: 150_000 }] })["alternates.0.description"]).toBe("Describe this alternate.");
    expect(errorsOf({ alternates: [{ description: "Alt 3", amountCents: null }] })["alternates.0.amount"]).toMatch(/minus sign/);
    expect(errorsOf({ alternates: [{ description: "Alt 3", amountCents: 0 }] })["alternates.0.amount"]).toBe("An alternate can't be $0.00.");
    const deduct = validateBidTerms({ ...valid, alternates: [{ description: "Deduct: owner-furnished fixtures", amountCents: -150_000 }] }, { today: TODAY });
    expect(deduct.ok && deduct.terms.alternates).toEqual([{ description: "Deduct: owner-furnished fixtures", amountCents: -150_000 }]);
  });

  test("blank alternate and unit-price rows are dropped", () => {
    const r = validateBidTerms(
      { ...valid, alternates: [{ description: " ", amountCents: null }], unitPrices: [{ item: "", unit: "", unitPriceCents: null }] },
      { today: TODAY },
    );
    expect(r.ok && [r.terms.alternates, r.terms.unitPrices]).toEqual([[], []]);
  });

  test("a unit price needs an item, a unit and a positive price", () => {
    const e = errorsOf({ unitPrices: [{ item: "Receptacle", unit: "", unitPriceCents: 18_500 }] });
    expect(e["unitPrices.0.unit"]).toMatch(/Enter the unit/);
    expect(errorsOf({ unitPrices: [{ item: "", unit: "each", unitPriceCents: 18_500 }] })["unitPrices.0.item"]).toMatch(/Name the item/);
    expect(errorsOf({ unitPrices: [{ item: "Receptacle", unit: "each", unitPriceCents: -1 }] })["unitPrices.0.price"]).toMatch(/more than \$0.00/);
  });

  test("valid-until must be a real date that is not in the past", () => {
    expect(errorsOf({ validUntil: "2026-04-30" }).validUntil).toBe("The valid-until date can't be in the past.");
    expect(errorsOf({ validUntil: "2026-02-30" }).validUntil).toBe("Enter a valid date.");
    expect(errorsOf({ validUntil: TODAY }).validUntil).toBeUndefined();
  });

  test("lists are trimmed and de-duplicated", () => {
    const r = validateBidTerms({ ...valid, exclusions: ["  Permit   fees ", "Permit fees", ""] }, { today: TODAY });
    expect(r.ok && r.terms.exclusions).toEqual(["Permit fees"]);
  });
});
