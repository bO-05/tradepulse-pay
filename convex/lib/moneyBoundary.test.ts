/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";

// Every money conversion in the payment modules must go through convex/lib/money.ts.
const sources = {
  ...import.meta.glob("../payments/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../payApps/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../agent/**/*.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../kernel/**/*.ts", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

const FLOAT_FORMAT = /\.toFixed\(|parseFloat\(|Number\.parseFloat\(/;
const SCALE_BY_100 = /[*/]\s*100(?![\d_])|(?<![\d_.])100\s*\*|\*\s*0?\.01\b/;
// Percent-to-fraction math (pctToDate / 100) is fine; scaling a money value by 100 is not.
const MONEY_WORD = /cents|dollar|amount|contractSum|price|total|gross|net\b|retainage/i;

function violations(): string[] {
  const out: string[] = [];
  for (const [path, src] of Object.entries(sources)) {
    src.split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (FLOAT_FORMAT.test(code) || (SCALE_BY_100.test(code) && MONEY_WORD.test(code))) {
        out.push(`${path}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return out;
}

describe("money conversion boundary", () => {
  test("the scan covers all four payment module folders", () => {
    const folders = new Set(Object.keys(sources).map((p) => p.split("/")[1]));
    expect([...folders].sort()).toEqual(["agent", "kernel", "payApps", "payments"]);
  });

  test("no toFixed, parseFloat or cents/dollars scaling outside money.ts", () => {
    expect(violations()).toEqual([]);
  });

  test("the scanner flags the patterns it is meant to catch", () => {
    for (const bad of [
      "const s = (amountCents / 100).toFixed(2);",
      "const cents = Math.round(dollars * 100);",
      "const total = parseFloat(value);",
      "const dollars = grossCents * 0.01;",
    ]) {
      expect(FLOAT_FORMAT.test(bad) || (SCALE_BY_100.test(bad) && MONEY_WORD.test(bad)), bad).toBe(true);
    }
    expect(SCALE_BY_100.test("clamp01(line.pctCompleteToDate / 100)") && MONEY_WORD.test("clamp01(line.pctCompleteToDate / 100)")).toBe(false);
  });
});
