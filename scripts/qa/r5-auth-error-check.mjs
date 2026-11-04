/**
 * Read-only UI check for the blocked-recipient sign-up message on the recovery build.
 *
 *   node scripts/qa/r5-auth-error-check.mjs
 *   node scripts/qa/r5-auth-error-check.mjs --url https://tradepulse-pay.asynchronope.tech
 *
 * It submits one synthetic sign-up for a non-allowlisted, non-reserved domain. The Convex auth
 * preflight refuses before sending mail, so no message leaves the deployment and no email code exists.
 * It never signs in, starts a run, or opens PayPal.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
let origin = "https://tradepulse-pay.asynchronope.tech";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url") {
    if (!args[i + 1]) throw new Error("--url requires an origin");
    origin = args[++i].replace(/\/+$/, "");
  } else throw new Error(`Unknown option: ${args[i]}`);
}

const chrome = [
  process.env.QA_CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean).find((candidate) => fs.existsSync(candidate));
if (!chrome) throw new Error("Chrome not found; set QA_CHROME_PATH");

const directory = path.join(root, "evidence", `r5-auth-error-check-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(directory, { recursive: true });
const report = { origin, checks: [], browserErrors: [], body: "" };
const check = (name, passed, detail = {}) => {
  report.checks.push({ name, passed: Boolean(passed), ...detail });
  if (!passed) throw new Error(`Check failed: ${name}`);
};

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  defaultViewport: { width: 1440, height: 1000 },
  protocolTimeout: 60000,
});
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => report.browserErrors.push({ kind: "pageerror", text: String(error.message).slice(0, 300) }));
  page.on("console", (message) => {
    if (message.type() === "error") report.browserErrors.push({ kind: "console", text: message.text().slice(0, 300) });
  });

  await page.goto(origin, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#signin-email", { timeout: 30000 });
  const signInText = await page.evaluate(() => document.body.innerText);
  check("normal sign-in has no demo-guide link", !/judge demo/i.test(signInText));
  report.signInCommit = await page.evaluate(async () => (await fetch("/version.json", { cache: "no-store" })).json());

  const opened = await page.evaluate(() => {
    const control = [...document.querySelectorAll("a,button")].find((el) => el.textContent?.trim() === "Create account");
    control?.click();
    return Boolean(control);
  });
  check("Create account opens the sign-up form", opened);
  await page.waitForSelector("#signup-name", { timeout: 15000 });
  await page.type("#signup-name", "R5 Blocked Check");
  await page.type("#signup-email", "r5-blocked-check@asynchronope.tech");
  await page.type("#signup-password", "R5Blocked!2026Pass");
  await page.click('form[aria-label="Create account"] button[type="submit"]');

  await page.waitForFunction(
    () => document.body.innerText.includes("Not sent: this test deployment only emails approved test addresses"),
    { timeout: 45000 },
  );
  report.body = await page.evaluate(() => document.body.innerText);
  check("blocked recipient shows the test-address message", report.body.includes("only emails approved test addresses"));
  check("blocked recipient does not show an invented failure", !/couldn't create the account|something went wrong|server error/i.test(report.body));
  check("verify screen is reachable for a retry", await page.$("#verify-code") !== null);
  report.screenshot = path.join(directory, "blocked-signup.png");
  await page.screenshot({ path: report.screenshot, fullPage: true });
} finally {
  await browser.close();
}

report.passed = report.checks.filter((item) => item.passed).length;
report.total = report.checks.length;
report.browserErrors = report.browserErrors.filter((item) => !/favicon/i.test(item.text));
fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ directory, passed: report.passed, total: report.total, browserErrors: report.browserErrors.length }));
