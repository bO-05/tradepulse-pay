import { describe, expect, test } from "vitest";
import {
  COMMERCIAL_READ_ONLY_TITLE,
  RESIDENTIAL_READ_ONLY_TITLE,
  readOnlyReason,
  readOnlyTitle,
} from "./referenceCopy";

describe("read-only reference copy", () => {
  test("a residential record is a settled sandbox record", () => {
    expect(RESIDENTIAL_READ_ONLY_TITLE).toBe("Settled sandbox record · read-only.");
    expect(readOnlyTitle("residential")).toBe("Settled sandbox record · read-only.");
    expect(readOnlyReason("residential")).toBe("This settled sandbox record is read-only.");
  });

  test("a commercial record keeps the reference-job wording", () => {
    expect(COMMERCIAL_READ_ONLY_TITLE).toBe("Preserved reference job · read-only.");
    expect(readOnlyTitle("commercial")).toBe("Preserved reference job · read-only.");
    expect(readOnlyReason("commercial")).toBe("This preserved reference job is read-only.");
  });

  test("a missing kind means commercial, so no pre-existing record gains residential wording", () => {
    expect(readOnlyTitle(undefined)).toBe("Preserved reference job · read-only.");
    expect(readOnlyTitle(null)).toBe("Preserved reference job · read-only.");
    expect(readOnlyReason(undefined)).toBe("This preserved reference job is read-only.");
  });

  test("the residential copy never says Reference job", () => {
    expect(readOnlyTitle("residential")).not.toMatch(/reference job/i);
    expect(readOnlyReason("residential")).not.toMatch(/reference job/i);
  });
});
