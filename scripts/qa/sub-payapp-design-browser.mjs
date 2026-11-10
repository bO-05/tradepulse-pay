import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT as root, launchBrowser, attachDiagnostics, delay } from "./lib.mjs";

/**
 * Design acceptance for the sub pay app (VAL-JUDGE-011).
 *
 * Signs in through `#/demo` as the Ortiz subcontractor, lands on the settled Lopez pay app, and
 * proves at 1440x900 and 390x844 that:
 *  - the net payment is the largest money figure on the page and its computed size is >= 24px;
 *  - exactly one visible control carries the primary button variant;
 *  - the money trail sits above the secondary detail, and the breakdown, summary and approval
 *    history are collapsed;
 *  - the payment and lien-waiver panels stay visible;
 *  - the page has no horizontal overflow and the net figure is inside the first viewport.
 *
 * Read-only: it never approves, pays, signs or opens a guided run.
 */
const site = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://localhost:3150";
const outDir = process.argv.includes("--out")
  ? path.resolve(process.argv[process.argv.indexOf("--out") + 1])
  : path.join(root, "docs", "evidence", `sub-payapp-design-${new Date().toISOString().slice(0, 10)}`);
fs.mkdirSync(outDir, { recursive: true });

const seatsSource = fs.readFileSync(path.join(root, "src", "auth", "demoSeats.ts"), "utf8");
const settledPayAppId = /SETTLED_LOPEZ_PAY_APP_ID = "([^"]+)"/.exec(seatsSource)?.[1];
if (!settledPayAppId) throw new Error("SETTLED_LOPEZ_PAY_APP_ID not found in src/auth/demoSeats.ts");
const SETTLED_HASH = `#/pay-apps/${settledPayAppId}`;

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

const report = { target: site, settledPayAppId, checks: [], measurements: [], diagnostics: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  if (!ok) console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
};

/** The tracked report never carries a sandbox payee address; screenshots are masked separately. */
function maskEmails(value) {
  return String(value ?? "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[sandbox email]");
}

async function measure(page) {
  return page.evaluate(() => {
    const money = /^\$[\d,]+\.\d{2}$/;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const figures = [...document.querySelectorAll("dd, p, span, td")]
      .map((el) => {
        const own = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
        const text = (own?.textContent ?? "").trim();
        if (!money.test(text) || !visible(el)) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          text,
          fontSize: parseFloat(cs.fontSize),
          testid: el.getAttribute("data-testid"),
          label: el.parentElement?.querySelector("dt")?.textContent?.trim() ?? null,
          top: Math.round(r.top + window.scrollY),
          right: Math.round(r.right + window.scrollX),
          inClosedDetails: el.closest("details:not([open])") !== null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.fontSize - a.fontSize || a.top - b.top);
    const domOrder = [...document.querySelectorAll("dd, p, span, td")]
      .map((el, index) => {
        const own = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
        const text = (own?.textContent ?? "").trim();
        return money.test(text) ? { text, index, testid: el.getAttribute("data-testid") } : null;
      })
      .filter(Boolean);
    const primary = [...document.querySelectorAll("button, a")]
      .filter((el) => typeof el.className === "string" && el.className.includes("bg-accent") && visible(el))
      .map((el) => ({
        tag: el.tagName,
        text: (el.textContent ?? "").trim(),
        testid: el.getAttribute("data-testid"),
        height: Math.round(el.getBoundingClientRect().height),
      }));
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top + window.scrollY),
        right: Math.round(r.right + window.scrollX),
        width: Math.round(r.width),
        height: Math.round(r.height),
        inClosedDetails: el.closest("details:not([open])") !== null,
      };
    };
    const detail = (testid) => {
      const el = document.querySelector(`[data-testid="${testid}"]`);
      if (!el) return null;
      const content = el.querySelector("summary")?.nextElementSibling ?? null;
      return {
        open: el.open === true,
        visible: visible(el),
        summary: el.querySelector("summary")?.textContent?.trim() ?? "",
        // Closed `<details>` renders its summary only: innerText excludes the hidden body.
        bodyText: (el.innerText ?? "").length,
        contentRendered: content ? content.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : false,
      };
    };
    const trail = box('[data-testid="payapp-money-trail"]');
    const net = figures.find((f) => f.label?.toLowerCase() === "net this draw") ?? figures[0];
    const netIndex = domOrder.findIndex((f) => f.text === net?.text);
    const claimedIndex = domOrder.findIndex((f) => f.text === "$5,400.00");
    const controls = [...document.querySelectorAll("a, button, input, select, textarea, [role=button]")]
      .filter(visible)
      .map((el) => ({
        tag: el.tagName,
        text: (el.textContent ?? "").trim().slice(0, 40),
        testid: el.getAttribute("data-testid"),
        height: Math.round(el.getBoundingClientRect().height),
      }));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      trailText: document.querySelector('[data-testid="payapp-money-trail"]')?.innerText ?? "",
      decisionText: document.querySelector('[data-testid="payapp-decision"]')?.innerText ?? "",
      figures,
      domOrder,
      primary,
      trail,
      net,
      netIndex,
      claimedIndex,
      details: {
        breakdown: detail("payapp-breakdown"),
        summary: detail("payapp-summary"),
        history: detail("payapp-approval-history"),
      },
      payment: box('[data-testid="payment-panel"]'),
      waiver: box('[data-testid="lien-waiver-panel"]'),
      meta: box('[data-testid="payapp-number"]'),
      moreActionsOpen: document.querySelector('[data-testid="payapp-more-actions"]')?.open ?? null,
      paymentText: document.querySelector('[data-testid="payment-panel"]')?.innerText ?? "",
      controls,
      under24: controls.filter((c) => c.height < 24),
    };
  });
}

for (const [width, height] of [[1440, 900], [390, 844]]) {
  const { browser } = await launchBrowser(width, height);
  const page = await browser.newPage();
  const diagnostics = attachDiagnostics(page);
  await page.goto(`${site}/#/demo`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('[data-testid="demo-enter-sub"]');
  await page.click('[data-testid="demo-enter-sub"]');
  await page.waitForFunction(() => location.hash.startsWith("#/pay-apps/"), { timeout: 60000 });
  await page.waitForSelector('[data-testid="payapp-money-trail"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="payment-panel"]', { timeout: 60000 });
  await delay(600);

  const m = await measure(page);
  report.measurements.push({
    width,
    ...m,
    trailText: maskEmails(m.trailText),
    decisionText: maskEmails(m.decisionText),
    paymentText: maskEmails(m.paymentText),
    controls: m.controls.length,
    under24: m.under24,
  });
  const tag = `[${width}]`;

  check(`${tag} Subcontractor lands on the settled Lopez pay app`, await page.evaluate(() => location.hash) === SETTLED_HASH);
  check(`${tag} money trail is visible`, (m.trail?.height ?? 0) > 0);
  check(`${tag} trail shows claimed $5,400.00 and net $3,800.00`, m.trailText.includes("$5,400.00") && m.trailText.includes("$3,800.00"));
  check(
    `${tag} trail explains the conservative review and recorded GC decision`,
    /funded or in-progress milestones are credited at 50% of their share/i.test(m.trailText)
      && /Work in place is reported by the subcontractor, not independently inspected/i.test(m.trailText)
      && /recorded per-line reason/i.test(m.trailText),
    m.trailText,
  );
  check(`${tag} trail states the kept Fixtures set cut plainly`, m.trailText.includes("Fixtures set was cut by $1,400.00 to $0.00, and the GC kept that cut"), m.trailText);
  check(`${tag} trail drops the unexplained above-review sentence`, !m.trailText.includes("above the review suggestion"));
  check(
    `${tag} new trail copy excludes internal money and funding jargon`,
    !/(140,000 cents)|tranche ceiling|funding progress/i.test(m.trailText),
    m.trailText,
  );
  check(
    `${tag} both flagged lines and their recorded reasons stay visible`,
    /Line 1\. Rough-in/i.test(m.decisionText) && /Line 2\. Fixtures set/i.test(m.decisionText) && /Reason:/i.test(m.decisionText),
    m.decisionText,
  );
  check(`${tag} trail names the PayPal settlement`, /paid by paypal/i.test(m.trailText), m.trailText.slice(0, 200));
  check(`${tag} net figure is the largest money figure`, m.net?.fontSize === Math.max(...m.figures.map((f) => f.fontSize)), JSON.stringify(m.figures.slice(0, 3)));
  check(`${tag} net figure is at least text-2xl (24px)`, (m.net?.fontSize ?? 0) >= 24, String(m.net?.fontSize));
  check(`${tag} net figure is labeled "Net this draw"`, /net this draw/i.test(m.net?.label ?? ""), m.net?.label ?? "");
  check(`${tag} net figure renders above the stages`, m.netIndex >= 0 && m.claimedIndex >= 0 && m.netIndex < m.claimedIndex, `${m.netIndex} vs ${m.claimedIndex}`);
  check(`${tag} exactly one primary action`, m.primary.length === 1, JSON.stringify(m.primary));
  check(`${tag} the primary is a named action`, /view payments|submit pay app|revise|withdraw/i.test(m.primary[0]?.text ?? ""), m.primary[0]?.text ?? "");
  check(`${tag} primary action meets the 44px floor`, (m.primary[0]?.height ?? 0) >= 44, String(m.primary[0]?.height));
  check(`${tag} money trail sits above the application detail`, (m.trail?.top ?? 0) < (m.meta?.top ?? 0), `${m.trail?.top} vs ${m.meta?.top}`);
  check(`${tag} breakdown is a collapsed disclosure`, m.details.breakdown?.open === false && m.details.breakdown.contentRendered === false, JSON.stringify(m.details.breakdown));
  check(`${tag} summary is a collapsed disclosure`, m.details.summary?.open === false && m.details.summary.contentRendered === false, JSON.stringify(m.details.summary));
  check(`${tag} approval history is a collapsed disclosure`, m.details.history?.open === false && m.details.history.contentRendered === false, JSON.stringify(m.details.history));
  check(`${tag} collapsed rows name their sections`, /pay app breakdown/i.test(m.details.breakdown?.summary ?? "") && /pay app summary/i.test(m.details.summary?.summary ?? "") && /approval history/i.test(m.details.history?.summary ?? ""));
  check(`${tag} payment panel stays visible`, (m.payment?.height ?? 0) > 0 && m.payment?.inClosedDetails === false);
  check(`${tag} payout receipt is on the page`, m.paymentText.includes("PayPal payout batch") && m.paymentText.includes("D5V7XEN5YZH4C"));
  check(`${tag} lien-waiver panel stays visible`, (m.waiver?.height ?? 0) > 0 && m.waiver?.inClosedDetails === false);
  check(`${tag} no horizontal page overflow`, m.scrollWidth <= m.clientWidth, `${m.scrollWidth} vs ${m.clientWidth}`);
  check(`${tag} net figure fits the viewport width`, (m.net?.right ?? 0) <= m.viewport.width, `${m.net?.right} vs ${m.viewport.width}`);
  check(`${tag} net figure is inside the first viewport`, (m.net?.top ?? 0) < m.viewport.height, `${m.net?.top} vs ${m.viewport.height}`);
  check(`${tag} no visible control under 24px`, m.under24.length === 0, JSON.stringify(m.under24));
  check(`${tag} secondary downloads are collapsed by default`, m.moreActionsOpen === false, String(m.moreActionsOpen));

  // Open the secondary actions: the downloads stay secondary, never primary.
  const more = await page.evaluate(() => {
    const details = document.querySelector('[data-testid="payapp-more-actions"]');
    if (details) details.open = true;
    const primary = [...document.querySelectorAll("button, a")]
      .filter((el) => typeof el.className === "string" && el.className.includes("bg-accent"))
      .map((el) => (el.textContent ?? "").trim());
    return {
      download: document.querySelector('[data-testid="payapp-download-pdf"]') !== null,
      exportCsv: document.querySelector('[data-testid="payapp-export-csv"]') !== null,
      primary,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  check(`${tag} More actions reveals Download PDF`, more.download);
  check(`${tag} More actions reveals Export lines CSV`, more.exportCsv);
  check(`${tag} downloads stay secondary`, more.primary.length === 1, JSON.stringify(more.primary));
  check(`${tag} open More actions does not overflow`, more.scrollWidth <= width, `${more.scrollWidth} vs ${width}`);
  await page.evaluate(() => {
    const details = document.querySelector('[data-testid="payapp-more-actions"]');
    if (details) details.open = false;
  });

  // The vocabulary and accessibility passes force every disclosure open; the wide sheet must stay
  // inside its own horizontal scroller and never widen the page.
  const opened = await page.evaluate(() => {
    for (const id of ["payapp-breakdown", "payapp-summary", "payapp-approval-history"]) {
      const details = document.querySelector(`[data-testid="${id}"]`);
      if (details) details.open = true;
    }
    const sheet = document.querySelector('[data-testid="g703-sheet"]');
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      sheetVisible: sheet !== null && sheet.getBoundingClientRect().height > 0,
      pageText: document.querySelector('[data-testid="payapp-summary"]')?.innerText ?? "",
      historyText: document.querySelector('[data-testid="payapp-approval-history"]')?.innerText ?? "",
    };
  });
  check(`${tag} open disclosures show the breakdown sheet`, opened.sheetVisible);
  check(`${tag} open disclosures show the summary lines`, /This draw/.test(opened.pageText), opened.pageText.slice(0, 120));
  check(
    `${tag} approval history explains the conservative suggestion and recorded reasons`,
    opened.historyText.includes("Conservative review suggested gross $2,000.00")
      && opened.historyText.includes("GC approved $4,000.00 with recorded per-line reasons")
      && !opened.historyText.includes("above the recommendation"),
    opened.historyText,
  );
  check(`${tag} open disclosures do not overflow the page`, opened.scrollWidth <= opened.clientWidth, `${opened.scrollWidth} vs ${opened.clientWidth}`);

  // Evidence screenshots show the page as a judge receives it: secondary detail collapsed.
  await page.evaluate(() => {
    for (const id of ["payapp-breakdown", "payapp-summary", "payapp-approval-history"]) {
      const details = document.querySelector(`[data-testid="${id}"]`);
      if (details) details.open = false;
    }
  });

  await maskSandboxEmails(page);
  await page.screenshot({ path: path.join(outDir, `sub-payapp-${width}.png`), fullPage: true });
  await page.evaluate(() => scrollTo(0, 0));
  await delay(150);
  await page.screenshot({ path: path.join(outDir, `sub-payapp-first-viewport-${width}.png`) });

  // `AgentIdButton` cancels its sign-in-options probe on unmount after sign-in; that is an abort.
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
  check(`${tag} zero page errors`, diagnostics.pageErrors.length === 0, JSON.stringify(diagnostics.pageErrors));
  check(`${tag} zero failed requests`, failedRequests.length === 0, JSON.stringify(failedRequests));
  check(`${tag} zero console errors`, diagnostics.consoleLogs.filter((l) => l.type === "error").length === 0, JSON.stringify(diagnostics.consoleLogs.filter((l) => l.type === "error").slice(0, 3)));

  await browser.close();
}

fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
const failures = report.checks.filter((c) => !c.ok);
console.log(JSON.stringify({ outDir, checksRun: report.checks.length, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
