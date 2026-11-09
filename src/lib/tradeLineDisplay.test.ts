import { describe, expect, test } from "vitest";
import { hasDivisionCode, tradeLineDisplay } from "./tradeLineDisplay";

/**
 * The settled Lopez draw row stores this exact string. Pin it byte-for-byte before normalizing:
 * the frozen row is never edited, only presented without the CSI division code.
 */
const STORED_LOPEZ_TRADE_LINE = "Plumbing (22 00 00) \u2013 Ortiz Plumbing";

describe("residential draw trade line presentation", () => {
  test("records the stored Lopez string byte-for-byte", () => {
    expect(STORED_LOPEZ_TRADE_LINE).toBe("Plumbing (22 00 00) \u2013 Ortiz Plumbing");
    expect(STORED_LOPEZ_TRADE_LINE.length).toBe(36);
    expect(STORED_LOPEZ_TRADE_LINE.charCodeAt(20)).toBe(0x2013);
    expect(hasDivisionCode(STORED_LOPEZ_TRADE_LINE)).toBe(true);
  });

  test("an en-dash stored line drops the division code", () => {
    expect(tradeLineDisplay(STORED_LOPEZ_TRADE_LINE)).toBe("Plumbing \u2014 Ortiz Plumbing");
  });

  test("a literal question-mark separator is normalized the same way", () => {
    expect(tradeLineDisplay("Plumbing (22 00 00) ? Ortiz Plumbing")).toBe("Plumbing \u2014 Ortiz Plumbing");
  });

  test("a plain line is left alone", () => {
    expect(tradeLineDisplay("Demolition, rough-in and permits")).toBe("Demolition, rough-in and permits");
    expect(tradeLineDisplay("PCO #1 \u2013 Add under-cabinet lighting")).toBe("PCO #1 \u2013 Add under-cabinet lighting");
  });
});
