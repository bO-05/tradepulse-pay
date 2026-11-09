import { describe, expect, test } from "vitest";
import { maskSharedEmail } from "./demoPrivacy";

describe("shared demo addresses are masked on screen", () => {
  test("maskSharedEmail hides a sandbox alias local part", () => {
    expect(maskSharedEmail("owner-q97f6pmh2d5qn733jmh5pg4c3x8hr9sn@example.com")).toBe("[demo inbox]@example.com");
  });

  test("maskSharedEmail hides a demo account local part", () => {
    expect(maskSharedEmail("owner@demo.tradepulse")).toBe("[demo inbox]@demo.tradepulse");
  });

  test("maskSharedEmail leaves a real customer address intact", () => {
    expect(maskSharedEmail("dana@bayview.example.org")).toBe("dana@bayview.example.org");
  });

  test("maskSharedEmail handles missing values", () => {
    expect(maskSharedEmail(null)).toBeNull();
    expect(maskSharedEmail(undefined)).toBeNull();
    expect(maskSharedEmail("not-an-address")).toBe("Demo inbox");
  });
});
