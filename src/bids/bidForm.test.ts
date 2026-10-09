import { describe, expect, test } from "vitest";
import { EMPTY_BID_FORM, bidFormFrom, bidSourceLabel, checkBidForm } from "./bidForm";

const TODAY = "2026-05-01";

describe("bid form", () => {
  test("a blank form asks for the base bid; blank alternate and unit-price rows are ignored", () => {
    const r = checkBidForm(EMPTY_BID_FORM, {}, TODAY);
    expect(r).toEqual({ ok: false, errors: { base: "Enter the base bid amount." } });
  });

  test("the money input's own error wins over 'enter an amount'", () => {
    const r = checkBidForm(EMPTY_BID_FORM, { base: "Use numbers only, with up to two decimals.", "alternates.0.amount": null }, TODAY);
    expect(r.ok === false && r.errors.base).toBe("Use numbers only, with up to two decimals.");
  });

  test("exclusions and inclusions are one per line", () => {
    const r = checkBidForm({ ...EMPTY_BID_FORM, baseAmountCents: 17_490_000, exclusions: "Permit fees\n\n Low-voltage cabling (27 00 00) ", inclusions: "Temporary power" }, {}, TODAY);
    expect(r.ok && [r.terms.exclusions, r.terms.inclusions]).toEqual([["Permit fees", "Low-voltage cabling (27 00 00)"], ["Temporary power"]]);
  });

  test("a revision starts from the current terms", () => {
    const form = bidFormFrom({ baseAmountCents: 100, alternates: [], exclusions: ["A", "B"], inclusions: [], unitPrices: [], validUntil: "2026-12-31" });
    expect(form).toMatchObject({ baseAmountCents: 100, exclusions: "A\nB", validUntil: "2026-12-31", note: "" });
  });

  test("source labels", () => {
    expect(bidSourceLabel("portal")).toBe("Bid portal");
    expect(bidSourceLabel("gc_entered")).toBe("Entered by GC");
    expect(bidSourceLabel("email_ai")).toBe("From email (AI-parsed)");
  });
});
