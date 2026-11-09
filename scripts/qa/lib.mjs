import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export { delay };

/**
 * Portable harness (root fix: this file used to hardcode the author's absolute
 * repo path, so a fresh clone could not run it). REPO_ROOT is derived from this
 * file's location; override with QA_REPO_ROOT / REM_EVIDENCE_DIR / REM_BASE_URL.
 */
export const REPO_ROOT = process.env.QA_REPO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EVIDENCE_DIR = process.env.REM_EVIDENCE_DIR || path.join(REPO_ROOT, "evidence");
export const BASE_URL = process.env.REM_BASE_URL || "https://brainy-skunk-440.convex.site";
export const BACKEND_URL = process.env.QA_BACKEND_URL || "https://brainy-skunk-440.convex.cloud";

const BROWSER_CANDIDATES = [
  process.env.QA_CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

export async function launchBrowser(width = 1440, height = 900) {
  const executablePath = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) {
    throw new Error(
      "No Chrome/Edge executable found. Set QA_CHROME_PATH to a Chrome/Edge binary to run the browser harness."
    );
  }
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    protocolTimeout: 300000,
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--window-size=${width},${height}`],
    defaultViewport: { width, height },
  });
  return { browser, executablePath };
}

export function attachDiagnostics(page) {
  const consoleLogs = [];
  const pageErrors = [];
  const failedRequests = [];
  const requests = [];
  page.on("console", (m) => consoleLogs.push({ type: m.type(), text: m.text() }));
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on("request", (r) => requests.push({ method: r.method(), url: r.url() }));
  page.on("requestfailed", (r) =>
    failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure() ? r.failure().errorText : "unknown"}`)
  );
  return { consoleLogs, pageErrors, failedRequests, requests };
}

export function writeJson(name, obj) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const p = path.join(EVIDENCE_DIR, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

export function writeLog(name, lines) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const p = path.join(EVIDENCE_DIR, name);
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

export async function shot(page, name, opts = {}) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const p = path.join(EVIDENCE_DIR, name);
  await page.screenshot({ path: p, fullPage: !!opts.full });
  return p;
}

/**
 * The project switcher's accessible name is "Select project" after the copy sweep; older builds
 * and audit scripts used "Select Commercial Construction Project". Accept both.
 */
export const PROJECT_SELECTOR = 'select[aria-label="Select project"], select[aria-label="Select Commercial Construction Project"]';

export async function waitForAppReady(page, timeout = 45000) {
  await page.waitForSelector(PROJECT_SELECTOR, { timeout });
  await page.waitForFunction(() => !document.body.innerText.includes("Connecting to Convex reactive backend"), { timeout });
  await delay(500);
}

export async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

export async function getSelectorState(page) {
  return page.evaluate((selector) => {
    const sel = document.querySelector(selector);
    if (!sel) return null;
    return {
      value: sel.value,
      selectedText: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent.trim() : null,
      options: [...sel.options].map((o) => ({ value: o.value, text: o.textContent.trim() })),
    };
  }, PROJECT_SELECTOR);
}

export async function selectProjectByTitle(page, titleSubstring) {
  return page.evaluate((needle, selector) => {
    const sel = document.querySelector(selector);
    if (!sel) return { ok: false, reason: "selector not found" };
    const opt = [...sel.options].find((o) => o.textContent.includes(needle));
    if (!opt) return { ok: false, reason: "option not found", options: [...sel.options].map((o) => o.textContent.trim()) };
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: opt.value, text: opt.textContent.trim() };
  }, titleSubstring, PROJECT_SELECTOR);
}

export async function realClickButtonByText(page, text, opts = {}) {
  const box = await page.evaluate(
    (needle, exact) => {
      const buttons = [...document.querySelectorAll("button")];
      const match = buttons.find((b) => {
        const t = (b.textContent || "").trim();
        return exact ? t === needle : t.includes(needle);
      });
      if (!match) return null;
      match.scrollIntoView({ block: "center" });
      const r = match.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (match.textContent || "").trim() };
    },
    text,
    !!opts.exact
  );
  if (!box) return { ok: false, reason: "button not found", text };
  await page.mouse.click(box.x, box.y);
  return { ok: true, ...box };
}

export async function setInputValue(page, selector, value) {
  return page.evaluate(
    (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("input not found: " + sel);
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value;
    },
    selector,
    value
  );
}

export async function setViewport(page, width, height) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await delay(400);
}