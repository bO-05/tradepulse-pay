import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

/**
 * Browser acceptance for the pay-app question thread.
 *
 * The sweep signs in with the shared demo GC and with Rosendin's sub1 account, creates its own
 * disposable pay app on the R6-A dev agreement, submits it, and uses *that* thread for the
 * question/reply round trip. It never posts to the frozen reference or to the shared settled pay
 * app; the only thing it reads there is the read-only blocker. The disposable pay app is withdrawn
 * at the end so the GC's review queue is left as it started.
 *
 * `--url` accepts an http://localhost:<port> origin like the other sweeps, and https origins:
 *   node scripts/qa/pay-app-thread-browser.mjs --url http://localhost:3150
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "https://tradepulse-pay.asynchronope.tech";
if (!/^(https:\/\/[a-z0-9.-]+(?::\d+)?|http:\/\/localhost(?::\d+)?)$/i.test(site)) throw new Error("--url must be an https origin or http://localhost:<port>.");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.join(root, "evidence", `pay-app-thread-browser-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
// The R6-A dev pay app is used only to find its agreement card in the sub's pay-app list.
const settledDevPayAppHash = "#/pay-apps/ph7f5h66zqqfcr6170j1r493bd8hnwkm";
// The preserved Rosendin reference: read-only, and the sweep never writes to it.
const referencePayAppHash = "#/pay-apps/ph72dz348hz9fdsbrj7t46qrgd8hdd3c";
// The preserving reference belongs to Rosendin's contractor, so this sweep signs in as sub1
// through the ordinary form (the public Sub seat is Ortiz on the Lopez reference).
const SUB_EMAIL = "sub1@demo.tradepulse";
const QA_AMOUNT_TEXT = "10.00";
// Read the shared password from source instead of copying it into evidence, logs or this script.
const demoPageSource = fs.readFileSync(path.join(root, "src", "auth", "DemoAccessPage.tsx"), "utf8");
const demoPassword = /export const DEMO_PASSWORD = "([^"]+)"/.exec(demoPageSource)?.[1];
if (!demoPassword) throw new Error("DEMO_PASSWORD not found in src/auth/DemoAccessPage.tsx");
const question = `QA thread ${stamp}: can you confirm the $0.50 hold is retainage on the $10.00 approved gross?`;
const reply = `QA thread reply ${stamp}: yes, it is 5% retainage on the approved gross. No other deduction is included.`;
const report = {
  target: site,
  subscriber: SUB_EMAIL,
  thread: { kind: "disposable", payAppId: null, hash: null, agreement: null, amountText: QA_AMOUNT_TEXT, withdrawn: null },
  readOnlyReference: { payApp: referencePayAppHash },
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
  executablePath: process.env.QA_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
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
let phase = "sign in as the sub";
try {
  await loginPassword(sub, SUB_EMAIL);
  const subIdentity = await sub.evaluate(() => document.querySelector('[data-testid="signed-in-identity"]')?.textContent?.trim() ?? "");
  check("the sub page is signed in as Rosendin", /rosendin/i.test(subIdentity), subIdentity);

  phase = "create a disposable pay app on the R6-A agreement";
  await openPayAppsList(sub);
  const opened = await openNewPayApp(sub, settledDevPayAppHash);
  report.thread.agreement = opened.agreement;
  report.thread.hash = await sub.evaluate(() => location.hash);
  report.thread.payAppId = report.thread.hash.replace(/^#\/pay-apps\//, "");
  report.thread.created = opened.mode === "create";
  check("the sweep uses its own disposable pay app", /^#\/pay-apps\/[a-z0-9]+$/.test(report.thread.hash), report.thread.hash);
  check("the disposable pay app is not the settled dev pay app", report.thread.hash !== settledDevPayAppHash, report.thread.hash);
  check("the disposable pay app is not the frozen reference", report.thread.hash !== referencePayAppHash, report.thread.hash);

  if (opened.status === "draft") {
    phase = "submit the disposable pay app";
    await submitDraft(sub, QA_AMOUNT_TEXT);
  } else {
    phase = "reuse the existing disposable pay app";
  }
  await sub.waitForSelector('[data-testid="pay-app-thread"]', { visible: true, timeout: 60_000 });
  await sub.waitForFunction(() => !document.body.innerText.includes("Loading pay application"));

  phase = "sub reads the disposable thread";
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

  phase = "open the GC demo";
  await loginSeat(gc, "gc");
  phase = "GC sees the question";
  await openThread(gc, report.thread.hash);
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
  await openThread(sub, report.thread.hash);
  await sub.waitForFunction((text) => document.body.innerText.includes(text), {}, reply);
  const subFinal = await threadSnapshot(sub);
  check("sub reads the GC reply", subFinal.text.includes(reply), subFinal.text.slice(0, 1600));
  check("both sides show both roles", ["sub", "gc"].every((role) => subFinal.entries.some((e) => e.role === role)));
  check("sub money trail still matches the first read", subFinal.moneyTrail === subBefore.moneyTrail, `${subBefore.moneyTrail} -> ${subFinal.moneyTrail}`);
  check("the sub can ask again later", subFinal.questionButton);
  await sub.screenshot({ path: path.join(evidenceDir, "thread-sub-reply.png"), fullPage: true });

  phase = "withdraw the disposable pay app";
  report.thread.withdrawn = await withdrawDraft(sub);
  check("the disposable pay app is withdrawn", report.thread.withdrawn === "withdrawn", String(report.thread.withdrawn));
  await sub.screenshot({ path: path.join(evidenceDir, "thread-disposable-withdrawn.png"), fullPage: true });

  phase = "open the preserved reference read-only";
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

async function loginSeat(page, role) {
  await page.goto(`${site}/#/demo`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`[data-testid="demo-enter-${role}"]`);
  await page.click(`[data-testid="demo-enter-${role}"]`);
  await page.waitForSelector('[data-testid="signed-in-identity"]', { timeout: 45_000 });
  const home = role === "gc" ? "#/inbox" : role === "sub" ? "#/portal" : "#/projects";
  await page.waitForFunction((value) => location.hash === value, { timeout: 45_000 }, home);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function loginPassword(page, email) {
  await page.goto(`${site}/#/signin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#signin-email", { timeout: 45_000 });
  await page.type("#signin-email", email);
  await page.type("#signin-password", demoPassword);
  await clickText(page, "Sign in");
  await page.waitForSelector('[data-testid="signed-in-identity"]', { timeout: 45_000 });
}

async function openPayAppsList(page) {
  await page.goto(`${site}/#/pay-apps`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading pay apps"), { timeout: 45_000 });
}

/**
 * Clicks "New pay app" on the card that owns the R6-A pay app, or adopts the open pay app that a
 * previous failed sweep left behind on that agreement. Returns the agreement identity and status.
 */
async function openNewPayApp(page, settledHash) {
  const found = await page.evaluate((targetHash) => {
    const link = document.querySelector(`a[href="${targetHash}"]`);
    if (!link) return { ok: false, reason: "the R6-A pay app is not in the sub's list" };
    const card = link.closest("section");
    if (!card) return { ok: false, reason: "the pay app link has no card" };
    const openLink = [...card.querySelectorAll('a[href^="#/pay-apps/"]')].find(
      (a) => /^(Continue|Open)\b/.test(a.textContent.trim()) && a.getAttribute("href") !== targetHash,
    );
    if (openLink) return { ok: true, mode: "adopt", href: openLink.getAttribute("href") };
    const button = card.querySelector('[data-testid="new-pay-app"]');
    if (!button) return { ok: false, reason: "the card has neither an open pay app nor a New pay app control" };
    if (button.disabled) return { ok: false, reason: "the New pay app control is disabled" };
    button.click();
    return { ok: true, mode: "create" };
  }, settledHash);
  if (!found.ok) throw new Error(found.reason);
  if (found.mode === "adopt") {
    await page.goto(`${site}/${found.href}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="g703-sheet"]', { timeout: 45_000 });
  } else {
    await page.waitForSelector('[role="dialog"]', { timeout: 15_000 });
    await clickText(page, "Create draft", '[role="dialog"]');
    await page.waitForFunction(() => /^#\/pay-apps\/[a-z0-9]+$/.test(location.hash), { timeout: 60_000 });
    await page.waitForSelector('[data-testid="g703-sheet"]', { timeout: 45_000 });
  }
  const status = await page.evaluate(() => (document.body.innerText.includes("Not submitted.") ? "draft" : "open"));
  const agreement = await page.evaluate(() => {
    const ledger = document.querySelector('[data-testid="payapp-view-payments"]')?.getAttribute("href") ?? null;
    const text = document.body.innerText;
    const match = /(SC-[A-Z0-9-]+)/.exec(text);
    return { ledger, agreementNumber: match?.[1] ?? null };
  });
  return { mode: found.mode, status, agreement };
}

async function submitDraft(page, amountText) {
  const line = await page.$('[data-testid="g703-line"][data-line-no="1"]');
  if (!line) throw new Error("the draft G703 has no line 1");
  const inputs = await line.$$("input");
  if (inputs.length === 0) throw new Error("line 1 has no money input");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type(amountText);
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => {
    const submit = document.querySelector('[data-testid="payapp-submit"]');
    return submit !== null && !submit.disabled;
  }, { timeout: 30_000 });
  await page.click('[data-testid="payapp-submit"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 15_000 });
  await clickText(page, "Submit pay app", '[role="dialog"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="g703-sheet"]') !== null && !document.body.innerText.includes("Not submitted"), { timeout: 60_000 });
  await page.waitForSelector('[data-testid="pay-app-thread"]', { visible: true, timeout: 60_000 });
}

async function withdrawDraft(page) {
  if (!(await page.$('[data-testid="payapp-withdraw"]'))) {
    await page.goto(`${site}/${await page.evaluate(() => location.hash)}`, { waitUntil: "domcontentloaded" });
  }
  await page.waitForSelector('[data-testid="payapp-withdraw"]', { timeout: 45_000 });
  await page.click('[data-testid="payapp-withdraw"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 15_000 });
  await clickText(page, "Withdraw pay app", '[role="dialog"]');
  await page.waitForFunction(() => /withdrawn/i.test(document.body.innerText), { timeout: 60_000 });
  const status = await page.evaluate(() => document.body.innerText);
  return /withdrawn/i.test(status) ? "withdrawn" : status.slice(0, 400);
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

async function clickText(page, text, rootSelector = null) {
  const clicked = await page.evaluate(
    (label, rootSel) => {
      const scope = rootSel ? document.querySelector(rootSel) : document;
      if (!scope) return false;
      const button = [...scope.querySelectorAll("button")].find((el) => el.textContent.trim() === label && !el.disabled);
      if (!button) return false;
      button.click();
      return true;
    },
    text,
    rootSelector,
  );
  if (!clicked) throw new Error(`Enabled button not found: ${text}${rootSelector ? ` in ${rootSelector}` : ""}`);
}
