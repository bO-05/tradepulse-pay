import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT as root, launchBrowser, attachDiagnostics, delay } from "./lib.mjs";

/**
 * Read-only acceptance for the `#/demo` judge landing (VAL-JUDGE-001 / VAL-JUDGE-002).
 *
 * Proves, at 1440x900 and 390x844:
 *  - exactly three role buttons, all inside the first viewport, and no other button before them;
 *  - the six manual items sit in one collapsed "Manual sign-in and sandbox details" disclosure;
 *  - the Subcontractor seat signs into sub4@demo.tradepulse and lands on the settled Lopez pay app
 *    with the money trail and PayPal payout receipt visible.
 *
 * It never approves, pays or starts a guided run. Defaults to the local dev server; pass
 * `--url https://<host>` to run it against a deployed build.
 */
const site = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://localhost:3150";
const outDir = process.argv.includes("--out")
  ? path.resolve(process.argv[process.argv.indexOf("--out") + 1])
  : path.join(root, "docs", "evidence", `demo-landing-${new Date().toISOString().slice(0, 10)}`);
fs.mkdirSync(outDir, { recursive: true });

const seatsSource = fs.readFileSync(path.join(root, "src", "auth", "demoSeats.ts"), "utf8");
const settledPayAppId = /SETTLED_LOPEZ_PAY_APP_ID = "([^"]+)"/.exec(seatsSource)?.[1];
if (!settledPayAppId) throw new Error("SETTLED_LOPEZ_PAY_APP_ID not found in src/auth/demoSeats.ts");
const SETTLED_HASH = `#/pay-apps/${settledPayAppId}`;
// Read the shared password from source instead of copying it into evidence, logs or this script.
const demoPageSource = fs.readFileSync(path.join(root, "src", "auth", "DemoAccessPage.tsx"), "utf8");
const demoPassword = /export const DEMO_PASSWORD = "([^"]+)"/.exec(demoPageSource)?.[1];
if (!demoPassword) throw new Error("DEMO_PASSWORD not found in src/auth/DemoAccessPage.tsx");
const MANUAL_ITEMS = [
  { label: "demo password", value: demoPassword },
  { label: "test card", value: "4032031427005060" },
  { label: "mirror URL", value: "cheery-axolotl-689.convex.site" },
  { label: "Recovery-dev note", value: "Recovery-dev" },
  { label: "Studio license note", value: "Studio license" },
];

/** Never publish a sandbox business inbox in evidence; the public demo addresses stay visible. */
async function maskSandboxEmails(page) {
  await page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const parent = walk.currentNode.parentElement;
      if (!parent || ["SCRIPT", "STYLE"].includes(parent.tagName)) continue;
      walk.currentNode.textContent = walk.currentNode.textContent.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) =>
        /@demo\.tradepulse$/i.test(email) ? email : "[sandbox email]",
      );
    }
  });
}

const report = { target: site, settledPayAppId, checks: [], measurements: [], diagnostics: [], checksRun: 0 };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  if (!ok) console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
};

/** Read the page without opening any disclosure. */
async function readLanding(page) {
  return page.evaluate(() => {
    const main = document.querySelector('[data-testid="demo-access-page"]');
    const seats = [...document.querySelectorAll('[data-testid^="demo-enter-"]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-testid"), top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      innerText: main?.innerText ?? "",
      buttons: [...document.querySelectorAll("button")].map((b) => ({
        testid: b.getAttribute("data-testid"),
        top: Math.round(b.getBoundingClientRect().top),
      })),
      seats,
      details: [...document.querySelectorAll("details")].map((d) => ({
        testid: d.getAttribute("data-testid"),
        summary: d.querySelector("summary")?.textContent?.trim() ?? "",
        open: d.open,
        text: d.textContent ?? "",
        items: d.querySelectorAll("dt").length,
      })),
      links: [...document.querySelectorAll("a[href]")].map((a) => ({
        text: (a.textContent ?? "").trim().slice(0, 80),
        href: a.getAttribute("href"),
      })),
    };
  });
}

async function openManual(page) {
  await page.evaluate(() => {
    const details = [...document.querySelectorAll("details")].find(
      (d) => d.getAttribute("data-testid") === "demo-manual-details",
    );
    if (details) details.open = true;
  });
  await delay(150);
}

for (const [width, height] of [[1440, 900], [390, 844]]) {
  const { browser } = await launchBrowser(width, height);
  const page = await browser.newPage();
  const diagnostics = attachDiagnostics(page);
  await page.goto(`${site}/#/demo`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="demo-access-page"]');
  await delay(300);

  const landing = await readLanding(page);
  // Keep the disclosure text out of the tracked report: it contains the shared demo password.
  report.measurements.push({
    width,
    ...landing,
    details: landing.details.map(({ text, ...rest }) => ({ ...rest, textLength: text.length })),
  });
  const manual = landing.details.find((d) => d.testid === "demo-manual-details");
  const manualMatches = landing.details.filter((d) => d.summary.includes("Manual sign-in and sandbox details"));

  check(`[${width}] exactly three role buttons`, landing.seats.length === 3, JSON.stringify(landing.seats.map((s) => s.id)));
  check(
    `[${width}] all three role buttons end inside the first viewport`,
    landing.seats.every((s) => s.bottom <= landing.viewport.height),
    JSON.stringify(landing.seats),
  );
  check(
    `[${width}] role buttons are the first buttons on the page`,
    landing.buttons[0]?.testid?.startsWith("demo-enter-") === true,
    JSON.stringify(landing.buttons.slice(0, 3)),
  );
  check(`[${width}] role buttons meet the 44px primary-action floor`, landing.seats.every((s) => s.height >= 44), JSON.stringify(landing.seats.map((s) => s.height)));
  const rosendinLinks = landing.links.filter((link) => /rosendin|sub1@|judge-demo/i.test(`${link.text} ${link.href}`));
  check(`[${width}] link census shows no Rosendin seat or commercial run`, rosendinLinks.length === 0, JSON.stringify(rosendinLinks));
  // A bare "#" is a dead link: it reloads the demo page and never opens the sign-in form. "#/" is
  // the app root, which renders the real sign-in form (with "create account") when signed out.
  const deadLinks = landing.links.filter((link) => link.href === "#" || link.href === "" || link.href === "#/home");
  check(`[${width}] demo page has no dead hash links`, deadLinks.length === 0, JSON.stringify(deadLinks));
  const normalSignIn = landing.links.find((link) => link.text === "Normal sign-in / create a GC account");
  check(
    `[${width}] the normal sign-in link navigates to the sign-in form instead of href="#"`,
    normalSignIn?.href === "#/",
    JSON.stringify(normalSignIn),
  );
  for (const item of MANUAL_ITEMS) {
    check(`[${width}] ${item.label} is not rendered before the disclosure opens`, !landing.innerText.includes(item.value));
  }
  check(`[${width}] one manual disclosure`, manualMatches.length === 1);
  check(`[${width}] manual disclosure is titled exactly "Manual sign-in and sandbox details"`, manual?.summary === "Manual sign-in and sandbox details", manual?.summary);
  check(`[${width}] manual disclosure is collapsed`, manual?.open === false, String(manual?.open));
  check(`[${width}] manual disclosure has exactly six items`, manual?.items === 6, String(manual?.items));
  for (const item of MANUAL_ITEMS) {
    check(`[${width}] manual disclosure contains the ${item.label}`, manual?.text.includes(item.value) === true);
  }
  check(`[${width}] manual disclosure contains the commit hash`, /Build\s+[0-9a-f]{7,40}/.test(manual?.text ?? ""), `${(manual?.text ?? "").length} chars`);
  check(`[${width}] no horizontal overflow`, landing.scrollWidth === width, `${landing.scrollWidth} vs ${width}`);
  await maskSandboxEmails(page);
  await page.screenshot({ path: path.join(outDir, `demo-collapsed-${width}.png`) });

  await openManual(page);
  const expanded = await page.evaluate(() => {
    const details = document.querySelector('[data-testid="demo-manual-details"]');
    return {
      text: details?.innerText ?? "",
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  for (const item of MANUAL_ITEMS) {
    check(`[${width}] expanded disclosure shows the ${item.label}`, expanded.text.includes(item.value));
  }
  check(`[${width}] expanded disclosure does not overflow`, expanded.scrollWidth === width, `${expanded.scrollWidth} vs ${width}`);
  await page.evaluate(() => document.querySelector('[data-testid="demo-manual-details"]')?.scrollIntoView({ block: "start" }));
  await delay(150);
  await maskSandboxEmails(page);
  await page.screenshot({ path: path.join(outDir, `demo-expanded-${width}.png`) });

  // The real judge path: the Subcontractor seat signs into Ortiz and lands on the settled pay app.
  await page.evaluate(() => {
    const details = document.querySelector('[data-testid="demo-manual-details"]');
    if (details) details.open = false;
  });
  await page.click('[data-testid="demo-enter-sub"]');
  await page.waitForFunction(() => location.hash.startsWith("#/pay-apps/"), { timeout: 60000 });
  await page.waitForSelector('[data-testid="payapp-money-trail"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="payment-panel"]', { timeout: 60000 });
  await delay(300);
  const landed = await page.evaluate(() => ({
    hash: location.hash,
    identity: document.querySelector('[data-testid="signed-in-identity"]')?.textContent?.trim() ?? "",
    moneyTrail: document.querySelector('[data-testid="payapp-money-trail"]')?.innerText ?? "",
    payout: document.querySelector('[data-testid="payment-panel"]')?.innerText ?? "",
    text: document.body.innerText,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  report.landing = { hash: landed.hash, identity: landed.identity };
  check(`[${width}] Subcontractor lands on the settled Lopez pay app`, landed.hash === SETTLED_HASH, landed.hash);
  check(`[${width}] Subcontractor is signed in as sub4@demo.tradepulse`, landed.identity.includes("sub4@demo.tradepulse"), landed.identity);
  check(`[${width}] money trail shows claimed $5,400.00 and net $3,800.00`, landed.moneyTrail.includes("$5,400.00") && landed.moneyTrail.includes("$3,800.00"), landed.moneyTrail.slice(0, 200));
  check(`[${width}] net figure is visible`, /Net this draw/i.test(landed.text));
  check(`[${width}] PayPal payout receipt is visible`, landed.payout.includes("PayPal payout batch") && landed.payout.includes("D5V7XEN5YZH4C"), "payout batch id present");
  await maskSandboxEmails(page);
  await page.screenshot({ path: path.join(outDir, `sub-payapp-${width}.png`), fullPage: true });

  // `AgentIdButton` cancels its sign-in-options probe on unmount after sign-in; that is a browser
  // abort of an in-flight request, not a failed request, and the endpoint itself is optional.
  const failedRequests = diagnostics.failedRequests.filter(
    (line) => !(line.includes("/api/sign-in-options") && line.includes("net::ERR_ABORTED")),
  );
  report.diagnostics.push({
    width,
    consoleErrors: diagnostics.consoleLogs.filter((l) => l.type === "error"),
    pageErrors: diagnostics.pageErrors,
    failedRequests,
    ignoredAborts: diagnostics.failedRequests.filter((line) => !failedRequests.includes(line)),
  });
  check(`[${width}] zero page errors`, diagnostics.pageErrors.length === 0, JSON.stringify(diagnostics.pageErrors));
  check(`[${width}] zero failed requests`, failedRequests.length === 0, JSON.stringify(failedRequests));
  check(
    `[${width}] zero console errors`,
    diagnostics.consoleLogs.filter((l) => l.type === "error").length === 0,
    JSON.stringify(diagnostics.consoleLogs.filter((l) => l.type === "error").slice(0, 3)),
  );

  // The other two seats keep the accounts and landing routes they always had.
  if (width === 1440) {
    for (const [role, email, expectedHash, selector] of [
      ["gc", "gc@demo.tradepulse", "#/inbox", '[data-testid="inbox-counts"]'],
      ["owner", "owner@demo.tradepulse", "#/projects", '[data-testid="owner-job-so-far"]'],
    ]) {
      const context = await browser.createBrowserContext();
      const seatPage = await context.newPage();
      await seatPage.goto(`${site}/#/demo`, { waitUntil: "networkidle0", timeout: 60000 });
      await seatPage.waitForSelector(`[data-testid="demo-enter-${role}"]`);
      await seatPage.click(`[data-testid="demo-enter-${role}"]`);
      await seatPage.waitForFunction((hash) => location.hash === hash, { timeout: 60000 }, expectedHash);
      await seatPage.waitForSelector(selector, { timeout: 60000 });
      const seat = await seatPage.evaluate(() => ({
        hash: location.hash,
        identity: document.querySelector('[data-testid="signed-in-identity"]')?.textContent?.trim() ?? "",
      }));
      check(`[${width}] ${role} seat keeps ${expectedHash}`, seat.hash === expectedHash, seat.hash);
      check(`[${width}] ${role} seat keeps the ${email} account`, seat.identity.includes(email), seat.identity);
      await maskSandboxEmails(seatPage);
      await seatPage.screenshot({ path: path.join(outDir, `${role}-landing-${width}.png`) });
      await context.close();
    }
  }
  await browser.close();
}

report.checksRun = report.checks.length;
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
const failures = report.checks.filter((c) => !c.ok);
console.log(JSON.stringify({ outDir, checksRun: report.checksRun, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
