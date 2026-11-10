/**
 * Recovery-dev only, fresh isolated contexts. No workflow, provider, payment or draft writes.
 * Ordinary demo sign-in is the only remote write. Screenshots mask non-demo addresses.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = "https://cheery-axolotl-689.convex.site";
if (process.argv.length !== 2 || process.env.CONVEX_DEPLOY_KEY ||
    !/^CONVEX_DEPLOYMENT=dev:cheery-axolotl-689(?:\s|$)/m.test(fs.readFileSync(path.join(root, ".env.local"), "utf8"))) throw new Error("Recovery dev only.");
const directory = path.join(root, "evidence", `audit-fixes-browser-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(directory, { recursive: true });
const report = { target: site, mode: "Read-only browser inspection; demo authentication only", checks: [], errors: [], expectedDenials: [] };
const browser = await puppeteer.launch({
  executablePath: process.env.QA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, defaultViewport: { width: 1440, height: 1000 }, protocolTimeout: 60000,
});
const check = (name, passed, detail = {}) => {
  report.checks.push({ name, passed: Boolean(passed), ...detail });
  if (!passed) throw new Error(`Check failed: ${name}`);
};
const agreement = "jn78x0j5xeh7q9gb55p26r7pdh8hdmjx";
const payApp = "ph7fh2dpqnx82kq1dn3gwcp8yx8hcem6";
const changeOrder = "kx79veecm7m5m0gqw5mz1nmb718hch9t";
let stage = "launch";
let diagnosticPage;
let expectingOwnerLedgerDenial = false;
async function open(page, hash, selector) {
  await page.goto(`${site}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(selector, { timeout: 45000 });
}
async function signIn(role) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", () => report.errors.push({ role, kind: "pageerror" }));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (role === "owner" && expectingOwnerLedgerDenial && message.text().startsWith("ConvexError: [CONVEX Q(payments/ledger:getAgreementLedger)]")) {
      report.expectedDenials.push({ role, operation: "payments/ledger:getAgreementLedger" });
      return;
    }
    report.errors.push({ role, kind: "console-error", text: message.text().replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").slice(0, 200) });
  });
  await open(page, "#/demo", `[data-testid="demo-enter-${role}"]`);
  await page.click(`[data-testid="demo-enter-${role}"]`);
  await page.waitForSelector('[data-testid="signed-in-identity"]', { timeout: 45000 });
  return { context, page };
}
async function shot(page, name) {
  // DOM-only screenshot masking; neither storage nor server data is changed.
  await page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      if (["SCRIPT", "STYLE"].includes(walk.currentNode.parentElement?.tagName)) continue;
      walk.currentNode.textContent = walk.currentNode.textContent.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
        (email) => email.endsWith("@demo.tradepulse") || email.endsWith("@example.com") ? email : "[sandbox email]");
    }
  });
  await page.screenshot({ path: path.join(directory, name), fullPage: false });
}
async function layout(page, role, hash, selector) {
  diagnosticPage = page;
  await open(page, hash, selector);
  check(`${role} ${hash} has one main heading`, await page.$$eval("main h1", (headings) => headings.length === 1));
  for (const width of [320, 360, 390, 768, 1440]) {
    await page.setViewport({ width, height: 900 });
    await page.waitForFunction(() => document.fonts.status === "loaded");
    const dimensions = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && (!el.closest(".table-scroll,.overflow-x-auto") || el.closest(".table-scroll,.overflow-x-auto").getBoundingClientRect().right > innerWidth + 1))
        .slice(0, 12).map((el) => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width })) }));
    check(`${role} ${hash} fits ${width}px`, dimensions.document <= dimensions.width + 1, dimensions);
  }
}
try {
  const gc = await signIn("gc");
  diagnosticPage = gc.page;
  const sub = await signIn("sub");
  const owner = await signIn("owner");
  stage = "reference defaults and receipts";
  await open(gc.page, "#/judge-demo", '[data-testid="judge-demo-agreement"]');
  check("guided demo defaults to preserved reference", await gc.page.$eval('[data-testid="judge-demo-agreement"]', (el) => el.textContent === "A401-DEMO-PAY-20261101-02"));
  check("reference hides Continue", !(await gc.page.$('[data-testid="judge-demo-continue"]')));
  await layout(gc.page, "GC", `#/payments/${agreement}`, '[data-testid="ledger-totals"]');
  const expectedTotals = {
    contractSumCents: "$55,000.00", billedCents: "$2,288.00", paidCents: "$2,288.00",
    retainageHeldCents: "$0.00", balanceCents: "$52,712.00", fundedCents: "$3,212.00",
    capturedCents: "$2,288.00", capturedNotPaidCents: "$0.00", retainageReleasedCents: "$228.80",
    changeOrdersInvoicedCents: "$0.00", changeOrdersPaidCents: "$1,850.00",
  };
  check("preserved reference financial totals are unchanged", await gc.page.evaluate((expected) =>
    Object.entries(expected).every(([key, value]) => document.querySelector(`[data-testid="ledger-${key}"]`)?.textContent.trim() === value),
  expectedTotals));
  await gc.page.waitForSelector('[data-testid="funding-tranches"]');
  const receiptIds = ["0WV193651L210315U", "94G95136J6812154U", "4HL52442UH4760109", "8P8CUQQA4RBV8", "ZFJ6GVLK6C44U", "HQ6GL4NYM9D32"];
  const missingIds = await gc.page.evaluate((ids) => ids.filter((id) => !document.body.innerText.includes(id)), receiptIds);
  check("ledger exposes provider receipt IDs", missingIds.length === 0, { missingIds });
  check("reference has no enabled money or tranche write controls", await gc.page.evaluate(() => ![...document.querySelectorAll("button")].some((b) => !b.disabled && /^(Fund |Edit$|Delete$|Add tranche|Close milestone|Check now|Re-run review)/i.test(b.textContent.trim()))));
  check("excluded scope estimate and remaining authorization explained", await gc.page.evaluate(() => document.body.innerText.includes("$4,500.00") && document.body.innerText.includes("not cash paid")));
  await gc.page.setViewport({ width: 360, height: 900 });
  await shot(gc.page, "gc-reference-ledger-360.png");
  stage = "inbox";
  await layout(gc.page, "GC", "#/inbox", '[data-testid="inbox-entry"]');
  check("paid residential card leads with a receipt and collapsed commercial records", await gc.page.evaluate(() => {
    const commercial = document.querySelector('[data-testid="inbox-commercial"]');
    return document.querySelector('[data-testid="inbox-residential-decision-action"]')?.textContent.trim() === "View paid receipt" &&
      commercial?.open === false && commercial.querySelector("summary > span")?.textContent.trim() === `Commercial reference job (${commercial.querySelectorAll('[data-testid="inbox-entry"]').length})`;
  }));
  await gc.page.type('input[placeholder^="Agreement, project"]', "A401-DEMO-PAY-20261101-02");
  await gc.page.waitForFunction(() => {
    const commercial = document.querySelector('[data-testid="inbox-commercial"]');
    return commercial?.open === true && commercial.getAttribute("data-record-count") === "2" && commercial.querySelectorAll('[data-testid="inbox-entry"]').length === 2;
  });
  check("inbox filters reference and truthful stand-ins", await gc.page.evaluate(() => {
    const text = document.querySelector("main").innerText;
    return text.includes("demo stand-in") && !text.includes("unknown owner") && !text.includes("Submitted by gc@");
  }));
  await gc.page.setViewport({ width: 360, height: 900 });
  await shot(gc.page, "gc-inbox-filter-360.png");
  stage = "mobile navigation";
  await gc.page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "Menu")?.click());
  await gc.page.waitForSelector('#workspace-navigation', { visible: true });
  await gc.page.keyboard.press("Escape");
  check("mobile Escape closes menu and restores focus", await gc.page.evaluate(() => document.activeElement?.textContent === "Menu" && document.querySelector('[aria-controls="workspace-navigation"]').getAttribute("aria-expanded") === "false"));
  await gc.page.evaluate(() => document.querySelector(".skip-link").click());
  check("skip link moves focus without changing route", await gc.page.evaluate(() => document.activeElement?.id === "workspace-main" && location.hash === "#/inbox"));
  stage = "other mobile surfaces";
  for (const [hash, selector] of [["#/payments", '[data-testid="payments-agreements"]'], [`#/agreements/${agreement}`, "main h1"], [`#/agreements/${agreement}/sov`, '[data-testid="sov-lines"]'], ["#/projects", '[data-testid="portal-change-orders"]']]) await layout(gc.page, "GC", hash, selector);
  await layout(gc.page, "GC", "#/billing-agents", "main h1");
  await layout(gc.page, "GC", "#/notifications", "main h1");
  check("notifications avoid legacy hidden placeholders", await gc.page.evaluate(() => !document.querySelector("main").innerText.includes("[hidden]")));
  for (const [hash, selector] of [["#/portal", '[data-testid="sub-contractor-name"]'], ["#/pay-apps", "main h1"], [`#/pay-apps/${payApp}`, '[data-testid="payapp-number"]']]) await layout(sub.page, "Sub", hash, selector);
  check("sub sees requested versus approved and honest missing explanation", await sub.page.evaluate(() => {
    const text = document.querySelector("main").innerText;
    return text.includes("$13,500.00") && text.includes("$288.00") && text.includes("No additional GC explanation was recorded");
  }));
  await sub.page.setViewport({ width: 360, height: 900 });
  await shot(sub.page, "sub-approval-history-360.png");
  stage = "Owner reporting and detail";
  await layout(owner.page, "Owner", "#/dashboard", '[data-testid="dashboard-convex-totals"]');
  check("Owner report shows separate 1850 invoice payment", await owner.page.evaluate(() => {
    const text = document.querySelector("main").innerText;
    return text.includes("$1,850.00") && text.includes("Owner change orders paid") && !text.includes("No agreements to report.");
  }));
  await shot(owner.page, "owner-reports-1440.png");
  await layout(owner.page, "Owner", `#/change-orders/${changeOrder}`, "main h1");
  check("Owner detail identifies agreement and payment-recorded UTC date", await owner.page.evaluate(() => {
    const text = document.querySelector("main").innerText;
    return text.includes("A401-DEMO-PAY-20261101-02") && text.includes("Payment recorded") && text.includes("UTC") && text.includes("INV2-34SZ-2MQV-HYR9-TCRG");
  }));
  expectingOwnerLedgerDenial = true;
  await open(owner.page, `#/payments/${agreement}`, '[data-testid="not-found"]');
  expectingOwnerLedgerDenial = false;
  check("Owner still cannot read subcontract ledger", true);
  stage = "malformed bookmarks";
  for (const hash of ["#/judge-demo/invalid", "#/judge-demo/%E0%A4%A"]) {
    await open(gc.page, hash, '[data-testid="not-found"]');
    check(`friendly missing state ${hash}`, !(await gc.page.evaluate(() => document.body.innerText.includes("ArgumentValidationError"))));
  }
  stage = "draft preview cancel";
  await open(sub.page, "#/pay-apps", '[data-testid="new-pay-app"]');
  const enabled = await sub.page.$('[data-testid="new-pay-app"]:not([disabled])');
  if (enabled) {
    await enabled.click();
    await sub.page.waitForSelector('[role="alertdialog"]');
    check("new pay app opens an explicit no-write preview", await sub.page.evaluate(() => document.querySelector('[role="alertdialog"]').innerText.includes("Cancel leaves no new record")));
    await sub.page.keyboard.press("Escape");
    check("cancel stays on pay-app list", sub.page.url().endsWith("#/pay-apps") && !(await sub.page.$('[role="alertdialog"]')));
  } else report.checks.push({ name: "draft preview cancel", skipped: "No eligible unused period; backend draft tests cover this without altering shared data." });
  check("no unexpected page or console errors", report.errors.length === 0);
} catch (err) {
  report.failure = { stage, message: String(err).slice(0, 400) };
  if (diagnosticPage) {
    report.diagnostic = await diagnosticPage.evaluate(() => ({ hash: location.hash,
      agreement: document.querySelector('[data-testid="judge-demo-agreement"]')?.textContent,
      heading: document.querySelector("main h1")?.textContent }));
    await shot(diagnosticPage, "failure.png");
  }
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ directory, checks: report.checks.length, failure: report.failure, errors: report.errors.length }));
}
