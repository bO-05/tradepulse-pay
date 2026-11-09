#!/usr/bin/env node
/**
 * Copy-leak scan for the judge-facing screens.
 *
 *   node scripts/qa/leak-scan.mjs --url http://localhost:3150
 *
 * The scan signs in through the three demo seats, walks the six GC/sub/owner
 * screens (plus the demo landing), and extracts only text the browser actually
 * renders. Anything inside a closed <details> is skipped, including the contents
 * of "Manual sign-in and sandbox details" on #/demo. The summary line has a
 * closed <details> in its ancestor chain, so it is skipped by the same rule.
 *
 * Quoted recorded history on the frozen Lopez reference is extracted into its
 * own bucket: it may contain the original commercial vocabulary and must never
 * be edited or hidden to make this scan pass. It is reported separately and
 * does not fail the run.
 *
 * Exit codes: 0 = no app-copy hits, 1 = app-copy hits, 2 = scan could not run.
 */
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, attachDiagnostics, writeJson, REPO_ROOT, delay } from "./lib.mjs";

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE_URL = argValue("--url", process.env.REM_BASE_URL || "http://localhost:3150").replace(/\/+$/, "");

const RULES = [
  { id: "agent-id", label: "AgentID", re: /\bAgentID\b/g },
  { id: "stand-in", label: "stand-in", re: /\bstand-in\b/gi },
  { id: "guided-demo-driver", label: "Guided demo driver", re: /Guided demo driver/gi },
  { id: "fixture", label: "fixture", re: /\bfixture\b/gi },
  { id: "demo-suffix", label: "(demo)", re: /\(demo\)/gi },
  { id: "seed-suffix", label: "(seed)", re: /\(seed\)/gi },
  { id: "demo-mutual", label: "Demo Mutual Insurance Co.", re: /Demo Mutual Insurance Co\.?/gi },
  { id: "convex", label: "Convex", re: /\bConvex\b/gi },
  { id: "invalid-domain", label: "verify-required.invalid", re: /verify-required\.invalid/gi },
  { id: "rule-closeout", label: "closeoutWorkBeforeEarlierTranches", re: /closeoutWorkBeforeEarlierTranches/g },
  { id: "rule-ceiling", label: "trancheCeilingPctToDate", re: /trancheCeilingPctToDate/g },
  { id: "rule-exclusions", label: "excludedScopeNotes", re: /excludedScopeNotes/g },
  { id: "judge-demo-period", label: "Judge demo ·", re: /Judge demo\s*[·•]/gi },
  { id: "recovery-dev", label: "Recovery-dev", re: /Recovery-dev/gi },
  { id: "studio-license", label: "Studio license", re: /Studio license/gi },
  { id: "cron-actor", label: "Convex Automated Cron Engine", re: /Convex Automated Cron Engine/gi },
  { id: "cron-auditor", label: "Convex Compliance Auditor Cron", re: /Convex Compliance Auditor Cron/gi },
  { id: "kernel-browser", label: "KERNEL hosted browser", re: /KERNEL hosted browser/gi },
  { id: "system-actor", label: "internal system actor", re: /\bsystem:[a-z0-9-]+\b/g },
  { id: "env-name", label: "environment variable name", re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/g },
  { id: "record-id", label: "record or vendor id", re: /\b[a-z][a-z0-9]{31}\b/g },
  // An unmasked address is any full local part at an example.com domain.
  // Masked forms (sb-****@personal.example.com, [demo inbox]@example.com) do
  // not match because '*' and '[' are not local-part characters.
  { id: "example-address", label: "unmasked .example.com address", re: /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)*example\.com\b/gi },
];

// Commit stamps are only a demo-flow concern; apply this rule to #/demo alone.
// Require at least one a-f letter so a plain date such as 20261108 is not a hit.
const DEMO_COMMIT_RULE = { id: "demo-commit", label: "commit hash in demo flow", re: /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g };

function contextFor(text, index, length) {
  const start = Math.max(0, index - 70);
  const end = Math.min(text.length, index + length + 70);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function scanText(text, rules) {
  const hits = [];
  for (const rule of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let match;
    while ((match = re.exec(text)) !== null) {
      hits.push({
        rule: rule.label,
        match: match[0],
        context: contextFor(text, match.index, match[0].length),
      });
      if (match[0] === "") re.lastIndex += 1;
    }
  }
  return hits;
}

/**
 * Runs in the browser. Walks rendered text nodes and returns app copy, quoted
 * recorded history, and the text skipped inside closed <details> elements. Any
 * text node with a closed <details> anywhere in its ancestor chain is skipped,
 * including that element's own <summary>, exactly as VAL-COPY-005 requires.
 */
async function extractText(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#workspace-main") ?? document.body;
    const app = [];
    const recorded = [];
    const skipped = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        if (el.closest("script,style,noscript,template,svg")) return NodeFilter.FILTER_REJECT;
        for (let n = el; n; n = n.parentElement) {
          if (n.tagName === "DETAILS" && !n.hasAttribute("open")) {
            skipped.push((node.textContent || "").trim().slice(0, 80));
            return NodeFilter.FILTER_REJECT;
          }
          if (n.hasAttribute("hidden")) return NodeFilter.FILTER_REJECT;
        }
        const visible =
          typeof el.checkVisibility === "function"
            ? el.checkVisibility({ checkVisibilityCSS: true })
            : el.getClientRects().length > 0;
        return visible ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const value = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!value) continue;
      if (node.parentElement.closest("[data-recorded-history]")) recorded.push(value);
      else app.push(value);
    }
    return {
      hash: location.hash,
      appText: app.join(" ").replace(/\s+/g, " ").trim(),
      recordedText: recorded.join(" ").replace(/\s+/g, " ").trim(),
      recordedBlocks: [...root.querySelectorAll("[data-recorded-history]")].filter((el) => {
        if (el.closest("details:not([open])")) return false;
        return typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0;
      }).length,
      skippedInsideClosedDetails: skipped.length,
    };
  });
}

async function selfTest(browser) {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><body>
        <details><summary>Manual details summary</summary>
          <p>fixture inside a closed panel</p>
          <p>AgentID inside a closed panel</p>
        </details>
        <p>fixture outside the panel</p>
        <blockquote data-recorded-history="true"><p>Demo Mutual Insurance Co. recorded note</p></blockquote>
        <p>masked sb-****@personal.example.com and [demo inbox]@example.com</p>
      </body></html>`,
      { waitUntil: "domcontentloaded" }
    );
    const text = await extractText(page);
    const failures = [];
    if (text.appText.includes("fixture inside a closed panel")) failures.push("closed details text leaked into app copy");
    if (text.appText.includes("AgentID inside a closed panel")) failures.push("closed details AgentID leaked into app copy");
    if (!text.recordedText.includes("Demo Mutual Insurance Co.")) failures.push("recorded history was not bucketed separately");
    if (text.appText.includes("Demo Mutual Insurance Co.")) failures.push("recorded history leaked into app copy");
    if (text.recordedBlocks !== 1) failures.push(`expected 1 recorded block, found ${text.recordedBlocks}`);
    if (!text.skippedInsideClosedDetails) failures.push("closed details contents were not observed as skipped");
    const appHits = scanText(text.appText, RULES);
    const recordedHits = scanText(text.recordedText, RULES);
    if (appHits.length !== 1 || appHits[0].match.toLowerCase() !== "fixture") {
      failures.push(`expected exactly one app-copy hit (fixture), found ${JSON.stringify(appHits.map((h) => h.match))}`);
    }
    if (!recordedHits.some((h) => h.rule === "Demo Mutual Insurance Co.")) {
      failures.push("recorded bucket did not report the Demo Mutual hit separately");
    }
    const maskedHits = scanText("sb-****@personal.example.com [demo inbox]@example.com", RULES);
    if (maskedHits.length) failures.push(`masked sandbox addresses were flagged: ${JSON.stringify(maskedHits)}`);
    const unmaskedHits = scanText("someone@example.com", RULES);
    if (!unmaskedHits.some((h) => h.rule === "unmasked .example.com address")) {
      failures.push("an unmasked example.com address was not flagged");
    }
    return {
      ok: failures.length === 0,
      failures,
      closedDetailsExempt: !text.appText.includes("fixture inside a closed panel"),
      insideClosedDetailsHits: 0,
      outsideHits: appHits.length,
      hits: appHits.map((hit) => ({ screen: "self-test", ...hit })),
      recordedReportedSeparately: recordedHits.some((h) => h.rule === "Demo Mutual Insurance Co."),
      skippedTextSample: text.skippedInsideClosedDetails,
    };
  } finally {
    await page.close();
  }
}

async function enterSeat(browser, seat) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/#/demo`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector(`[data-testid="demo-enter-${seat}"]`, { timeout: 30000 });
  await page.click(`[data-testid="demo-enter-${seat}"]`);
  await page.waitForFunction(() => location.hash !== "#/demo", { timeout: 60000 });
  await page.waitForFunction(
    () => !document.body.innerText.includes("Connecting to Convex reactive backend"),
    { timeout: 60000 }
  );
  await delay(2000);
  return { context, page };
}

async function gotoAndWait(page, hash, name) {
  await page.goto(`${BASE_URL}/${hash}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction((wanted) => location.hash.startsWith(wanted), { timeout: 45000 }, hash);
  await page.waitForFunction(
    () => !document.body.innerText.includes("Connecting to Convex reactive backend"),
    { timeout: 45000 }
  );
  await delay(1500);
  const body = await page.evaluate(() => document.body.innerText);
  if (body.length < 80) throw new Error(`${name}: page rendered almost no text (${body.length} chars)`);
}

function resolved(href) {
  return new URL(href, `${BASE_URL}/`).href;
}

async function findLink(page, pattern, description) {
  const href = await page.evaluate((source) => {
    const re = new RegExp(source, "i");
    const link = [...document.querySelectorAll("a[href]")].find((a) => re.test(a.textContent ?? ""));
    return link?.getAttribute("href") ?? null;
  }, pattern.source);
  if (!href) throw new Error(`could not find ${description} link`);
  return resolved(href);
}

function readSettledPayAppId() {
  const file = path.join(REPO_ROOT, "src", "auth", "demoSeats.ts");
  const source = fs.readFileSync(file, "utf8");
  const id = /SETTLED_LOPEZ_PAY_APP_ID\s*=\s*"([^"]+)"/.exec(source)?.[1];
  if (!id) throw new Error(`SETTLED_LOPEZ_PAY_APP_ID not found in ${file}`);
  return id;
}

async function main() {
  const settledPayAppId = readSettledPayAppId();
  const { browser } = await launchBrowser(1440, 900);
  const screens = [];
  const diagnostics = {};
  try {
    // Signed-out demo landing.
    {
      const page = await browser.newPage();
      const diag = attachDiagnostics(page);
      await page.goto(`${BASE_URL}/#/demo`, { waitUntil: "networkidle0", timeout: 60000 });
      await page.waitForSelector('[data-testid="demo-access-page"]', { timeout: 30000 });
      await delay(800);
      screens.push({ name: "Demo landing", route: "#/demo", ...(await extractText(page)) });
      diagnostics["Demo landing"] = { consoleErrors: diag.consoleLogs.filter((l) => l.type === "error"), pageErrors: diag.pageErrors, failedRequests: diag.failedRequests };
      await page.close();
    }

    // GC inbox + the frozen Lopez project page.
    {
      const { context, page } = await enterSeat(browser, "gc");
      const diag = attachDiagnostics(page);
      await gotoAndWait(page, "#/inbox", "GC inbox");
      screens.push({ name: "GC inbox", route: "#/inbox", ...(await extractText(page)) });

      await gotoAndWait(page, "#/all-projects", "GC all projects");
      const lopez = await findLink(page, /Lopez Kitchen/i, "Lopez project");
      await page.goto(lopez, { waitUntil: "networkidle0", timeout: 60000 });
      await delay(1800);
      const body = await page.evaluate(() => document.body.innerText);
      if (!/Lopez Kitchen/i.test(body)) throw new Error("GC Lopez project: Lopez content did not render");
      screens.push({ name: "GC Lopez project", route: new URL(lopez).hash, ...(await extractText(page)) });
      diagnostics["GC inbox"] = { consoleErrors: diag.consoleLogs.filter((l) => l.type === "error"), pageErrors: diag.pageErrors, failedRequests: diag.failedRequests };
      await context.close();
    }

    // Settled Ortiz pay app on the Lopez job.
    {
      const { context, page } = await enterSeat(browser, "sub");
      const diag = attachDiagnostics(page);
      const hash = `#/pay-apps/${settledPayAppId}`;
      await gotoAndWait(page, hash, "Sub pay app");
      const body = await page.evaluate(() => document.body.innerText);
      if (!/Ortiz Plumbing/.test(body)) throw new Error("Sub pay app: Ortiz pay app did not render");
      screens.push({ name: "Sub pay app", route: hash, ...(await extractText(page)) });
      diagnostics["Sub pay app"] = { consoleErrors: diag.consoleLogs.filter((l) => l.type === "error"), pageErrors: diag.pageErrors, failedRequests: diag.failedRequests };
      await context.close();
    }

    // Owner home, draws, and the change-order invoice detail.
    {
      const { context, page } = await enterSeat(browser, "owner");
      const diag = attachDiagnostics(page);
      await gotoAndWait(page, "#/projects", "Owner projects");
      const homeBody = await page.evaluate(() => document.body.innerText);
      if (!/Owner home/i.test(homeBody)) throw new Error("Owner projects: owner home did not render");
      screens.push({ name: "Owner projects", route: "#/projects", ...(await extractText(page)) });

      await gotoAndWait(page, "#/owner-pay-apps", "Owner pay apps");
      screens.push({ name: "Owner pay apps", route: "#/owner-pay-apps", ...(await extractText(page)) });

      await gotoAndWait(page, "#/change-orders", "Owner change orders");
      // The owner has both the residential Lopez job and a commercial reference
      // job. Pick Lopez so the invoice we scan belongs to the residential story.
      const picked = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="change-orders-project"]');
        if (!select) return false;
        const option = [...select.options].find((o) => /Lopez Kitchen/i.test(o.textContent ?? ""));
        if (!option) return false;
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      });
      if (!picked) throw new Error("Owner change orders: could not select the Lopez project");
      await delay(1500);
      const invoiceHref = await page.evaluate(() => {
        const link = [...document.querySelectorAll('a[href*="/change-orders/"]')][0];
        return link?.getAttribute("href") ?? null;
      });
      if (!invoiceHref) throw new Error("Owner change orders: no invoice detail link on the Lopez job");
      const invoice = resolved(invoiceHref);
      await page.goto(invoice, { waitUntil: "networkidle0", timeout: 60000 });
      await delay(1800);
      const coBody = await page.evaluate(() => document.body.innerText);
      if (!/change order|invoice/i.test(coBody)) throw new Error("Owner change-order invoice: detail did not render");
      screens.push({ name: "Owner change-order invoice", route: new URL(invoice).hash, ...(await extractText(page)) });
      diagnostics["Owner screens"] = { consoleErrors: diag.consoleLogs.filter((l) => l.type === "error"), pageErrors: diag.pageErrors, failedRequests: diag.failedRequests };
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const results = screens.map((screen) => {
    const rules = screen.route === "#/demo" ? [...RULES, DEMO_COMMIT_RULE] : RULES;
    const appHits = scanText(screen.appText, rules);
    const recordedHits = scanText(screen.recordedText, rules);
    return {
      name: screen.name,
      route: screen.route,
      appCopyHits: appHits,
      quotedRecordedText: {
        blocks: screen.recordedBlocks,
        characters: screen.recordedText.length,
        hits: recordedHits,
      },
      skippedInsideClosedDetails: screen.skippedInsideClosedDetails,
      charsScanned: screen.appText.length,
    };
  });

  const self = await (async () => {
    const { browser } = await launchBrowser(900, 700);
    try {
      return await selfTest(browser);
    } finally {
      await browser.close();
    }
  })();

  const core = results.filter((r) => r.name !== "Demo landing");
  const appHits = results.reduce((n, r) => n + r.appCopyHits.length, 0);
  const recordedHits = results.reduce((n, r) => n + r.quotedRecordedText.hits.length, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    selfTest: self,
    summary: {
      screens: core.length,
      screensIncludingDemo: results.length,
      appCopyHits: appHits,
      quotedRecordedHits: recordedHits,
      quotedRecordedBlocks: results.reduce((n, r) => n + r.quotedRecordedText.blocks, 0),
    },
    screens: results,
    diagnostics,
  };
  const file = writeJson("leak-scan.json", report);

  console.log(`leak-scan ${BASE_URL}`);
  console.log(
    `self-test: ${self.ok ? "PASS" : "FAIL"} (closed <details> exempt=${self.closedDetailsExempt}, inside hits=${self.insideClosedDetailsHits}, outside hits=${self.outsideHits}, quoted reported separately=${self.recordedReportedSeparately})`
  );
  if (!self.ok) for (const failure of self.failures) console.error(`  self-test failure: ${failure}`);
  for (const hit of self.hits) {
    console.log(`  self-test hit [${hit.screen}] ${hit.rule}: "${hit.match}" — …${hit.context}…`);
  }
  for (const r of results) {
    const recorded = r.quotedRecordedText.blocks
      ? `${r.quotedRecordedText.hits.length} hits in ${r.quotedRecordedText.blocks} quoted block(s)`
      : "none";
    console.log(`  ${r.name} (${r.route}): ${r.appCopyHits.length} app-copy hits; quoted recorded: ${recorded}`);
    for (const hit of r.appCopyHits) {
      console.error(`    HIT [${r.name}] ${hit.rule}: "${hit.match}" — …${hit.context}…`);
    }
    for (const hit of r.quotedRecordedText.hits) {
      console.log(`    quoted [${r.name}] ${hit.rule}: "${hit.match}" — left verbatim`);
    }
  }
  console.log(
    `summary: ${core.length} core screens + demo; ${appHits} app-copy hits; ${report.summary.quotedRecordedBlocks} quoted block(s), ${recordedHits} banned strings inside quoted history (reported, never rewritten)`
  );
  console.log(`evidence: ${file}`);

  if (!self.ok) process.exitCode = 2;
  else if (appHits > 0) process.exitCode = 1;
  else process.exitCode = 0;
}

main().catch((error) => {
  console.error(`leak-scan could not run: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 2;
});
