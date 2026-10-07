import { describe, expect, test } from "vitest";
import { subPayoutStatusLabel } from "./payoutStatusLabel";

describe("subPayoutStatusLabel", () => {
  test("only SUCCESS is labeled as paid", () => {
    expect(subPayoutStatusLabel("success").net).toBe("Net paid");
    for (const s of ["created", "pending", "capture_pending", "unclaimed", "returned", "failed", null]) {
      expect(subPayoutStatusLabel(s).net).not.toBe("Net paid");
    }
  });

  test("UNCLAIMED and RETURNED are not called pending", () => {
    expect(subPayoutStatusLabel("unclaimed").status).toMatch(/^Unclaimed/);
    expect(subPayoutStatusLabel("unclaimed").net).toBe("Net (unclaimed)");
    expect(subPayoutStatusLabel("returned").status).toMatch(/^Returned/);
    expect(subPayoutStatusLabel("returned").net).toBe("Net (returned, not paid)");
    expect(subPayoutStatusLabel("failed").status).toMatch(/^Failed/);
    expect(subPayoutStatusLabel("pending").status).toMatch(/^Pending/);
  });
});
