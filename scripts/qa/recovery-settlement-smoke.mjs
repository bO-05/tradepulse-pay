/**
 * Recovery DEV only. Default: inspect the latest guided demo.
 * --start creates a fresh guided demo; --resume continues the latest one.
 * Both write modes open real SANDBOX checkout. Neither simulates buyer approval.
 * --guest additionally submits the README's public sandbox test card.
 * --owner-checkout opens the current run's invoice through a fresh Owner session.
 * --owner-pay additionally pays that $1,850 invoice with the public sandbox card.
 * --release-retainage explicitly uses the GC closeout control after the invoice and payouts settle.
 * Evidence contains selected metadata only, never auth frames, cookies or tokens.
 */
import puppeteer from "puppeteer-core";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { assertCorrectedDemoAward, assertSandboxCheckout, assertOwnerInvoice, assertSandboxAmount, guestSubmitRank } from "./recovery-settlement-safety.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = "https://cheery-axolotl-689.convex.site";
const cloud = "https://cheery-axolotl-689.convex.cloud";
const rawFlags = process.argv.slice(2);
let selectedRunId;
const flags = [];
for (let i = 0; i < rawFlags.length; i++) {
  if (rawFlags[i] === "--run") {
    selectedRunId = rawFlags[++i];
    if (!selectedRunId || !/^nx[a-z0-9]+$/i.test(selectedRunId)) {
      throw new Error("--run requires a judge demo run id.");
    }
  } else {
    flags.push(rawFlags[i]);
  }
}
if (flags.some(flag => !["--start", "--resume", "--guest", "--owner-checkout", "--owner-pay", "--release-retainage"].includes(flag)) ||
    (flags.includes("--start") && flags.includes("--resume")) ||
    (selectedRunId && (flags.includes("--start") || flags.includes("--resume")))) {
  throw new Error("Use --start/--resume, --owner-checkout/--owner-pay, --run, or --release-retainage; no target override is allowed.");
}
if (flags.includes("--guest") && !flags.some(flag => ["--start", "--resume"].includes(flag))) {
  throw new Error("--guest requires an explicit --start or --resume.");
}
const driveDemo = flags.includes("--start") || flags.includes("--resume");
const writes = driveDemo || flags.includes("--owner-pay") || flags.includes("--release-retainage");
const directory = path.join(root, "evidence", `recovery-settlement-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(directory, { recursive: true });
const report = { target: site, writes, guestEnabled: flags.includes("--guest") || flags.includes("--owner-pay"), steps: [], errors: [] };
const client = new ConvexHttpClient(cloud);
let browser;
let token;
let appPage;
let activeRunId = selectedRunId;
let phase = "sandbox preflight";

const sanitize = value => value === site || /^https:\/\/(?:[a-z]+\.)?sandbox\.paypal\.com$/.test(String(value)) ? String(value) : String(value)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
  .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
  .replace(/\beyJ[A-Za-z0-9_.-]+/g, "[token]")
  .replace(/https?:\/\/[^\s)]+/g, "[url]")
  .slice(0, 14000);

async function login(page, role = "gc") {
  await page.goto(`${site}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="password"]');
  await page.evaluate(role => {
    for (const [selector, value] of [
      ['input[type="email"]', `${role}@demo.tradepulse`],
      ['input[type="password"]', "TradePulseDemo!2026"],
    ]) {
      const field = document.querySelector(selector);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
    document.querySelector('input[type="password"]').closest("form").requestSubmit();
  }, role);
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'));
  await page.goto(`${site}/${role === "gc" ? "#/judge-demo" : "#/projects"}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(role === "gc" ? '[data-testid="judge-demo-page"]' : '[data-testid="portal-change-orders"]');
  await page.waitForFunction(() => !document.body.innerText.includes("Loading…"));
}

async function demoSnapshot(page) {
  return page.evaluate(() => ({
    phase: document.querySelector('[data-testid="judge-demo-phase"]')?.textContent,
    error: document.querySelector('[data-testid="judge-demo-error"]')?.textContent,
    agreement: document.querySelector('[data-testid="judge-demo-agreement"]')?.textContent,
    agreementHash: document.querySelector('[data-testid="judge-demo-agreement"]')?.getAttribute("href"),
    steps: [...document.querySelectorAll('[data-testid="judge-demo-steps"] > li')].map(el => ({
      id: el.dataset.testid, status: el.dataset.status, text: el.innerText,
    })),
    fundingError: document.querySelector('[data-testid="funding-error"]')?.textContent,
  }));
}

async function paymentSurfaces() {
  const surfaces = [];
  for (const page of await browser.pages()) {
    for (const frame of page.frames()) {
      let url;
      try { url = new URL(frame.url()); } catch { continue; }
      if (!url.hostname.endsWith(".sandbox.paypal.com")) continue;
      try {
        const description = await frame.evaluate(() => {
          const visible = el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
          const roots = [document];
          for (let i = 0; i < roots.length; i++) {
            for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
          }
          return {
            title: document.title,
            text: document.body?.innerText?.replace(/Albania[\s\S]*?Zimbabwe/g, "[country options]").slice(0, 12000),
            controls: roots.flatMap(root => [...root.querySelectorAll("input,select,button,a[role=button],a[href],[role=button]")])
              .filter(el => el.type !== "hidden" && (el.tagName !== "A" || /^(?:pay|debit|credit|continue|log.?in|checkout|sign.?in)/i.test(el.textContent.trim())))
              .map(el => ({
              tag: el.tagName, id: el.id, name: el.name, type: el.type,
              label: el.getAttribute("aria-label") || el.labels?.[0]?.textContent || el.textContent?.slice(0, 100),
              autocomplete: el.autocomplete, placeholder: el.placeholder, visible: visible(el),
              ...(el.type === "checkbox" ? { checked: el.checked } : {}),
            })),
            frames: [...document.querySelectorAll("iframe")].map(el => {
              let url;
              try { url = new URL(el.src); } catch { /* about:blank has no HTTP origin. */ }
              return { title: el.title, origin: url?.origin, pathname: url?.pathname };
            }),
            shadowHosts: roots.slice(1).map(root => ({ tag: root.host.tagName, id: root.host.id })),
          };
        });
        // An invoice includes account contact details. Only its controls belong in QA evidence.
        if (url.pathname.startsWith("/invoice/")) {
          const text = description.text ?? "";
          description.invoiceStates = {
            due: /amount due|due date|balance due/i.test(text),
            paid: /invoice paid|paid on|payment received/i.test(text),
            unavailable: /can't pay|cannot pay|unable to|unavailable|something went wrong/i.test(text),
            payNow: /pay now|pay invoice|pay with/i.test(text),
          };
          delete description.text;
        }
        surfaces.push({ origin: url.origin, pathname: url.pathname, ...description });
      } catch { /* A payment popup can navigate or close while it is inspected. */ }
    }
  }
  return JSON.parse(JSON.stringify(surfaces), (_key, value) => typeof value === "string" ? sanitize(value) : value);
}

async function paymentScreenshots() {
  let count = 0;
  for (const page of await browser.pages()) {
    if (!page.url().startsWith("https://www.sandbox.paypal.com/checkoutnow")) continue;
    await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(node.textContent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          const mask = document.createElement("div");
          mask.dataset.qaEmailMask = "true";
          Object.assign(mask.style, { position: "absolute", left: `${rect.left + scrollX}px`, top: `${rect.top + scrollY}px`,
            width: `${rect.width}px`, height: `${rect.height}px`, background: "#334155", zIndex: "2147483647" });
          document.body.append(mask);
        }
      }
      document.querySelectorAll('input[type="email"]').forEach(input => { input.dataset.qaStyle = input.getAttribute("style") || ""; input.style.color = "transparent"; });
    });
    await page.screenshot({ path: path.join(directory, `paypal-checkout-${++count}.png`), fullPage: true });
    await page.evaluate(() => {
      document.querySelectorAll("[data-qa-email-mask]").forEach(el => el.remove());
      document.querySelectorAll("[data-qa-style]").forEach(el => { el.setAttribute("style", el.dataset.qaStyle); delete el.dataset.qaStyle; });
    });
  }
}

async function ledgerSnapshot() {
  const run = await client.query(api.judgeDemo.runs.getRun, activeRunId ? { runId: activeRunId } : {});
  if (!run) return { run: null };
  const ledger = await client.query(api.payments.ledger.getAgreementLedger, { agreementId: run.agreementId });
  return {
    run: { runId: run._id, agreementId: run.agreementId, agreementNumber: run.agreementNumber,
      honestPayAppId: run.honestPayAppId, agentPayAppId: run.agentPayAppId, changeOrderId: run.changeOrderId },
    totals: ledger?.totals,
    excludedScopeNotes: ledger?.agreement.excludedScopeNotes,
    sov: ledger?.sov,
    retainageReleases: ledger?.retainageReleases.map(({ receiverEmail: _email, ...release }) => release),
    milestones: ledger?.milestones.map(milestone => ({
      name: milestone.name, amountCents: milestone.amountCents, status: milestone.status, funding: milestone.funding,
      releases: milestone.releases.map(({ receiverEmail: _privateEmail, ...release }) => release),
    })),
  };
}

async function fillSandboxGuest(checkout, assertSandbox, expectedCents) {
  assertSandbox();
  await checkout.waitForSelector("#cardNumber", { visible: true, timeout: 60_000 });
  assertSandbox();
  await checkout.select("#country", "US");
  await checkout.waitForSelector('#billingState option[value="CA"]');
  await checkout.waitForFunction(() => document.querySelector("#onboardOptionGuest") ||
    [...document.querySelectorAll("button")].some(el => /^pay now as guest$/i.test(el.textContent.trim())) ||
    [...document.querySelectorAll('input[type="checkbox"]')].some(el => /save.*create.*account/i.test(el.labels?.[0]?.textContent ?? "")));
  const guestMode = await checkout.evaluate(() => {
    const radio = document.querySelector("#onboardOptionGuest");
    if (radio) { radio.click(); return radio.checked; }
    const createAccount = [...document.querySelectorAll('input[type="checkbox"]')]
      .find(el => /save.*create.*account/i.test(el.labels?.[0]?.textContent ?? ""));
    if (createAccount?.checked) createAccount.click();
    const marketing = document.querySelector("#marketingOptIn");
    if (marketing?.checked) marketing.click();
    return Boolean(createAccount && !createAccount.checked) ||
      [...document.querySelectorAll("button")].some(el => /^pay now as guest$/i.test(el.textContent.trim()));
  });
  if (!guestMode) throw new Error("Guest checkout was not selected.");
  const cookieClose = await checkout.$("#bannerCloseButton");
  if (cookieClose && await cookieClose.evaluate(el => el.getBoundingClientRect().height > 0)) await cookieClose.click();
  const buyerEmail = `recovery-sandbox-${Date.now()}@example.com`;
  for (const [selector, value] of [
    ["#firstName", "Sandbox"], ["#lastName", "Buyer"], ["#billingLine1", "123 Test Street"],
    ["#billingCity", "San Jose"], ["#billingPostalCode", "95131"], ["#phone", "2025550100"],
    ["#cardNumber", "4032031427005060"], ["#cardExpiry", "0129"], ["#cardCvv", "480"],
    ["#email", buyerEmail],
  ]) {
    assertSandbox();
    await checkout.waitForSelector(selector, { visible: true });
    await checkout.click(selector);
    await checkout.keyboard.down("Control");
    await checkout.keyboard.press("a");
    await checkout.keyboard.up("Control");
    await checkout.keyboard.press("Backspace");
    await checkout.type(selector, value, { delay: 25 });
    if (!["#cardNumber", "#cardExpiry", "#phone"].includes(selector) &&
        !await checkout.$eval(selector, (el, expected) => el.value === expected, value)) {
      throw new Error(`Synthetic sandbox field ${selector} changed during entry.`);
    }
  }
  await checkout.select("#billingState", "CA");
  await checkout.keyboard.press("Tab");
  assertSandbox();
  report.steps.push({ action: "prepare sandbox guest card", result: "public README test card; synthetic reserved-domain buyer data; no account creation" });
  const payButtons = await checkout.$$("button");
  const candidates = [];
  for (const button of payButtons) {
    const info = await button.evaluate(el => ({
      label: el.textContent.trim(), type: el.type, role: el.getAttribute("role"), id: el.id,
      disabled: el.disabled, visible: el.getBoundingClientRect().height > 0,
    }));
    const rank = guestSubmitRank(info);
    if (rank !== null) candidates.push({ button, rank, info });
  }
  const selected = candidates.sort((a, b) => a.rank - b.rank)[0];
  const payButton = selected?.button;
  if (!payButton) throw new Error("Sandbox Pay Now button unavailable.");
  if (selected.rank !== 0 && await checkout.evaluate(() =>
    document.querySelector("#onboardOptionSignup")?.checked ||
    [...document.querySelectorAll('input[type="checkbox"]')].some(el =>
      /save.*create.*account/i.test(el.labels?.[0]?.textContent ?? "") && el.checked))) {
    throw new Error("Refusing sandbox submission with account creation selected.");
  }
  const amountText = await checkout.evaluate(() => [...document.querySelectorAll("button")]
    .map(el => el.textContent.trim()).find(text => /^[\d.,\s$]+$/.test(text) && text.includes("$")) ?? "");
  assertSandboxAmount(amountText, expectedCents);
  assertSandbox();
  phase = "real sandbox buyer approval";
  await payButton.click();
  report.steps.push({ action: "click sandbox guest payment submit", control: selected.info, result: "clicked; authorization not assumed" });
}

async function submitSandboxGuest(appPage) {
  const orderId = assertCorrectedDemoAward(await ledgerSnapshot());
  const checkout = (await browser.pages()).find(page => page.url().startsWith("https://www.sandbox.paypal.com/checkoutnow"));
  if (!checkout) throw new Error("Sandbox checkout popup not found.");
  await fillSandboxGuest(checkout, () => assertSandboxCheckout(checkout.url(), orderId), 550_000);
  await appPage.waitForFunction(() => document.querySelector('[data-testid="judge-demo-step-fund"]')?.dataset.status === "done" ||
    document.querySelector('[data-testid="funding-error"]')?.textContent ||
    document.querySelector('[data-testid="judge-demo-error"]')?.textContent, { timeout: 180_000 });
  const funded = await ledgerSnapshot();
  const funding = funded.milestones.find(milestone => milestone.name === "Mobilization")?.funding;
  if (!funding?.paypalAuthorizationId || !["authorized", "partially_captured", "captured"].includes(funding.status)) {
    throw new Error("PayPal did not confirm a usable authorization.");
  }
  report.steps.push({ action: "verify real sandbox authorization", result: "confirmed", authorizationId: funding.paypalAuthorizationId });
}

async function settlementSnapshot() {
  const snapshot = await ledgerSnapshot();
  if (!snapshot.run) return snapshot;
  const ids = [snapshot.run.honestPayAppId, snapshot.run.agentPayAppId].filter(Boolean);
  const inbox = await client.query(api.payApps.proposals.listInbox, {});
  snapshot.payApps = [];
  for (const item of inbox.filter(item => ids.includes(item.payApp._id))) {
    const trace = await client.query(api.payApps.proposals.getAgentTrace, { payAppId: item.payApp._id });
    snapshot.payApps.push({
      id: item.payApp._id, status: item.payApp.status, requestedCents: item.payApp.requestedTotalCents,
      review: item.payApp.review ? { engine: item.payApp.review.engine, provider: item.payApp.review.provider,
        model: item.payApp.review.model, approvedTotalCents: item.payApp.review.approvedTotalCents } : null,
      license: item.license,
      proposals: item.proposals.map(proposal => ({
        id: proposal._id, kind: proposal.kind, status: proposal.status, amountCents: proposal.amountCents,
        editedAmountCents: proposal.editedAmountCents, flags: proposal.flags, error: proposal.error,
        paypalCaptureId: proposal.paypalCaptureId,
      })),
      payment: item.payment ? { status: item.payment.status, grossCents: item.payment.grossCents,
        netCents: item.payment.netCents, retainageCents: item.payment.retainageCents,
        batchId: item.payment.batchId, error: item.payment.error } : null,
      trace: trace ? { provider: trace.provider, model: trace.model, runId: trace.runId,
        inputTokens: trace.inputTokens, outputTokens: trace.outputTokens,
        tools: trace.parsedOutput?.toolCalls?.map(call => call.tool) } : null,
    });
  }
  const dashboard = await client.query(api.dashboard.queries.getDashboardData, {});
  snapshot.dashboardTotals = dashboard.agreements.find(agreement => agreement.agreementId === snapshot.run.agreementId)?.totals;
  const keys = ["capturedCents", "paidCents", "retainageHeldCents", "changeOrdersPaidCents"];
  snapshot.reconciliation = {
    dashboardMatchesLedger: Boolean(snapshot.dashboardTotals) && keys.every(key => snapshot.dashboardTotals[key] === snapshot.totals[key]),
    bothPayoutsSettled: snapshot.payApps.length === 2 && snapshot.payApps.every(item => item.payment?.status === "success"),
    balanceFormulaMatches: snapshot.totals.balanceCents === snapshot.totals.contractSumCents - snapshot.totals.paidCents - snapshot.totals.retainageHeldCents,
    payoutAndRetainageReconcile: snapshot.totals.capturedCents === snapshot.totals.paidCents + snapshot.totals.retainageHeldCents,
  };
  return snapshot;
}

async function inspectOwnerInvoice() {
  const run = await client.query(api.judgeDemo.runs.getRun, activeRunId ? { runId: activeRunId } : {});
  if (!run?.changeOrderId) throw new Error("No invoice on this demo run.");
  const orders = await client.query(api.billing.changeOrders.listForProject, { projectId: run.projectId });
  const invoice = orders.prime.changeOrders.find(order => order._id === run.changeOrderId);
  assertCorrectedDemoAward(await ledgerSnapshot());
  assertOwnerInvoice(invoice, run.changeOrderId);
  const context = await browser.createBrowserContext();
  const owner = await context.newPage();
  owner.setDefaultTimeout(30_000);
  await login(owner, "owner");
  await owner.waitForFunction(url => [...document.querySelectorAll('[data-testid="change-order-invoice-link"]')]
    .some(el => el.getAttribute("href") === url), { timeout: 30_000 }, invoice.payerViewUrl);
  let invoiceLink;
  for (const link of await owner.$$('[data-testid="change-order-invoice-link"]')) {
    if (await link.evaluate(el => el.getAttribute("href")) === invoice.payerViewUrl) { invoiceLink = link; break; }
  }
  if (!invoiceLink) throw new Error("Owner cannot see this run's invoice link.");
  await invoiceLink.click();
  let payer;
  for (let attempt = 0; attempt < 60 && !payer; attempt++) {
    payer = (await context.pages()).find(page => page.url().startsWith("https://www.sandbox.paypal.com/invoice/"));
    if (!payer) await delay(500);
  }
  if (!payer) throw new Error("Owner sandbox invoice view did not open.");
  if (invoice.status === "paid") {
    report.ownerInvoice = { invoiceId: invoice.paypalInvoiceId, storedStatus: "paid", ownerLinkVerified: true };
    report.steps.push({ action: "Owner invoice", result: "already recorded paid; no duplicate checkout" });
    return { owner, payer, context, invoice };
  }
  let card;
  for (let attempt = 0; attempt < 90 && !card; attempt++) {
    for (const frame of payer.frames()) {
      let url;
      try { url = new URL(frame.url()); } catch { continue; }
      if (url.origin !== "https://www.sandbox.paypal.com" || url.pathname !== "/smart/buttons") continue;
      const candidate = await frame.$('[data-funding-source="card"]');
      if (candidate && await candidate.evaluate(el => el.getBoundingClientRect().height > 0)) { card = candidate; break; }
    }
    if (!card) await delay(500);
  }
  report.ownerInvoice = { invoiceId: invoice.paypalInvoiceId, changeOrderId: invoice._id,
    amountCents: invoice.amountCents, storedStatus: invoice.status, ownerLinkVerified: true,
    surfaces: await paymentSurfaces() };
  report.steps.push({ action: "Owner opens own sandbox invoice through the app", result: "payer view opened; payment not assumed" });
  if (!card) throw new Error("Sandbox invoice card checkout is unavailable.");
  await card.click();
  let checkout;
  for (let attempt = 0; attempt < 90 && !checkout; attempt++) {
    checkout = (await context.pages()).find(page => page.url().startsWith("https://www.sandbox.paypal.com/checkoutnow"));
    if (!checkout) await delay(500);
  }
  if (!checkout) throw new Error("Sandbox invoice guest checkout did not open.");
  await checkout.waitForSelector("#cardNumber", { visible: true, timeout: 60_000 });
  report.ownerInvoice.checkoutSurfaces = await paymentSurfaces();
  report.steps.push({ action: "Owner opens sandbox debit/card checkout", result: "guest form opened; payment not submitted" });
  return { owner, payer, checkout, context, invoice };
}

async function payOwnerInvoice(opened) {
  const { owner, payer, checkout, context, invoice } = opened;
  if (invoice.status !== "paid") {
    if (payer.url() !== invoice.payerViewUrl) throw new Error("Sandbox invoice payer view changed.");
    const orderId = new URL(checkout.url()).searchParams.get("token");
    await fillSandboxGuest(checkout, () => assertSandboxCheckout(checkout.url(), orderId), 185_000);
  }
  let status = invoice.status;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (checkout && !checkout.isClosed()) {
      const invalidEmail = await checkout.evaluate(() => /your email (?:isn.t valid|is invalid)/i.test(document.body.innerText))
        .catch(() => false);
      if (invalidEmail) throw new Error("PayPal rejected the synthetic guest email; invoice payment is not confirmed.");
    }
    // Ordinary authorized GC refresh GETs PayPal, never a fabricated settlement mutation.
    const result = await client.action(api.payments.invoices.refreshChangeOrderStatus, { changeOrderId: invoice._id });
    status = result.status;
    if (status === "paid") break;
    await delay(5000);
  }
  report.ownerInvoice.finalStatus = status;
  if (status !== "paid") throw new Error("PayPal has not confirmed payment of the Owner invoice.");
  // The invoice link may replace the Owner app tab with PayPal. Verify the app row on a fresh tab
  // that shares the same authenticated browser context.
  const ownerUi = await context.newPage();
  await ownerUi.goto(`${site}/#/projects`, { waitUntil: "domcontentloaded" });
  await ownerUi.waitForSelector('[data-testid="portal-change-orders"]', { timeout: 30_000 });
  await ownerUi.waitForFunction(url => [...document.querySelectorAll('[data-testid="change-order-invoice-link"]')]
    .some(link => link.getAttribute("href") === url && link.closest('[data-testid="change-order-row"]')?.dataset.status === "paid"),
    { timeout: 45_000 }, invoice.payerViewUrl);
  report.steps.push({ action: "verify Owner payment", result: "PayPal confirmed PAID; Owner app row updated" });
}

async function releaseDemoRetainage(page) {
  const before = await settlementSnapshot();
  assertCorrectedDemoAward(before);
  if (before.totals.retainageHeldCents === 0 && before.retainageReleases?.some(release => release.status === "success")) {
    report.steps.push({ action: "GC retainage closeout", result: "already settled; nothing submitted twice" });
    return;
  }
  if (!before.reconciliation.bothPayoutsSettled || !before.reconciliation.payoutAndRetainageReconcile ||
      before.totals.changeOrdersPaidCents !== 185_000 || before.totals.retainageHeldCents <= 0 ||
      before.retainageReleases.length !== 0) {
    throw new Error("Retainage closeout requires settled demo payouts and the paid Owner invoice, without another release in flight.");
  }
  await page.waitForSelector('[data-testid="judge-demo-release-retainage"]:not([disabled])');
  await page.click('[data-testid="judge-demo-release-retainage"]');
  report.steps.push({ action: "GC clicks optional retainage release", amountCents: before.totals.retainageHeldCents,
    result: "submitted through authenticated GC UI; settlement not assumed" });
  const deadline = Date.now() + 240_000;
  let after;
  while (Date.now() < deadline) {
    after = await settlementSnapshot();
    if (after.retainageReleases?.some(release => release.status === "success")) break;
    if (after.retainageReleases?.some(release => ["failed", "denied", "unclaimed", "returned", "blocked"].includes(release.status))) {
      throw new Error("Retainage payout needs attention; not settled.");
    }
    await delay(5000);
  }
  report.retainageCloseout = after?.retainageReleases;
  if (after?.totals.retainageHeldCents !== 0 || after?.totals.retainageReleasedCents !== before.totals.retainageHeldCents ||
      !after.retainageReleases.some(release => release.status === "success")) {
    throw new Error("Retainage release has not settled successfully.");
  }
  report.steps.push({ action: "verify retainage closeout", result: "payout SUCCESS; held balance zero" });
}

try {
  // Do not trust a DEV label to imply sandbox credentials.
  if (process.env.CONVEX_DEPLOY_KEY) throw new Error("Deployment-key overrides are not supported.");
  const local = fs.readFileSync(path.join(root, ".env.local"), "utf8");
  if (!/^CONVEX_DEPLOYMENT=dev:cheery-axolotl-689(?:\s|$)/m.test(local)) throw new Error("Unexpected local deployment.");
  const check = spawnSync(process.execPath, [
    path.join(root, "node_modules/convex/bin/main.js"), "env", "get", "PAYPAL_ENV",
    "--env-file", path.join(root, ".env.local"),
  ], { cwd: root, encoding: "utf8", timeout: 60_000, windowsHide: true });
  if (check.status !== 0 || check.stdout.trim() !== "sandbox") throw new Error("PayPal sandbox preflight failed.");
  report.steps.push({ action: "sandbox preflight", result: "passed" });

  phase = "temporary public demo session";
  const auth = await client.action(api.auth.signIn, {
    provider: "password", params: { flow: "signIn", email: "gc@demo.tradepulse", password: "TradePulseDemo!2026" },
  });
  token = auth.tokens?.token;
  if (!token) throw new Error("No temporary demo token.");
  client.setAuth(token);
  report.before = await ledgerSnapshot();

  browser = await puppeteer.launch({
    executablePath: process.env.QA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, defaultViewport: { width: 1450, height: 1100 }, protocolTimeout: 60_000,
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  appPage = page;
  page.setDefaultTimeout(30_000);
  phase = "public demo browser sign-in";
  await login(page);
  if (activeRunId) {
    await page.goto(`${site}/#/judge-demo/${activeRunId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="judge-demo-page"]');
    await page.waitForFunction(() => !document.body.innerText.includes("Loading…"));
  }
  report.initialUi = await demoSnapshot(page);
  if (driveDemo) {
    phase = flags.includes("--start") ? "start guided demo" : "resume guided demo";
    const selector = flags.includes("--start") ? '[data-testid="judge-demo-start"]' : '[data-testid="judge-demo-continue"]';
    await page.waitForSelector(selector);
    await page.click(selector);
    if (flags.includes("--start")) {
      await page.waitForSelector('[role="alertdialog"]');
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('[role="alertdialog"] button')]
          .find(el => el.textContent.trim() === "Create sandbox run");
        if (!button || button.disabled) throw new Error("Start-run confirmation unavailable.");
        button.click();
      });
      await page.waitForFunction(previous => {
        const href = document.querySelector('[data-testid="judge-demo-agreement"]')?.getAttribute("href");
        return href?.startsWith("#/payments/") && href !== previous;
      }, { timeout: 30_000 }, report.initialUi.agreementHash ?? null);
      const hash = await page.evaluate(() => location.hash);
      activeRunId = hash.split("/").filter(Boolean).pop();
      if (!activeRunId) throw new Error("The fresh guided run did not expose its run id.");
    }
    await page.waitForFunction(() => document.querySelector('[data-testid="fund-milestone-button"]') ||
      document.querySelector('[data-testid="judge-demo-step-fund"]')?.dataset.status === "done" ||
      document.querySelector('[data-testid="judge-demo-error"]')?.textContent);
    const error = await page.$('[data-testid="judge-demo-error"]');
    if (error) throw new Error("Guided demo stopped before checkout.");
    const alreadyFunded = await page.$eval('[data-testid="judge-demo-step-fund"]', el => el.dataset.status === "done");
    if (!alreadyFunded) {
      phase = "funding confirmation";
      await page.click('[data-testid="fund-milestone-button"]');
      await page.waitForSelector('[role="alertdialog"]');
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('[role="alertdialog"] button')].find(el => el.textContent.trim() === "Continue to PayPal");
        if (!button || button.disabled) throw new Error("Funding confirmation unavailable.");
        button.click();
      });
      phase = "PayPal sandbox checkout";
      let cardButton;
      for (let attempt = 0; attempt < 40 && !cardButton; attempt++) {
        for (const frame of page.frames()) {
          if (!frame.url().startsWith("https://www.sandbox.paypal.com/")) continue;
          cardButton = await frame.$('[data-funding-source="card"]');
          if (cardButton) break;
        }
        if (!cardButton) await delay(500);
      }
      report.checkoutBeforeClick = await paymentSurfaces();
      if (!cardButton) throw new Error("Sandbox debit/credit-card button unavailable.");
      await cardButton.click();
      await delay(10000);
      report.checkout = await paymentSurfaces();
      await paymentScreenshots();
      if (flags.includes("--guest")) {
        await submitSandboxGuest(page);
      }
    }
    if (alreadyFunded || flags.includes("--guest")) {
      phase = "GC-approved capture and payout driver";
      await page.waitForFunction(() => document.querySelector('[data-testid="judge-demo-error"]')?.textContent ||
        document.querySelector('[data-testid="judge-demo-phase"]')?.textContent.includes("Payout requests and the change-order invoice were submitted"),
      { timeout: 420_000 });
      const driverError = await page.$eval('[data-testid="judge-demo-page"]', el => el.querySelector('[data-testid="judge-demo-error"]')?.textContent);
      if (driverError) throw new Error(`Guided demo stopped: ${sanitize(driverError)}`);
      phase = "actual payout settlement";
      await page.waitForFunction(() => ["done", "error", "human"].includes(document.querySelector('[data-testid="judge-demo-step-payout"]')?.dataset.status),
        { timeout: 240_000 });
    }
  }
  if (flags.includes("--owner-checkout") || flags.includes("--owner-pay")) {
    phase = "Owner sandbox invoice";
    const opened = await inspectOwnerInvoice();
    if (flags.includes("--owner-pay")) await payOwnerInvoice(opened);
  }
  if (flags.includes("--release-retainage")) {
    phase = "optional GC retainage closeout";
    await releaseDemoRetainage(page);
  }
  report.ui = await demoSnapshot(page);
  report.after = await settlementSnapshot();
  if (flags.includes("--guest") && !report.after.reconciliation?.bothPayoutsSettled) {
    report.errors.push("Both sandbox payouts have not settled successfully. Pending/unclaimed is not paid.");
  }
} catch (error) {
  report.errors.push(`Settlement check stopped during ${phase}: ${sanitize(error.message)}`);
  if (browser) {
    report.checkoutAtStop = await paymentSurfaces();
    try { await paymentScreenshots(); if (appPage) report.ui = await demoSnapshot(appPage); } catch { /* Preserve original failure. */ }
  }
  if (token) {
    try { report.after = await settlementSnapshot(); } catch { /* Report the original failure. */ }
  }
} finally {
  if (browser) await browser.close();
  if (token) {
    try { await client.action(api.auth.signOut, {}); }
    catch { report.errors.push("Could not revoke temporary API demo session."); }
    client.clearAuth();
  }
  const safeReport = JSON.stringify(report, (_key, value) => typeof value === "string" ? sanitize(value) : value, 2);
  fs.writeFileSync(path.join(directory, "report.json"), safeReport);
  console.log(`Evidence: ${directory}`);
  console.log(JSON.stringify({
    target: report.target, writes, guestEnabled: report.guestEnabled, steps: report.steps, errors: report.errors,
    run: report.after?.run, totals: report.after?.totals, payApps: report.after?.payApps,
    reconciliation: report.after?.reconciliation,
    retainageCloseout: report.retainageCloseout,
    ownerInvoice: report.ownerInvoice ? (({ invoiceId, amountCents, storedStatus, ownerLinkVerified, finalStatus }) =>
      ({ invoiceId, amountCents, storedStatus, ownerLinkVerified, finalStatus }))(report.ownerInvoice) : undefined,
    checkoutAtStop: report.checkoutAtStop?.filter(surface => surface.pathname === "/checkoutnow").map(surface => ({
      title: surface.title, text: surface.text,
    })),
  }, (_key, value) => typeof value === "string" ? sanitize(value) : value, 2));
}
if (report.errors.length) process.exitCode = 1;
