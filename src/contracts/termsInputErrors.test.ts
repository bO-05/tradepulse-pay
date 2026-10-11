import { describe, expect, test } from "vitest";
import {
  draftFromTerms,
  firstTermsError,
  termsErrorsWithInput,
  termsFromDraft,
  type AgreementTerms,
} from "../../convex/lib/agreementTerms";
import { maskedNumberChange, maskMoneyInput, maskPercentInput, parseMoneyToCents, parsePercentToBps } from "../ui/masks";

const SAVED: AgreementTerms = {
  retainageBps: 500,
  retainageReductionBpsAt50: 250,
  paymentTerms: { type: "net", days: 30 },
  liquidatedDamagesCentsPerDay: 25_000,
  insurance: {
    glEachOccurrenceCents: 100_000_000,
    glAggregateCents: 200_000_000,
    autoCents: 100_000_000,
    umbrellaCents: 500_000_000,
    workersComp: true,
    additionalInsured: true,
  },
  warrantyMonths: 12,
  governingState: "CA",
};
const CTX = { projectState: "CA", contractSumCents: 17_240_000, primeRetainageBps: 500 };

const money = (raw: string) => maskedNumberChange(raw, maskMoneyInput, (t) => parseMoneyToCents(t), "Use numbers only.");
const percent = (raw: string) => maskedNumberChange(raw, maskPercentInput, (t) => parsePercentToBps(t), "Use numbers only.");

describe("masked numeric input reports invalid text separately from an empty field", () => {
  test("rejected or unparseable text is invalid, not an empty value", () => {
    for (const r of [money("-1"), money("abc"), money("."), percent("-1"), percent("abc"), percent("150")]) {
      expect(r.value).toBeNull();
      expect(r.invalid).toEqual(expect.any(String));
    }
  });

  test("a cleared field is empty and valid; a number is valid", () => {
    expect(money("")).toMatchObject({ value: null, invalid: null });
    expect(percent("")).toMatchObject({ value: null, invalid: null });
    expect(money("250")).toMatchObject({ value: 25_000, invalid: null });
    expect(percent("2.5")).toMatchObject({ value: 250, invalid: null });
  });
});

describe("invalid optional terms block Save instead of deleting the saved term", () => {
  test("an invalid LD per day keeps an inline error and blocks Save", () => {
    const draft = { ...draftFromTerms(SAVED), liquidatedDamagesCentsPerDay: money("-1").value };
    const errors = termsErrorsWithInput(draft, CTX, { liquidatedDamagesCentsPerDay: money("-1").invalid! });
    expect(errors.liquidatedDamagesCentsPerDay).toEqual(expect.any(String));
    expect(firstTermsError(errors)?.field).toBe("liquidatedDamagesCentsPerDay");
  });

  test("an invalid retainage reduction keeps an inline error and blocks Save", () => {
    const draft = { ...draftFromTerms(SAVED), retainageReductionBpsAt50: percent("abc").value };
    const errors = termsErrorsWithInput(draft, CTX, { retainageReductionBpsAt50: percent("abc").invalid! });
    expect(firstTermsError(errors)?.field).toBe("retainageReductionBpsAt50");
  });

  test("only an explicitly cleared optional field removes the term", () => {
    const draft = { ...draftFromTerms(SAVED), liquidatedDamagesCentsPerDay: money("").value, retainageReductionBpsAt50: percent("").value };
    const errors = termsErrorsWithInput(draft, CTX, {});
    expect(firstTermsError(errors)).toBeNull();
    const terms = termsFromDraft(draft);
    expect(terms.liquidatedDamagesCentsPerDay).toBeUndefined();
    expect(terms.retainageReductionBpsAt50).toBeUndefined();
  });
});
