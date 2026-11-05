import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

/**
 * Browser acceptance for the Owner "Job so far" card. It uses the shared synthetic Owner and GC
 * demo accounts, checks that the Owner card is present and read-only, and checks that the GC project
 * summary does not receive it. It performs no write, payment or guided run.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "https://tradepulse-pay.asynchronope.tech";
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(site)) throw new Error("--url must be an https origin.");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.join(root, "evidence", `owner-job-browser-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
const report = { target: site, checks: [], pageErrors: [], consoleErrors: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  defaultViewport: { width: 1450, height: 1200 },
});
const ownerContext = await browser.createBrowserContext();
const gcContext = await browser.createBrowserContext();
const owner = await ownerContext.newPage();
const gc = await gcContext.newPage();
for (const page of [owner, gc]) {
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (text.includes("Failed to load resource") || text.includes("favicon")) return;
    report.consoleErrors.push(text);
  });
}
let phase = "open Owner demo";
try {
  await owner.goto(`${site}/#/demo`, { waitUntil: "domcontentloaded" });
  await owner.waitForSelector('[data-testid="demo-enter-owner"]');
  await owner.click('[data-testid="demo-enter-owner"]');
  await owner.waitForFunction(() => location.hash === "#/projects", { timeout: 45_000 });

  phase = "Owner job card";
  await owner.waitForSelector('[data-testid="owner-job-so-far"]', { visible: true });
  const card = await owner.evaluate(() => {
    const el = document.querySelector('[data-testid="owner-job-so-far"]');
    const progress = el?.querySelector('[role="progressbar"]');
    return {
      text: el?.innerText ?? "",
      controls: el?.querySelectorAll("button, input, select, textarea, a").length ?? -1,
      progress: progress
        ? { now: progress.getAttribute("aria-valuenow"), min: progress.getAttribute("aria-valuemin"), max: progress.getAttribute("aria-valuemax") }
        : null,
      cards: document.querySelectorAll('[data-testid="owner-job-so-far"]').length,
      status: el?.querySelector('[data-testid="owner-job-status"]')?.innerText ?? "",
      percent: el?.querySelector('[data-testid="owner-job-percent"]')?.innerText ?? "",
    };
  });
  check("Owner home shows the job-so-far card", card.cards >= 1, JSON.stringify(card));
  check("card names the job-so-far summary", card.text.includes("Job so far"));
  check("card says it is read-only", card.text.includes("Read-only"), card.text.slice(0, 500));
  check("card has no payment or approval control", card.controls === 0, String(card.controls));
  check("card has a progress bar", card.progress !== null, JSON.stringify(card.progress));
  check("progress bar is bounded 0 to 100", card.progress?.min === "0" && card.progress?.max === "100", JSON.stringify(card.progress));
  for (const label of ["Contract to date", "Completed & stored", "Paid to date", "Retainage held", "Balance to finish", "Change orders"]) {
    check(`card shows ${label}`, card.text.includes(label), card.text.slice(0, 1200));
  }
  check("card shows a dollar figure", /\$[\d,]+\.\d{2}/.test(card.text), card.text.slice(0, 1200));
  check("card shows a completion figure or a clear not-started mark", card.percent.includes("%") || card.percent === "—", card.percent);
  check("card explains paid-to-date sources", card.text.includes("paid pay apps") && card.text.includes("paid change orders"), card.text.slice(-700));
  check("card has a non-empty status line", card.status.trim().length > 0, card.status);
  await owner.screenshot({ path: path.join(evidenceDir, "owner-job-so-far.png"), fullPage: true });

  phase = "GC project summary";
  await gc.goto(`${site}/#/demo`, { waitUntil: "domcontentloaded" });
  await gc.waitForSelector('[data-testid="demo-enter-gc"]');
  await gc.click('[data-testid="demo-enter-gc"]');
  await gc.waitForFunction(() => location.hash === "#/inbox", { timeout: 45_000 });
  await gc.goto(`${site}/#/projects`, { waitUntil: "domcontentloaded" });
  await gc.waitForFunction(() => document.body.innerText.includes("Project summaries"), { timeout: 45_000 });
  const gcText = await gc.evaluate(() => document.body.innerText);
  check("GC sees project summaries", gcText.includes("Project summaries"));
  check("GC does not receive the Owner job card", (await gc.$('[data-testid="owner-job-so-far"]')) === null);
  await gc.screenshot({ path: path.join(evidenceDir, "gc-project-summaries.png"), fullPage: true });

  report.ok = true;
} catch (error) {
  report.errors = [{ phase, message: error instanceof Error ? error.message : String(error) }];
  report.ok = false;
  report.snapshot = await owner.evaluate(() => document.body.innerText.slice(0, 10000)).catch(() => "");
  report.gcSnapshot = await gc.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => "");
  await owner.screenshot({ path: path.join(evidenceDir, "failure-owner.png"), fullPage: true }).catch(() => {});
  await gc.screenshot({ path: path.join(evidenceDir, "failure-gc.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidenceDir, ...report }, null, 2));
  await browser.close();
}
