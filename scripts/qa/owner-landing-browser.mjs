import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

/**
 * Read-only acceptance for the signed-out landing hero and the Owner home's text contrast.
 * Signs in with the shared demo Owner (no guided run, no approvals, no payments, no settings writes)
 * and prints every text/background pair below WCAG AA. Exit code 1 if any check fails.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "https://tradepulse-pay.asynchronope.tech";
if (!/^(https:\/\/[a-z0-9.-]+(?::\d+)?|http:\/\/localhost(?::\d+)?)$/i.test(site)) throw new Error("--url must be an https origin or http://localhost:<port>.");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.join(root, "evidence", `owner-landing-browser-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
const report = { target: site, checks: [], contrast: [], pageErrors: [], consoleErrors: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  defaultViewport: { width: 1450, height: 1200 },
});
let phase = "signed-out-landing";
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
  const landing = await page.evaluate(() => ({
    text: document.body.innerText,
    demoHref: document.querySelector('[data-testid="landing-open-demo"]')?.getAttribute("href") ?? null,
    h1s: [...document.querySelectorAll("h1")].map((h) => h.innerText),
  }));
  check("signed-out root shows the residential hero", landing.text.includes("Pay the right amount.") && landing.text.includes("Catch overbilling early"), landing.text.slice(0, 800));
  check("signed-out root still shows the ordinary sign-in form", landing.text.includes("Sign in"));
  check("hero links to the guided demo", landing.demoHref === "#/demo", String(landing.demoHref));
  check("the page keeps a single h1", landing.h1s.length === 1, JSON.stringify(landing.h1s));

  await page.click('[data-testid="landing-open-demo"]');
  await page.waitForSelector('[data-testid="demo-access-page"]');
  check("demo link lands on the seat picker", page.url().includes("#/demo"), page.url());

  phase = "owner-home";
  await page.click('[data-testid="demo-enter-owner"]');
  await page.waitForSelector('[data-testid="owner-job-so-far"]', { timeout: 60_000 });
  check("owner home renders the job-so-far card", true);

  const contrast = await page.evaluate(() => {
    const parse = (value) => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (!m) return null;
      const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const channel = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const blend = (fg, bg) => ({
      r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
      g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
      b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
      a: 1,
    });
    const opaqueBackground = (el) => {
      let node = el;
      const stack = [];
      while (node && node.nodeType === 1) {
        const cs = getComputedStyle(node);
        const bg = parse(cs.backgroundColor);
        if (bg && bg.a > 0) {
          stack.push(bg);
          if (bg.a >= 1) break;
        }
        node = node.parentElement;
      }
      let base = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
      if (base.a < 1) base = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = stack.length - 1; i >= 0; i -= 1) base = blend(stack[i], base);
      return base;
    };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const s = getComputedStyle(node);
        if (s.opacity !== "" && Number(s.opacity) === 0) return false;
        if (node.getAttribute("aria-hidden") === "true") return false;
        if (node.tagName === "DETAILS" && !node.open && node !== el) return false;
      }
      return true;
    };
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
      if (!own) continue;
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg) continue;
      const bg = opaqueBackground(el);
      const composed = fg.a < 1 ? blend(fg, bg) : fg;
      const l1 = luminance(composed);
      const l2 = luminance(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const px = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const large = px >= 24 || (px >= 18.66 && bold);
      const required = large ? 3 : 4.5;
      if (ratio + 0.01 < required) {
        out.push({
          text: own.slice(0, 80),
          color: cs.color,
          background: `rgb(${bg.r}, ${bg.g}, ${bg.b})`,
          ratio: Math.round(ratio * 100) / 100,
          required,
          fontSize: cs.fontSize,
          testId: el.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
        });
      }
    }
    return out;
  });
  report.contrast = contrast;
  fs.writeFileSync(path.join(evidenceDir, "contrast.json"), JSON.stringify(contrast, null, 2));
  check("owner home has no WCAG AA text-contrast violations", contrast.length === 0, JSON.stringify(contrast.slice(0, 6)));
  check("no unexpected page errors", report.pageErrors.length === 0, JSON.stringify(report.pageErrors));
  check("no unexpected console errors", report.consoleErrors.length === 0, JSON.stringify(report.consoleErrors));
} catch (error) {
  report.error = String(error);
} finally {
  report.ok = report.checks.every((c) => c.ok) && !report.error;
  fs.writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify({ ok: report.ok, error: report.error ?? null, checks: report.checks.length, contrast: report.contrast.length, evidence: evidenceDir }, null, 2));
  process.exit(report.ok ? 0 : 1);
}
