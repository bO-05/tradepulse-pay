/**
 * Recovery-dev only, fresh isolated contexts. Read-only inspection: the only remote writes are the
 * ordinary demo sign-ins. It verifies the judge-facing fixes from the November 3 V3/V4 audit:
 * hidden unconfigured providers, one date convention, the dashboard money chart, the pay-app money
 * trail and G702 snapshot note, focus after sign-in, and the shared Not found page.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = "https://cheery-axolotl-689.convex.site";
if (
  process.env.CONVEX_DEPLOY_KEY ||
  !/^CONVEX_DEPLOYMENT=dev:cheery-axolotl-689(?:\s|$)/m.test(fs.readFileSync(path.join(root, ".env.local"), "utf8"))
) {
  throw new Error("Recovery dev only.");
}
const directory = path.join(root, "evidence", `audit-v3-browser-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(directory, { recursive: true });
const report = { target: site, mode: "Read-only V3/V4 retest; demo authentication only", checks: [], errors: [] };
const check = (name, passed, detail = {}) => {
  report.checks.push({ name, passed: Boolean(passed), ...detail });
  if (!passed) throw new Error(`Check failed: ${name}`);
};
const bodyText = (page) => page.evaluate(() => document.body.innerText);

const browser = await puppeteer.launch({
  executablePath: process.env.QA_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  defaultViewport: { width: 1440, height: 1000 },
  protocolTimeout: 60000,
});

async function open(page, hash) {
  await page.goto(`${site}/${hash}`, { waitUntil: "domcontentloaded" });
}

async function signIn(role) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on("pageerror", () => report.errors.push({ role, kind: "pageerror" }));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    report.errors.push({ role, kind: "console-error", text: message.text().slice(0, 200) });
  });
  await open(page, "#/demo");
  await page.waitForSelector(`[data-testid="demo-enter-${role}"]`, { timeout: 45000 });
  await page.click(`[data-testid="demo-enter-${role}"]`);
  await page.waitForSelector('[data-testid="signed-in-identity"]', { timeout: 45000 });
  await page.waitForFunction(() => document.querySelector("main") !== null, { timeout: 45000 });
  return { context, page };
}

async function screenshot(page, name) {
  // Screenshots never publish a sandbox business inbox; the public demo addresses stay visible.
  await page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      if (["SCRIPT", "STYLE"].includes(walk.currentNode.parentElement?.tagName)) continue;
      walk.currentNode.textContent = walk.currentNode.textContent.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) =>
        /@demo\.tradepulse$/i.test(email) ? email : "[sandbox email]",
      );
    }
  });
  await page.screenshot({ path: path.join(directory, name), fullPage: false });
}

try {
  // Public sign-in: an unconfigured provider is hidden, not a disabled button plus an apology.
  const publicContext = await browser.createBrowserContext();
  const publicPage = await publicContext.newPage();
  await open(publicPage, "#/");
  await publicPage.waitForSelector('form[aria-label="Sign in"]', { timeout: 45000 });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const signInText = await bodyText(publicPage);
  check("sign-in hides the unconfigured AgentID button", !signInText.includes("Continue with AgentID"));
  check("sign-in hides the AgentID configuration apology", !signInText.includes("AgentID is not configured"));
  check("sign-in still explains the sandbox", signInText.includes("PayPal sandbox") && signInText.includes("no real money"));
  await screenshot(publicPage, "sign-in-1440.png");
  await publicContext.close();

  const gc = await signIn("gc");
  await new Promise((resolve) => setTimeout(resolve, 500));
  check("sign-in moves focus into the workspace", await gc.page.evaluate(() => document.activeElement?.id === "workspace-main"));

  // Reports: one date convention, a real money chart, and no license apology.
  await open(gc.page, "#/dashboard");
  await gc.page.waitForSelector('[data-testid="dashboard-basic-view"]', { timeout: 45000 });
  const dashboard = await bodyText(gc.page);
  check("reports label the global pending figure as all agreements", dashboard.includes("pending pay apps across all agreements"));
  check("reports drop raw Convex debug metadata", !dashboard.includes("Live from Convex"));
  check("reports hide the unconfigured Studio warning", !dashboard.includes("AG Studio license is not configured"));
  check("reports state the basic view needs no license", dashboard.includes("No AG Studio license is needed"));
  check("reports render the money chart", (await gc.page.$('[data-testid="dashboard-money-chart"]')) !== null);
  const barCount = await gc.page.$$eval('[data-testid="dashboard-money-chart"] [role="img"]', (rows) => rows.length);
  check("money chart draws one bar per active agreement", barCount >= 1, { barCount });
  await screenshot(gc.page, "reports-money-chart-1440.png");
  await gc.page.setViewport({ width: 390, height: 900 });
  await gc.page.waitForFunction(() => document.fonts.status === "loaded");
  check("reports fit a 390px phone", await gc.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await screenshot(gc.page, "reports-money-chart-390.png");
  await gc.page.setViewport({ width: 1440, height: 1000 });

  // Pay app: the money trail names the AI figure, the GC figure and the retainage snapshot.
  await open(gc.page, "#/pay-apps/ph7fh2dpqnx82kq1dn3gwcp8yx8hcem6");
  await gc.page.waitForSelector('[data-testid="payapp-money-trail"]', { timeout: 45000 });
  const payApp = await bodyText(gc.page);
  check("pay app shows the money trail", payApp.includes("Money trail") && payApp.includes("Claimed"));
  check("money trail shows the AI recommendation and GC approval", payApp.includes("AI recommended gross $320.00") && payApp.includes("GC approved $288.00"));
  check("money trail explains the edit", payApp.includes("$32.00 below the AI recommendation"));
  check("G702 explains the retainage snapshot", (await gc.page.$('[data-testid="g702-retainage-note"]')) !== null);
  check("G702 links the release record to the ledger", payApp.includes("a later release does not rewrite this historical G702"));
  check("pay app dates use labeled UTC", /\d{1,2}:\d{2} [AP]M UTC/.test(payApp));
  check("pay app dates never duplicate the timezone", !/\bUTC\s+UTC\b/.test(payApp));
  await screenshot(gc.page, "pay-app-money-trail-1440.png");
  await gc.page.setViewport({ width: 360, height: 900 });
  await gc.page.waitForFunction(() => document.fonts.status === "loaded");
  check("money trail fits a 360px phone", await gc.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await screenshot(gc.page, "pay-app-money-trail-360.png");
  await gc.page.setViewport({ width: 1440, height: 1000 });

  // Sub: a prime change-order bookmark returns the shared Not found page with an h1.
  const sub = await signIn("sub");
  await open(sub.page, "#/change-orders/kx79veec7m5m0gqw5mz1nmb718hch9t");
  await sub.page.waitForSelector('[data-testid="not-found"]', { timeout: 45000 });
  check("forbidden change order uses the shared Not found page", (await sub.page.$eval("main h1", (el) => el.textContent)) === "Not found");
  check("the denial does not reveal the change order", !(await bodyText(sub.page)).includes("PCO #"));

  check("no unexpected console or page errors", report.errors.length === 0, { errors: report.errors });
} catch (error) {
  report.failure = String(error?.message ?? error);
} finally {
  report.passed = report.checks.filter((c) => c.passed).length;
  report.total = report.checks.length;
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, passed: report.passed, total: report.total, failure: report.failure ?? null, errors: report.errors.length }));
  await browser.close();
}
if (report.failure) process.exitCode = 1;
