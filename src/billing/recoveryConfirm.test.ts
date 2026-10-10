import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Every call of `fn(` in `text` sits inside an `onConfirm` handler of a ConfirmDialog. */
function callsOnlyInsideOnConfirm(text: string, fn: string): boolean {
  const calls = [...text.matchAll(new RegExp(`\\b${fn}\\(`, "g"))].map((m) => m.index ?? 0);
  if (calls.length === 0) return false;
  return calls.every((at) => {
    const before = text.slice(0, at);
    const confirm = before.lastIndexOf("onConfirm={async () => {");
    const dialog = before.lastIndexOf("<ConfirmDialog");
    return confirm > dialog && dialog >= 0 && !before.slice(confirm).includes("/>");
  });
}

describe("recovery money writes are confirmed and tranche rows carry no pay controls", () => {
  test("Retry payout and Retry payment on the Payment panel run only from a ConfirmDialog with amount, payee and effect", () => {
    const panel = src("./PaymentPanel.tsx");
    expect(callsOnlyInsideOnConfirm(panel, "retry")).toBe(true);
    expect(callsOnlyInsideOnConfirm(panel, "resume")).toBe(true);
    expect(callsOnlyInsideOnConfirm(panel, "pay")).toBe(true);
    for (const kind of ["retry", "resume"]) {
      const at = panel.indexOf(`open={confirm === "${kind}"}`);
      expect(at, kind).toBeGreaterThan(0);
      const dialog = panel.slice(at, panel.indexOf("/>", panel.indexOf("onConfirm", at)));
      expect(dialog).toContain("amountCents={payment.netCents}");
      expect(dialog).toContain("payee={payee}");
      expect(dialog).toContain("effect={");
    }
  });

  test("the owner invoice resend runs only from a ConfirmDialog naming the amount and the billing email", () => {
    const owner = src("./OwnerBilling.tsx");
    expect(callsOnlyInsideOnConfirm(owner, "resume")).toBe(true);
    const at = owner.indexOf("open={confirmSend}");
    const dialog = owner.slice(at, owner.indexOf("/>", owner.indexOf("onConfirm", at)));
    expect(dialog).toContain("amountCents={app.figures.currentPaymentDueCents}");
    expect(dialog).toContain("payee={recipient}");
    expect(dialog).toContain("effect={");
  });

  test("Resume release for retainage runs only from a ConfirmDialog", () => {
    const retainage = src("../payments/RetainageRelease.tsx");
    expect(callsOnlyInsideOnConfirm(retainage, "resumeRelease")).toBe(true);
  });

  test("funding-tranche release rows can refresh status but cannot pay, retry a payout or resume a release", () => {
    const rows = src("../payments/ReleaseMilestone.tsx");
    expect(rows).not.toContain("retryPayout");
    expect(rows).not.toContain("resumeRelease");
    expect(rows).not.toContain("payPayApp");
    expect(rows).toContain("refreshPayoutStatus");
    expect(rows).toContain("Retry this payment from the approved pay app&apos;s Payment panel.");
  });
});
