/** Pure, fail-closed guards for the recovery sandbox browser check. */
export function assertCorrectedDemoAward(snapshot) {
  const mobilization = snapshot.milestones?.find(milestone => milestone.name === "Mobilization");
  if (snapshot.totals?.contractSumCents !== 5_500_000 || mobilization?.funding?.grossCents !== 550_000 ||
      !snapshot.excludedScopeNotes?.some(note => /seismic bracing/i.test(note)) ||
      snapshot.sov?.reduce((sum, line) => sum + line.scheduledValueCents, 0) !== 5_500_000) {
    throw new Error("Refusing guest approval: the corrected demo award and exclusion notes were not verified.");
  }
  return mobilization.funding.paypalOrderId;
}

export function assertSandboxCheckout(url, orderId) {
  const target = new URL(url);
  if (target.origin !== "https://www.sandbox.paypal.com" || target.pathname !== "/checkoutnow" ||
      !orderId || target.searchParams.get("token") !== orderId) {
    throw new Error("Sandbox checkout does not match this run's funding order.");
  }
}

export function assertOwnerInvoice(invoice, changeOrderId) {
  if (!invoice || invoice._id !== changeOrderId || invoice.amountCents !== 185_000 ||
      !invoice.paypalInvoiceId || !["invoiced", "paid"].includes(invoice.status)) {
    throw new Error("Expected demo Owner invoice unavailable.");
  }
  const target = new URL(invoice.payerViewUrl);
  if (target.origin !== "https://www.sandbox.paypal.com" || target.pathname !== "/invoice/p/" ||
      target.username || target.password) {
    throw new Error("Owner invoice is not a PayPal sandbox payer view.");
  }
}

/** Checkout can keep its original locale after selecting US billing. */
export function assertSandboxAmount(text, cents) {
  const dollars = (cents / 100).toFixed(2);
  const us = Number(dollars).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const european = Number(dollars).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const normalized = text.trim().replace(/\s/g, "");
  if (![dollars, us, european].some(amount => normalized === `$${amount}` || normalized === `${amount}$`)) {
    throw new Error("Sandbox checkout total does not match the approved demo amount.");
  }
}

/** Lower rank wins. Never mistake the "Pay now" navigation tab for a payment submit. */
export function guestSubmitRank({ label, type, role, id, disabled, visible }) {
  if (!visible || disabled || role === "tab" || ["card-tab", "bnpl-tab"].includes(id)) return null;
  if (/^pay now as guest$/i.test(label.trim())) return 0;
  if (type !== "submit") return null;
  if (/^pay now$/i.test(label.trim())) return 1;
  if (/^agree and pay$/i.test(label.trim())) return 2;
  return null;
}
