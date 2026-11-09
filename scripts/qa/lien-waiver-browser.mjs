import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

/**
 * Browser acceptance for the opt-in lien-waiver gate. Uses the shared synthetic demo accounts and a
 * paid demo pay app. It reads the gate's current value, turns it on only if it is off for the test,
 * then restores the starting value. It does not submit a signature, so no waiver record is created.
 *
 * `--url` accepts an http://localhost:<port> origin like the other sweeps, and https origins:
 *   node scripts/qa/lien-waiver-browser.mjs --url http://localhost:3150
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "https://tradepulse-pay.asynchronope.tech";
if (!/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(site)) throw new Error("--url must be an http(s) origin.");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.join(root, "evidence", `lien-waiver-browser-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
const agreementHash = "#/agreements/jn759h53ce7h290fmpckyszrwd8hnzpc";
const payAppHash = "#/pay-apps/ph7f5h66zqqfcr6170j1r493bd8hnwkm";
// Read the shared password from source instead of copying it into evidence, logs or this script.
const demoPageSource = fs.readFileSync(path.join(root, "src", "auth", "DemoAccessPage.tsx"), "utf8");
const demoPassword = /export const DEMO_PASSWORD = "([^"]+)"/.exec(demoPageSource)?.[1];
if (!demoPassword) throw new Error("DEMO_PASSWORD not found in src/auth/DemoAccessPage.tsx");
// Rosendin (sub1) is a party to the commercial agreement this sweep opens. The public Sub seat is
// Ortiz Plumbing on the frozen Lopez reference, so it signs in through the ordinary sign-in form.
const SUB_EMAIL = "sub1@demo.tradepulse";
const report = {
  target: site,
  agreement: agreementHash,
  payApp: payAppHash,
  subscriber: SUB_EMAIL,
  gateBefore: null,
  gateAfter: null,
  gateRestored: null,
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
  await loginSeat(gc, "gc");
  phase = "read the gate's starting value";
  report.gateBefore = await readGate(gc);
  check("gate reads either on or off before the test", report.gateBefore === "on" || report.gateBefore === "off", report.gateBefore);
  if (report.gateBefore === "off") {
    phase = "enable gate";
    await setGate(gc, "on");
  }
  const onText = await gc.evaluate(() => document.body.innerText);
  check("gate is on for the test", onText.includes("Gate is on"));
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

  phase = "sign in as Rosendin (sub1)";
  await loginPassword(sub, SUB_EMAIL);
  const subIdentity = await sub.evaluate(() => document.querySelector('[data-testid="signed-in-identity"]')?.textContent?.trim() ?? "");
  check("the sub page is signed in as Rosendin", /rosendin/i.test(subIdentity), subIdentity);
  phase = "open pay app as sub";
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

  phase = "restore the gate";
  report.gateAfter = await setGate(gc, report.gateBefore);
  report.gateRestored = report.gateAfter === report.gateBefore;
  check("gate is restored to the value it started with", report.gateRestored, `${report.gateBefore} -> ${report.gateAfter}`);

  phase = "confirm the restored gate's effect";
  await gc.goto(`${site}/${payAppHash}`, { waitUntil: "domcontentloaded" });
  await gc.waitForFunction(() => !document.body.innerText.includes("Loading pay application"), { timeout: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const panelPresent = (await gc.$('[data-testid="lien-waiver-panel"]')) !== null;
  check(
    report.gateAfter === "off" ? "waiver panel is absent when the restored gate is off" : "waiver panel is present when the restored gate is on",
    report.gateAfter === "off" ? !panelPresent : panelPresent,
  );
  await gc.screenshot({ path: path.join(evidenceDir, "pay-app-restored.png"), fullPage: true });

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
  // Best effort: never leave the shared deployment's gate flipped, even when a check above threw.
  if (report.gateBefore && report.gateAfter !== report.gateBefore) {
    try {
      report.gateAfter = await setGate(gc, report.gateBefore);
      report.gateRestored = report.gateAfter === report.gateBefore;
    } catch (restoreError) {
      report.gateRestoreError = restoreError instanceof Error ? restoreError.message : String(restoreError);
      report.gateRestored = false;
    }
  }
  fs.writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        evidenceDir,
        target: report.target,
        ok: report.ok,
        gateBefore: report.gateBefore,
        gateAfter: report.gateAfter,
        gateRestored: report.gateRestored,
        checks: report.checks.length,
        failedChecks: report.checks.filter((c) => !c.ok).map((c) => c.name),
        errors: report.errors,
        gateRestoreError: report.gateRestoreError,
      },
      null,
      2,
    ),
  );
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

async function readGate(page) {
  await page.goto(`${site}/${agreementHash}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.includes("Lien-waiver gate"), { timeout: 45_000 });
  await page.waitForFunction(() => /Gate is (on|off)/.test(document.body.innerText), { timeout: 45_000 });
  const text = await page.evaluate(() => document.body.innerText);
  if (text.includes("Gate is on")) return "on";
  if (text.includes("Gate is off")) return "off";
  throw new Error("The gate card did not read on or off.");
}

/** Reads the current value first, then flips only when the requested value differs. */
async function setGate(page, desired) {
  const current = await readGate(page);
  if (current === desired) return current;
  if (desired === "on") {
    await clickText(page, "Enable lien-waiver gate");
    await page.waitForSelector('[role="alertdialog"]');
    await clickText(page, "Enable gate", '[role="alertdialog"]');
    await page.waitForFunction(() => document.body.innerText.includes("Gate is on"), { timeout: 30_000 });
  } else {
    await clickText(page, "Turn off gate");
    await page.waitForSelector('[role="alertdialog"]');
    await clickText(page, "Turn off gate", '[role="alertdialog"]');
    await page.waitForFunction(() => document.body.innerText.includes("Gate is off"), { timeout: 30_000 });
  }
  return readGate(page);
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
