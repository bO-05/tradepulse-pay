import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

/**
 * Browser acceptance for the pay-app question thread. Uses the R6-A dev run (not the preserved
 * reference) and the shared synthetic GC/sub accounts. The sub asks about the amount, the GC
 * replies, both sides see the thread, and the G702 money trail does not change. It also opens the
 * preserved reference pay app read-only and checks that the server refuses a composer there.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "https://tradepulse-pay.asynchronope.tech";
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(site)) throw new Error("--url must be an https origin.");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.join(root, "evidence", `pay-app-thread-browser-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
const payAppHash = "#/pay-apps/ph7f5h66zqqfcr6170j1r493bd8hnwkm";
const referencePayAppHash = "#/pay-apps/ph72dz348hz9fdsbrj7t46qrgd8hdd3c";
const question = `QA thread ${stamp}: can you confirm the $200 hold is retainage on the $2,000 approved gross?`;
const reply = `QA thread reply ${stamp}: yes, it is 10% retainage on the approved gross. No other deduction is included.`;
const report = {
  target: site,
  payApp: payAppHash,
  referencePayApp: referencePayAppHash,
  question,
  reply,
  checks: [],
  pageErrors: [],
  consoleErrors: [],
};
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  defaultViewport: { width: 1450, height: 1200 },
});
const gcContext = await browser.createBrowserContext();
const subContext = await browser.createBrowserContext();
const gc = await gcContext.newPage();
const sub = await subContext.newPage();
for (const page of [gc, sub]) {
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (error) => report.pageErrors.push(String(error)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (text.includes("Failed to load resource") || text.includes("favicon")) return;
    report.consoleErrors.push(text);
  });
}
let phase = "open sub demo";
try {
  await login(sub, "sub");
  phase = "open submitted pay app as sub";
  await openThread(sub, payAppHash);
  const subBefore = await threadSnapshot(sub);
  check("sub sees the question card", subBefore.text.includes("Questions about this amount"));
  check("sub sees the no-change explanation", subBefore.text.includes("does not change the pay app"), subBefore.text);
  check("sub has the question control", subBefore.questionButton);
  check("sub has no posting block", !subBefore.blocked, subBefore.blocked ?? "");
  check("sub thread starts empty or only has older entries", !subBefore.text.includes(question));
  await sub.screenshot({ path: path.join(evidenceDir, "thread-sub-before.png"), fullPage: true });

  phase = "sub asks the question";
  await sub.click('[data-testid="pay-app-thread-question"]');
  await sub.waitForSelector('[data-testid="pay-app-thread-input"]', { visible: true });
  await sub.type('[data-testid="pay-app-thread-input"]', question);
  await sub.waitForFunction(() => {
    const button = document.querySelector('[data-testid="pay-app-thread-send"]');
    return button !== null && !button.disabled;
  });
  await sub.click('[data-testid="pay-app-thread-send"]');
  await sub.waitForFunction((text) => document.body.innerText.includes(text), {}, question);
  const subAfter = await threadSnapshot(sub);
  check("sub entry appears immediately", subAfter.entries.some((e) => e.role === "sub" && e.text.includes(question)));
  check("sub entry keeps the question text", subAfter.text.includes(question), subAfter.text.slice(0, 1200));
  check("sub money trail is unchanged", subAfter.moneyTrail === subBefore.moneyTrail, `${subBefore.moneyTrail} -> ${subAfter.moneyTrail}`);
  await sub.screenshot({ path: path.join(evidenceDir, "thread-sub-question.png"), fullPage: true });

  phase = "open GC demo";
  await login(gc, "gc");
  phase = "GC sees the question";
  await openThread(gc, payAppHash);
  await gc.waitForFunction((text) => document.body.innerText.includes(text), {}, question);
  const gcBefore = await threadSnapshot(gc);
  check("GC reads the sub question", gcBefore.text.includes(question), gcBefore.text.slice(0, 1200));
  check("GC has a reply control", gcBefore.replyButton);
  check("GC has no sub question control", !gcBefore.questionButton);
  await gc.screenshot({ path: path.join(evidenceDir, "thread-gc-question.png"), fullPage: true });

  phase = "GC replies";
  await gc.click('[data-testid="pay-app-thread-reply"]');
  await gc.waitForSelector('[data-testid="pay-app-thread-input"]', { visible: true });
  await gc.type('[data-testid="pay-app-thread-input"]', reply);
  await gc.waitForFunction(() => {
    const button = document.querySelector('[data-testid="pay-app-thread-send"]');
    return button !== null && !button.disabled;
  });
  await gc.click('[data-testid="pay-app-thread-send"]');
  await gc.waitForFunction((text) => document.body.innerText.includes(text), {}, reply);
  const gcAfter = await threadSnapshot(gc);
  check("GC reply appears with both entries", gcAfter.entries.some((e) => e.role === "gc" && e.text.includes(reply)));
  check("GC still sees the sub question", gcAfter.text.includes(question), gcAfter.text.slice(0, 1600));
  check("GC money trail is unchanged", gcAfter.moneyTrail === gcBefore.moneyTrail, `${gcBefore.moneyTrail} -> ${gcAfter.moneyTrail}`);
  await gc.screenshot({ path: path.join(evidenceDir, "thread-gc-reply.png"), fullPage: true });

  phase = "sub sees the GC reply";
  await openThread(sub, payAppHash);
  await sub.waitForFunction((text) => document.body.innerText.includes(text), {}, reply);
  const subFinal = await threadSnapshot(sub);
  check("sub reads the GC reply", subFinal.text.includes(reply), subFinal.text.slice(0, 1600));
  check("both sides show both roles", ["sub", "gc"].every((role) => subFinal.entries.some((e) => e.role === role)));
  check("sub money trail still matches the first read", subFinal.moneyTrail === subBefore.moneyTrail, `${subBefore.moneyTrail} -> ${subFinal.moneyTrail}`);
  check("the sub can ask again later", subFinal.questionButton);
  await sub.screenshot({ path: path.join(evidenceDir, "thread-sub-reply.png"), fullPage: true });

  phase = "open preserved reference read-only";
  await openThread(sub, referencePayAppHash);
  const reference = await threadSnapshot(sub);
  check("reference thread is read-only", reference.blocked?.includes("preserved demo run") === true, reference.blocked ?? reference.text);
  check("reference has no question control", !reference.questionButton);
  check("reference has no reply control", !reference.replyButton);
  await sub.screenshot({ path: path.join(evidenceDir, "thread-reference-read-only.png"), fullPage: true });

  report.ok = true;
} catch (error) {
  report.errors = [{ phase, message: error instanceof Error ? error.message : String(error) }];
  report.ok = false;
  report.snapshot = await gc.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => "");
  report.subSnapshot = await sub.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => "");
  report.subHash = await sub.evaluate(() => location.hash).catch(() => "");
  await gc.screenshot({ path: path.join(evidenceDir, "failure-gc.png"), fullPage: true }).catch(() => {});
  await sub.screenshot({ path: path.join(evidenceDir, "failure-sub.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidenceDir, ...report }, null, 2));
  await browser.close();
}

async function login(page, role) {
  await page.goto(`${site}/#/demo`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`[data-testid="demo-enter-${role}"]`);
  await page.click(`[data-testid="demo-enter-${role}"]`);
  await page.waitForSelector('[data-testid="signed-in-identity"]', { timeout: 45_000 });
  // The Subcontractor seat lands on the settled Lopez pay app; this sweep starts at the portal.
  const home = role === "gc" ? "#/inbox" : role === "sub" ? "#/portal" : "#/projects";
  if (role === "sub") await page.evaluate(() => { location.hash = "#/portal"; });
  await page.waitForFunction((value) => location.hash === value, { timeout: 45_000 }, home);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function openThread(page, hash) {
  await page.goto(`${site}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="pay-app-thread"]', { visible: true });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading pay application"));
}

async function threadSnapshot(page) {
  return await page.evaluate(() => {
    const card = document.querySelector('[data-testid="pay-app-thread"]');
    const money = document.querySelector('[data-testid="payapp-money-trail"]');
    return {
      text: card?.innerText ?? "",
      moneyTrail: money?.innerText ?? "",
      blocked: document.querySelector('[data-testid="pay-app-thread-blocked"]')?.innerText ?? null,
      questionButton: document.querySelector('[data-testid="pay-app-thread-question"]') !== null,
      replyButton: document.querySelector('[data-testid="pay-app-thread-reply"]') !== null,
      entries: [...document.querySelectorAll('[data-testid="pay-app-thread-entry"]')].map((entry) => ({
        role: entry.getAttribute("data-author-role"),
        text: entry.innerText,
      })),
    };
  });
}
