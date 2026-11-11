/**
 * Deterministic mounted fake-clock regression for the real JudgeDemoPage.
 *
 * The production component is mounted in real Chrome from scripts/qa/fixtures/
 * judge-demo-history-fixture.html, with Convex hooks served as a fixed in-memory fixture at the
 * Vite dependency boundary. The page's real React effect, 1 s `setInterval`, cleanup and history
 * rendering run unchanged. No Convex deployment, run, payment or stored row is touched.
 *
 * It covers the states the live history cannot contain without a write:
 *   - paid pay apps with no change-order invoice stay "Pay apps paid · Owner payment open" in both
 *     the selector and the selected detail, no matter how far the clock advances;
 *   - the exact one-hour boundary (in progress at createdAt + 3600000, abandoned at +3600001) for
 *     every time-limited fixture run, with completed, owner-open and different runs selected;
 *   - interval start, callback progress and cleanup to zero after the last time-limited entry;
 *   - toggle on/off by real click, descending createdAt order and direct abandoned selection;
 *   - completed runs keep a fixed createdAt-to-invoicedAt duration.
 */
import fs from "node:fs";
import path from "node:path";
import { delay, launchBrowser, REPO_ROOT } from "./lib.mjs";
import { captureEvidenceScreenshot, maskEmailsInPage, writeEvidenceJson } from "./evidence-privacy.mjs";
import { installClock, readClockAudit, setFakeNow } from "./judge-demo-clock.mjs";

const site = process.env.REM_BASE_URL || "http://localhost:3150";
const outDir = process.env.REM_EVIDENCE_DIR
  ? path.join(process.env.REM_EVIDENCE_DIR, "mounted-fixture")
  : path.join(REPO_ROOT, "evidence", "submission-amendment-mounted-2026-11-11");
const HOUR = 3_600_000;
const RUN_SELECT = 'select[aria-label="Demo run"]';
fs.mkdirSync(outDir, { recursive: true });

const ANCHOR = Date.UTC(2026, 10, 11, 12, 0, 0);
const runs = [
  { runId: "fixture-complete", agreementNumber: "A401-DEMO-PAY-FIXTURE-C", createdAt: ANCHOR - 4 * HOUR, payAppsPaid: true, ownerPaid: true },
  { runId: "fixture-owner-open", agreementNumber: "A401-DEMO-PAY-FIXTURE-O", createdAt: ANCHOR - 6 * HOUR, payAppsPaid: true, ownerPaid: false },
  { runId: "fixture-old", agreementNumber: "A401-DEMO-PAY-FIXTURE-OLD", createdAt: ANCHOR - 3 * HOUR, payAppsPaid: false, ownerPaid: false },
  { runId: "fixture-fresh-1", agreementNumber: "A401-DEMO-PAY-FIXTURE-F1", createdAt: ANCHOR - 30 * 60_000, payAppsPaid: false, ownerPaid: false },
  { runId: "fixture-fresh-2", agreementNumber: "A401-DEMO-PAY-FIXTURE-F2", createdAt: ANCHOR - 20 * 60_000, payAppsPaid: false, ownerPaid: false },
  { runId: "fixture-fresh-3", agreementNumber: "A401-DEMO-PAY-FIXTURE-F3", createdAt: ANCHOR - 10 * 60_000, payAppsPaid: false, ownerPaid: false },
];
const complete = runs[0];
const fixture = {
  selectedRunId: null,
  runs,
  queries: {
    "payments/ledger:getAgreementLedger": null,
    "payApps/proposals:listInbox": [],
    "dashboard/queries:getDashboardData": null,
  },
  changeOrdersByProject: {
    [`project-${complete.runId}`]: {
      prime: {
        changeOrders: [{
          _id: "fixture-change-order",
          status: "paid",
          invoicedAt: complete.createdAt + 252_000,
          amountCents: 185_000,
          label: "Fixture change order",
          payerViewUrl: "https://example.invalid/payer",
        }],
      },
    },
  },
};

// Served in place of Vite's pre-bundled `convex/react`. It is deliberately plain: the fixture data
// is static, and the page's own state/interval drives every re-render.
const CONVEX_REACT_MOCK = `
const NAME = Symbol.for("functionName");
function fixture() { return window.__judgeDemoFixture || { runs: [], queries: {} }; }
function view(r) {
  if (!r) return null;
  return {
    _id: r.runId,
    agreementId: "agreement-" + r.runId,
    agreementNumber: r.agreementNumber,
    agreementStatus: "generated",
    contractorId: null,
    honestPayAppId: null,
    agentPayAppId: null,
    projectId: "project-" + r.runId,
    changeOrderId: null,
    createdAt: r.createdAt,
    readOnlyReference: false,
  };
}
function value(name, args) {
  const f = fixture();
  if (name === "judgeDemo/runs:listRuns") return f.runs;
  if (name === "judgeDemo/runs:getRun") {
    return view(f.runs.find((r) => r.runId === f.selectedRunId) ?? f.runs[0] ?? null);
  }
  if (name === "judgeDemo/runs:getRunByPath") {
    return view(f.runs.find((r) => r.runId === args.runId) ?? null);
  }
  if (name === "billing/changeOrders:listForProject") {
    return (f.changeOrdersByProject && f.changeOrdersByProject[args.projectId]) || { prime: { changeOrders: [] } };
  }
  return f.queries[name];
}
export function useQuery(ref, args) {
  if (args === "skip") return undefined;
  return value(ref && ref[NAME], args);
}
export function useQueries() { return {}; }
export function usePaginatedQuery() { return { results: [], status: "Exhausted", loadMore: () => {} }; }
export function useAction() { return async () => undefined; }
export function useMutation() { return async () => undefined; }
export function useConvex() { return { query: async () => undefined, mutation: async () => undefined, action: async () => undefined }; }
export function useConvexAuth() { return { isLoading: false, isAuthenticated: true }; }
export function useConvexConnectionState() { return { isWebSocketConnected: true, hasEverConnected: true, connectionCount: 1, connectionRetries: 0, inflightMutations: 0, inflightActions: 0, timeOfOldestInflightRequest: null }; }
export function useSubscription() {}
export function ConvexProvider({ children }) { return children; }
export function ConvexProviderWithAuth({ children }) { return children; }
export class ConvexReactClient { constructor() {} }
`;

const result = {
  generatedAt: new Date().toISOString(),
  target: `${site}/scripts/qa/fixtures/judge-demo-history-fixture.html`,
  readOnly: true,
  writes: [],
  fixtureOnly: true,
  fixtureRuns: runs,
  limitations: [
    "This mount uses fixed in-memory Convex hook fixtures, not live records. It exists to cover the no-invoice owner-open, exact-boundary and interval-cleanup states that must never be created on the deployment.",
    "The production JudgeDemoPage component, its React effect, its shared clock and its cleanup are unmodified; only the Convex hook results are fixtures.",
  ],
  checks: [],
  steps: [],
  states: {},
  widths: {},
  pageErrors: [],
  consoleErrors: [],
};

const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
};

async function readHistory(page) {
  return page.evaluate((selector) => {
    const select = document.querySelector(selector);
    const toggle = document.querySelector('[data-testid="judge-demo-abandoned-toggle"]');
    const checkbox = toggle ? toggle.querySelector('input[type="checkbox"]') : null;
    const elapsed = document.querySelector('[data-testid="judge-demo-elapsed"]');
    const note = document.querySelector('[data-testid="judge-demo-abandoned-note"]');
    return {
      options: select ? [...select.options].map((option) => ({ value: option.value, text: option.textContent.trim() })) : [],
      selectedValue: select ? select.value : null,
      toggleText: toggle ? toggle.textContent.trim() : null,
      toggleChecked: checkbox ? checkbox.checked : null,
      togglePresent: Boolean(toggle),
      elapsedText: elapsed ? elapsed.textContent.trim() : null,
      abandonedAttr: elapsed ? elapsed.getAttribute("data-abandoned") : null,
      note: note ? note.textContent.trim().slice(0, 240) : null,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  }, RUN_SELECT);
}

function stateOfOption(text) {
  if (text.includes("Abandoned · not finished")) return "abandoned";
  if (text.includes("Complete · Owner paid")) return "complete";
  if (text.includes("Pay apps paid · Owner payment open")) return "owner_pending";
  if (text.includes("In progress")) return "in_progress";
  return "unknown";
}

const optionFor = (history, runId) => history.options.find((option) => option.value === runId) ?? null;
const abandonedCount = (history) => {
  const match = /Show (\d+) abandoned runs?/.exec(history.toggleText || "");
  return match ? Number(match[1]) : 0;
};

async function selectRun(page, run) {
  await page.select(RUN_SELECT, run.runId);
  await page.waitForFunction(
    (selector, runId) => {
      const select = document.querySelector(selector);
      return Boolean(select && select.value === runId);
    },
    { timeout: 30000 },
    RUN_SELECT,
    run.runId,
  );
  await delay(120);
}

async function waitForTick(page) {
  const before = await readClockAudit(page);
  try {
    await page.waitForFunction(
      (calls, active) => window.__qaClock.audit.clock.calls > calls || window.__qaClock.audit.clock.active.length < active,
      { timeout: 10000 },
      before.clock.calls,
      before.clock.active.length,
    );
  } catch (error) {
    const after = await readClockAudit(page);
    throw new Error(`clock tick did not advance: before=${JSON.stringify(before.clock)} after=${JSON.stringify(after.clock)} now=${after.now}`);
  }
  await delay(60);
  return readClockAudit(page);
}

const { browser } = await launchBrowser(1440, 900);
let page = null;
try {
  page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.on("pageerror", (error) => result.pageErrors.push(String(error && error.message ? error.message : error)));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/Failed to load resource|favicon|net::ERR_ABORTED/i.test(text)) return;
    result.consoleErrors.push(text);
  });
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    if (request.url().includes("/node_modules/.vite/deps/convex_react.js")) {
      await request.respond({ status: 200, contentType: "application/javascript", body: CONVEX_REACT_MOCK });
      return;
    }
    await request.continue();
  });

  await installClock(page, ANCHOR, { frozen: true });
  await page.evaluateOnNewDocument((payload) => {
    window.__judgeDemoFixture = payload;
  }, { ...fixture, selectedRunId: null });
  await page.goto(`${site}/scripts/qa/fixtures/judge-demo-history-fixture.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="judge-demo-page"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="judge-demo-run"]', { timeout: 60000 });
  await page.waitForFunction(
    (selector) => {
      const select = document.querySelector(selector);
      return Boolean(select && select.options.length >= 5);
    },
    { timeout: 30000 },
    RUN_SELECT,
  );
  await delay(500);

  let history = await readHistory(page);
  result.states.initial = history;
  const old = runs.find((run) => run.runId === "fixture-old");
  check("the fixture history excludes only the already-abandoned run by default", history.options.length === 5 && optionFor(history, old.runId) === null, JSON.stringify(history.options.map((option) => option.text)));
  check("the counted toggle names the one abandoned fixture run", /Show 1 abandoned run /.test(history.toggleText || ""), history.toggleText);
  check("the completed fixture run keeps its fixed duration", history.elapsedText === "Finished in 4:12 (start to change-order invoice)", history.elapsedText);

  // Paid pay apps without an invoice: owner-payment-open in both selector and detail.
  const ownerOpen = runs.find((run) => run.runId === "fixture-owner-open");
  await selectRun(page, ownerOpen);
  history = await readHistory(page);
  result.states.ownerOpenNoInvoice = history;
  check(
    "paid pay apps without an invoice read owner-payment-open in the selector",
    stateOfOption(optionFor(history, ownerOpen.runId)?.text || "") === "owner_pending",
    JSON.stringify(optionFor(history, ownerOpen.runId)),
  );
  check(
    "paid pay apps without an invoice read owner-payment-open in the detail, never abandoned",
    history.elapsedText === "Pay apps paid · Owner payment open" && history.abandonedAttr !== "true" && !history.note && !/Finished in|Elapsed|Abandoned/.test(history.elapsedText || ""),
    JSON.stringify(history.elapsedText),
  );

  // Exact one-hour boundary walk for all three time-limited fixture runs.
  const timeLimited = runs.filter((run) => !run.payAppsPaid && !run.ownerPaid && run.runId !== old.runId).sort((a, b) => a.createdAt - b.createdAt);
  const selections = [
    { run: runs.find((run) => run.runId === "fixture-complete"), why: "a completed run is selected" },
    { run: ownerOpen, why: "the no-invoice owner-open run is selected" },
    { run: timeLimited[2], why: "the last time-limited run is selected when it crosses" },
  ];
  for (let index = 0; index < timeLimited.length; index += 1) {
    const target = timeLimited[index];
    await selectRun(page, selections[index].run);
    const before = await readHistory(page);
    await setFakeNow(page, target.createdAt + HOUR);
    let audit = await waitForTick(page);
    let state = await readHistory(page);
    const atBoundary = optionFor(state, target.runId);
    check(
      `fixture step ${index + 1}: ${target.agreementNumber} is In progress at exactly one hour`,
      atBoundary !== null && stateOfOption(atBoundary.text) === "in_progress",
      JSON.stringify(atBoundary),
    );
    check(
      `fixture step ${index + 1}: the abandoned count is unchanged at the exact boundary`,
      abandonedCount(state) === index + 1,
      `${abandonedCount(state)} vs ${index + 1}`,
    );
    await setFakeNow(page, target.createdAt + HOUR + 1);
    audit = await waitForTick(page);
    state = await readHistory(page);
    let crossed = optionFor(state, target.runId);
    if (crossed === null) {
      await page.click('[data-testid="judge-demo-abandoned-toggle"] input[type="checkbox"]');
      await delay(150);
      crossed = optionFor(await readHistory(page), target.runId);
      await page.click('[data-testid="judge-demo-abandoned-toggle"] input[type="checkbox"]');
      await delay(150);
      state = await readHistory(page);
    }
    check(
      `fixture step ${index + 1}: ${target.agreementNumber} is Abandoned one millisecond past the hour`,
      crossed !== null && stateOfOption(crossed.text) === "abandoned",
      JSON.stringify(crossed),
    );
    check(
      `fixture step ${index + 1}: the abandoned count grows by one`,
      abandonedCount(state) === index + 2,
      `${abandonedCount(state)} vs ${index + 2}`,
    );
    if (selections[index].run.ownerPaid) {
      check(
        `fixture step ${index + 1}: the selected completed run keeps its fixed duration`,
        state.elapsedText === "Finished in 4:12 (start to change-order invoice)",
        state.elapsedText,
      );
    }
    if (selections[index].run.runId === ownerOpen.runId) {
      check(
        `fixture step ${index + 1}: the no-invoice owner-open detail never flips to abandoned`,
        state.elapsedText === "Pay apps paid · Owner payment open" && state.abandonedAttr !== "true",
        state.elapsedText,
      );
    }
    if (selections[index].run.runId === target.runId) {
      check(
        `fixture step ${index + 1}: the crossing selected run freezes as abandoned`,
        state.abandonedAttr === "true" && /Abandoned/.test(state.elapsedText || "") && Boolean(state.note),
        JSON.stringify(state.elapsedText),
      );
    }
    result.steps.push({
      target: { runId: target.runId, agreementNumber: target.agreementNumber, createdAt: target.createdAt },
      selection: { runId: selections[index].run.runId, why: selections[index].why },
      selectedBefore: before.elapsedText,
      atBoundary: atBoundary ? atBoundary.text : null,
      oneMillisecondPast: crossed ? crossed.text : null,
      toggleCount: abandonedCount(state),
      clock: { created: audit.clock.created.length, cleared: audit.clock.cleared.length, active: audit.clock.active.length, calls: audit.clock.calls },
    });
  }

  // Cleanup after the last time-limited entry.
  await page.waitForFunction(() => window.__qaClock.audit.clock.active.length === 0, { timeout: 10000 });
  const stopped = await readClockAudit(page);
  await delay(500);
  const stillStopped = await readClockAudit(page);
  result.cleanup = {
    activeIntervals: stopped.clock.active.length,
    created: stopped.clock.created.length,
    cleared: stopped.clock.cleared.length,
    callsAtStop: stopped.clock.calls,
    callsAfterWait: stillStopped.clock.calls,
    createdAfterWait: stillStopped.clock.created.length,
    intervals: stopped.clock.created,
  };
  check("the fixture page clears the shared interval after the final transition", stopped.clock.active.length === 0, JSON.stringify(stopped.clock));
  check("fixture callbacks stop", stillStopped.clock.calls === stopped.clock.calls, `${stillStopped.clock.calls} vs ${stopped.clock.calls}`);
  check("no fixture replacement interval starts", stillStopped.clock.created.length === stopped.clock.created.length, `${stillStopped.clock.created.length} vs ${stopped.clock.created.length}`);
  history = await readHistory(page);
  result.states.allAbandoned = history;
  check("the fixture toggle counts all four abandoned runs", /Show 4 abandoned runs/.test(history.toggleText || ""), history.toggleText);
  check(
    "the fixture default list is the two clock-independent runs plus the selected crossing run",
    history.options.length === 3 &&
      stateOfOption(optionFor(history, "fixture-complete")?.text || "") === "complete" &&
      stateOfOption(optionFor(history, "fixture-owner-open")?.text || "") === "owner_pending" &&
      stateOfOption(optionFor(history, "fixture-fresh-3")?.text || "") === "abandoned" &&
      history.options.filter((option) => stateOfOption(option.text) === "abandoned").length === 1,
    JSON.stringify(history.options.map((option) => option.text)),
  );

  // The no-invoice owner-open state is indefinite, even far past every abandonment threshold.
  await setFakeNow(page, ANCHOR + 30 * 24 * HOUR);
  await selectRun(page, ownerOpen);
  const ownerOpenLater = await readHistory(page);
  result.states.ownerOpenNoInvoiceLater = ownerOpenLater;
  check(
    "owner-open without an invoice stays owner-open far past the hour",
    ownerOpenLater.elapsedText === "Pay apps paid · Owner payment open" && ownerOpenLater.abandonedAttr !== "true" && !ownerOpenLater.note,
    JSON.stringify(ownerOpenLater.elapsedText),
  );

  // Real mouse toggle interaction, then direct abandoned selection with the toggle off.
  await page.click('[data-testid="judge-demo-abandoned-toggle"] input[type="checkbox"]');
  await delay(250);
  history = await readHistory(page);
  result.states.toggleOn = history;
  check(
    "fixture toggle on restores all four abandoned runs with the abandoned label",
    history.toggleChecked === true &&
      history.options.filter((option) => stateOfOption(option.text) === "abandoned").length === 4 &&
      ["fixture-old", "fixture-fresh-1", "fixture-fresh-2", "fixture-fresh-3"].every((runId) => stateOfOption(optionFor(history, runId)?.text || "") === "abandoned"),
    JSON.stringify(history.options.map((option) => option.text)),
  );
  const stamps = history.options.map((option) => runs.find((run) => run.runId === option.value)?.createdAt ?? 0);
  check("fixture shown options are in descending createdAt order", stamps.every((stamp, index) => index === 0 || stamp <= stamps[index - 1]), JSON.stringify(stamps));
  await maskEmailsInPage(page);
  result.widths["1440-toggle-on"] = {
    history: result.states.toggleOn,
    file: await captureEvidenceScreenshot(page, path.join(outDir, "fixture-history-toggle-on-1440.png"), { fullPage: true }),
  };

  await page.click('[data-testid="judge-demo-abandoned-toggle"] input[type="checkbox"]');
  await delay(250);
  history = await readHistory(page);
  result.states.toggleOff = history;
  check("fixture toggle off removes abandoned runs again", history.toggleChecked === false && history.options.every((option) => stateOfOption(option.text) !== "abandoned"));

  await page.evaluate((runId) => {
    window.location.hash = `#/judge-demo/${encodeURIComponent(runId)}`;
  }, "fixture-fresh-1");
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.value === "fixture-fresh-1",
    { timeout: 30000 },
    RUN_SELECT,
  );
  await delay(150);
  history = await readHistory(page);
  result.states.directAbandoned = history;
  check("fixture direct abandoned selection stays in the selector", history.selectedValue === "fixture-fresh-1" && Boolean(optionFor(history, "fixture-fresh-1")), JSON.stringify(history.options.map((option) => option.text)));
  check("fixture direct abandoned detail is frozen and explained", history.abandonedAttr === "true" && /Abandoned/.test(history.elapsedText || "") && Boolean(history.note) && !/Elapsed/.test(history.elapsedText || ""), JSON.stringify(history.elapsedText));
  const directAudit = await readClockAudit(page);
  await delay(250);
  const directAuditLater = await readClockAudit(page);
  check("fixture direct abandoned selection starts no timer", directAudit.clock.active.length === 0 && directAuditLater.clock.created.length === directAudit.clock.created.length);
  await maskEmailsInPage(page);
  result.widths["1440-direct-abandoned"] = {
    history: result.states.directAbandoned,
    file: await captureEvidenceScreenshot(page, path.join(outDir, "fixture-history-direct-abandoned-1440.png"), { fullPage: true }),
  };

  // Both-width evidence.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await delay(300);
  await page.evaluate(() => {
    window.location.hash = "#/judge-demo";
  });
  await page.waitForSelector('[data-testid="judge-demo-run"]', { timeout: 30000 });
  await delay(300);
  history = await readHistory(page);
  result.widths["390-default"] = { history, file: null };
  check("fixture has no horizontal overflow at 390", history.scrollWidth <= history.clientWidth, `${history.scrollWidth}/${history.clientWidth}`);
  await maskEmailsInPage(page);
  result.widths["390-default"].file = await captureEvidenceScreenshot(page, path.join(outDir, "fixture-history-390.png"), { fullPage: true });
  if (history.togglePresent) {
    await page.click('[data-testid="judge-demo-abandoned-toggle"] input[type="checkbox"]');
    await delay(250);
    const shown = await readHistory(page);
    result.widths["390-toggle-on"] = { history: shown, file: null };
    check("fixture has no horizontal overflow at 390 with abandoned runs shown", shown.scrollWidth <= shown.clientWidth, `${shown.scrollWidth}/${shown.clientWidth}`);
    await maskEmailsInPage(page);
    result.widths["390-toggle-on"].file = await captureEvidenceScreenshot(page, path.join(outDir, "fixture-history-toggle-on-390.png"), { fullPage: true });
  }

  result.ok = result.checks.every((entry) => entry.ok) && result.pageErrors.length === 0 && result.consoleErrors.length === 0;
  writeEvidenceJson(path.join(outDir, "fixture-report.json"), result, "mounted guided-history fixture report");
  console.log(JSON.stringify({
    ok: result.ok,
    checks: result.checks.length,
    failed: result.checks.filter((entry) => !entry.ok).length,
    pageErrors: result.pageErrors.length,
    consoleErrors: result.consoleErrors.length,
    steps: result.steps.length,
    cleanup: result.cleanup,
    report: path.join(outDir, "fixture-report.json"),
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  result.ok = false;
  result.error = String(error && error.message ? error.message : error);
  writeEvidenceJson(path.join(outDir, "fixture-report.json"), result, "mounted guided-history fixture failure");
  console.error(JSON.stringify({ ok: false, error: result.error, checks: result.checks.length }, null, 2));
  process.exitCode = 1;
} finally {
  if (page) await page.close().catch(() => undefined);
  await browser.close();
}
