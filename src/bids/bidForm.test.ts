import { describe, expect, test } from "vitest";
import { EMPTY_BID_FORM, bidFormFrom, bidSourceLabel, blankAlternate, blankUnitPrice, checkBidForm, removeBidFormRow, rowMaskKey } from "./bidForm";

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

  describe("removing optional rows (PROC-SCRUTINY-004)", () => {
    const BAD = "Use numbers only, with up to two decimals.";
    const twoAlternates = () => {
      const a = blankAlternate();
      const b = blankAlternate();
      return {
        form: { ...EMPTY_BID_FORM, baseAmountCents: 17_240_000, alternates: [a, b] },
        a,
        b,
      };
    };

    test("an invalid alternate amount blocks submit until its row is removed; then the bid is valid", () => {
      const { form, a, b } = twoAlternates();
      const filled = { ...form, alternates: [a, { ...b, description: "Upgrade fixtures", amountCents: 150_000 }] };
      const maskErrors = { [rowMaskKey("alternates", a.rowId)]: BAD };
      const blocked = checkBidForm(filled, maskErrors, TODAY);
      expect(blocked.ok === false && blocked.errors["alternates.0.amount"]).toBe(BAD);

      const next = removeBidFormRow({ form: filled, maskErrors, errors: blocked.ok ? {} : blocked.errors }, "alternates", a.rowId);
      expect(next.form.alternates.map((r) => r.rowId)).toEqual([b.rowId]);
      expect(next.errors).toEqual({});
      const r = checkBidForm(next.form, next.maskErrors, TODAY);
      expect(r.ok && r.terms.alternates).toEqual([{ description: "Upgrade fixtures", amountCents: 150_000 }]);
    });

    test("a mask error left behind by a removed row never blocks submit", () => {
      const { form, b } = twoAlternates();
      const onlyB = { ...form, alternates: [b] };
      const r = checkBidForm(onlyB, { [rowMaskKey("alternates", "gone-row")]: BAD }, TODAY);
      expect(r.ok).toBe(true);
    });

    test("removing an earlier row keeps a later row's error attached to that row", () => {
      const { form, a, b } = twoAlternates();
      const filled = { ...form, alternates: [{ ...a, description: "Deduct", amountCents: -50_000 }, { ...b, description: "Bad" }] };
      const maskErrors = { [rowMaskKey("alternates", b.rowId)]: BAD };
      const blocked = checkBidForm(filled, maskErrors, TODAY);
      expect(blocked.ok === false && blocked.errors["alternates.1.amount"]).toBe(BAD);

      const next = removeBidFormRow({ form: filled, maskErrors, errors: blocked.ok ? {} : blocked.errors }, "alternates", a.rowId);
      expect(next.errors).toEqual({ "alternates.0.amount": BAD });
      const again = checkBidForm(next.form, next.maskErrors, TODAY);
      expect(again.ok === false && again.errors).toEqual({ "alternates.0.amount": BAD });
    });

    test("removing an invalid unit-price row lets the bid submit", () => {
      const u = blankUnitPrice();
      const filled = { ...EMPTY_BID_FORM, baseAmountCents: 17_240_000, unitPrices: [{ ...u, item: "Duplex receptacle", unit: "each" }] };
      const maskErrors = { [rowMaskKey("unitPrices", u.rowId)]: BAD };
      const blocked = checkBidForm(filled, maskErrors, TODAY);
      expect(blocked.ok === false && blocked.errors["unitPrices.0.price"]).toBe(BAD);
      const next = removeBidFormRow({ form: filled, maskErrors, errors: blocked.ok ? {} : blocked.errors }, "unitPrices", u.rowId);
      const r = checkBidForm(next.form, next.maskErrors, TODAY);
      expect(r.ok && r.terms.unitPrices).toEqual([]);
    });

    test("a revision form gives every prefilled row its own id", () => {
      const form = bidFormFrom({
        baseAmountCents: 100,
        alternates: [{ description: "A", amountCents: 1 }, { description: "B", amountCents: 2 }],
        exclusions: [],
        inclusions: [],
        unitPrices: [],
      });
      expect(new Set(form.alternates.map((r) => r.rowId)).size).toBe(2);
      expect(form.unitPrices).toHaveLength(1);
    });
  });

  test("source labels", () => {
    expect(bidSourceLabel("portal")).toBe("Bid portal");
    expect(bidSourceLabel("gc_entered")).toBe("Entered by GC");
    expect(bidSourceLabel("email_ai")).toBe("From email (AI-parsed)");
  });
});
