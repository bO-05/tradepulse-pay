/**
 * Mounted guided-history regression against the real app, real records and a controllable clock.
 *
 * No DOM test library is installed and none is approved, so this harness mounts the production
 * `JudgeDemoPage` in real Chrome and drives the actual React interval effect:
 *
 *  1. Sign in as the demo GC and read the existing 20 guided runs (query-only; no run is created).
 *  2. Freeze `Date.now` just after the oldest run starts, so every unfinished entry is still
 *     "In progress" while the page is mounted - not an already-aged render.
 *  3. Advance the frozen clock to each unfinished run's exact one-hour boundary, then one
 *     millisecond past it, waiting for the page's own 1 s interval to commit each render.
 *  4. Assert the entry stays "In progress" at exactly one hour and becomes "Abandoned · not
 *     finished" at 1 ms past it, with the counted toggle growing, while completed, owner-open and
 *     different in-progress runs stay selected across the walk.
 *  5. After the last time-limited entry transitions, assert the shared 1 s interval is cleared, no
 *     new one is created and its callbacks stop.
 *  6. Drive the abandoned toggle on and off with real mouse clicks, select an abandoned run
 *     directly by hash, and confirm the completed fixed duration and owner-open labels never
 *     contradict the selector.
 *
 * Reports and screenshots go to the gitignored evidence/ tree and pass the shared fail-closed email
 * masking. Read-only: the only network reads are the signed-in listRuns query and the page's own
 * queries. Nothing is written to Convex.
 */
import fs from "node:fs";
import path from "node:path";
import { delay, launchBrowser, REPO_ROOT } from "./lib.mjs";
import { captureEvidenceScreenshot, maskEmailsInPage, writeEvidenceJson } from "./evidence-privacy.mjs";
import { freezeClock, installClock, readClockAudit, setFakeNow, waitForClockCalls } from "./judge-demo-clock.mjs";

const site = process.env.REM_BASE_URL || "http://localhost:3150";
const outDir = process.env.REM_EVIDENCE_DIR
  ? path.join(process.env.REM_EVIDENCE_DIR, "mounted-history")
  : path.join(REPO_ROOT, "evidence", "submission-amendment-mounted-2026-11-11");
const HOUR = 3_600_000;
const RUN_SELECT = 'select[aria-label="Demo run"]';
fs.mkdirSync(outDir, { recursive: true });

const result = {
  generatedAt: new Date().toISOString(),
  target: site,
  readOnly: true,
  writes: [],
  limitations: [
    "The exact one-hour boundary is proven against existing records by freezing Date.now at createdAt + 3600000 and then + 3600001 ms; no run row is created or edited.",
    "Paid-pay-apps-without-invoice and completed-duration fixtures are covered by judge-demo-fixture-browser.mjs because the live history has no owner-open run without an invoice.",
    "Persisted measurements are read after the shared fail-closed email mask.",
  ],
  clockWalk: { steps: [], boundary: null, cleanup: null },
  history: {},
  widths: {},
  pageErrors: [],
  consoleErrors: [],
};

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
};

function readConvexUrl() {
  const file = path.join(REPO_ROOT, ".env.local");
  const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((entry) => entry.startsWith("VITE_CONVEX_URL="));
  if (!line) throw new Error("VITE_CONVEX_URL is missing from .env.local");
  return line.slice("VITE_CONVEX_URL=".length).trim();
}

const convexUrl = process.env.QA_CONVEX_URL || readConvexUrl();

async function fetchRuns(page) {
  return page.evaluate(async (url) => {
    const key = Object.keys(window.localStorage).find((entry) => entry.startsWith("__convexAuthJWT"));
    if (!key) throw new Error("no signed-in Convex Auth token");
    const jwt = window.localStorage.getItem(key);
    const response = await fetch(`${url}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ path: "judgeDemo/runs:listRuns", args: {}, format: "json" }),
    });
    if (!response.ok) throw new Error(`listRuns HTTP ${response.status}`);
    const body = await response.json();
    if (body.status !== "success" || !Array.isArray(body.value)) throw new Error("listRuns returned no value");
    return body.value;
  }, convexUrl);
}

async function readHistory(page) {
  return page.evaluate((selector) => {
    const select = document.querySelector(selector);
    const toggle = document.querySelector('[data-testid="judge-demo-abandoned-toggle"]');
    const checkbox = toggle ? toggle.querySelector('input[type="checkbox"]') : null;
    const elapsed = document.querySelector('[data-testid="judge-demo-elapsed"]');
    const run = document.querySelector('[data-testid="judge-demo-run"]');
    const note = document.querySelector('[data-testid="judge-demo-abandoned-note"]');
    return {
      options: select ? [...select.options].map((option) => ({ value: option.value, text: option.textContent.trim() })) : [],
      selectedValue: select ? select.value : null,
      disabled: select ? select.disabled : null,
      toggleText: toggle ? toggle.textContent.trim() : null,
      toggleChecked: checkbox ? checkbox.checked : null,
      togglePresent: Boolean(toggle),
      elapsedText: elapsed ? elapsed.textContent.trim() : null,
      abandonedAttr: elapsed ? elapsed.getAttribute("data-abandoned") : null,
      agreementText: run ? run.textContent.trim().slice(0, 200) : null,
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

function optionFor(history, runId) {
  return history.options.find((option) => option.value === runId) ?? null;
}

function abandonedCount(history) {
  const match = /Show (\d+) abandoned runs?/.exec(history.toggleText || "");
  return match ? Number(match[1]) : 0;
}

async function selectRun(page, run, { direct = false } = {}) {
  if (direct) {
    await page.evaluate((runId) => {
      window.location.hash = `#/judge-demo/${encodeURIComponent(runId)}`;
    }, run.runId);
  } else {
    await page.select(RUN_SELECT, run.runId);
  }
  await page.waitForFunction(
    (selector, runId, agreementNumber) => {
      const select = document.querySelector(selector);
      const link = document.querySelector('[data-testid="judge-demo-agreement"]');
      return Boolean(select && select.value === runId && link && link.textContent.trim() === agreementNumber);
    },
    { timeout: 60000 },
    RUN_SELECT,
    run.runId,
    run.agreementNumber,
  );
  await delay(120);
}

async function waitForFinishedDuration(page) {
  await page.waitForFunction(
    () => /Finished in \d+:\d{2} \(start to change-order invoice\)/.test(document.querySelector('[data-testid="judge-demo-elapsed"]')?.textContent || ""),
    { timeout: 60000 },
  );
}

async function waitForTick(page) {
  const before = await readClockAudit(page);
  // A normal tick needs two callbacks. The final transition clears the interval after one callback,
  // so accept either the callback count moving or the cleanup taking the active interval to zero.
  await page.waitForFunction(
    (calls, active) => window.__qaClock.audit.clock.calls > calls || window.__qaClock.audit.clock.active.length < active,
    { timeout: 10000 },
    before.clock.calls,
    before.clock.active.length,
  );
  await delay(60);
  return readClockAudit(page);
}

/** Freezes the clock before the judge-demo route mounts, then advances through each threshold. */
async function walkThresholds(page, runs, unfinished) {
  const completed = runs.filter((run) => run.ownerPaid);
  const ownerOpen = runs.filter((run) => run.payAppsPaid && !run.ownerPaid);
  const stepPlan = (index) => {
    if (index === 0) return { kind: "select", run: completed[0], why: "a completed run is selected" };
    if (index === 1) return { kind: "select", run: ownerOpen[0], why: "an owner-payment-open run is selected" };
    if (index === 2) return { kind: "select", run: unfinished[index + 1], why: "a different in-progress run is selected" };
    if (index === 3) return { kind: "select", run: unfinished[index], why: "the crossing run itself is selected" };
    if (index % 2 === 0) {
      const prior = unfinished[index - 4] ?? unfinished[0];
      return { kind: "direct", run: prior, why: "an already-abandoned run is selected directly" };
    }
    return { kind: "select", run: (index % 4 === 1 ? completed : ownerOpen)[0], why: "a clock-independent run is selected" };
  };

  await selectRun(page, completed[0]);
  await waitForFinishedDuration(page);
  const completeDuration = (await readHistory(page)).elapsedText;

  for (let index = 0; index < unfinished.length; index += 1) {
    const target = unfinished[index];
    const plan = stepPlan(index);
    await selectRun(page, plan.run, { direct: plan.kind === "direct" });
    if (plan.run.ownerPaid) await waitForFinishedDuration(page);
    const selectedBefore = await readHistory(page);

    // Exactly the one-hour boundary: still in progress, strictly-more-than-one-hour rule.
    await setFakeNow(page, target.createdAt + HOUR);
    let audit = await waitForTick(page);
    let history = await readHistory(page);
    const boundaryOption = optionFor(history, target.runId);
    check(
      `step ${index + 1}: ${target.agreementNumber} is still In progress at exactly one hour`,
      boundaryOption !== null && stateOfOption(boundaryOption.text) === "in_progress",
      JSON.stringify(boundaryOption),
    );
    check(
      `step ${index + 1}: the counted toggle is unchanged at the exact boundary`,
      abandonedCount(history) === index,
      `${abandonedCount(history)} vs ${index}`,
    );

    // One millisecond past the boundary: abandoned, hidden from the default list, count grows.
    await setFakeNow(page, target.createdAt + HOUR + 1);
    audit = await waitForTick(page);
    history = await readHistory(page);
    let crossed = optionFor(history, target.runId);
    if (crossed === null) {
      // Prove the hidden entry itself now reads abandoned by briefly showing the counted group.
      await page.click('[data-testid="judge-demo-abandoned-toggle"] input[type="checkbox"]');
      await delay(150);
      crossed = optionFor(await readHistory(page), target.runId);
      await page.click('[data-testid="judge-demo-abandoned-toggle"] input[type="checkbox"]');
      await delay(150);
      history = await readHistory(page);
    }
    check(
      `step ${index + 1}: ${target.agreementNumber} is Abandoned at one hour plus one millisecond`,
      crossed !== null && stateOfOption(crossed.text) === "abandoned",
      JSON.stringify(crossed),
    );
    if (plan.run.runId === target.runId) {
      check(
        `step ${index + 1}: the selected run shows the frozen abandoned detail`,
        history.abandonedAttr === "true" && /Abandoned/.test(history.elapsedText || "") && Boolean(history.note),
        JSON.stringify(history.elapsedText),
      );
    }
    check(
      `step ${index + 1}: the counted toggle grows by exactly one`,
      abandonedCount(history) === index + 1,
      `${abandonedCount(history)} vs ${index + 1}`,
    );
    check(
      `step ${index + 1}: the abandoned entry leaves the default list unless it is selected`,
      (optionFor(history, target.runId) !== null) === (plan.run.runId === target.runId),
      JSON.stringify(history.options.map((option) => option.text)),
    );
    if (plan.run.ownerPaid) {
      check(
        `step ${index + 1}: the completed selection keeps its fixed duration`,
        history.elapsedText === completeDuration,
        `${history.elapsedText} vs ${completeDuration}`,
      );
    }
    if (plan.run.payAppsPaid && !plan.run.ownerPaid) {
      check(
        `step ${index + 1}: the owner-open selection never reads abandoned`,
        /Owner payment open/.test(history.elapsedText || "") && history.abandonedAttr !== "true" && !history.note,
        JSON.stringify(history.elapsedText),
      );
    }
    if (plan.kind === "direct") {
      // Older guided runs are read-only demo fixtures by design, so the explanatory note is
      // intentionally omitted for them; the frozen abandoned detail is still required.
      check(
        `step ${index + 1}: the directly selected abandoned run stays frozen`,
        history.abandonedAttr === "true" && /Abandoned/.test(history.elapsedText || "") && !/Elapsed/.test(history.elapsedText || ""),
        JSON.stringify(history.elapsedText),
      );
    } else if (!plan.run.ownerPaid && !plan.run.payAppsPaid && plan.run.runId !== target.runId) {
      check(
        `step ${index + 1}: the different in-progress selection keeps counting`,
        /^Elapsed /.test(history.elapsedText || "") && history.abandonedAttr !== "true",
        JSON.stringify(history.elapsedText),
      );
    }

    result.clockWalk.steps.push({
      index,
      target: { runId: target.runId, agreementNumber: target.agreementNumber, createdAt: target.createdAt },
      selection: { runId: plan.run.runId, agreementNumber: plan.run.agreementNumber, why: plan.why },
      selectedBefore: selectedBefore.selectedValue,
      boundaryLabel: boundaryOption ? boundaryOption.text : null,
      crossedLabel: crossed ? crossed.text : null,
      toggleCountAfter: abandonedCount(history),
      clock: { created: audit.clock.created.length, cleared: audit.clock.cleared.length, active: audit.clock.active.length, calls: audit.clock.calls },
      elapsedAfter: history.elapsedText,
    });
    if (index === 0) {
      result.clockWalk.boundary = {
        runId: target.runId,
        agreementNumber: target.agreementNumber,
        createdAt: target.createdAt,
        atBoundary: boundaryOption ? boundaryOption.text : null,
        oneMillisecondPast: crossed ? crossed.text : null,
      };
    }
  }
  return completeDuration;
}

const { browser } = await launchBrowser(1440, 900);
let page = null;
try {
  const context = await browser.createBrowserContext();
  page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on("pageerror", (error) => result.pageErrors.push(String(error && error.message ? error.message : error)));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/Failed to load resource|favicon|net::ERR_ABORTED/i.test(text)) return;
    result.consoleErrors.push(text);
  });

  // Live clock during sign-in so Convex Auth and the query client keep normal wall-clock time.
  await installClock(page);
  await page.goto(`${site}/#/demo`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="demo-enter-gc"]', { timeout: 60000 });
  await page.click('[data-testid="demo-enter-gc"]');
  await page.waitForFunction(
    () => document.body.innerText.includes("Bayview Remodeling") && !document.body.innerText.includes("Connecting to Convex reactive backend"),
    { timeout: 60000 },
  );
  await delay(1200);

  const baselineRuns = await fetchRuns(page);
  result.history.baseline = baselineRuns.map(({ runId, agreementNumber, createdAt, payAppsPaid, ownerPaid }) => ({ runId, agreementNumber, createdAt, payAppsPaid, ownerPaid }));
  check("the demo GC has the existing 20 guided runs", baselineRuns.length === 20, String(baselineRuns.length));
  const unfinished = baselineRuns.filter((run) => !run.payAppsPaid && !run.ownerPaid).sort((a, b) => a.createdAt - b.createdAt);
  const completed = baselineRuns.filter((run) => run.ownerPaid);
  const ownerOpen = baselineRuns.filter((run) => run.payAppsPaid && !run.ownerPaid);
  check("existing history has unfinished, completed and owner-open runs", unfinished.length > 0 && completed.length > 0 && ownerOpen.length > 0, `${unfinished.length}/${completed.length}/${ownerOpen.length}`);
  const run20 = baselineRuns.find((run) => run.runId === "nx753t1t92fqkqaa0cm7d68yhx8hyknj");
  check("run -20 is present and still has zero paid pay apps and no paid owner", Boolean(run20) && run20.payAppsPaid === false && run20.ownerPaid === false, JSON.stringify(run20));
  check("run -20 is A401-DEMO-PAY-20261110-20 created at 2026-11-10T11:33:45.932Z", run20?.agreementNumber === "A401-DEMO-PAY-20261110-20" && run20?.createdAt === 1794310425932, JSON.stringify(run20));
  result.history.run20 = run20;

  // Mount while the oldest unfinished run is only five minutes old: every unfinished entry is
  // in progress on the first render, so the walk advances a live page rather than re-rendering it.
  const anchor = Math.min(...baselineRuns.map((run) => run.createdAt)) + 5 * 60_000;
  await freezeClock(page, anchor);
  result.clockWalk.anchor = { epochMs: anchor, iso: new Date(anchor).toISOString() };
  await page.evaluate(() => {
    window.location.hash = "#/judge-demo";
  });
  await page.waitForSelector('[data-testid="judge-demo-page"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="judge-demo-run"]', { timeout: 60000 });
  await page.waitForFunction(
    (selector, expected) => {
      const select = document.querySelector(selector);
      return Boolean(select && select.options.length === expected);
    },
    { timeout: 60000 },
    RUN_SELECT,
    baselineRuns.length,
  );
  await delay(600);

  let history = await readHistory(page);
  result.history.initial = history;
  check("all 20 runs are listed while nothing is abandoned", history.options.length === 20, String(history.options.length));
  check("no abandoned toggle is needed before any entry ages out", history.togglePresent === false, JSON.stringify(history.toggleText));
  check("every unfinished entry renders In progress", unfinished.every((run) => stateOfOption(optionFor(history, run.runId)?.text || "") === "in_progress"));
  check("completed entries render Complete · Owner paid", completed.every((run) => stateOfOption(optionFor(history, run.runId)?.text || "") === "complete"));
  check("paid-pay-apps entries render Owner payment open", ownerOpen.every((run) => stateOfOption(optionFor(history, run.runId)?.text || "") === "owner_pending"));
  await maskEmailsInPage(page);
  result.widths["1440-initial"] = { file: await captureEvidenceScreenshot(page, path.join(outDir, "guided-history-mounted-initial-1440.png"), { fullPage: true }) };

  // Live counting on a mounted page: the earliest unfinished run's elapsed text advances.
  const earliest = unfinished[0];
  await selectRun(page, earliest);
  const elapsedBefore = await readHistory(page);
  const callsBefore = (await readClockAudit(page)).clock.calls;
  await setFakeNow(page, anchor + 65_000);
  const afterAdvance = await waitForClockCalls(page, callsBefore, 2);
  const elapsedAfter = await readHistory(page);
  result.history.liveCount = { before: elapsedBefore.elapsedText, after: elapsedAfter.elapsedText, clockCalls: afterAdvance.clock.calls };
  check("the mounted page counts elapsed time live", elapsedBefore.elapsedText === "Elapsed 5:00" && elapsedAfter.elapsedText === "Elapsed 6:05", `${elapsedBefore.elapsedText} -> ${elapsedAfter.elapsedText}`);

  // Owner-open and completed detail consistency on the existing records.
  await selectRun(page, ownerOpen[0]);
  await delay(800); // The change-order query supplies the fixed invoiced duration.
  const ownerOpenDetail = await readHistory(page);
  result.history.ownerOpenDetail = ownerOpenDetail;
  check("the owner-open selector label matches its detail", stateOfOption(optionFor(ownerOpenDetail, ownerOpen[0].runId)?.text || "") === "owner_pending" && /Owner payment open/.test(ownerOpenDetail.elapsedText || "") && ownerOpenDetail.abandonedAttr !== "true", JSON.stringify(ownerOpenDetail.elapsedText));

  const completeDuration = await walkThresholds(page, baselineRuns, unfinished);

  // After the last time-limited entry transitions, the shared clock must be gone and stay gone.
  await page.waitForFunction(() => window.__qaClock.audit.clock.active.length === 0, { timeout: 10000 });
  const stopped = await readClockAudit(page);
  await delay(500);
  const stillStopped = await readClockAudit(page);
  result.clockWalk.cleanup = {
    activeIntervals: stopped.clock.active.length,
    created: stopped.clock.created.length,
    cleared: stopped.clock.cleared.length,
    callsAtStop: stopped.clock.calls,
    callsAfterWait: stillStopped.clock.calls,
    createdAfterWait: stillStopped.clock.created.length,
  };
  check("the shared interval is cleared after the last time-limited entry", stopped.clock.active.length === 0, JSON.stringify(stopped.clock));
  check("no further callbacks run after cleanup", stillStopped.clock.calls === stopped.clock.calls, `${stillStopped.clock.calls} vs ${stopped.clock.calls}`);
  check("no replacement interval is created after cleanup", stillStopped.clock.created.length === stopped.clock.created.length, `${stillStopped.clock.created.length} vs ${stopped.clock.created.length}`);
  check("every unfinished run aged into the counted abandoned group", abandonedCount(await readHistory(page)) === unfinished.length, `${abandonedCount(await readHistory(page))} vs ${unfinished.length}`);

  history = await readHistory(page);
  result.history.allAbandoned = history;
  check("the default list keeps exactly the clock-independent runs", history.options.length === completed.length + ownerOpen.length, `${history.options.length} vs ${completed.length + ownerOpen.length}`);
  check("the default list contains no abandoned entry", history.options.every((option) => stateOfOption(option.text) !== "abandoned"));
  check("the toggle declares the plural abandoned count", /Show 14 abandoned runs/.test(history.toggleText || ""), history.toggleText);
  await maskEmailsInPage(page);
  result.widths["1440-stopped"] = { file: await captureEvidenceScreenshot(page, path.join(outDir, "guided-history-mounted-stopped-1440.png"), { fullPage: true }) };

  // Real mouse interaction: toggle on restores every abandoned run in descending createdAt order.
  await page.click('[data-testid="judge-demo-abandoned-toggle"] input[type="checkbox"]');
  await delay(250);
  history = await readHistory(page);
  result.history.toggleOn = history;
  check("toggle on shows the counted abandoned runs", history.toggleChecked === true && history.options.filter((option) => stateOfOption(option.text) === "abandoned").length === unfinished.length, JSON.stringify(history.toggleText));
  const orderedStamps = history.options.map((option) => baselineRuns.find((run) => run.runId === option.value)?.createdAt ?? 0);
  check("shown options are in descending createdAt order", orderedStamps.every((stamp, index) => index === 0 || stamp <= orderedStamps[index - 1]), JSON.stringify(orderedStamps));
  await maskEmailsInPage(page);
  result.widths["1440-toggle-on"] = { file: await captureEvidenceScreenshot(page, path.join(outDir, "guided-history-mounted-toggle-on-1440.png"), { fullPage: true }) };

  await page.click('[data-testid="judge-demo-abandoned-toggle"] input[type="checkbox"]');
  await delay(250);
  history = await readHistory(page);
  result.history.toggleOff = history;
  const serverOrderVisible = baselineRuns.filter((run) => !unfinished.some((entry) => entry.runId === run.runId)).map((run) => run.runId);
  check("toggle off removes every abandoned entry again", history.toggleChecked === false && history.options.every((option) => stateOfOption(option.text) !== "abandoned"));
  check("the default order is the server order of the remaining runs", JSON.stringify(history.options.map((option) => option.value)) === JSON.stringify(serverOrderVisible), JSON.stringify(history.options.map((option) => option.value)));

  // Direct selection of an abandoned run with the toggle off keeps it selectable and frozen.
  // Run -20 is a writable demo sandbox, so it also shows the explanatory abandoned note.
  const directAbandoned = run20;
  await selectRun(page, directAbandoned, { direct: true });
  history = await readHistory(page);
  result.history.directAbandoned = history;
  check("a direct abandoned selection is retained in the selector", history.selectedValue === directAbandoned.runId && Boolean(optionFor(history, directAbandoned.runId)), JSON.stringify(history.options.map((option) => option.text)));
  check("the direct abandoned detail is frozen and explained", history.abandonedAttr === "true" && /Abandoned/.test(history.elapsedText || "") && Boolean(history.note) && !/Elapsed/.test(history.elapsedText || ""), JSON.stringify(history.elapsedText));
  const directAudit = await readClockAudit(page);
  await delay(300);
  const directAuditLater = await readClockAudit(page);
  check("a direct abandoned selection starts no timer", directAudit.clock.active.length === 0 && directAuditLater.clock.created.length === directAudit.clock.created.length, JSON.stringify(directAudit.clock));
  await maskEmailsInPage(page);
  result.widths["1440-direct-abandoned"] = { file: await captureEvidenceScreenshot(page, path.join(outDir, "guided-history-mounted-direct-abandoned-1440.png"), { fullPage: true }) };

  // Completed duration stays fixed at the end of the walk.
  await selectRun(page, completed[0]);
  await waitForFinishedDuration(page);
  const completedAtEnd = await readHistory(page);
  check("the completed fixed duration is unchanged after the walk", completedAtEnd.elapsedText === completeDuration, `${completedAtEnd.elapsedText} vs ${completeDuration}`);
  result.history.completedAtEnd = completedAtEnd;

  // Both-width evidence on the same mounted page.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await delay(400);
  await page.evaluate(() => {
    window.location.hash = "#/judge-demo";
  });
  await page.waitForSelector('[data-testid="judge-demo-run"]', { timeout: 60000 });
  await delay(500);
  history = await readHistory(page);
  result.widths["390-default"] = { history, file: null };
  check("no horizontal page overflow at 390", history.scrollWidth <= history.clientWidth, `${history.scrollWidth}/${history.clientWidth}`);
  await maskEmailsInPage(page);
  result.widths["390-default"].file = await captureEvidenceScreenshot(page, path.join(outDir, "guided-history-mounted-390.png"), { fullPage: true });
  if (history.togglePresent) {
    await page.click('[data-testid="judge-demo-abandoned-toggle"] input[type="checkbox"]');
    await delay(250);
    const shown = await readHistory(page);
    result.widths["390-toggle-on"] = { history: shown, file: null };
    check("no horizontal page overflow at 390 with abandoned runs shown", shown.scrollWidth <= shown.clientWidth, `${shown.scrollWidth}/${shown.clientWidth}`);
    await maskEmailsInPage(page);
    result.widths["390-toggle-on"].file = await captureEvidenceScreenshot(page, path.join(outDir, "guided-history-mounted-toggle-on-390.png"), { fullPage: true });
  }

  // Read-only after-state: the same runs and the same -20 projection.
  const afterRuns = await fetchRuns(page);
  result.history.after = afterRuns;
  check("the run set is byte-identical before and after", JSON.stringify(afterRuns) === JSON.stringify(baselineRuns), `${afterRuns.length} vs ${baselineRuns.length}`);
  const afterRun20 = afterRuns.find((run) => run.runId === "nx753t1t92fqkqaa0cm7d68yhx8hyknj");
  check("run -20 is unchanged after the mounted walk", JSON.stringify(afterRun20) === JSON.stringify(run20), JSON.stringify(afterRun20));
  result.safety = {
    method: "signed-in read-only judgeDemo/runs:listRuns query before and after",
    scope: "guided-run id set and -20 projection; not a full-row or PayPal provider-ledger audit",
    judgeDemoRunsCount: afterRuns.length,
    run20: afterRun20,
    unchanged: true,
  };

  result.checks = checks;
  result.ok = checks.every((entry) => entry.ok) && result.pageErrors.length === 0 && result.consoleErrors.length === 0;
  writeEvidenceJson(path.join(outDir, "report.json"), result, "mounted guided-history report");
  console.log(JSON.stringify({
    ok: result.ok,
    checks: checks.length,
    failed: checks.filter((entry) => !entry.ok).length,
    pageErrors: result.pageErrors.length,
    consoleErrors: result.consoleErrors.length,
    steps: result.clockWalk.steps.length,
    cleanup: result.clockWalk.cleanup,
    boundary: result.clockWalk.boundary,
    report: path.join(outDir, "report.json"),
  }, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  result.checks = checks;
  result.ok = false;
  result.error = String(error && error.message ? error.message : error);
  writeEvidenceJson(path.join(outDir, "report.json"), result, "mounted guided-history failure report");
  console.error(JSON.stringify({ ok: false, error: result.error, checks: checks.length }, null, 2));
  process.exitCode = 1;
} finally {
  if (page) await page.close().catch(() => undefined);
  await browser.close();
}
