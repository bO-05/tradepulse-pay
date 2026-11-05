import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const src = readFileSync(new URL("./useJudgeDemoDriver.ts", import.meta.url), "utf8");

test("the guided demo's edit reason names a concrete line and promises no waiver or resubmit", () => {
  const line = src.split("\n").find((l) => l.includes("reason: `GC approved"));
  expect(line).toBeDefined();
  expect(line!).toContain("Line 2");
  expect(line!).toContain("excluded scope");
  expect(line!).toContain("unapproved and stays unpaid");
  const lower = line!.toLowerCase();
  // R7 N-10: the demo agreements have the waiver gate off, and the edit does not reschedule work,
  // so neither a waiver nor a resubmit path may be promised to the sub.
  expect(lower).not.toContain("waiver");
  expect(lower).not.toContain("resubmit");
  expect(line!).not.toContain("90%");
});
