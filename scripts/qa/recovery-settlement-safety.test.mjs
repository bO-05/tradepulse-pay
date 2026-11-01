import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCorrectedDemoAward, assertSandboxCheckout, assertOwnerInvoice, assertSandboxAmount, guestSubmitRank } from "./recovery-settlement-safety.mjs";

const snapshot = () => ({
  totals: { contractSumCents: 5_500_000 },
  milestones: [{ name: "Mobilization", funding: { grossCents: 550_000, paypalOrderId: "TEST-ORDER" } }],
  excludedScopeNotes: ["Seismic bracing is excluded."],
  sov: [{ scheduledValueCents: 5_500_000 }],
});
test("only the corrected award with exclusion notes may reach buyer approval", () => {
  assert.equal(assertCorrectedDemoAward(snapshot()), "TEST-ORDER");
  for (const changes of [
    { totals: { contractSumCents: 5_950_000 } }, { milestones: [] }, { excludedScopeNotes: [] },
    { sov: [{ scheduledValueCents: 5_950_000 }] },
  ]) assert.throws(() => assertCorrectedDemoAward({ ...snapshot(), ...changes }));
});
test("checkout must be sandbox, exact path, and the current funding order", () => {
  assert.doesNotThrow(() => assertSandboxCheckout("https://www.sandbox.paypal.com/checkoutnow?token=TEST-ORDER", "TEST-ORDER"));
  for (const url of [
    "https://www.paypal.com/checkoutnow?token=TEST-ORDER",
    "https://www.sandbox.paypal.com/checkoutnow?token=OLD-ORDER",
    "https://www.sandbox.paypal.com/unexpected?token=TEST-ORDER",
    "https://www.sandbox.paypal.com.evil.example/checkoutnow?token=TEST-ORDER",
  ]) assert.throws(() => assertSandboxCheckout(url, "TEST-ORDER"));
});
test("navigation tabs and account-creation buttons cannot submit the guest payment", () => {
  const button = { label: "Pay Now", type: "submit", role: null, id: "", disabled: false, visible: true };
  assert.equal(guestSubmitRank(button), 1);
  assert.equal(guestSubmitRank({ ...button, label: "Pay now as guest", type: "button" }), 0);
  assert.equal(guestSubmitRank({ ...button, label: "Agree and Pay" }), 2);
  for (const changes of [
    { id: "card-tab", type: "button" }, { role: "tab" }, { type: "button" },
    { disabled: true }, { visible: false }, { label: "Create Account & Pay Now" }, { label: "Pay Later" },
  ]) assert.equal(guestSubmitRank({ ...button, ...changes }), null);
});
test("Owner checkout belongs to the current invoiced demo change order", () => {
  const invoice = { _id: "CO-TEST", amountCents: 185_000, paypalInvoiceId: "INV2-TEST", status: "invoiced",
    payerViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-TEST" };
  assert.doesNotThrow(() => assertOwnerInvoice(invoice, "CO-TEST"));
  for (const changes of [
    { _id: "OTHER-CO" }, { amountCents: 1 }, { paypalInvoiceId: null }, { status: "draft" },
    { payerViewUrl: "https://www.paypal.com/invoice/p/#INV2-TEST" },
    { payerViewUrl: "https://www.sandbox.paypal.com/other/#INV2-TEST" },
    { payerViewUrl: "https://www.sandbox.paypal.com.evil.example/invoice/p/#INV2-TEST" },
  ]) assert.throws(() => assertOwnerInvoice({ ...invoice, ...changes }, "CO-TEST"));
});
test("the visible payment total must exactly match, including locale variants", () => {
  for (const text of ["$1,850.00", "1.850,00 $", "$1850.00"]) {
    assert.doesNotThrow(() => assertSandboxAmount(text, 185_000));
  }
  for (const text of ["$1,850.01", "$5,500.00", "$18.50", "1850", "USD 1850.00", "Pay $1,850.00 later"]) {
    assert.throws(() => assertSandboxAmount(text, 185_000));
  }
});
