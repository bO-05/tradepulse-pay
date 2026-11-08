import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

/**
 * Read-only acceptance for the residential landing copy, the split GC navigation and the
 * approval-inbox buckets. It signs into the shared demo GC, reads screens, and never approves,
 * rejects, pays or starts a guided run.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const site = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : "https://tradepulse-pay.asynchronope.tech";
if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(site)) throw new Error("--url must be an https origin.");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.join(root, "evidence", `landing-nav-inbox-browser-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
const report = { target: site, checks: [], pageErrors: [], consoleErrors: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  defaultViewport: { width: 1450, height: 1200 },
});
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
let phase = "landing";
try {
  await page.goto(`${site}/#/demo`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-access-page"]');
  const landing = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="demo-access-page"]');
    const card = document.querySelector('[data-testid="demo-enter-gc"]');
    return {
      text: main?.innerText ?? "",
      html: main?.innerHTML ?? "",
      roleCards: document.querySelectorAll('[data-testid^="demo-enter-"]').length,
      cardPresent: !!card,
    };
  });
  const landingText = landing.text.toLowerCase();
  check("landing leads with the residential GC job story", landingText.includes("residential remodel gcs") && landingText.includes("pay the right amount."));
  for (const text of ["Catch overbilling early", "Decide with the evidence", "Keep a clean owner trail", "owner or lender", "PayPal sandbox money only"]) {
    check(`landing explains ${text}`, landing.text.includes(text), landing.text.slice(0, 1600));
  }
  check("landing offers all three demo seats", landing.roleCards === 3, String(landing.roleCards));
  check("landing keeps the credential-free GC entry", landing.cardPresent);
  check("judge checklist is available but collapsed", landing.text.includes("Judge walkthrough") && landing.html.includes("<details"));
  check("test-card number is not in the first reading surface", !landing.text.includes("4032031427005060"));
  await page.evaluate(() => {
    const summaries = [...document.querySelectorAll("summary")];
    summaries.find((el) => el.textContent.includes("Manual sign-in and sandbox details"))?.click();
  });
  await page.waitForFunction(() => document.body.innerText.includes("4032031427005060"));
  check("manual sandbox details open on demand", (await page.evaluate(() => document.body.innerText)).includes("4032031427005060"));
  await page.screenshot({ path: path.join(evidenceDir, "landing-residential.png"), fullPage: true });

  phase = "GC login";
  await page.click('[data-testid="demo-enter-gc"]');
  await page.waitForFunction(() => location.hash === "#/inbox", { timeout: 45_000 });
  await page.waitForSelector('[data-testid="inbox-counts"]');

  phase = "GC navigation";
  const nav = await page.evaluate(() => {
    const list = document.querySelector("#workspace-navigation > ul");
    const primary = [...(list?.children ?? [])]
      .map((li) => li.querySelector(":scope > a"))
      .filter(Boolean)
      .map((a) => a.textContent.trim());
    const details = list?.querySelector("details");
    return {
      primary,
      more: details
        ? {
            label: details.querySelector("summary")?.textContent.trim() ?? "",
            open: details.open,
            links: [...details.querySelectorAll("a")].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute("href") })),
          }
        : null,
    };
  });
  check("GC primary bar is capped at the daily payment path", nav.primary.length === 6, JSON.stringify(nav.primary));
  for (const label of ["Approvals", "Billing", "Projects", "Change orders", "Payments"]) {
    check(`primary nav keeps ${label}`, nav.primary.some((text) => text.startsWith(label)), JSON.stringify(nav.primary));
  }
  check("primary nav keeps the guided demo for judges", nav.primary.some((text) => text.startsWith("Guided demo")), JSON.stringify(nav.primary));
  check("back-office registers are not in the primary bar", !nav.primary.some((text) => /Procurement|People|Vendors|Payment reports/.test(text)), JSON.stringify(nav.primary));
  check("More menu is present and collapsed", nav.more?.open === false && nav.more?.label.startsWith("More"), JSON.stringify(nav.more));
  for (const label of ["Procurement", "Compliance & waivers", "Project summaries", "People", "Vendors", "Billing agents", "Payment reports"]) {
    check(`More menu keeps ${label}`, nav.more?.links.some((link) => link.text.startsWith(label)), JSON.stringify(nav.more?.links));
  }
  await page.evaluate(() => document.querySelector("#workspace-navigation details > summary")?.click());
  await page.waitForFunction(() => document.querySelector("#workspace-navigation details")?.open === true);
  const moreHrefs = await page.evaluate(() => [...document.querySelectorAll("#workspace-navigation details a")].map((a) => a.getAttribute("href")));
  check("More links point at the existing routes", moreHrefs.includes("#/procurement") && moreHrefs.includes("#/dashboard") && moreHrefs.includes("#/billing-agents"), JSON.stringify(moreHrefs));
  await page.screenshot({ path: path.join(evidenceDir, "gc-nav-more.png"), fullPage: false });

  phase = "approval inbox";
  const inbox = await page.evaluate(() => {
    const entries = [...document.querySelectorAll('[data-testid="inbox-entry"]')];
    const history = document.querySelector("main details");
    return {
      counts: document.querySelector('[data-testid="inbox-counts"]')?.textContent.trim() ?? "",
      entries: entries.length,
      visible: entries.filter((el) => el.getClientRects().length > 0).length,
      labels: entries.map((el) => el.querySelector('[data-testid="inbox-payapp-status"]')?.textContent.trim() ?? ""),
      groups: [...document.querySelectorAll("main section[aria-label] > div > h2")].map((el) => el.textContent.trim()),
      history: history ? { open: history.open, label: history.querySelector("summary")?.textContent.trim() ?? "" } : null,
      chips: [...document.querySelectorAll("main h1, main h2")].map((el) => el.textContent.trim()),
    };
  });
  const match = inbox.counts.match(/^(\d+) open · (\d+) awaiting payment · (\d+) in history$/);
  check("inbox reports its three buckets", match !== null, inbox.counts);
  const [, activeCount, waitingCount, historyCount] = match?.map(Number) ?? [];
  check("inbox bucket counts add up to the loaded entries", activeCount + waitingCount + historyCount === inbox.entries, JSON.stringify(inbox));
  check("open work is rendered before settled history", inbox.chips.some((text) => text.startsWith("Needs your attention")) || activeCount === 0, JSON.stringify(inbox.chips));
  check("settled applications are grouped, not repeated at full height", historyCount === 0 || inbox.history !== null, JSON.stringify(inbox.history));
  if (historyCount > 0 && activeCount + waitingCount > 0) {
    check("history is collapsed while open work exists", inbox.history?.open === false, JSON.stringify(inbox.history));
  } else if (historyCount > 0) {
    check("history opens when it is the only work left", inbox.history?.open === true, JSON.stringify(inbox.history));
  }
  check("status codes are shown as readable labels", !inbox.labels.some((label) => /_/.test(label)), JSON.stringify(inbox.labels));
  await page.screenshot({ path: path.join(evidenceDir, "inbox-buckets.png"), fullPage: true });

  phase = "inbox filter";
  await page.type('input[placeholder^="Agreement, project"]', "A401-DEMO-PAY-20261105-07");
  await delay(500);
  await page.waitForFunction(() => {
    const visible = [...document.querySelectorAll('[data-testid="inbox-entry"]')].filter((el) => el.getClientRects().length > 0);
    return visible.length === 2;
  });
  const filtered = await page.evaluate(() => ({
    visible: [...document.querySelectorAll('[data-testid="inbox-entry"]')].filter((el) => el.getClientRects().length > 0).length,
    text: document.querySelector("main")?.innerText ?? "",
  }));
  check("search returns the two R6-A pay apps", filtered.visible === 2, String(filtered.visible));
  check("filtered history becomes visible without clearing the search", filtered.text.includes("A401-DEMO-PAY-20261105-07"));
  await page.screenshot({ path: path.join(evidenceDir, "inbox-filtered.png"), fullPage: true });

  phase = "phone navigation";
  await page.setViewport({ width: 390, height: 900 });
  await delay(300);
  const phone = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    menuVisible: [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Menu" && b.getClientRects().length > 0),
  }));
  check("phone layout does not overflow horizontally", phone.overflow <= 1, String(phone.overflow));
  check("phone menu control is visible", phone.menuVisible);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Menu")?.click());
  await page.waitForFunction(() => document.querySelector("#workspace-navigation")?.getClientRects().length > 0);
  const phoneNav = await page.evaluate(() => [...document.querySelectorAll("#workspace-navigation > ul > li > a")].filter((a) => a.getClientRects().length > 0).map((a) => a.textContent.trim()));
  check("phone menu exposes the same capped primary bar", phoneNav.length === 6 && phoneNav.some((text) => text.startsWith("Approvals")), JSON.stringify(phoneNav));
  await page.screenshot({ path: path.join(evidenceDir, "phone-nav.png"), fullPage: false });

  report.ok = true;
} catch (error) {
  report.errors = [{ phase, message: error instanceof Error ? error.message : String(error) }];
  report.ok = false;
  report.snapshot = await page.evaluate(() => document.body.innerText.slice(0, 12000)).catch(() => "");
  await page.screenshot({ path: path.join(evidenceDir, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  report.checks.push({ name: "no unexpected page errors", ok: report.pageErrors.length === 0, detail: JSON.stringify(report.pageErrors) });
  report.checks.push({ name: "no unexpected console errors", ok: report.consoleErrors.length === 0, detail: JSON.stringify(report.consoleErrors) });
  if (!report.ok || report.pageErrors.length > 0 || report.consoleErrors.length > 0) report.ok = false;
  fs.writeFileSync(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ evidenceDir, ...report }, null, 2));
  await browser.close();
}
