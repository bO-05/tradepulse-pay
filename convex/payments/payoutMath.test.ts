import { describe, expect, test } from "vitest";
import { RETAINAGE_PERCENT } from "../terms";
import {
  batchIdFromLinks,
  checkCaptureAmount,
  computePayoutSplit,
  isDuplicateBatchError,
  isMilestoneFullyPaid,
  payoutStatusFromPayPal,
  remainingAuthorizedCents,
  retainagePercentFor,
} from "./payoutMath";
import { canTransitionPayment } from "./stateMachine";

describe("retainage split", () => {
  test("$10,000.00 gross at the default 10% holds $1,000.00 and pays $9,000.00", () => {
    expect(RETAINAGE_PERCENT).toBe(10);
    expect(computePayoutSplit(1_000_000, retainagePercentFor({}))).toEqual({
      grossCents: 1_000_000,
      retainageCents: 100_000,
      netCents: 900_000,
    });
  });

  test("odd amounts round retainage to whole cents and net + retainage = gross", () => {
    expect(computePayoutSplit(333_333, 10)).toEqual({ grossCents: 333_333, retainageCents: 33_333, netCents: 300_000 });
    // 0.5 cent rounds half away from zero, like Math.round for positives.
    expect(computePayoutSplit(5, 10)).toEqual({ grossCents: 5, retainageCents: 1, netCents: 4 });
    expect(computePayoutSplit(4, 10)).toEqual({ grossCents: 4, retainageCents: 0, netCents: 4 });
    for (const gross of [1, 99, 12_345, 777_777, 11_900_000]) {
      const s = computePayoutSplit(gross, 10);
      expect(s.retainageCents).toBe(Math.round(gross * 0.1));
      expect(Number.isInteger(s.retainageCents) && Number.isInteger(s.netCents)).toBe(true);
      expect(s.retainageCents + s.netCents).toBe(gross);
    }
  });

  test("uses the agreement's retainage percentage, falling back to the terms default", () => {
    expect(computePayoutSplit(1_000_000, retainagePercentFor({ retainagePercent: 5 })).retainageCents).toBe(50_000);
    expect(retainagePercentFor({ retainagePercent: null })).toBe(RETAINAGE_PERCENT);
    expect(retainagePercentFor({ retainagePercent: 250 })).toBe(RETAINAGE_PERCENT);
    expect(computePayoutSplit(1_000_000, 0)).toEqual({ grossCents: 1_000_000, retainageCents: 0, netCents: 1_000_000 });
  });

  test("rejects non-integer or non-positive gross", () => {
    expect(() => computePayoutSplit(10.5, 10)).toThrow();
    expect(() => computePayoutSplit(0, 10)).toThrow();
  });
});

describe("capture amount", () => {
  test("partial capture is not final; the remaining amount is final", () => {
    expect(checkCaptureAmount(600_000, 1_000_000)).toEqual({ ok: true, finalCapture: false, remainingAfterCents: 400_000 });
    expect(checkCaptureAmount(1_000_000, 1_000_000)).toEqual({ ok: true, finalCapture: true, remainingAfterCents: 0 });
  });

  test("never exceeds the remaining authorized amount", () => {
    expect(checkCaptureAmount(1_000_001, 1_000_000).ok).toBe(false);
    expect(checkCaptureAmount(1, 0).ok).toBe(false);
    expect(checkCaptureAmount(0, 100).ok).toBe(false);
    expect(checkCaptureAmount(1.5, 100).ok).toBe(false);
    expect(remainingAuthorizedCents({ grossCents: 1_000_000, capturedCents: 600_000 })).toBe(400_000);
    expect(remainingAuthorizedCents({ grossCents: 1_000_000 })).toBe(1_000_000);
  });
});

describe("payout status mapping", () => {
  test("maps PayPal item statuses; unsettled items return null", () => {
    expect(payoutStatusFromPayPal("SUCCESS", "PROCESSING")).toBe("success");
    // The sandbox reports batch SUCCESS while the item is UNCLAIMED; the item decides.
    expect(payoutStatusFromPayPal("UNCLAIMED", "SUCCESS")).toBe("unclaimed");
    expect(payoutStatusFromPayPal("RETURNED")).toBe("returned");
    for (const s of ["FAILED", "BLOCKED", "REFUNDED", "REVERSED"]) expect(payoutStatusFromPayPal(s)).toBe("failed");
    expect(payoutStatusFromPayPal("PENDING", "PROCESSING")).toBeNull();
    expect(payoutStatusFromPayPal("ONHOLD")).toBeNull();
    expect(payoutStatusFromPayPal(undefined, "PENDING")).toBeNull();
    expect(payoutStatusFromPayPal(undefined, "DENIED")).toBe("failed");
  });

  test("payout state transitions follow the state machine", () => {
    expect(canTransitionPayment("payout", "created", "pending")).toBe(true);
    expect(canTransitionPayment("payout", "pending", "success")).toBe(true);
    expect(canTransitionPayment("payout", "pending", "unclaimed")).toBe(true);
    expect(canTransitionPayment("payout", "unclaimed", "returned")).toBe(true);
    expect(canTransitionPayment("payout", "success", "failed")).toBe(false);
    expect(canTransitionPayment("payout", "created", "success")).toBe(false);
    expect(canTransitionPayment("funding", "authorized", "partially_captured")).toBe(true);
    expect(canTransitionPayment("funding", "partially_captured", "voided")).toBe(true);
    expect(canTransitionPayment("funding", "captured", "voided")).toBe(false);
  });
});

describe("duplicate batch handling", () => {
  // Shape observed live in the sandbox on a repeated sender_batch_id.
  const live = {
    status: 400,
    issues: ["Batch with given sender_batch_id already exists"],
    links: ["https://api.sandbox.paypal.com/v1/payments/payouts/RBUCFZADTJ2K8"],
  };

  test("recognizes the 400 and extracts the existing batch id", () => {
    expect(isDuplicateBatchError(live)).toBe(true);
    expect(batchIdFromLinks(live.links)).toBe("RBUCFZADTJ2K8");
  });

  test("other errors are not duplicates", () => {
    expect(isDuplicateBatchError({ ...live, status: 422 })).toBe(false);
    expect(isDuplicateBatchError({ status: 400, issues: ["RECEIVER_UNREGISTERED"] })).toBe(false);
    expect(isDuplicateBatchError(null)).toBe(false);
    expect(batchIdFromLinks(["https://developer.paypal.com/docs/api/payments.payouts-batch/#errors"])).toBeUndefined();
  });
});

test("a milestone is paid once successful payouts cover its amount", () => {
  expect(isMilestoneFullyPaid(1_000_000, [600_000])).toBe(false);
  expect(isMilestoneFullyPaid(1_000_000, [600_000, 400_000])).toBe(true);
});
