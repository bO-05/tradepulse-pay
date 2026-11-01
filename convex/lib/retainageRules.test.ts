import { describe, expect, test } from "vitest";
import { checkRetainage, defaultRetainage, effectiveRetainageCapBps, RETAINAGE_RULES } from "./retainageRules";
import { validateProjectSetup, type ProjectSetupInput } from "./projectSetup";

describe("retainage rules", () => {
  test("encodes the researched states", () => {
    expect(RETAINAGE_RULES.map((r) => r.state).sort()).toEqual(["AZ", "CA", "CO", "FL", "NV", "NY", "OR", "TX", "WA"]);
  });

  test("CA blocks 10% citing §8811 and 'not legal advice'; 5% and 4.5% pass", () => {
    const r = checkRetainage("CA", 124_000_000, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("5%");
      expect(r.message).toContain("Cal. Civ. Code §8811");
      expect(r.message).toContain("not legal advice");
    }
    expect(checkRetainage("CA", 124_000_000, 500).ok).toBe(true);
    expect(checkRetainage("CA", 124_000_000, 450).ok).toBe(true);
  });

  test.each([
    ["NV", "NRS 624.609"],
    ["WA", "SB 5528 (2023)"],
    ["OR", "ORS 701.420"],
  ])("%s caps at 5%% for a $90,000.00 contract with its own citation", (state, citation) => {
    const r = checkRetainage(state, 9_000_000, 600);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain(citation);
      expect(r.message).toContain("5%");
      expect(r.message).toContain("not legal advice");
      for (const other of ["Cal. Civ. Code", "NRS", "SB 5528", "ORS", "756-c", "38-46"].filter((c) => !citation.startsWith(c))) {
        expect(r.message).not.toContain(other);
      }
    }
    expect(checkRetainage(state, 9_000_000, 500).ok).toBe(true);
  });

  test.each([
    ["NY", "N.Y. Gen. Bus. Law §756-c"],
    ["CO", "C.R.S. §38-46-103"],
  ])("%s applies the cap at exactly $150,000.00 and not one cent below", (state, citation) => {
    expect(checkRetainage(state, 14_999_999, 1000).ok).toBe(true);
    const at = checkRetainage(state, 15_000_000, 1000);
    expect(at.ok).toBe(false);
    if (!at.ok) {
      expect(at.message).toContain(citation);
      expect(at.message).toContain("not legal advice");
    }
    expect(checkRetainage(state, 15_000_000, 500).ok).toBe(true);
  });

  test.each(["TX", "AZ", "FL"])("%s has no private cap; 10%% passes with an informational note", (state) => {
    const r = checkRetainage(state, 61_250_000, 1000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.note).toContain("not legal advice");
    expect(effectiveRetainageCapBps(state, 61_250_000)).toBeNull();
  });

  test("default retainage is min(company default, state cap)", () => {
    expect(defaultRetainage(1000, "CA", null)).toMatchObject({ bps: 500, loweredToCap: true });
    expect(defaultRetainage(1000, "AZ", null)).toMatchObject({ bps: 1000, loweredToCap: false });
    expect(defaultRetainage(400, "CA", null)).toMatchObject({ bps: 400, loweredToCap: false });
    expect(defaultRetainage(undefined, "CA", null).bps).toBe(500);
    expect(defaultRetainage(1000, "NY", 14_999_999).bps).toBe(1000);
    expect(defaultRetainage(1000, "NY", 15_000_000).bps).toBe(500);
  });
});

describe("project setup validation", () => {
  const valid: ProjectSetupInput = {
    title: "Harbor Point Dental Office TI",
    ownerName: "Harbor Point Dental LLC",
    address: { line1: "455 Embarcadero W", city: "Oakland", zip: "94607" },
    state: "CA",
    contractValueCents: 124_000_000,
    retainageBps: 500,
    billingDay: 25,
    startDate: "2026-10-01",
    substantialCompletionDate: "2027-05-28",
  };

  test("the standard CA project is valid", () => {
    expect(validateProjectSetup(valid)).toEqual({});
  });

  test("each invalid value is reported on its own field", () => {
    expect(validateProjectSetup({ ...valid, title: " " }).title).toBeDefined();
    expect(validateProjectSetup({ ...valid, state: "" }).state).toBeDefined();
    expect(validateProjectSetup({ ...valid, contractValueCents: 0 }).contractValueCents).toBeDefined();
    expect(validateProjectSetup({ ...valid, contractValueCents: -1 }).contractValueCents).toBeDefined();
    expect(validateProjectSetup({ ...valid, contractValueCents: null }).contractValueCents).toBeDefined();
    expect(validateProjectSetup({ ...valid, contractValueCents: 12.5 }).contractValueCents).toBeDefined();
    for (const day of [0, 29, 31, null]) {
      expect(validateProjectSetup({ ...valid, billingDay: day }).billingDay).toBe("Billing day must be between 1 and 28.");
    }
    expect(validateProjectSetup({ ...valid, address: { ...valid.address, zip: "9460" } }).zip).toBeDefined();
    expect(validateProjectSetup({ ...valid, substantialCompletionDate: "2026-09-30" }).substantialCompletionDate).toBeDefined();
    expect(validateProjectSetup({ ...valid, retainageBps: 12_000 }).retainageBps).toBe("Retainage must be between 0% and 100%.");
    expect(validateProjectSetup({ ...valid, retainageBps: -1 }).retainageBps).toBeDefined();
    expect(validateProjectSetup({ ...valid, retainageBps: 1000 }).retainageBps).toContain("Cal. Civ. Code §8811");
    expect(validateProjectSetup({ ...valid, startDate: "2026-02-30" }).startDate).toBeDefined();
  });

  test("substantial completion is optional", () => {
    expect(validateProjectSetup({ ...valid, substantialCompletionDate: "" })).toEqual({});
    expect(validateProjectSetup({ ...valid, substantialCompletionDate: undefined })).toEqual({});
  });
});
