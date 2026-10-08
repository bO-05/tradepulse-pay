import { describe, expect, test } from "vitest";
import { milestoneFundingLabel, milestoneFundingState } from "./milestoneFundingState";

const auth = (status: string, capturedCents = 0) => ({ status, paypalAuthorizationId: "AUTH-1", capturedCents });

describe("milestoneFundingState", () => {
  test("no funding attempt or one that holds no money is not funded", () => {
    expect(milestoneFundingState("planned", null)).toBe("not_funded");
    expect(milestoneFundingState("funding", { status: "created", paypalAuthorizationId: null })).toBe("not_funded");
    expect(milestoneFundingState("funding", { status: "approved" })).toBe("not_funded");
    expect(milestoneFundingState("planned", { status: "failed" })).toBe("not_funded");
    expect(milestoneFundingState("funding_expired", auth("expired"))).toBe("not_funded");
    expect(milestoneFundingState("planned", auth("voided"))).toBe("not_funded");
  });

  test("an authorized funding payment is funded", () => {
    expect(milestoneFundingState("funded", auth("authorized"))).toBe("funded");
  });

  test("partial, full and closed captures are captured", () => {
    expect(milestoneFundingState("funded", auth("partially_captured", 500))).toBe("captured");
    expect(milestoneFundingState("complete", auth("captured", 1_000))).toBe("captured");
    expect(milestoneFundingState("complete", auth("voided", 500))).toBe("captured");
  });

  test("a paid milestone is paid whatever the funding row says", () => {
    expect(milestoneFundingState("paid", auth("captured", 1_000))).toBe("paid");
    expect(milestoneFundingState("paid", null)).toBe("paid");
  });

  test("labels are plain text", () => {
    expect(milestoneFundingLabel("not_funded")).toBe("Not funded");
    expect(milestoneFundingLabel("funded")).toBe("Funded (authorized)");
    expect(milestoneFundingLabel("captured")).toBe("Captured");
    expect(milestoneFundingLabel("paid")).toBe("Paid");
  });
});
