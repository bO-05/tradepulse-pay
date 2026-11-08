import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

/**
 * Browser acceptance for the opt-in lien-waiver gate. Uses the shared synthetic demo accounts and a
 * paid demo pay app. It enables the gate, checks the GC and sub views and the signing dialog, then
 * turns the gate off again. It does not submit a signature, so no waiver record is created.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "https://tradepulse-pay.asynchronope.tech";
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(site)) throw new Error("--url must be an https origin.");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.join(root, "evidence", `lien-waiver-browser-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
const agreementHash = "#/agreements/jn759h53ce7h290fmpckyszrwd8hnzpc";
const payAppHash = "#/pay-apps/ph7f5h66zqqfcr6170j1r493bd8hnwkm";
const report = {
  target: site,
  agreement: agreementHash,
  payApp: payAppHash,
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
let phase = "open GC demo";
try {
  await login(gc, "gc");
  phase = "open agreement as GC";
  await gc.goto(`${site}/${agreementHash}`, { waitUntil: "domcontentloaded" });
  await gc.waitForFunction(() => document.body.innerText.includes("Lien-waiver gate"), { timeout: 45_000 });
  let offText = await gc.evaluate(() => document.body.innerText);
  if (offText.includes("Gate is on")) {
    await clickText(gc, "Turn off gate");
    await gc.waitForSelector('[role="alertdialog"]');
    await clickText(gc, "Turn off gate", '[role="alertdialog"]');
    await gc.waitForFunction(() => document.body.innerText.includes("Gate is off"), { timeout: 30_000 });
    offText = await gc.evaluate(() => document.body.innerText);
  }
  check("GC sees the gate card off before the test", offText.includes("Gate is off"), offText.slice(0, 500));
  await gc.screenshot({ path: path.join(evidenceDir, "gate-off.png"), fullPage: true });

  phase = "enable gate";
  await clickText(gc, "Enable lien-waiver gate");
  await gc.waitForSelector('[role="alertdialog"]');
  const enableDialog = await gc.evaluate(() => document.querySelector('[role="alertdialog"]').innerText);
  check("enable confirmation explains the payout requirement", enableDialog.includes("Every payout on this subcontract will wait"));
  await clickText(gc, "Enable gate", '[role="alertdialog"]');
  await gc.waitForFunction(() => document.body.innerText.includes("Gate is on"), { timeout: 30_000 });
  const onText = await gc.evaluate(() => document.body.innerText);
  check("gate turns on", onText.includes("Gate is on"));
  check("gate names the enabling admin", onText.includes("Enabled"));
  await gc.screenshot({ path: path.join(evidenceDir, "gate-on.png"), fullPage: true });

  phase = "open paid pay app as GC";
  await gc.goto(`${site}/${payAppHash}`, { waitUntil: "domcontentloaded" });
  await gc.waitForSelector('[data-testid="lien-waiver-panel"]', { visible: true });
  const gcPanel = await gc.evaluate(() => document.querySelector('[data-testid="lien-waiver-panel"]').innerText);
  check("GC sees the waiver panel", gcPanel.includes("Lien waivers"));
  check("conditional waiver names the approved amount", gcPanel.includes("$2,000.00"), gcPanel);
  check("conditional waiver is not signed", gcPanel.toLowerCase().includes("not signed"));
  check("GC sees that the sub must sign", gcPanel.includes("Waiting for the sub to sign"));
  check(
    "GC has no signing button",
    (await gc.$('[data-testid="lien-waiver-sign-conditional"]')) === null,
  );
  check("no prior unconditional waiver is demanded for a pre-gate payment", !gcPanel.includes("Unconditional waiver for the prior payment"));
  await gc.screenshot({ path: path.join(evidenceDir, "pay-app-gate-on-gc.png"), fullPage: true });

  phase = "open pay app as sub";
  await login(sub, "sub");
  await sub.waitForFunction(() => document.body.innerText.includes("My agreements & pay applications"), { timeout: 45_000 });
  await openHash(sub, payAppHash);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await sub.waitForSelector('[data-testid="lien-waiver-panel"]', { visible: true });
  const subPanel = await sub.evaluate(() => document.querySelector('[data-testid="lien-waiver-panel"]').innerText);
  check("sub sees the waiver panel", subPanel.includes("Conditional waiver for this payment"));
  check("sub sees the signing control", (await sub.$('[data-testid="lien-waiver-sign-conditional"]')) !== null);

  phase = "open signing dialog as sub";
  await clickText(sub, "Sign conditional waiver");
  await sub.waitForSelector('[role="dialog"]');
  const dialog = await sub.evaluate(() => document.querySelector('[role="dialog"]').innerText);
  check("signing dialog names the conditional waiver", dialog.includes("Sign the conditional waiver"));
  check("signing dialog shows the server amount", dialog.includes("$2,000.00"), dialog);
  check("signing dialog shows the recipient", dialog.includes("Fixture GC") || dialog.includes("Austin Commercial"), dialog);
  check("signing dialog requires the attestation", dialog.includes("I understand it is an in-app attestation"));
  check("signing dialog has a full-name field", (await sub.$('input[type="text"]')) !== null);
  await sub.screenshot({ path: path.join(evidenceDir, "signing-dialog.png"), fullPage: true });

  phase = "review the exact statement as sub";
  await sub.type('input[type="text"]', "Dana Sub");
  await sub.evaluate(() => {
    const box = document.querySelector('[role="dialog"] input[type="checkbox"]');
    if (box) box.click();
  });
  await clickText(sub, "Review statement", '[role="dialog"]');
  await sub.waitForSelector('[data-testid="lien-waiver-statement"]', { timeout: 30_000 });
  const statement = await sub.evaluate(() => document.querySelector('[data-testid="lien-waiver-statement"]').textContent);
  check(
    "review shows the statement the server will hash",
    statement.includes("CONDITIONAL LIEN WAIVER") && statement.includes("Amount waived: $2,000.00"),
    statement,
  );
  check("review names the signer", statement.includes("Signed by: Dana Sub"), statement);
  check("review names the recipient", statement.includes("Recipient of the waiver:"), statement);
  check("review keeps the disclaimer", statement.includes("not legal advice"), statement);
  const reviewText = await sub.evaluate(() => document.querySelector('[role="dialog"]').innerText);
  check("review says the evidence is recorded", reviewText.includes("IP address") && reviewText.includes("SHA-256"), reviewText);
  await sub.screenshot({ path: path.join(evidenceDir, "signing-review.png"), fullPage: true });
  await clickText(sub, "Back", '[role="dialog"]');
  await sub.waitForSelector('[data-testid="lien-waiver-statement"]', { hidden: true, timeout: 10_000 });
  check("Back returns to the form without signing", (await sub.$('[data-testid^="lien-waiver-signed-"]')) === null);

  await clickText(sub, "Cancel", '[role="dialog"]');
  await sub.waitForFunction(() => document.querySelector('[role="dialog"]') === null, { timeout: 10_000 });
  check("cancelling closes the dialog without signing", (await sub.$('[data-testid^="lien-waiver-signed-"]')) === null);

  phase = "turn gate off as GC";
  await gc.goto(`${site}/${agreementHash}`, { waitUntil: "domcontentloaded" });
  await gc.waitForFunction(() => document.body.innerText.includes("Gate is on"), { timeout: 30_000 });
  await clickText(gc, "Turn off gate");
  await gc.waitForSelector('[role="alertdialog"]');
  await clickText(gc, "Turn off gate", '[role="alertdialog"]');
  await gc.waitForFunction(() => document.body.innerText.includes("Gate is off"), { timeout: 30_000 });
  check("gate turns off again", true);

  phase = "confirm panel disappears";
  await gc.goto(`${site}/${payAppHash}`, { waitUntil: "domcontentloaded" });
  await gc.waitForFunction(() => !document.body.innerText.includes("Loading pay application"), { timeout: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  check("waiver panel is absent when the gate is off", (await gc.$('[data-testid="lien-waiver-panel"]')) === null);
  await gc.screenshot({ path: path.join(evidenceDir, "pay-app-gate-off.png"), fullPage: true });

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

async function openHash(page, hash) {
  await page.evaluate((value) => {
    location.hash = value.startsWith("#") ? value.slice(1) : value;
  }, hash);
  await page.waitForFunction((value) => location.hash === value, {}, hash);
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
