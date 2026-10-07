import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import {
  assertMilestoneTransition,
  assertPaymentTransition,
  canTransitionMilestone,
  canTransitionPayment,
  isTerminalPaymentStatus,
} from "./stateMachine";

function errorOf(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("funding transitions", () => {
  test("the happy path is legal", () => {
    const path = ["created", "approved", "authorized", "partially_captured", "captured"];
    for (let i = 1; i < path.length; i++) expect(canTransitionPayment("funding", path[i - 1], path[i])).toBe(true);
    expect(canTransitionPayment("funding", "authorized", "captured")).toBe(true);
    expect(canTransitionPayment("funding", "partially_captured", "voided")).toBe(true);
    expect(canTransitionPayment("funding", "authorized", "expired")).toBe(true);
  });

  test("declines and abandoned orders can fail before authorization", () => {
    expect(canTransitionPayment("funding", "created", "failed")).toBe(true);
    expect(canTransitionPayment("funding", "approved", "failed")).toBe(true);
    expect(canTransitionPayment("funding", "created", "expired")).toBe(true);
  });

  test.each([
    ["created", "authorized"],
    ["created", "captured"],
    ["approved", "captured"],
    ["authorized", "approved"],
    ["authorized", "failed"],
    ["captured", "voided"],
    ["voided", "authorized"],
    ["failed", "approved"],
    ["failed", "authorized"],
    ["expired", "authorized"],
    ["authorized", "authorized"],
    ["created", "success"],
    ["created", "pending"],
  ])("rejects %s → %s", (from, to) => {
    expect(canTransitionPayment("funding", from, to)).toBe(false);
    const err = errorOf(() => assertPaymentTransition("funding", from, to));
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<{ code: string; message: string }>).data).toMatchObject({
      code: "ILLEGAL_TRANSITION",
      message: `Illegal funding payment transition: ${from} → ${to}.`,
    });
  });

  test("terminal statuses", () => {
    for (const s of ["captured", "voided", "expired", "failed"]) expect(isTerminalPaymentStatus("funding", s)).toBe(true);
    for (const s of ["created", "approved", "authorized", "partially_captured"]) expect(isTerminalPaymentStatus("funding", s)).toBe(false);
  });

  test("unknown statuses are rejected", () => {
    expect(canTransitionPayment("funding", "bogus", "approved")).toBe(false);
    expect(canTransitionPayment("funding", "created", "bogus")).toBe(false);
  });
});

describe("payout transitions", () => {
  test("legal payout and retainage-release paths", () => {
    for (const kind of ["payout", "retainage_release"] as const) {
      expect(canTransitionPayment(kind, "created", "pending")).toBe(true);
      expect(canTransitionPayment(kind, "pending", "success")).toBe(true);
      expect(canTransitionPayment(kind, "pending", "unclaimed")).toBe(true);
      expect(canTransitionPayment(kind, "unclaimed", "returned")).toBe(true);
      expect(canTransitionPayment(kind, "pending", "failed")).toBe(true);
    }
  });

  test.each([
    ["created", "success"],
    ["success", "pending"],
    ["success", "failed"],
    ["failed", "success"],
    ["returned", "success"],
    ["pending", "authorized"],
    ["created", "approved"],
  ])("rejects payout %s → %s", (from, to) => {
    expect(() => assertPaymentTransition("payout", from, to)).toThrow(ConvexError);
  });
});

describe("milestone transitions", () => {
  test("funding lifecycle", () => {
    expect(canTransitionMilestone("planned", "funding")).toBe(true);
    expect(canTransitionMilestone("funding", "funded")).toBe(true);
    expect(canTransitionMilestone("funding", "planned")).toBe(true);
    expect(canTransitionMilestone("funded", "funding_expired")).toBe(true);
  });

  test.each([
    ["planned", "funded"],
    ["funded", "funding"],
    ["funded", "planned"],
    ["paid", "planned"],
    ["bogus", "funding"],
  ])("rejects %s → %s", (from, to) => {
    expect(() => assertMilestoneTransition(from, to)).toThrow(ConvexError);
  });
});
