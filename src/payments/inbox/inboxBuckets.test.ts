import { describe, expect, test } from "vitest";
import { inboxGroup, payAppStatusLabel } from "./inboxBuckets";

describe("approval inbox buckets", () => {
  test("open work stays in front of the GC", () => {
    for (const status of ["submitted", "under_review", "reviewed"]) expect(inboxGroup(status)).toBe("active");
  });

  test("approved work waits for payment, settled work moves to history", () => {
    for (const status of ["approved", "approved_as_noted"]) expect(inboxGroup(status)).toBe("waiting");
    for (const status of ["paid", "rejected", "revision_requested", "unknown"]) expect(inboxGroup(status)).toBe("history");
  });

  test("status labels are readable and preserve unknown values", () => {
    expect(payAppStatusLabel("reviewed")).toBe("Ready for decision");
    expect(payAppStatusLabel("approved_as_noted")).toBe("Approved as noted");
    expect(payAppStatusLabel("some_new_status")).toBe("some new status");
  });
});
