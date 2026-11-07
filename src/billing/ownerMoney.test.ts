import { describe, expect, test } from "vitest";
import { ownerMoneyTotals } from "./ownerMoney";

const row = (status: string, currentPaymentDueCents: number) => ({ status, currentPaymentDueCents });

describe("owner money totals", () => {
  test("buckets each status the panel shows", () => {
    const totals = ownerMoneyTotals([
      row("draft", 999_999),
      row("submitted_to_owner", 200_000),
      row("changes_requested", 500_000),
      row("approved", 300_000),
      row("approved_invoiced", 100_000),
      row("paid", 150_000),
    ]);
    expect(totals).toEqual({ submittedCents: 200_000, owedCents: 400_000, paidCents: 150_000 });
  });

  test("ignores unknown statuses instead of guessing a bucket", () => {
    expect(ownerMoneyTotals([row("something_new", 123_456)])).toEqual({
      submittedCents: 0,
      owedCents: 0,
      paidCents: 0,
    });
  });

  test("treats missing or negative amounts as zero", () => {
    expect(
      ownerMoneyTotals([
        row("approved", -1),
        { status: "approved", currentPaymentDueCents: Number.NaN },
        row("paid", 1_000),
      ]),
    ).toEqual({ submittedCents: 0, owedCents: 0, paidCents: 1_000 });
  });
});
