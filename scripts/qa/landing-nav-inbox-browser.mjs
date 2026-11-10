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
// Local dev is the fast loop for this sweep; anything else must be an https origin.
const localDev = /^http:\/\/localhost(?::\d+)?$/i.test(site);
if (!localDev && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(site)) {
  throw new Error("--url must be an https origin or http://localhost:<port>.");
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = process.argv.includes("--out")
  ? path.resolve(process.argv[process.argv.indexOf("--out") + 1])
  : path.join(root, "evidence", `landing-nav-inbox-browser-${stamp}`);
fs.mkdirSync(evidenceDir, { recursive: true });
const report = { target: site, checks: [], measurements: [], pageErrors: [], consoleErrors: [] };
const check = (name, ok, detail = "") => {
  report.checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  defaultViewport: { width: 1440, height: 900 },
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
  for (const text of ["Catch overbilling early", "Decide with the evidence", "Keep a clean owner trail", "owner or lender", "PayPal sandbox · no real money"]) {
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
  // The strip resolves from its own query; measure the settled cells, not the loading card.
  await page.waitForFunction(() => {
    const value = document.querySelector('[data-testid="project-money-collected"]')?.innerText?.trim() ?? "";
    return /^\$[\d,]+\.\d{2}$/.test(value);
  }, { timeout: 60_000 });

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
  check(
    "the demo GC More menu has six entries and no Procurement",
    nav.more?.links.length === 6 && !nav.more.links.some((link) => /^Procurement/.test(link.text) || link.href === "#/procurement"),
    JSON.stringify(nav.more?.links),
  );
  for (const label of ["Compliance & waivers", "Project summaries", "People", "Vendors", "Billing agents", "Payment reports"]) {
    check(`More menu keeps ${label}`, nav.more?.links.some((link) => link.text.startsWith(label)), JSON.stringify(nav.more?.links));
  }
  await page.evaluate(() => document.querySelector("#workspace-navigation details > summary")?.click());
  await page.waitForFunction(() => document.querySelector("#workspace-navigation details")?.open === true);
  const moreHrefs = await page.evaluate(() => [...document.querySelectorAll("#workspace-navigation details a")].map((a) => a.getAttribute("href")));
  check(
    "More links point at the existing routes and omit Procurement",
    moreHrefs.includes("#/dashboard") && moreHrefs.includes("#/billing-agents") && !moreHrefs.includes("#/procurement"),
    JSON.stringify(moreHrefs),
  );
  await page.screenshot({ path: path.join(evidenceDir, "gc-nav-more.png"), fullPage: false });

  phase = "direct procurement fallback";
  await page.goto(`${site}/#/procurement`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => [...document.querySelectorAll("h1")].some((h) => h.textContent.trim() === "Procurement"), { timeout: 60_000 });
  const directProcurement = await page.evaluate(() => ({
    hash: location.hash,
    search: location.search,
    notFound: document.body.innerText.includes("Not found"),
    hasProcurementHeading: [...document.querySelectorAll("h1")].some((h) => h.textContent.trim() === "Procurement"),
  }));
  check(
    "the demo GC still opens the direct #/procurement route",
    directProcurement.hash === "#/procurement" && directProcurement.hasProcurementHeading && !directProcurement.notFound,
    JSON.stringify(directProcurement),
  );
  await page.screenshot({ path: path.join(evidenceDir, "gc-procurement-direct.png"), fullPage: false });

  phase = "editable project procurement entry";
  await page.goto(`${site}/#/all-projects`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => location.hash === "#/all-projects"
      && document.body.innerText.includes("Your company's projects")
      && !document.body.innerText.includes("Loading projects…"),
    { timeout: 60_000 },
  );
  const projectHrefs = await page.evaluate(() => [...document.querySelectorAll('a[href^="#/all-projects/"]')]
    .map((a) => a.getAttribute("href"))
    .filter((href) => /^#\/all-projects\/[^/]+$/.test(href) && !/#\/all-projects\/(new|quick-start)$/.test(href)));
  check("the GC project list offers project pages", projectHrefs.length > 0, JSON.stringify(projectHrefs));
  let editableProject = null;
  for (const href of projectHrefs.slice(0, 8)) {
    await page.goto(`${site}/${href}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (target) => location.hash === target
        && document.body.innerText.includes("Open billing")
        && !/Loading (?:trade packages|trades)…/.test(document.body.innerText),
      { timeout: 30_000 },
      href,
    );
    editableProject = await page.evaluate(() => {
      const entry = [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "Open in Procurement");
      if (!entry) return null;
      return {
        projectHash: location.hash,
        hasSpecEntry: [...document.querySelectorAll("button")].some((el) => el.textContent.trim() === "AI spec breakdown"),
      };
    });
    if (editableProject) break;
  }
  check("an editable project keeps its Open in Procurement entry", editableProject !== null, JSON.stringify(projectHrefs.slice(0, 8)));
  check("an editable project keeps the trade spec entry", editableProject.hasSpecEntry, JSON.stringify(editableProject));
  const projectId = editableProject.projectHash.replace("#/all-projects/", "");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "Open in Procurement")?.click());
  await page.waitForFunction(() => [...document.querySelectorAll("h1")].some((h) => h.textContent.trim() === "Procurement"), { timeout: 60_000 });
  const projectProcurement = await page.evaluate(() => ({ hash: location.hash, search: location.search, notFound: document.body.innerText.includes("Not found") }));
  const projectQuery = new URLSearchParams(projectProcurement.search);
  check(
    "the editable project entry opens its query-scoped Procurement route",
    projectProcurement.hash === "#/procurement" && projectQuery.get("project") === projectId && projectQuery.get("tab") === "packages" && !projectProcurement.notFound,
    JSON.stringify({ projectId, ...projectProcurement }),
  );
  await page.screenshot({ path: path.join(evidenceDir, "gc-procurement-editable.png"), fullPage: false });

  phase = "return to approval inbox";
  await page.goto(`${site}/#/inbox`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="inbox-counts"]');
  // Coming back from Procurement remounts the landing; let the strip and the work rows resolve again.
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="inbox-entry"]').length > 0, { timeout: 60_000 });
  await page.waitForFunction(() => {
    const value = document.querySelector('[data-testid="project-money-collected"]')?.innerText?.trim() ?? "";
    return /^\$[\d,]+\.\d{2}$/.test(value);
  }, { timeout: 60_000 });

  phase = "approval inbox";
  const inbox = await page.evaluate(() => {
    const visible = (el) => {
      if (el.closest("details:not([open])")) return false;
      return typeof el.checkVisibility === "function" ? el.checkVisibility({ checkVisibilityCSS: true }) : el.getClientRects().length > 0;
    };
    const entries = [...document.querySelectorAll('[data-testid="inbox-entry"]')];
    // Scope each disclosure by its own test id: the money strip has a receipts panel too.
    const historySelector = '[data-testid="inbox-history"]';
    const commercialSelector = '[data-testid="inbox-commercial"]';
    const history = document.querySelector(historySelector);
    const commercial = document.querySelector(commercialSelector);
    const action = document.querySelector('[data-testid="inbox-residential-decision-action"]');
    const strips = [...document.querySelectorAll('[data-testid="project-money-strip"]')];
    const stripValue = (id) => strips[0]?.querySelector(`[data-testid="${id}"]`)?.innerText?.trim() ?? null;
    const statusOf = (el) => el.querySelector('[data-testid="inbox-payapp-status"]')?.getAttribute("data-status") ?? null;
    const records = [...document.querySelectorAll('[data-testid="inbox-residential-decision"], [data-testid="inbox-entry"]')].map((el) => ({
      payAppId: el.getAttribute("data-payapp-id"),
      projectKind: el.getAttribute("data-project-kind"),
      status: statusOf(el),
      top: Math.round(el.getBoundingClientRect().top + scrollY),
      visible: visible(el),
      insideCommercial: el.closest(commercialSelector) !== null,
    }));
    const firstCommercial = records.findIndex((record) => record.projectKind === "commercial");
    const primaries = [...document.querySelectorAll("a, button")].filter((el) => visible(el) && /\bbg-accent\b/.test(el.className) && /\btext-accent-fg\b/.test(el.className));
    return {
      counts: document.querySelector('[data-testid="inbox-counts"]')?.textContent.trim() ?? "",
      entries: entries.length,
      entryStatuses: entries.map(statusOf),
      entryKinds: entries.map((el) => el.getAttribute("data-project-kind")),
      visible: entries.filter(visible).length,
      labels: entries.map((el) => el.querySelector('[data-testid="inbox-payapp-status"]')?.textContent.trim() ?? ""),
      groups: [...document.querySelectorAll("main section[aria-label] > div > h2")].map((el) => el.textContent.trim()),
      strips: {
        count: strips.length,
        scopes: strips.map((el) => el.getAttribute("data-money-scope")),
        titles: strips.map((el) => el.querySelector("h2")?.innerText.trim() ?? null),
        labels: [...(strips[0]?.querySelectorAll("dt") ?? [])].map((dt) => dt.innerText.trim()),
        values: ["project-money-collected", "project-money-paid-subs", "project-money-retainage", "project-money-retainage-held-from-you", "project-money-owed"].map(stripValue),
        ownerCaptions: strips.flatMap((el) => {
          const subCell = el.querySelector('[data-testid="project-money-retainage"]')?.closest("div.rounded-lg") ?? null;
          return [...el.querySelectorAll('[data-testid="project-money-owner-retainage"]')].map((caption) => ({
            insideSubRetainageCell: subCell !== null && subCell.contains(caption),
          }));
        }),
        top: strips[0] ? Math.round(strips[0].getBoundingClientRect().top + scrollY) : null,
        pageHasPortfolioWords: /Money across your jobs|Collected from owners/.test(document.body.innerText),
      },
      history: history
        ? {
            selector: historySelector,
            tag: history.tagName.toLowerCase(),
            open: history.open,
            label: history.querySelector("summary")?.textContent.trim() ?? "",
            records: history.querySelectorAll('[data-testid="inbox-entry"]').length,
          }
        : null,
      commercial: commercial
        ? {
            selector: commercialSelector,
            open: commercial.open,
            title: commercial.querySelector("summary > span")?.textContent.trim() ?? "",
            declaredCount: Number(commercial.getAttribute("data-record-count")),
            records: commercial.querySelectorAll('[data-testid="inbox-entry"]').length,
            visibleRecords: [...commercial.querySelectorAll('[data-testid="inbox-entry"]')].filter(visible).length,
          }
        : null,
      records,
      residentialLeads: firstCommercial === -1 || records.slice(firstCommercial).every((record) => record.projectKind !== "residential"),
      action: action ? { text: action.textContent.trim(), href: action.getAttribute("href") } : null,
      paidApproveActions: [...document.querySelectorAll("a, button")].filter((el) => /^Approve .* and pay /.test(el.textContent.trim())).map((el) => el.textContent.trim()),
      primaryCount: primaries.length,
      pageHeight: document.documentElement.scrollHeight,
      chips: [...document.querySelectorAll("main h1, main h2")].map((el) => el.textContent.trim()),
    };
  });
  console.log(
    `history disclosure measured: ${inbox.history ? `${inbox.history.selector} (<${inbox.history.tag}>) "${inbox.history.label}" open=${inbox.history.open}` : "not present"}`,
  );
  const ACTIVE_STATUSES = new Set(["submitted", "under_review", "reviewed"]);
  const WAITING_STATUSES = new Set(["approved", "approved_as_noted"]);
  const activeCount = inbox.entryStatuses.filter((status) => ACTIVE_STATUSES.has(status)).length;
  const waitingCount = inbox.entryStatuses.filter((status) => WAITING_STATUSES.has(status)).length;
  const historyCount = inbox.entryStatuses.filter((status) => !ACTIVE_STATUSES.has(status) && !WAITING_STATUSES.has(status)).length;
  // The header is the commercial partition's active workload, not every active row.
  const commercialActive = inbox.entryStatuses.filter(
    (status, index) => inbox.entryKinds[index] !== "residential" && ACTIVE_STATUSES.has(status),
  ).length;
  const headerMatch = inbox.counts.match(/^(\d+) open in commercial reference$/);
  check("the workload header names the commercial reference", headerMatch !== null, inbox.counts);
  check("the workload header counts only the commercial active partition", Number(headerMatch?.[1]) === commercialActive, `${inbox.counts} vs ${commercialActive} commercial active`);
  check("inbox bucket counts add up to the loaded entries", activeCount + waitingCount + historyCount === inbox.entries, JSON.stringify(inbox));
  check("the GC landing renders exactly one money strip", inbox.strips.count === 1, JSON.stringify(inbox.strips));
  check("the one strip is the Lopez project scope", inbox.strips.scopes[0] === "project" && /Money on this job · Lopez Kitchen Remodel/.test(inbox.strips.titles[0] ?? ""), JSON.stringify(inbox.strips));
  check("no portfolio strip or its copy survives", !inbox.strips.scopes.includes("portfolio") && !inbox.strips.pageHasPortfolioWords, JSON.stringify(inbox.strips));
  check("the Lopez strip has the five directed cells and stored values", JSON.stringify(inbox.strips.labels) === JSON.stringify(["Collected from homeowner", "Paid to subs", "Retainage you hold", "Retainage held from you", "Owed this week"]) && JSON.stringify(inbox.strips.values) === JSON.stringify(["$4,800.00", "$3,800.00", "$200.00", "$400.00", "$0.00"]), JSON.stringify(inbox.strips));
  check("the owner caption lives only in the directed owner cell", inbox.strips.ownerCaptions.length === 1 && inbox.strips.ownerCaptions[0].insideSubRetainageCell === false, JSON.stringify(inbox.strips.ownerCaptions));
  check("the money strip leads the work content", inbox.strips.top !== null && (inbox.records[0] === undefined || inbox.strips.top < inbox.records[0].top), JSON.stringify({ strip: inbox.strips.top, firstRecord: inbox.records[0]?.top }));
  check("open work is rendered before settled history", inbox.chips.some((text) => text.startsWith("Needs your attention")) || activeCount === 0, JSON.stringify(inbox.chips));
  check("residential history keeps its existing disclosure", inbox.history !== null, JSON.stringify(inbox.history));
  if (historyCount > 0 && activeCount + waitingCount > 0) {
    check("history is collapsed while open work exists", inbox.history?.open === false, JSON.stringify(inbox.history));
  } else if (inbox.history) {
    check("history opens when it is the only residential work left", inbox.history.open === true, JSON.stringify(inbox.history));
  }
  check("paid residential card offers its receipt", inbox.action?.text === "View paid receipt" && inbox.action?.href?.startsWith("#/pay-apps/"), JSON.stringify(inbox.action));
  check("no paid representation offers approve-and-pay", inbox.paidApproveActions.length === 0, JSON.stringify(inbox.paidApproveActions));
  check("residential records precede every commercial record", inbox.residentialLeads, JSON.stringify(inbox.records));
  check("commercial records share one collapsed disclosure", inbox.commercial?.open === false && inbox.commercial.visibleRecords === 0, JSON.stringify(inbox.commercial));
  check("commercial disclosure has the real count", inbox.commercial?.title === `Commercial reference job (${inbox.commercial.records})` && inbox.commercial.declaredCount === inbox.commercial.records, JSON.stringify(inbox.commercial));
  check("every commercial entry is inside that disclosure", inbox.records.filter((record) => record.projectKind === "commercial").length === inbox.commercial?.records && inbox.records.filter((record) => record.projectKind === "commercial").every((record) => record.insideCommercial), JSON.stringify(inbox.records));
  check("the collapsed landing keeps one primary action", inbox.primaryCount === 1, String(inbox.primaryCount));
  check("status codes are shown as readable labels", !inbox.labels.some((label) => /_/.test(label)), JSON.stringify(inbox.labels));
  report.measurements.push({ screen: "inbox-collapsed", width: 1440, height: 900, pageHeight: inbox.pageHeight, commercial: inbox.commercial, records: inbox.records });
  await page.screenshot({ path: path.join(evidenceDir, "inbox-buckets.png"), fullPage: true });

  await page.click('[data-testid="inbox-history"] > summary');
  await page.waitForFunction(() => document.querySelector('[data-testid="inbox-history"]')?.open === true);
  const paidHistory = await page.evaluate(() => {
    const history = document.querySelector('[data-testid="inbox-history"]');
    const paid = history?.querySelector('[data-payapp-id]');
    return {
      records: history?.querySelectorAll('[data-testid="inbox-entry"]').length ?? 0,
      payAppId: paid?.getAttribute("data-payapp-id") ?? null,
      status: paid?.querySelector('[data-testid="inbox-payapp-status"]')?.textContent.trim() ?? "",
      approveActions: [...(paid?.querySelectorAll("a, button") ?? [])].filter((el) => /^Approve/i.test(el.textContent.trim())).map((el) => el.textContent.trim()),
      primaryActions: [...(paid?.querySelectorAll("a, button") ?? [])].filter((el) => /\bbg-accent\b/.test(el.className) && /\btext-accent-fg\b/.test(el.className)).length,
    };
  });
  check("paid history entry remains reachable", paidHistory.records > 0 && paidHistory.status === "Paid", JSON.stringify(paidHistory));
  check("paid history entry has no approval or primary action", paidHistory.approveActions.length === 0 && paidHistory.primaryActions === 0, JSON.stringify(paidHistory));
  await page.screenshot({ path: path.join(evidenceDir, "inbox-paid-history.png"), fullPage: true });
  await page.click('[data-testid="inbox-history"] > summary');
  await page.waitForFunction(() => document.querySelector('[data-testid="inbox-history"]')?.open === false);

  await page.click('[data-testid="inbox-commercial"] > summary');
  await page.waitForFunction(() => document.querySelector('[data-testid="inbox-commercial"]')?.open === true);
  const expanded = await page.evaluate(() => {
    const commercial = document.querySelector('[data-testid="inbox-commercial"]');
    const visible = (el) => !el.closest("details:not([open])") && (typeof el.checkVisibility === "function" ? el.checkVisibility({ checkVisibilityCSS: true }) : el.getClientRects().length > 0);
    return {
      records: commercial?.querySelectorAll('[data-testid="inbox-entry"]').length ?? 0,
      visibleRecords: [...(commercial?.querySelectorAll('[data-testid="inbox-entry"]') ?? [])].filter(visible).length,
      primaryCount: [...document.querySelectorAll("a, button")].filter((el) => visible(el) && /\bbg-accent\b/.test(el.className) && /\btext-accent-fg\b/.test(el.className)).length,
      pageHeight: document.documentElement.scrollHeight,
    };
  });
  check("expanding the commercial disclosure reveals every counted record", expanded.records === inbox.commercial?.records && expanded.visibleRecords === expanded.records, JSON.stringify(expanded));
  check("the expanded commercial disclosure still has one primary", expanded.primaryCount === 1, String(expanded.primaryCount));
  report.measurements.push({ screen: "inbox-commercial-open", width: 1440, height: 900, ...expanded });
  await page.screenshot({ path: path.join(evidenceDir, "inbox-commercial-open.png"), fullPage: true });
  await page.click('[data-testid="inbox-commercial"] > summary');
  await page.waitForFunction(() => document.querySelector('[data-testid="inbox-commercial"]')?.open === false);

  phase = "paid commercial filter";
  await page.type('input[placeholder^="Agreement, project"]', "A401-DEMO-PAY-20261105-07");
  await delay(500);
  await page.waitForFunction(() => {
    const commercial = document.querySelector('[data-testid="inbox-commercial"]');
    return commercial?.getAttribute("data-record-count") === "2" && commercial.querySelectorAll('[data-testid="inbox-entry"]').length === 2;
  });
  const filtered = await page.evaluate(() => {
    const visible = (el) => !el.closest("details:not([open])") && (typeof el.checkVisibility === "function" ? el.checkVisibility({ checkVisibilityCSS: true }) : el.getClientRects().length > 0);
    const commercial = document.querySelector('[data-testid="inbox-commercial"]');
    const primaries = [...document.querySelectorAll("a, button")].filter((el) => visible(el) && /\bbg-accent\b/.test(el.className) && /\btext-accent-fg\b/.test(el.className)).map((el) => ({
      text: el.textContent.trim(),
      href: el.getAttribute("href"),
      testId: el.getAttribute("data-testid"),
      height: Math.round(el.getBoundingClientRect().height),
      insideDetails: el.closest("details") !== null,
    }));
    return {
      records: commercial?.querySelectorAll('[data-testid="inbox-entry"]').length ?? 0,
      visible: [...(commercial?.querySelectorAll('[data-testid="inbox-entry"]') ?? [])].filter(visible).length,
      text: document.querySelector("main")?.innerText ?? "",
      commercialOpen: commercial?.open === true,
      commercialTitle: commercial?.querySelector("summary > span")?.textContent.trim() ?? "",
      primaries,
    };
  });
  check("paid commercial search keeps both records collapsed by default", !filtered.commercialOpen && filtered.records === 2 && filtered.visible === 0 && filtered.commercialTitle === "Commercial reference job (2)", JSON.stringify(filtered));
  check("paid commercial filter has exactly one visible primary", filtered.primaries.length === 1, JSON.stringify(filtered.primaries));
  check("paid commercial primary is a receipt outside the disclosure", filtered.primaries[0]?.testId === "inbox-commercial-decision-action" && filtered.primaries[0]?.text === "View paid receipt" && filtered.primaries[0]?.href?.startsWith("#/pay-apps/") && filtered.primaries[0]?.insideDetails === false, JSON.stringify(filtered.primaries));
  check("paid commercial primary meets the 44px floor", (filtered.primaries[0]?.height ?? 0) >= 44, JSON.stringify(filtered.primaries));
  report.measurements.push({ screen: "inbox-paid-commercial-filter", width: 1440, height: 900, ...filtered });
  await page.screenshot({ path: path.join(evidenceDir, "inbox-paid-commercial-filter-collapsed.png"), fullPage: true });
  await page.click('[data-testid="inbox-commercial"] > summary');
  await page.waitForFunction(() => document.querySelector('[data-testid="inbox-commercial"]')?.open === true);
  const filteredOpen = await page.evaluate(() => {
    const visible = (el) => !el.closest("details:not([open])") && el.getClientRects().length > 0;
    return {
      visible: [...document.querySelectorAll('[data-testid="inbox-entry"]')].filter(visible).length,
      text: document.querySelector("main")?.innerText ?? "",
      primaryCount: [...document.querySelectorAll("a, button")].filter((el) => visible(el) && /\bbg-accent\b/.test(el.className) && /\btext-accent-fg\b/.test(el.className)).length,
    };
  });
  check("expanding the paid commercial filter reveals both records without adding a primary", filteredOpen.visible === 2 && filteredOpen.text.includes("Rosendin Electric") && filteredOpen.primaryCount === 1, JSON.stringify(filteredOpen));
  await page.screenshot({ path: path.join(evidenceDir, "inbox-paid-commercial-filter-open.png"), fullPage: true });
  await page.click('[data-testid="inbox-commercial"] > summary');
  await page.waitForFunction(() => document.querySelector('[data-testid="inbox-commercial"]')?.open === false);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Clear" && button.getClientRects().length > 0)?.click());
  await page.waitForFunction(() => document.querySelector('[data-testid="inbox-commercial"]')?.open === false && document.querySelector('[data-testid="inbox-residential-decision-action"]')?.textContent.trim() === "View paid receipt");

  phase = "commercial-only pending filter";
  const pendingCommercialId = await page.evaluate(() => {
    const commercial = document.querySelector('[data-testid="inbox-commercial"]');
    const entry = [...(commercial?.querySelectorAll('[data-testid="inbox-entry"]') ?? [])].find((el) =>
      el.getAttribute("data-project-kind") === "commercial" &&
      el.querySelector('[data-testid="inbox-payapp-status"]')?.getAttribute("data-status") === "reviewed" &&
      el.querySelector('[data-testid="approve-proposal"]'),
    );
    return entry?.getAttribute("data-payapp-id") ?? null;
  });
  check("a decidable commercial record is available for the commercial-only state", typeof pendingCommercialId === "string" && pendingCommercialId.length > 0, String(pendingCommercialId));
  await page.type('input[placeholder^="Agreement, project"]', pendingCommercialId);
  await delay(500);
  await page.waitForFunction((payAppId) => {
    const commercial = document.querySelector('[data-testid="inbox-commercial"]');
    return commercial?.getAttribute("data-record-count") === "1" && commercial.querySelector(`[data-payapp-id="${payAppId}"]`) !== null;
  }, {}, pendingCommercialId);
  const commercialOnly = await page.evaluate(() => {
    const visible = (el) => !el.closest("details:not([open])") && (typeof el.checkVisibility === "function" ? el.checkVisibility({ checkVisibilityCSS: true }) : el.getClientRects().length > 0);
    const commercial = document.querySelector('[data-testid="inbox-commercial"]');
    const primaries = [...document.querySelectorAll("a, button")].filter((el) => visible(el) && /\bbg-accent\b/.test(el.className) && /\btext-accent-fg\b/.test(el.className)).map((el) => ({
      text: el.textContent.trim(),
      href: el.getAttribute("href"),
      testId: el.getAttribute("data-testid"),
      height: Math.round(el.getBoundingClientRect().height),
      insideDetails: el.closest("details") !== null,
    }));
    return {
      commercialOpen: commercial?.open === true,
      records: commercial?.querySelectorAll('[data-testid="inbox-entry"]').length ?? 0,
      visibleRecords: [...(commercial?.querySelectorAll('[data-testid="inbox-entry"]') ?? [])].filter(visible).length,
      primaries,
    };
  });
  check("commercial-only records stay collapsed by default", !commercialOnly.commercialOpen && commercialOnly.records === 1 && commercialOnly.visibleRecords === 0, JSON.stringify(commercialOnly));
  check("commercial-only state has exactly one visible primary", commercialOnly.primaries.length === 1, JSON.stringify(commercialOnly.primaries));
  check("commercial-only primary opens the decision outside the disclosure", commercialOnly.primaries[0]?.testId === "inbox-commercial-decision-action" && commercialOnly.primaries[0]?.text === "Review next commercial pay app" && commercialOnly.primaries[0]?.href === `#/pay-apps/${pendingCommercialId}` && commercialOnly.primaries[0]?.insideDetails === false, JSON.stringify(commercialOnly.primaries));
  check("commercial-only primary meets the 44px floor", (commercialOnly.primaries[0]?.height ?? 0) >= 44, JSON.stringify(commercialOnly.primaries));
  report.measurements.push({ screen: "inbox-commercial-only-pending", width: 1440, height: 900, ...commercialOnly });
  await page.screenshot({ path: path.join(evidenceDir, "inbox-commercial-only-pending-collapsed.png"), fullPage: true });
  await page.click('[data-testid="inbox-commercial"] > summary');
  await page.waitForFunction(() => document.querySelector('[data-testid="inbox-commercial"]')?.open === true);
  const commercialOnlyOpen = await page.evaluate(() => {
    const visible = (el) => !el.closest("details:not([open])") && el.getClientRects().length > 0;
    return {
      visibleRecords: [...document.querySelectorAll('[data-testid="inbox-entry"]')].filter(visible).length,
      primaryCount: [...document.querySelectorAll("a, button")].filter((el) => visible(el) && /\bbg-accent\b/.test(el.className) && /\btext-accent-fg\b/.test(el.className)).length,
    };
  });
  check("expanding the commercial-only record does not add a competing primary", commercialOnlyOpen.visibleRecords === 1 && commercialOnlyOpen.primaryCount === 1, JSON.stringify(commercialOnlyOpen));
  await page.click('[data-testid="inbox-commercial"] > summary');
  await page.waitForFunction(() => document.querySelector('[data-testid="inbox-commercial"]')?.open === false);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Clear" && button.getClientRects().length > 0)?.click());
  await page.waitForFunction(() => document.querySelector('[data-testid="inbox-commercial"]')?.open === false && document.querySelector('[data-testid="inbox-residential-decision-action"]')?.textContent.trim() === "View paid receipt");

  phase = "phone navigation";
  await page.setViewport({ width: 390, height: 844 });
  await delay(300);
  const phone = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    pageHeight: document.documentElement.scrollHeight,
    commercialOpen: document.querySelector('[data-testid="inbox-commercial"]')?.open === true,
    primaryCount: [...document.querySelectorAll("a, button")].filter((el) => !el.closest("details:not([open])") && el.getClientRects().length > 0 && /\bbg-accent\b/.test(el.className) && /\btext-accent-fg\b/.test(el.className)).length,
    menuVisible: [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Menu" && b.getClientRects().length > 0),
  }));
  check("phone layout does not overflow horizontally", phone.overflow <= 1, String(phone.overflow));
  check("phone keeps commercial records collapsed with one primary", !phone.commercialOpen && phone.primaryCount === 1, JSON.stringify(phone));
  report.measurements.push({ screen: "inbox-collapsed", width: 390, height: 844, pageHeight: phone.pageHeight, primaryCount: phone.primaryCount });
  check("phone menu control is visible", phone.menuVisible);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Menu")?.click());
  await page.waitForFunction(() => document.querySelector("#workspace-navigation")?.getClientRects().length > 0);
  const phoneNav = await page.evaluate(() => [...document.querySelectorAll("#workspace-navigation > ul > li > a")].filter((a) => a.getClientRects().length > 0).map((a) => a.textContent.trim()));
  check("phone menu exposes the same capped primary bar", phoneNav.length === 6 && phoneNav.some((text) => text.startsWith("Approvals")), JSON.stringify(phoneNav));
  await page.screenshot({ path: path.join(evidenceDir, "phone-nav.png"), fullPage: false });

  await page.goto(`${site}/#/procurement`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => [...document.querySelectorAll("h1")].some((h) => h.textContent.trim() === "Procurement"), { timeout: 60_000 });
  const phoneProcurement = await page.evaluate(() => ({
    heading: [...document.querySelectorAll("h1")].some((h) => h.textContent.trim() === "Procurement"),
    notFound: document.body.innerText.includes("Not found"),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  check("phone keeps the direct Procurement fallback", phoneProcurement.heading && !phoneProcurement.notFound, JSON.stringify(phoneProcurement));
  report.measurements.push({ screen: "procurement-direct", width: 390, height: 844, overflow: phoneProcurement.overflow });
  await page.screenshot({ path: path.join(evidenceDir, "phone-procurement-direct.png"), fullPage: false });

  await page.goto(`${site}/#/inbox`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="inbox-counts"]');
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Menu")?.click());
  await page.waitForFunction(() => document.querySelector("#workspace-navigation")?.getClientRects().length > 0);
  await page.evaluate(() => document.querySelector("#workspace-navigation details > summary")?.click());
  await page.waitForFunction(() => document.querySelector("#workspace-navigation details")?.open === true);
  const phoneMoreHrefs = await page.evaluate(() => [...document.querySelectorAll("#workspace-navigation details a")].map((a) => a.getAttribute("href")));
  check("phone More also omits Procurement", phoneMoreHrefs.length === 6 && !phoneMoreHrefs.includes("#/procurement"), JSON.stringify(phoneMoreHrefs));
  await page.screenshot({ path: path.join(evidenceDir, "phone-nav-more.png"), fullPage: false });

  await page.goto(`${site}/#/all-projects/${projectId}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (target) => location.hash === target
      && document.body.innerText.includes("Open billing")
      && !/Loading (?:trade packages|trades)…/.test(document.body.innerText),
    { timeout: 30_000 },
    `#/all-projects/${projectId}`,
  );
  const phoneEditable = await page.evaluate(() => [...document.querySelectorAll("button")].some((el) => el.textContent.trim() === "Open in Procurement"));
  check("phone keeps the editable project Procurement entry", phoneEditable);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((el) => el.textContent.trim() === "Open in Procurement")?.click());
  await page.waitForFunction(() => [...document.querySelectorAll("h1")].some((h) => h.textContent.trim() === "Procurement"), { timeout: 60_000 });
  const phoneEditableRoute = await page.evaluate(() => ({ hash: location.hash, search: location.search, notFound: document.body.innerText.includes("Not found") }));
  const phoneEditableQuery = new URLSearchParams(phoneEditableRoute.search);
  check(
    "phone keeps the editable project query-scoped Procurement route",
    phoneEditableRoute.hash === "#/procurement" && phoneEditableQuery.get("project") === projectId && phoneEditableQuery.get("tab") === "packages" && !phoneEditableRoute.notFound,
    JSON.stringify({ projectId, ...phoneEditableRoute }),
  );
  await page.screenshot({ path: path.join(evidenceDir, "phone-procurement-editable.png"), fullPage: false });

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
