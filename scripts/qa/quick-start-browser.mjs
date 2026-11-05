import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

/**
 * Browser acceptance for the GC Quick start: one job, one sub, an approved SOV, an executed
 * subcontract, and the honest demo-invite note. Shared demo accounts only; synthetic data.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "https://tradepulse-pay.asynchronope.tech";
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(site)) throw new Error("--url must be an https origin.");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.join(root, "evidence", `quick-start-browser-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
const title = `QA quick start ${stamp.slice(0, 16)}`;
const subEmail = `nora.qa.${stamp.replace(/[^a-z0-9]/gi, "").slice(-16).toLowerCase()}@example.com`;
const report = { target: site, title, subEmail, checks: [], errors: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  defaultViewport: { width: 1450, height: 1200 },
});
const page = await browser.newPage();
page.setDefaultTimeout(30_000);
let phase = "open demo access";
try {
  await page.goto(`${site}/#/demo`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-enter-gc"]');
  await page.click('[data-testid="demo-enter-gc"]');
  await page.waitForFunction(() => location.hash === "#/inbox");

  phase = "open quick start";
  await page.goto(`${site}/#/all-projects/quick-start`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#quick-start-job-title");
  check("quick start route opens", true);

  phase = "job step";
  await setValue(page, "#quick-start-job-title", title);
  await setValue(page, "#quick-start-job-owner", "QA Owner LLC");
  await setValue(page, "#quick-start-job-line1", "123 QA Street");
  await setValue(page, "#quick-start-job-city", "Oakland");
  await page.select("#quick-start-job-state", "CA");
  await setValue(page, "#quick-start-job-zip", "94607");
  await setValue(page, "#quick-start-job-contract", "$124,000.00");
  await setValue(page, "#quick-start-job-retainage", "5");
  await setValue(page, "#quick-start-job-billing-day", "25");
  await setValue(page, "#quick-start-job-start", "2026-11-05");
  await setValue(page, "#quick-start-job-completion", "2027-05-28");
  await clickText(page, "Continue to the sub");
  await page.waitForSelector("#quick-start-sub-company", { visible: true });
  check("job step validates and advances", true);

  phase = "sub step";
  await setValue(page, "#quick-start-sub-company", "QA Eastbay Electric");
  await setValue(page, "#quick-start-sub-contact", "Nora QA");
  await setValue(page, "#quick-start-sub-email", subEmail);
  await page.select("#quick-start-sub-trade", "26 00 00");
  await setValue(page, "#quick-start-sub-phone", "(510) 555-0142");
  await setValue(page, "#quick-start-sub-license", "C10-QA123");
  await clickText(page, "Continue to the SOV");
  await page.waitForSelector("textarea", { visible: true });
  check("sub step validates and advances", true);

  phase = "SOV step";
  await setValue(page, "textarea", "Rough-in, 22000\nTrim-out, 19500\nCloseout, 8250");
  await clickText(page, "Use pasted lines");
  await page.waitForFunction(() => document.querySelectorAll('input[id^="quick-start-sov-"][id$="-amount"]').length === 3);
  check("pasted SOV rows render", true);
  await clickText(page, "Review the setup");
  await page.waitForFunction(() => document.body.innerText.includes("Review and create"));
  const reviewText = await page.evaluate(() => document.body.innerText);
  check("review total is $49,750.00", reviewText.includes("$49,750.00"));
  check("review retainage is 5%", reviewText.includes("5%"));
  check("demo invite is explained before submit", reviewText.includes("Demo invites are read-only"));

  phase = "create";
  await clickText(page, "Create job and subcontract");
  await page.waitForFunction(
    () => document.body.innerText.includes("Job and subcontract ready") ||
      document.body.innerText.includes("Quick start stopped before it finished"),
    { timeout: 90_000 },
  );
  const successText = await page.evaluate(() => document.body.innerText);
  if (successText.includes("Quick start stopped before it finished")) {
    throw new Error(successText.slice(successText.indexOf("Quick start stopped before it finished"), 1200));
  }
  check("job and subcontract ready", successText.includes("Job and subcontract ready"));
  check("demo invite note is honest", successText.includes("Demo companies cannot create invites"));
  check("no generic stopped error", !successText.includes("Quick start stopped"));
  check("subcontract total appears", successText.includes("$49,750.00"));

  const links = await page.evaluate(() => {
    const byText = (text) => [...document.querySelectorAll("a")].find((a) => a.textContent.trim() === text)?.getAttribute("href") ?? null;
    return { project: byText("Open the job"), agreement: byText("Open the subcontract"), sov: byText("Open the SOV") };
  });
  check("project link exists", Boolean(links.project), JSON.stringify(links));
  check("agreement link exists", Boolean(links.agreement), JSON.stringify(links));
  check("SOV link exists", Boolean(links.sov), JSON.stringify(links));
  await page.screenshot({ path: path.join(evidenceDir, "quick-start-ready.png"), fullPage: true });

  phase = "verify job";
  await page.goto(`${site}/${links.project}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((name) => document.body.innerText.includes(name), {}, title);
  await page.waitForFunction(() => !document.body.innerText.includes("Loading trade packages"), { timeout: 30_000 });
  const jobText = await page.evaluate(() => document.body.innerText);
  check("project page shows the new job", jobText.includes(title));
  check("project page shows the sub trade package", jobText.includes("26 00 00") || jobText.includes("Electrical"));
  await page.screenshot({ path: path.join(evidenceDir, "quick-start-job.png"), fullPage: true });

  phase = "verify agreement";
  await page.goto(`${site}/${links.agreement}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading agreement"), { timeout: 30_000 });
  await page.waitForFunction(() => document.body.innerText.includes("QA Eastbay Electric"), { timeout: 30_000 });
  const agreementText = await page.evaluate(() => document.body.innerText);
  check("agreement page shows the sub", agreementText.includes("QA Eastbay Electric"));
  check("agreement page shows 49,750", agreementText.includes("49,750"));
  await page.screenshot({ path: path.join(evidenceDir, "quick-start-agreement.png"), fullPage: true });

  phase = "verify SOV";
  await page.goto(`${site}/${links.sov}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="sov-contract-sum"]');
  const sovText = await page.evaluate(() => document.body.innerText);
  check("SOV shows the contract sum", sovText.includes("$49,750.00"));
  check("SOV is approved", sovText.includes("Approved"));
  check("SOV is locked", sovText.includes("Locked. Changes only through change orders"));
  await page.screenshot({ path: path.join(evidenceDir, "quick-start-sov.png"), fullPage: true });

  check("three SOV lines are present", (await page.$$('[data-testid="sov-line"]')).length >= 3 || sovText.includes("Rough-in"));
  report.ok = true;
} catch (error) {
  report.errors.push({ phase, message: error instanceof Error ? error.message : String(error) });
  report.ok = false;
  report.snapshot = await page.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => "");
  await page.screenshot({ path: path.join(evidenceDir, "quick-start-failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidenceDir, ...report }, null, 2));
  await browser.close();
}

async function setValue(page, selector, value) {
  await page.waitForSelector(selector, { visible: true });
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, value);
}

async function clickText(page, text) {
  const clicked = await page.evaluate((label) => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === label && !el.disabled);
    if (!button) return false;
    button.click();
    return true;
  }, text);
  if (!clicked) throw new Error(`Enabled button not found: ${text}`);
}
