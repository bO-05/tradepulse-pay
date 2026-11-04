/**
 * Read-only recovery smoke (no email, payment, seed/reset, or business writes).
 * node scripts/qa/recovery-smoke.mjs [URL | --url URL] [--demo-login]
 * URL falls back to REM_BASE_URL, then http://localhost:3150.
 * --demo-login explicitly permits ordinary sign-in for the three public DEMO
 * users only. Fresh, non-persistent contexts; no cookies/tokens/auth-state export.
 * QA_CHROME_PATH and REM_EVIDENCE_DIR may override Chrome and evidence location.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
let target = process.env.REM_BASE_URL || "http://localhost:3150";
let demoLogin = false;
let healthTarget;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--demo-login") demoLogin = true;
  else if (args[i] === "--url") {
    if (!args[i + 1]) throw new Error("--url requires a URL");
    target = args[++i];
  } else if (args[i] === "--health-url") {
    if (!args[i + 1]) throw new Error("--health-url requires a URL");
    healthTarget = new URL(args[++i]);
    if (!["http:", "https:"].includes(healthTarget.protocol) || healthTarget.username || healthTarget.password || healthTarget.search) {
      throw new Error("--health-url must be an HTTP(S) URL without credentials or query parameters");
    }
  } else if (!args[i].startsWith("-")) target = args[i];
  else throw new Error(`Unknown option: ${args[i]}`);
}
const base = new URL(target);
if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search) {
  throw new Error("Use an HTTP(S) target without credentials or query parameters");
}
base.hash = "";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = path.resolve(process.env.REM_EVIDENCE_DIR || path.join(root, "evidence"),
  `recovery-${base.hostname.replace(/[^a-z0-9.-]/gi, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const chrome = [
  process.env.QA_CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean).find(p => fs.existsSync(p));
if (!chrome) throw new Error("Chrome not found; set QA_CHROME_PATH");
fs.mkdirSync(evidence, { recursive: true });

// No raw request/response bodies, user text, storage, or console arguments saved.
function sanitize(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
      try { const u = new URL(raw); return `${u.origin}${u.pathname}`; } catch { return "[url]"; }
    })
    .replace(/\b[A-Za-z0-9_+/=-]{28,}\b/g, "[identifier]")
    .replace(/TradePulseDemo!2026/g, "[demo-password]")
    .slice(0, 1200);
}
const report = {
  target: base.href, startedAt: new Date().toISOString(), demoLogin,
  safety: "Fresh contexts; only public navigation and optional public DEMO sign-in; no business action submissions.",
  public: {}, roles: [], failures: [],
};
const browser = await puppeteer.launch({
  executablePath: chrome, headless: true, protocolTimeout: 45000,
  defaultViewport: { width: 1440, height: 1000 },
  args: ["--disable-dev-shm-usage"],
});
async function fresh() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  const diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], httpErrors: [] };
  page.on("console", msg => {
    if (msg.type() === "error" && diagnostics.consoleErrors.length < 25) diagnostics.consoleErrors.push(sanitize(msg.text()));
  });
  page.on("pageerror", error => diagnostics.pageErrors.push(sanitize(error.message)));
  page.on("requestfailed", req => {
    if (diagnostics.failedRequests.length < 25) diagnostics.failedRequests.push({
      url: sanitize(req.url()), error: sanitize(req.failure()?.errorText),
    });
  });
  page.on("response", res => {
    if (res.status() >= 400 && diagnostics.httpErrors.length < 25) {
      diagnostics.httpErrors.push({ url: sanitize(res.url()), status: res.status() });
    }
  });
  return { context, page, diagnostics };
}
async function open(page, url = base.href) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("h1,h2,form,nav,pre"));
  await delay(1200);
  return response?.status();
}
async function hasTextControl(page, text) {
  return page.evaluate(text => [...document.querySelectorAll("button,a")].some(el =>
    el.textContent.trim() === text && el.getClientRects().length > 0), text);
}
async function navigateText(page, text) {
  return page.evaluate(text => {
    const el = [...document.querySelectorAll("button,a")].find(el =>
      el.textContent.trim() === text && el.getClientRects().length > 0);
    if (!el) return false;
    if (el instanceof HTMLButtonElement && el.type === "submit" && el.closest("form")) return false;
    el.click();
    return true;
  }, text);
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: false });
  return `${name}.png`;
}
async function surface(page) {
  return page.evaluate(() => {
    const text = document.body.innerText;
    const markers = [
      "Milestone funding", "Not funded", "Funded (authorized)", "Captured", "Paid",
      "PayPal", "sandbox", "Not found", "Something went wrong", "Invalid credentials",
      "No agreements", "No projects", "Connecting to Convex reactive backend",
      "No executed agreements yet.", "No pay applications submitted yet.",
      "No change-order invoices yet.",
      "Create account", "Forgot password?", "Sign in",
    ];
    return {
      markers: markers.filter(m => text.includes(m)),
      hasMain: !!document.querySelector("main"),
      hasPasswordInput: !!document.querySelector('input[type="password"]'),
    };
  });
}
try {
  const { context, page, diagnostics } = await fresh();
  try {
    report.public.httpStatus = await open(page);
    report.public.title = sanitize(await page.title());
    report.public.signIn = await hasTextControl(page, "Sign in");
    report.public.agentId = await hasTextControl(page, "Continue with AgentID");
    await delay(1_000);
    report.public.agentIdState = await page.evaluate(() => ({
      buttonVisible: [...document.querySelectorAll("button")].some(el => el.textContent.trim() === "Continue with AgentID"),
      mentionsConfiguration: document.body.innerText.includes("AgentID is not configured"),
    }));
    if (report.public.agentIdState.buttonVisible || report.public.agentIdState.mentionsConfiguration) {
      report.failures.push("Unconfigured AgentID must be hidden from the sign-in screen.");
    }
    report.public.screenshot = await screenshot(page, "public-sign-in");
    report.public.navigation = [];
    for (const label of ["Create account", "Forgot password?"]) {
      await open(page);
      const available = await hasTextControl(page, label);
      const item = { label, available, navigated: false, formOpened: false };
      if (available) {
        item.navigated = await navigateText(page, label);
        await delay(500);
        item.formOpened = await page.evaluate(label =>
          [...document.querySelectorAll("h1,h2,h3")].some(el =>
            label === "Create account" ? /create account/i.test(el.textContent) : /forgot|reset/i.test(el.textContent)), label);
        item.screenshot = await screenshot(page, label === "Create account" ? "public-create-account" : "public-reset-password");
      }
      report.public.navigation.push(item);
    }
    report.public.currentSourceAuthNavigation = report.public.navigation.every(item => item.formOpened);
    // Observe health through the same isolated browser, storing only public status fields.
    const health = await page.goto(healthTarget?.href ?? new URL("/api/health", base).href, { waitUntil: "domcontentloaded" });
    report.public.health = { httpStatus: health?.status() };
    try {
      const json = JSON.parse(await page.evaluate(() => document.body.innerText));
      for (const key of ["status", "app", "version"]) {
        if (typeof json[key] === "string") report.public.health[key] = sanitize(json[key]);
      }
    } catch { report.public.health.json = false; }
    report.public.diagnostics = diagnostics;
  } finally { await context.close(); }

  if (demoLogin && !report.public.signIn) {
    report.failures.push("Demo roles skipped: public sign-in is unavailable.");
  }
  if (demoLogin && report.public.signIn) {
    const definitions = [
      { role: "gc", account: "gc", expected: ["Procurement", "Payments", "Approvals", "Billing agents"],
        routes: ["#/procurement", "#/payments", "#/inbox", "#/billing-agents", "#/dashboard"] },
      { role: "sub", account: "sub1", expected: ["My agreements & pay applications"],
        routes: ["#/portal", "#/payments"] },
      { role: "owner", account: "owner", expected: ["Home", "Projects", "Reports"],
        routes: ["#/projects", "#/dashboard"] },
    ];
    for (const def of definitions) {
      const { context, page, diagnostics } = await fresh();
      const result = { role: def.role, loginSucceeded: false, expectedNavigation: {}, routes: [], diagnostics };
      report.roles.push(result);
      try {
        await open(page);
        // Native setters trigger React's input/change handlers without CDP keyboard input.
        await page.evaluate(({ email, password }) => {
          const set = (selector, value) => {
            const input = document.querySelector(selector);
            if (!input) throw new Error(`Missing login field: ${selector}`);
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          };
          set('input[type="email"]', email);
          set('input[type="password"]', password);
        }, { email: `${def.account}@demo.tradepulse`, password: "TradePulseDemo!2026" });
        // This is the ONLY form submitted by this script.
        await page.evaluate(() => {
          const form = document.querySelector('input[type="password"]')?.closest("form");
          if (!form) throw new Error("Missing sign-in form");
          form.requestSubmit();
        });
        try {
          await page.waitForFunction(() => !document.querySelector('input[type="password"]'), { timeout: 20000 });
          result.loginSucceeded = true;
        } catch {
          result.error = "Demo login did not leave sign-in within 20 seconds; no retry performed.";
          result.surface = await surface(page);
          continue;
        }
        await delay(1500);
        for (const label of def.expected) result.expectedNavigation[label] = await hasTextControl(page, label);
        // Record only known navigation labels, never arbitrary account/body text.
        result.observedNavigation = [];
        for (const label of [
          ...def.expected, "Projects & change orders", "Projects overview", "Dashboard",
          "Payments", "Pay apps", "Change orders", "Compliance", "Bid invitations",
        ]) {
          if (await hasTextControl(page, label) && !result.observedNavigation.includes(label)) {
            result.observedNavigation.push(label);
          }
        }
        result.screenshot = await screenshot(page, `${def.role}-landing`);
        // Hash-only, fixed read-only areas. No clicks on any business-action controls.
        for (const hash of def.routes) {
          await page.evaluate(hash => { location.hash = hash; }, hash);
          await delay(1600);
          let loadingSettled = true;
          try {
            await page.waitForFunction(() => !/Loading dashboard(?:\.{3}|…)/i.test(document.body.innerText),
              { timeout: 12000 });
          } catch { loadingSettled = false; }
          const route = { path: `${base.pathname}${hash}`, loadingSettled, surface: await surface(page) };
          route.navigationMatchesHash = await page.evaluate(hash =>
            [...document.querySelectorAll('a[href]')].some(el =>
              el.getAttribute("href") === hash && el.getClientRects().length > 0), hash);
          route.screenshot = await screenshot(page, `${def.role}-${hash.slice(2)}`);
          result.routes.push(route);
        }
      } catch (error) { result.error = sanitize(error.message); }
      finally { await context.close(); }
    }
  }
} catch (error) {
  report.failures.push(sanitize(error.message));
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  report.checks = {
    publicSignIn: report.public.httpStatus === 200 && report.public.signIn === true,
    currentSourceAuthNavigation: report.public.currentSourceAuthNavigation === true,
    health: report.public.health?.httpStatus === 200 && report.public.health?.status === "ok",
    demoRoleLogin: demoLogin ? report.roles.length === 3 && report.roles.every(r => r.loginSucceeded) : "not-requested",
    noPageErrors: [report.public.diagnostics, ...report.roles.map(r => r.diagnostics)]
      .filter(Boolean).every(d => d.pageErrors.length === 0),
    routeLoadingSettled: report.roles.every(r => r.routes.every(route => route.loadingSettled)),
  };
  const output = path.join(evidence, "report.json");
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(`Recovery smoke report: ${output}`);
  console.log(JSON.stringify({
    target: report.target, public: report.public,
    roles: report.roles.map(({ role, loginSucceeded, expectedNavigation, observedNavigation, error, routes, diagnostics }) =>
      ({ role, loginSucceeded, expectedNavigation, observedNavigation, error, routes, diagnostics })),
    checks: report.checks,
    failures: report.failures,
  }, null, 2));
}
if (report.failures.length || Object.values(report.checks).some(value => value === false)) process.exitCode = 1;
