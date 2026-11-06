import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

/**
 * Read-only proof that GC Quick start survives a reload.
 *
 * Signs in as the shared demo GC, opens #/all-projects/quick-start, types a project name, reloads and
 * checks that the draft, the resume banner and "Start over" behave. It never presses a create button,
 * so no Convex record is written; the only state it changes is this browser profile's own draft.
 *
 *   node scripts/qa/quick-start-resume-browser.mjs
 *   node scripts/qa/quick-start-resume-browser.mjs --url https://cheery-axolotl-689.convex.site
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "https://tradepulse-pay.asynchronope.tech";
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(site)) throw new Error("--url must be an https origin.");
const QUICK_START = "#/all-projects/quick-start";
const DRAFT_KEY = "tradepulse.quickStart.v1.";
const PROJECT_NAME = "Lopez kitchen remodel";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.join(root, "evidence", `quick-start-resume-browser-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
const report = { target: site, checks: [], pageErrors: [], consoleErrors: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  defaultViewport: { width: 1280, height: 1000 },
});
let phase = "sign-in";
try {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (text.includes("Failed to load resource") || text.includes("favicon")) return;
    report.consoleErrors.push(text);
  });

  await page.goto(`${site}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('form[aria-label="Sign in"]');
  await page.click('[data-testid="landing-open-demo"]');
  await page.waitForSelector('[data-testid="demo-access-page"]');
  await page.click('[data-testid="demo-enter-gc"]');
  await page.waitForFunction(() => location.hash === "#/inbox", { timeout: 60_000 });
  check("the demo GC is signed in", true);

  phase = "open-quick-start";
  await page.goto(`${site}/${QUICK_START}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('form[aria-label="Quick start job"]');
  check("quick start opens on step 1", (await page.evaluate(() => document.body.innerText)).includes("Step 1 of 4: Job"));
  check(
    "a fresh wizard shows no resume banner",
    !(await page.evaluate(() => document.body.innerText)).includes("Resumed a saved quick start"),
  );
  // The wizard writes its draft on mount, so a first visit stores one empty, company-scoped draft.
  const fresh = await page.evaluate((prefix) => {
    const keys = Object.keys(window.localStorage).filter((key) => key.startsWith(prefix));
    const raw = keys.length === 1 ? JSON.parse(window.localStorage.getItem(keys[0])) : null;
    return { keys, title: raw?.form?.title ?? null, ids: raw?.ids ?? null };
  }, DRAFT_KEY);
  check("the first visit stores one empty draft for this company", fresh.keys.length === 1 && fresh.title === "" && Object.keys(fresh.ids ?? {}).length === 0, JSON.stringify(fresh));

  phase = "type-and-persist";
  await page.click("#quick-start-job-title");
  await page.type("#quick-start-job-title", PROJECT_NAME);
  const stored = await page.evaluate((prefix) => {
    const key = Object.keys(window.localStorage).find((candidate) => candidate.startsWith(prefix));
    if (!key) return null;
    const raw = JSON.parse(window.localStorage.getItem(key));
    return { key, title: raw?.form?.title ?? null, step: raw?.step ?? null, ids: raw?.ids ?? null };
  }, DRAFT_KEY);
  check("typing saves the draft under a per-company key", Boolean(stored?.key), JSON.stringify(stored));
  check("the saved draft holds the typed project name", stored?.title === PROJECT_NAME, JSON.stringify(stored));
  check("the saved draft keeps step 1 and no created ids", stored?.step === 1 && Object.keys(stored?.ids ?? {}).length === 0, JSON.stringify(stored));

  phase = "reload";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('form[aria-label="Quick start job"]');
  const afterReload = await page.evaluate(() => ({
    title: document.querySelector("#quick-start-job-title")?.value ?? null,
    text: document.body.innerText,
  }));
  check("the reload restores the typed project name", afterReload.title === PROJECT_NAME, String(afterReload.title));
  check("the reload explains that a saved draft was resumed", afterReload.text.includes("Resumed a saved quick start"), afterReload.text.slice(0, 400));
  check("the resumed draft says nothing has been created", afterReload.text.includes("Nothing has been created yet."));
  check("a draft without records shows no locked step", !afterReload.text.includes("The job is already created"), afterReload.text.slice(0, 600));
  await page.screenshot({ path: path.join(evidenceDir, "resumed-draft.png"), fullPage: true });

  phase = "start-over";
  await page.evaluate(() => {
    const details = [...document.querySelectorAll("details")].find((el) => el.textContent?.includes("Start over"));
    if (!details) throw new Error("the resume banner has no Start over control");
    details.open = true;
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes("Start a fresh quick start"));
    if (!button) throw new Error("Start over has no confirm button");
    button.click();
  });
  await page.waitForFunction(() => !document.body.innerText.includes("Resumed a saved quick start"), { timeout: 20_000 });
  const afterReset = await page.evaluate(() => ({
    title: document.querySelector("#quick-start-job-title")?.value ?? null,
    text: document.body.innerText,
  }));
  check("Start over removes the resume banner", !afterReset.text.includes("Resumed a saved quick start"));
  check("Start over clears the form", afterReset.title === "", String(afterReset.title));
  await page.screenshot({ path: path.join(evidenceDir, "started-over.png"), fullPage: true });

  check("no unexpected page errors", report.pageErrors.length === 0, JSON.stringify(report.pageErrors));
  check("no unexpected console errors", report.consoleErrors.length === 0, JSON.stringify(report.consoleErrors));
} catch (error) {
  report.error = String(error);
} finally {
  report.ok = report.checks.every((c) => c.ok) && !report.error;
  report.phase = phase;
  fs.writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(
    JSON.stringify(
      { ok: report.ok, error: report.error ?? null, phase, checks: report.checks.length, evidence: evidenceDir },
      null,
      2,
    ),
  );
  process.exit(report.ok ? 0 : 1);
}
