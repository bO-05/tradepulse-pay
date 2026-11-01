import { describe, expect, test } from "vitest";
import {
  bpsToEditableText,
  centsToEditableText,
  maskMoneyInput,
  maskPercentInput,
  parseMoneyToCents,
  parsePercentToBps,
} from "./masks";

describe("maskMoneyInput", () => {
  test("letters are removed and flagged", () => {
    expect(maskMoneyInput("abc")).toEqual({ text: "", rejected: true });
    expect(maskMoneyInput("12a3")).toEqual({ text: "123", rejected: true });
  });

  test("keeps at most two decimals", () => {
    expect(maskMoneyInput("1234567.891")).toEqual({ text: "1234567.89", rejected: true });
    expect(maskMoneyInput("1.2.3")).toEqual({ text: "1.23", rejected: true });
  });

  test("commas and $ are formatting, not errors", () => {
    expect(maskMoneyInput("$1,234.56")).toEqual({ text: "1234.56", rejected: false });
  });

  test("negatives only when allowed", () => {
    expect(maskMoneyInput("-5")).toEqual({ text: "5", rejected: true });
    expect(maskMoneyInput("-5", { allowNegative: true })).toEqual({ text: "-5", rejected: false });
    expect(maskMoneyInput("5-", { allowNegative: true })).toEqual({ text: "5", rejected: true });
  });
});

describe("parseMoneyToCents", () => {
  test("returns integer cents", () => {
    expect(parseMoneyToCents("1234567.89")).toEqual({ ok: true, value: 123456789 });
    expect(parseMoneyToCents("$1,234.5")).toEqual({ ok: true, value: 123450 });
    expect(parseMoneyToCents(".5")).toEqual({ ok: true, value: 50 });
    expect(parseMoneyToCents("0.07")).toEqual({ ok: true, value: 7 });
    expect(parseMoneyToCents("")).toEqual({ ok: true, value: null });
  });

  test("rejects non-numeric text", () => {
    expect(parseMoneyToCents("abc").ok).toBe(false);
    expect(parseMoneyToCents("12abc").ok).toBe(false);
    expect(parseMoneyToCents("1e5").ok).toBe(false);
    expect(parseMoneyToCents(".").ok).toBe(false);
  });

  test("rejects more than two decimals and disallowed negatives", () => {
    expect(parseMoneyToCents("1234567.891")).toEqual({ ok: false, error: "Use at most two decimals (cents)." });
    expect(parseMoneyToCents("-5")).toEqual({ ok: false, error: "Amount can't be negative." });
    expect(parseMoneyToCents("-1,250", { allowNegative: true })).toEqual({ ok: true, value: -125000 });
  });

  test("stored values are always safe integers", () => {
    for (const text of ["0.1", "0.2", "19.99", "1000000.01"]) {
      const result = parseMoneyToCents(text);
      expect(result.ok && Number.isInteger(result.value)).toBe(true);
    }
    expect(parseMoneyToCents("99999999999999").ok).toBe(false);
  });
});

describe("percent", () => {
  test("mask keeps two decimals and rejects letters/negatives", () => {
    expect(maskPercentInput("abc")).toEqual({ text: "", rejected: true });
    expect(maskPercentInput("5.255")).toEqual({ text: "5.25", rejected: true });
    expect(maskPercentInput("-5")).toEqual({ text: "5", rejected: true });
    expect(maskPercentInput("7.5%")).toEqual({ text: "7.5", rejected: false });
  });

  test("parses to basis points", () => {
    expect(parsePercentToBps("5")).toEqual({ ok: true, value: 500 });
    expect(parsePercentToBps("7.5")).toEqual({ ok: true, value: 750 });
    expect(parsePercentToBps("12.25%")).toEqual({ ok: true, value: 1225 });
    expect(parsePercentToBps("")).toEqual({ ok: true, value: null });
  });

  test("rejects invalid percents", () => {
    expect(parsePercentToBps("abc").ok).toBe(false);
    expect(parsePercentToBps("-5").ok).toBe(false);
    expect(parsePercentToBps("5.255").ok).toBe(false);
    expect(parsePercentToBps("101").ok).toBe(false);
    expect(parsePercentToBps("6", { max: 5 })).toEqual({ ok: false, error: "Percent can't be more than 5%." });
  });
});

describe("editable text", () => {
  test("round-trips cents and bps", () => {
    expect(centsToEditableText(123456)).toBe("1234.56");
    expect(centsToEditableText(-125000)).toBe("-1250.00");
    expect(centsToEditableText(null)).toBe("");
    expect(bpsToEditableText(750)).toBe("7.5");
    expect(bpsToEditableText(1000)).toBe("10");
  });
});
