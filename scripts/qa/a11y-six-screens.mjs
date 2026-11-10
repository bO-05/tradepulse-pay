#!/usr/bin/env node
/**
 * Accessibility and cross-screen design gate for the six judge screens.
 *
 *   node scripts/qa/a11y-six-screens.mjs --url http://localhost:3150
 *   node scripts/qa/a11y-six-screens.mjs --url https://tradepulse-pay.asynchronope.tech --out docs/evidence/a11y-...
 *
 * Signs in through the public demo seats, then checks every judge screen at 1440x900 and
 * 390x844 in both disclosure states:
 *
 *   - axe-core with no serious or critical violation,
 *   - every visible a/button/input/select/textarea/summary/[role=button] at least 24px tall
 *     and every primary-variant action at least 44px,
 *   - exactly one visible primary action per screen,
 *   - status pills carry words, never colour alone,
 *   - the shared money trail is present on the sub, GC and owner views,
 *   - the inbox's reachable empty state is an EmptyState with one action,
 *   - no horizontal page overflow,
 *   - no app-copy hit from the shared leak-scan rules (quoted recorded history is reported,
 *     never failed or rewritten), and
 *   - no page or console errors.
 *
 * Screens: #/demo, #/inbox, screen 3 in both of its routes (the Lopez project page and the GC
 * owner-billing tab with Lopez selected), the settled Ortiz pay app, #/projects, #/owner-pay-apps
 * and the Lopez change-order invoice. Writes report.json, report.md and screenshots under --out
 * (default docs/evidence/a11y-six-screens-<date>).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { AxePuppeteer } from "@axe-core/puppeteer";
import { REPO_ROOT, attachDiagnostics, delay } from "./lib.mjs";
import { DEMO_COMMIT_RULE, RULES, extractText, openDisclosures, scanText } from "./copy-rules.mjs";
import {
  captureEvidenceScreenshot,
  maskEmailsInPage,
  safeEvidenceLine,
  sanitizeForEvidence,
  writeEvidenceJson,
  writeEvidenceText,
} from "./evidence-privacy.mjs";

const require = createRequire(import.meta.url);
const AXE_SOURCE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const AXE_VERSION = require("axe-core/package.json").version;

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE_URL = argValue("--url", process.env.REM_BASE_URL || "http://localhost:3150").replace(/\/+$/, "");
const OUT_DIR = path.resolve(
  argValue("--out", path.join(REPO_ROOT, "docs", "evidence", `a11y-six-screens-${new Date().toISOString().slice(0, 10)}`)),
);
fs.mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  axeVersion: AXE_VERSION,
  viewports: VIEWPORTS,
  screens: [],
  checks: [],
  failures: [],
};
const check = (name, ok, detail = "") => {
  const safeDetail = redact(detail);
  report.checks.push({ name, ok, detail: safeDetail });
  if (!ok) report.failures.push({ name, detail: safeDetail });
};

function readSettledPayAppId() {
  const file = path.join(REPO_ROOT, "src", "auth", "demoSeats.ts");
  const source = fs.readFileSync(file, "utf8");
  const id = /SETTLED_LOPEZ_PAY_APP_ID\s*=\s*"([^"]+)"/.exec(source)?.[1];
  if (!id) throw new Error(`SETTLED_LOPEZ_PAY_APP_ID not found in ${file}`);
  return id;
}

/**
 * Read the shared password from source instead of copying it into this script, a log or
 * docs/evidence. The demo manual block is leak-exempt, but the committed screenshots and
 * report must not reproduce the credential.
 */
function readDemoPassword() {
  const file = path.join(REPO_ROOT, "src", "auth", "DemoAccessPage.tsx");
  const source = fs.readFileSync(file, "utf8");
  const password = /export const DEMO_PASSWORD\s*=\s*"([^"]+)"/.exec(source)?.[1];
  if (!password) throw new Error(`DEMO_PASSWORD not found in ${file}`);
  return password;
}

const DEMO_PASSWORD = readDemoPassword();
const REDACTED_PASSWORD = "[demo password redacted]";

/** Recursively replaces the demo password in everything written to the evidence report. */
function redactSecret(value) {
  if (typeof value === "string") return value.split(DEMO_PASSWORD).join(REDACTED_PASSWORD);
  if (Array.isArray(value)) return value.map(redactSecret);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactSecret(child)]));
  }
  return value;
}

/**
 * Every report value is evidence: the demo credential is redacted and every email-shaped value is
 * masked, recursively, before it can reach report.json, report.md or stdout.
 */
function redact(value) {
  return sanitizeForEvidence(redactSecret(value));
}

function browserPath() {
  const candidates = [
    process.env.QA_CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("No Chrome/Edge binary found. Set QA_CHROME_PATH.");
  return found;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function waitForScreen(page, selectors, timeout = 60000) {
  for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
    await page.waitForSelector(selector, { timeout });
  }
  await page.waitForFunction(
    () => !document.body.innerText.includes("Connecting to Convex reactive backend"),
    { timeout },
  );
  await page.waitForFunction(
    () => !/Loading (the )?(money|inbox|draw|pay application)/i.test(document.body.innerText),
    { timeout },
  ).catch(() => {});
  await page.waitForFunction(
    () => ((document.querySelector("#workspace-main") ?? document.body).innerText ?? "").trim().length > 0,
    { timeout },
  );
  await delay(800);
}

async function enterSeat(browser, seat) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${BASE_URL}/#/demo`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector(`[data-testid="demo-enter-${seat}"]`, { timeout: 30000 });
  await page.click(`[data-testid="demo-enter-${seat}"]`);
  await page.waitForFunction(() => location.hash !== "#/demo", { timeout: 60000 });
  await page.waitForFunction(
    () => !document.body.innerText.includes("Connecting to Convex reactive backend"),
    { timeout: 60000 },
  );
  await delay(1500);
  await page.close();
  return context;
}

async function resolveLopezHash(context) {
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/#/all-projects`, { waitUntil: "networkidle0", timeout: 60000 });
  await waitForScreen(page, "#workspace-main");
  const href = await page.evaluate(() => {
    const link = [...document.querySelectorAll("a[href]")].find((a) => /Lopez Kitchen/i.test(a.textContent ?? ""));
    return link?.getAttribute("href") ?? null;
  });
  await page.close();
  if (!href) throw new Error("Could not find the Lopez project link on #/all-projects");
  return href;
}

/**
 * Screen 3's second route is project-scoped. The picker sorts the residential job first, but the
 * audit drives it explicitly so the measured screen is named Lopez rather than relying on order.
 */
async function selectLopezOwnerBilling(page) {
  const state = await page.evaluate(() => {
    const select = document.querySelector('[data-testid="owner-billing-project"]');
    if (!select) return { picker: false, selected: null };
    const option = [...select.options].find((o) => /Lopez Kitchen/i.test(o.textContent ?? ""));
    if (!option) return { picker: true, selected: null };
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { picker: true, selected: option.value };
  });
  if (state.picker && !state.selected) throw new Error("GC owner billing: the Lopez project is not in the picker");
  await page.waitForFunction(
    () => /Money on this job/i.test(document.querySelector('[data-testid="project-money-strip"]')?.innerText ?? ""),
    { timeout: 30000 },
  );
  await delay(1000);
  return state;
}

async function resolveChangeOrderHash(context) {
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/#/change-orders`, { waitUntil: "networkidle0", timeout: 60000 });
  await waitForScreen(page, "#workspace-main");
  const picked = await page.evaluate(() => {
    const select = document.querySelector('[data-testid="change-orders-project"]');
    if (!select) return false;
    const option = [...select.options].find((o) => /Lopez Kitchen/i.test(o.textContent ?? ""));
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  if (!picked) throw new Error("Could not select the Lopez project on #/change-orders");
  await delay(1500);
  const href = await page.evaluate(
    () => [...document.querySelectorAll('a[href*="/change-orders/"]')][0]?.getAttribute("href") ?? null,
  );
  await page.close();
  if (!href) throw new Error("No change-order detail link on the Lopez project");
  return href;
}

/** Visible interactive population the contract measures (plus summaries, which are also targets). */
const TARGET_SELECTOR = "a, button, input, select, textarea, summary, [role=button]";

async function measure(page, name, width) {
  return page.evaluate(
    (targetSelector) => {
      const visible = (el) => {
        if (el.closest("details:not([open])")) return false;
        if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true });
        return el.getClientRects().length > 0;
      };
      const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const targets = [...document.querySelectorAll(targetSelector)].filter(visible);
      const measured = targets.map((el) => {
        const rect = el.getBoundingClientRect();
        const classes = typeof el.className === "string" ? el.className : "";
        const primary = /\bbg-accent\b/.test(classes) && /\btext-accent-fg\b/.test(classes);
        return {
          tag: el.tagName.toLowerCase(),
          testId: el.getAttribute("data-testid"),
          text: words(el).slice(0, 70),
          height: Math.round(rect.height * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          primary,
          // The named primary's full computed class list is part of VAL-JUDGE-003's evidence.
          ...(primary ? { classes } : {}),
          ariaHidden: el.getAttribute("aria-hidden") === "true",
        };
      });
      const visibleTargets = measured.filter((t) => !t.ariaHidden);
      const primaries = visibleTargets.filter((t) => t.primary);
      const under24 = visibleTargets.filter((t) => t.height < 24);
      const under44Primary = primaries.filter((t) => t.height < 44);

      // Containers such as a proposal card also carry data-status for the tests; only leaf status
      // nodes are the visible pills/labels, so scan those for colour-only communication.
      const statuses = [...document.querySelectorAll("[data-status]")]
        .filter((el) => visible(el) && el.querySelector("[data-status]") === null)
        .map((el) => ({ status: el.getAttribute("data-status"), text: words(el).slice(0, 120) }));
      const wordlessStatuses = statuses.filter((s) => s.text === "" || s.text.includes("_"));

      // Every reachable EmptyState on this screen must explain the next step and offer one action.
      // (The inbox's filter-empty state is also driven and screenshotted explicitly below.)
      const emptyStates = [...document.querySelectorAll(".border-dashed")]
        .filter(visible)
        .map((el) => {
          const actions = [...el.querySelectorAll("button, a")].filter(visible);
          const paragraphs = [...el.querySelectorAll("p")].filter(visible);
          return {
            title: el.querySelector("h2, h3")?.textContent?.trim() ?? null,
            text: words(el).slice(0, 240),
            actionCount: actions.length,
            action: actions[0]?.textContent?.trim() ?? null,
            descriptionCount: paragraphs.length,
          };
        });

      const strings = {
        pageText: (document.body.innerText ?? "").replace(/\s+/g, " ").trim(),
        payappMoneyTrail: !!document.querySelector('[data-testid="payapp-money-trail"]'),
        gcMoneyTrail: !!document.querySelector('[data-testid="gc-money-trail"]'),
        ownerMoneyTrail: !!document.querySelector('[data-testid="owner-money-trail"]'),
        ownerDrawMoneyTrail: !!document.querySelector('[data-testid="owner-draw-money-trail"]'),
        moneyStrip: document.querySelector('[data-testid="project-money-strip"]')?.innerText ?? null,
        retainageLabels: [...document.querySelectorAll('[data-testid="project-money-retainage"]')].map((el) => {
          const cell = el.closest("div");
          return words(cell).slice(0, 160);
        }),
        payappRetainage: document.querySelector('[data-testid="payapp-retainage-total"]')?.innerText ?? null,
        demoSeats: document.querySelectorAll('[data-testid^="demo-enter-"]').length,
        demoManualDetails: document.querySelector('[data-testid="demo-manual-details"] summary')?.textContent?.trim() ?? null,
      };

      return {
        hash: location.hash,
        title: document.title,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        targetCount: visibleTargets.length,
        minTargetHeight: visibleTargets.length ? Math.min(...visibleTargets.map((t) => t.height)) : null,
        primaries,
        // VAL-JUDGE-006 enumerates the whole measured population with each element's
        // selector (tag + test id) and measured height.
        targets: visibleTargets,
        under24,
        under44Primary,
        statuses,
        wordlessStatuses,
        emptyStates,
        strings,
      };
    },
    TARGET_SELECTOR,
  );
}

async function axeScan(page) {
  const results = await new AxePuppeteer(page, AXE_SOURCE)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    count: v.nodes.length,
    nodes: v.nodes.slice(0, 3).map((n) => ({ target: n.target, summary: (n.failureSummary ?? "").slice(0, 240) })),
  }));
  const seriousCritical = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  return { violations, seriousCritical };
}

function leakText(text, route) {
  const rules = route === "#/demo" ? [...RULES, DEMO_COMMIT_RULE] : RULES;
  return scanText(text, rules);
}

/**
 * The filter fields render twice (a desktop grid and a mobile <details>). At 390 the first copy
 * is CSS-hidden, so a real mouse click is not available; a native setter plus an input event
 * drives the same controlled React state at both widths.
 */
async function setSearchValue(page, value) {
  return page.evaluate((next) => {
    const inputs = [...document.querySelectorAll('input[placeholder^="Agreement, project"]')];
    const el = inputs[0];
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, value);
}

async function emptyStateCheck(page, width, screenshotPath) {
  if (!(await setSearchValue(page, "zzz-no-such-application"))) return { ok: false, reason: "search input not found" };
  await page.waitForFunction(() => document.body.innerText.includes("No applications match these filters"), { timeout: 10000 }).catch(() => {});
  await delay(500);
  // The search re-render can restore raw values, so mask again before measuring and capturing.
  await maskEmailsInPage(page);
  const result = await page.evaluate(() => {
    const visible = (el) => (typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0);
    const empty = [...document.querySelectorAll(".border-dashed")].filter(visible).find((el) => /No applications match these filters/.test(el.innerText));
    if (!empty) return { ok: false, reason: "EmptyState not found for the filtered inbox" };
    const actions = [...empty.querySelectorAll("button, a")].filter(visible);
    const descriptions = [...empty.querySelectorAll("p")].filter(visible).map((p) => p.textContent.trim());
    return {
      ok: actions.length === 1 && descriptions.length > 0,
      title: empty.innerText.split("\n")[0],
      text: empty.innerText.replace(/\s+/g, " ").trim(),
      actionCount: actions.length,
      action: actions[0]?.textContent?.trim() ?? null,
      descriptions,
    };
  });
  if (screenshotPath) await captureEvidenceScreenshot(page, screenshotPath, { fullPage: true });
  await setSearchValue(page, "");
  await page.waitForFunction(() => !document.body.innerText.includes("No applications match these filters"), { timeout: 10000 }).catch(() => {});
  await delay(500);
  return { width, ...result };
}

async function auditState(page, screen, viewport, state) {
  // Mask after the state has settled and before anything is measured. The target text, page text,
  // axe run and capture must all describe the same masked DOM the evidence persists.
  await maskEmailsInPage(page);
  const measured = await measure(page, screen.name, viewport.width);
  const axe = await axeScan(page);
  const extracted = await extractText(page);
  const appHits = leakText(extracted.appText, screen.route);
  const recordedHits = leakText(extracted.recordedText, screen.route);
  const shot = path.join(OUT_DIR, `${screen.slug}-${viewport.width}-${state}.png`);
  await captureEvidenceScreenshot(page, shot, { fullPage: true });
  const prefix = `${screen.name} @${viewport.width} ${state}`;

  check(`${prefix}: no horizontal overflow`, measured.scrollWidth <= measured.innerWidth + 1, `${measured.scrollWidth} vs ${measured.innerWidth}`);
  check(`${prefix}: exactly one primary action`, measured.primaries.length === 1, JSON.stringify(measured.primaries));
  check(`${prefix}: every primary action is at least 44px tall`, measured.under44Primary.length === 0, JSON.stringify(measured.under44Primary));
  check(`${prefix}: every visible target is at least 24px tall`, measured.under24.length === 0, JSON.stringify(measured.under24));
  check(`${prefix}: status pills carry words`, measured.wordlessStatuses.length === 0, JSON.stringify(measured.wordlessStatuses));
  check(
    `${prefix}: every EmptyState offers one action and an explanation`,
    measured.emptyStates.every((empty) => empty.actionCount === 1 && empty.descriptionCount >= 1),
    JSON.stringify(measured.emptyStates),
  );
  check(`${prefix}: no serious or critical axe violation`, axe.seriousCritical.length === 0, JSON.stringify(axe.seriousCritical));
  check(`${prefix}: no app-copy leak`, appHits.length === 0, JSON.stringify(appHits));
  return { state, viewport: viewport.width, measured, axe, appHits, quotedRecordedHits: recordedHits, screenshot: path.relative(REPO_ROOT, shot) };
}

async function main() {
  const settledPayAppId = readSettledPayAppId();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: browserPath(),
    protocolTimeout: 300000,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1440, height: 900 },
  });

  let gcContext;
  let subContext;
  let ownerContext;
  try {
    gcContext = await enterSeat(browser, "gc");
    subContext = await enterSeat(browser, "sub");
    ownerContext = await enterSeat(browser, "owner");
    const lopezHash = await resolveLopezHash(gcContext);
    const coHash = await resolveChangeOrderHash(ownerContext);

    const screens = [
      { name: "Demo landing", slug: "demo", route: "#/demo", url: `${BASE_URL}/#/demo`, context: null, selector: ['[data-testid="demo-access-page"]'], seat: "signed out" },
      // Readiness uses structural markers, not the exact action under test: if a required trail or
      // primary is missing, the audit reports that as a failed check instead of timing out.
      { name: "GC home", slug: "gc-home", route: "#/inbox", url: `${BASE_URL}/#/inbox`, context: gcContext, selector: ["#workspace-main", '[data-testid="project-money-strip"]', '[data-testid="inbox-counts"]'], seat: "gc" },
      { name: "Lopez project page", slug: "lopez-project", route: lopezHash, url: `${BASE_URL}/${lopezHash}`, context: gcContext, selector: ["#workspace-main", '[data-testid="project-money-strip"]'], seat: "gc" },
      // Screen 3's second route: the GC owner-billing tab with the Lopez job selected. It renders a
      // composition no other audited route renders (project picker, money strip, GC draw detail).
      { name: "Lopez owner billing", slug: "lopez-owner-billing", route: "#/billing/owner-billing", url: `${BASE_URL}/#/billing/owner-billing`, context: gcContext, selector: ["#workspace-main", '[data-testid="gc-owner-billing"]', '[data-testid="project-money-strip"]'], seat: "gc", prepare: selectLopezOwnerBilling },
      { name: "Sub pay app", slug: "sub-pay-app", route: `#/pay-apps/${settledPayAppId}`, url: `${BASE_URL}/#/pay-apps/${settledPayAppId}`, context: subContext, selector: ["#workspace-main", '[data-testid="payapp-number"]'], seat: "sub" },
      { name: "Owner home", slug: "owner-home", route: "#/projects", url: `${BASE_URL}/#/projects`, context: ownerContext, selector: ["#workspace-main", '[data-testid="owner-job-so-far"]'], seat: "owner" },
      { name: "Owner draw", slug: "owner-draw", route: "#/owner-pay-apps", url: `${BASE_URL}/#/owner-pay-apps`, context: ownerContext, selector: ["#workspace-main", '[data-testid="owner-documents"]'], seat: "owner" },
      { name: "Change-order invoice", slug: "change-order-invoice", route: coHash, url: `${BASE_URL}/${coHash}`, context: ownerContext, selector: ["#workspace-main", '[data-testid="change-order-amount"]'], seat: "owner" },
    ];

    for (const screen of screens) {
      const screenReport = { name: screen.name, route: screen.route, seat: screen.seat, states: [], emptyState: null, diagnostics: null };
      for (const viewport of VIEWPORTS) {
        const context = screen.context ?? (await browser.createBrowserContext());
        const page = await context.newPage();
        const diag = attachDiagnostics(page);
        await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
        await page.goto(screen.url, { waitUntil: "networkidle0", timeout: 60000 });
        await waitForScreen(page, screen.selector);
        if (screen.prepare) await screen.prepare(page);
        // New screenshots and a clean disclosure state per viewport.
        const closed = await auditState(page, screen, viewport, "closed");
        // Dedicated trail crops for VAL-JUDGE-004's three surfaces (plus the owner draw).
        const trailTestId = {
          "lopez-project": "gc-money-trail",
          "sub-pay-app": "payapp-money-trail",
          "owner-home": "owner-money-trail",
          "owner-draw": "owner-draw-money-trail",
        }[screen.slug];
        let trailScreenshot = null;
        if (trailTestId) {
          const trail = await page.$(`[data-testid="${trailTestId}"]`);
          if (trail) {
            trailScreenshot = path.join(OUT_DIR, `${screen.slug}-${viewport.width}-money-trail.png`);
            await captureEvidenceScreenshot(page, trailScreenshot, { element: trail });
            trailScreenshot = path.relative(REPO_ROOT, trailScreenshot);
          }
        }
        if (screen.slug === "gc-home") {
          const emptyShot = path.join(OUT_DIR, `${screen.slug}-${viewport.width}-empty.png`);
          screenReport.emptyState = {
            ...screenReport.emptyState,
            [viewport.width]: {
              ...(await emptyStateCheck(page, viewport.width, emptyShot)),
              screenshot: path.relative(REPO_ROOT, emptyShot),
            },
          };
        }
        const opened = await openDisclosures(page);
        const open = await auditState(page, screen, viewport, "open");
        open.disclosuresOpened = opened;
        // The #/demo manual block is leak-exempt but still a reachable target surface, so axe and
        // the 24px floor are measured with it open; it is left out of the leak extractor above.
        let manualOpen = null;
        if (screen.slug === "demo") {
          await page.evaluate(() => {
            const el = document.querySelector('[data-testid="demo-manual-details"]');
            if (el && !el.open) {
              el.open = true;
              el.dispatchEvent(new Event("toggle"));
            }
          });
          await delay(400);
          // The manual block is public to judges, but neither the committed screenshot nor the
          // persisted measurements may reproduce the credential or an address. Mask both before
          // measuring, then the capture wrapper re-masks and verifies before the screenshot.
          await page.evaluate(
            (secret, replacement) => {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              let node;
              while ((node = walker.nextNode())) {
                const value = node.textContent ?? "";
                if (value.includes(secret)) node.textContent = value.split(secret).join(replacement);
              }
            },
            DEMO_PASSWORD,
            "••••••••",
          );
          await maskEmailsInPage(page);
          const manualMeasured = await measure(page, screen.name, viewport.width);
          const manualAxe = await axeScan(page);
          const manualShot = path.join(OUT_DIR, `${screen.slug}-${viewport.width}-manual-open.png`);
          await captureEvidenceScreenshot(page, manualShot, { fullPage: true });
          check(`Demo landing @${viewport.width} manual-open: no serious or critical axe violation`, manualAxe.seriousCritical.length === 0, JSON.stringify(manualAxe.seriousCritical));
          check(`Demo landing @${viewport.width} manual-open: every visible target is at least 24px tall`, manualMeasured.under24.length === 0, JSON.stringify(manualMeasured.under24));
          check(`Demo landing @${viewport.width} manual-open: exactly one primary action`, manualMeasured.primaries.length === 1, JSON.stringify(manualMeasured.primaries));
          manualOpen = { measured: manualMeasured, axe: manualAxe, screenshot: path.relative(REPO_ROOT, manualShot) };
        }

        // Contract-specific design assertions.
        if (screen.slug === "demo") {
          check(`Demo landing @${viewport.width}: exactly three seats`, closed.measured.strings.demoSeats === 3, String(closed.measured.strings.demoSeats));
          check(
            `Demo landing @${viewport.width}: one collapsed manual details block`,
            closed.measured.strings.demoManualDetails === "Manual sign-in and sandbox details",
            String(closed.measured.strings.demoManualDetails),
          );
        }
        if (screen.slug === "gc-home") {
          check(`GC home @${viewport.width}: money strip is present`, closed.measured.strings.moneyStrip !== null);
          // The Lopez strip is the only strip on the GC home, so retainage reads in both directions:
          // the sub cell says "Retainage you hold" and the separate owner cell says "Retainage held from you".
          check(
            `GC home @${viewport.width}: retainage is labeled in both directions`,
            /Retainage you hold/i.test(closed.measured.strings.retainageLabels.join(" ")) &&
              /Retainage held from you/i.test(closed.measured.strings.moneyStrip ?? ""),
            JSON.stringify(closed.measured.strings.retainageLabels),
          );
          const empty = screenReport.emptyState?.[viewport.width];
          check(`GC home @${viewport.width}: the reachable empty state uses EmptyState with one action`, !!empty?.ok, JSON.stringify(empty));
        }
        if (screen.slug === "lopez-project") {
          check(`Lopez project page @${viewport.width}: the shared GC money trail is present`, closed.measured.strings.gcMoneyTrail);
        }
        if (screen.slug === "lopez-owner-billing") {
          check(`Lopez owner billing @${viewport.width}: the money strip is present`, closed.measured.strings.moneyStrip !== null);
          check(
            `Lopez owner billing @${viewport.width}: the strip is scoped to the Lopez job`,
            /Money on this job/i.test(closed.measured.strings.moneyStrip ?? ""),
            String(closed.measured.strings.moneyStrip ?? "").slice(0, 120),
          );
          check(
            `Lopez owner billing @${viewport.width}: the Lopez job is selected`,
            /Lopez Kitchen Remodel/i.test(closed.measured.strings.pageText),
            closed.measured.strings.pageText.slice(0, 200),
          );
        }
        if (screen.slug === "sub-pay-app") {
          check(`Sub pay app @${viewport.width}: the shared money trail is present`, closed.measured.strings.payappMoneyTrail);
          check(`Sub pay app @${viewport.width}: retainage reads as a word plus a figure`, /retainage/i.test(closed.measured.strings.payappRetainage ?? "") && /\$/.test(closed.measured.strings.payappRetainage ?? ""), String(closed.measured.strings.payappRetainage));
        }
        if (screen.slug === "owner-home") {
          check(`Owner home @${viewport.width}: the shared owner money trail is present`, closed.measured.strings.ownerMoneyTrail);
          check(`Owner home @${viewport.width}: headed Job so far`, /Job so far/i.test(closed.measured.strings.pageText), closed.measured.strings.pageText.slice(0, 200));
        }
        if (screen.slug === "owner-draw") {
          check(`Owner draw @${viewport.width}: the shared owner draw money trail is present`, closed.measured.strings.ownerDrawMoneyTrail);
        }
        if (screen.slug === "change-order-invoice") {
          check(`Change-order invoice @${viewport.width}: the invoice amount is on the page`, /Add under-cabinet lighting/i.test(closed.measured.strings.pageText));
        }

        screenReport.states.push({ viewport: viewport.width, trailScreenshot, closed, open, manualOpen, diagnostics: {
          pageErrors: diag.pageErrors,
          consoleErrors: diag.consoleLogs.filter((l) => l.type === "error" && !/Failed to load resource|favicon/i.test(l.text)),
          failedRequests: diag.failedRequests.filter((r) => !/ERR_ABORTED/.test(r)),
        } });
        check(`${screen.name} @${viewport.width}: no page errors`, diag.pageErrors.length === 0, JSON.stringify(diag.pageErrors));
        check(
          `${screen.name} @${viewport.width}: no console errors`,
          diag.consoleLogs.filter((l) => l.type === "error" && !/Failed to load resource|favicon/i.test(l.text)).length === 0,
          JSON.stringify(diag.consoleLogs.filter((l) => l.type === "error")),
        );
        screenReport.diagnostics = screenReport.diagnostics ?? { pageErrors: [], consoleErrors: [], failedRequests: [] };
        screenReport.diagnostics.pageErrors.push(...diag.pageErrors);
        screenReport.diagnostics.consoleErrors.push(...diag.consoleLogs.filter((l) => l.type === "error" && !/Failed to load resource|favicon/i.test(l.text)));
        screenReport.diagnostics.failedRequests.push(...diag.failedRequests.filter((r) => !/ERR_ABORTED/.test(r)));
        await page.close();
        if (!screen.context) await context.close();
      }
      report.screens.push(redact(screenReport));
    }
  } finally {
    await browser.close();
    for (const context of [gcContext, subContext, ownerContext]) {
      if (context) await context.close().catch(() => {});
    }
  }

  const states = report.screens.flatMap((s) => s.states.flatMap((st) => [{ screen: s.name, ...st.closed }, { screen: s.name, ...st.open }]));
  const seriousCritical = states.reduce((n, s) => n + s.axe.seriousCritical.length, 0);
  const appHits = states.reduce((n, s) => n + s.appHits.length, 0);
  const primaries = states.filter((s) => s.measured.primaries.length === 1).length;
  report.summary = {
    screens: report.screens.length,
    viewportStates: states.length,
    checks: report.checks.length,
    failedChecks: report.failures.length,
    seriousCriticalAxeViolations: seriousCritical,
    appCopyHits: appHits,
    statesWithOnePrimary: primaries,
    screenshots: fs.readdirSync(OUT_DIR).filter((file) => file.endsWith(".png")).length,
  };

  // Both artifacts are generated from redacted data and written through the fail-closed writers.
  writeEvidenceJson(path.join(OUT_DIR, "report.json"), report);
  const lines = [
    "# Accessibility and cross-screen design gate",
    "",
    `- Target: ${BASE_URL}`,
    `- Generated: ${report.generatedAt}`,
    `- axe-core: ${AXE_VERSION}`,
    `- Screens: ${report.summary.screens} visits (demo + six judge screens; screen 3 in both of its routes), at 1440x900 and 390x844`,
    `- Checks: ${report.summary.checks} run, ${report.summary.failedChecks} failed`,
    `- Serious/critical axe violations: ${report.summary.seriousCriticalAxeViolations}`,
    `- App-copy leak hits: ${report.summary.appCopyHits}`,
    "",
    "| Screen | Width | State | axe serious/critical | primaries | min target | <24px | leak hits | overflow |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const screen of report.screens) {
    for (const state of screen.states) {
      for (const [label, audit] of [["closed", state.closed], ["open", state.open]]) {
        lines.push(
          `| ${screen.name} | ${state.viewport} | ${label} | ${audit.axe.seriousCritical.length} | ${audit.measured.primaries.length} | ${audit.measured.minTargetHeight ?? "—"} | ${audit.measured.under24.length} | ${audit.appHits.length} | ${audit.measured.scrollWidth > audit.measured.innerWidth + 1 ? "YES" : "no"} |`,
        );
      }
      if (state.manualOpen) {
        lines.push(
          `| ${screen.name} | ${state.viewport} | manual-open | ${state.manualOpen.axe.seriousCritical.length} | ${state.manualOpen.measured.primaries.length} | ${state.manualOpen.measured.minTargetHeight ?? "—"} | ${state.manualOpen.measured.under24.length} | — | ${state.manualOpen.measured.scrollWidth > state.manualOpen.measured.innerWidth + 1 ? "YES" : "no"} |`,
        );
      }
    }
  }
  lines.push("", "## Evidence artifacts", "");
  lines.push("- `report.json` — every check, the full measured target population per screen/width/state (tag, test id, text, height), the named primary with its classes, axe violations and leak hits.");
  lines.push("- `<screen>-<width>-closed.png` and `<screen>-<width>-open.png` — full-page screenshots with disclosures closed and open.");
  lines.push("- `<screen>-<width>-manual-open.png` — the demo manual block opened (leak-exempt, still axe-checked).");
  lines.push("- `lopez-project|sub-pay-app|owner-home|owner-draw-<width>-money-trail.png` — the shared money trail on its surface.");
  lines.push("- `gc-home-<width>-empty.png` — the reachable inbox empty state.");
  lines.push("", "## Named primary actions", "");
  for (const screen of report.screens) {
    const state = screen.states[0]?.closed;
    const primary = state?.measured.primaries[0];
    lines.push(`- **${screen.name}** (${screen.route}): ${primary ? `\`${primary.testId ?? "(no test id)"}\` ${JSON.stringify(primary.text)} ${primary.height}px` : "none"}`);
  }
  lines.push("", "## Failures", "");
  if (report.failures.length === 0) lines.push("None.");
  else for (const failure of report.failures) lines.push(`- ${failure.name}${failure.detail ? `: ${failure.detail}` : ""}`);
  lines.push("", "## Quoted recorded history (reported, never rewritten)", "");
  const quoted = report.screens.flatMap((s) => s.states.flatMap((st) => [...st.closed.quotedRecordedHits, ...st.open.quotedRecordedHits].map((h) => ({ screen: s.name, width: st.viewport, ...h }))));
  if (quoted.length === 0) lines.push("None.");
  else for (const hit of quoted.slice(0, 30)) lines.push(`- ${hit.screen} @${hit.width}: ${hit.rule}: \`${hit.match}\` — ${hit.context}`);
  writeEvidenceText(path.join(OUT_DIR, "report.md"), lines.join("\n") + "\n");

  console.log(safeEvidenceLine(`a11y-six-screens ${BASE_URL}`));
  console.log(safeEvidenceLine(`axe-core ${AXE_VERSION}; ${report.summary.screens} screens x ${VIEWPORTS.length} viewports x 2 disclosure states`));
  console.log(safeEvidenceLine(`checks: ${report.summary.checks} run, ${report.checks.filter((c) => c.ok).length} passed, ${report.failures.length} failed`));
  console.log(safeEvidenceLine(`serious/critical axe: ${seriousCritical}; app-copy leak hits: ${appHits}; states with exactly one primary: ${primaries}/${states.length}`));
  for (const failure of report.failures) console.error(safeEvidenceLine(`  FAIL ${failure.name}${failure.detail ? `: ${failure.detail}` : ""}`));
  for (const screen of report.screens) {
    const state = screen.states[0]?.closed;
    const primary = state?.measured.primaries[0];
    console.log(safeEvidenceLine(`  ${screen.name} (${screen.route}) primary=${primary ? `${primary.testId ?? primary.tag} "${primary.text}" ${primary.height}px` : "none"}`));
  }
  console.log(safeEvidenceLine(`evidence: ${OUT_DIR}`));
  if (report.failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(safeEvidenceLine(`a11y-six-screens could not run: ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exitCode = 2;
});
