/**
 * Controllable clock + timer instrumentation for the mounted guided-history regressions.
 *
 * Installed before application code runs. The clock starts in live mode so sign-in and Convex
 * queries keep normal wall-clock behaviour, then freezes at an exact epoch millisecond for the
 * threshold walk. `Date.now` is the only clock override: timers still fire on the browser's real
 * scheduler, but every 1 s `setInterval` - the shared history clock is the only 1 s interval on the
 * page - is shortened to 25 ms and its creation, callbacks and cleanup are recorded. Other
 * intervals keep their real delay, so harness/HMR timers stay out of the accounting.
 */

const SETUP = (initial, startFrozen) => {
  const realDateNow = Date.now.bind(Date);
  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const audit = {
    mode: startFrozen ? "frozen" : "live",
    frozenAt: startFrozen ? initial : null,
    initial,
    clock: { created: [], cleared: [], active: [], calls: 0 },
    otherIntervals: 0,
  };
  let frozen = initial;
  window.__qaClock = {
    freeze(value) {
      audit.mode = "frozen";
      audit.frozenAt = value;
      frozen = value;
    },
    set(value) {
      if (audit.mode !== "frozen") throw new Error("clock is not frozen");
      frozen = value;
    },
    live() {
      audit.mode = "live";
      audit.frozenAt = null;
    },
    now() {
      return audit.mode === "frozen" ? frozen : realDateNow();
    },
    realNow() {
      return realDateNow();
    },
    audit,
  };
  Date.now = () => (audit.mode === "frozen" ? frozen : realDateNow());
  window.setInterval = (fn, delay, ...args) => {
    const ms = Number(delay);
    if (ms === 1000) {
      const id = realSetInterval(() => {
        audit.clock.calls += 1;
        fn(...args);
      }, 25);
      audit.clock.created.push({ id, delay: ms });
      audit.clock.active.push(id);
      return id;
    }
    audit.otherIntervals += 1;
    return realSetInterval(fn, delay, ...args);
  };
  window.clearInterval = (id) => {
    const index = audit.clock.active.indexOf(id);
    if (index >= 0) {
      audit.clock.active.splice(index, 1);
      audit.clock.cleared.push(id);
    }
    return realClearInterval(id);
  };
};

/**
 * Installs the clock and timer audit before any page script executes. Live by default so sign-in
 * and Convex keep wall-clock behaviour; `frozen` starts at the given epoch for deterministic mounts.
 */
export async function installClock(page, liveNow = Date.now(), { frozen = false } = {}) {
  await page.evaluateOnNewDocument(SETUP, liveNow, frozen);
}

/** Freezes Date.now at an exact epoch millisecond. */
export async function freezeClock(page, at) {
  await page.evaluate((value) => window.__qaClock.freeze(value), at);
}

/** Moves a frozen clock to a new exact epoch millisecond. */
export async function setFakeNow(page, at) {
  await page.evaluate((value) => window.__qaClock.set(value), at);
}

/** Reads the timer accounting snapshot. */
export async function readClockAudit(page) {
  return page.evaluate(() => {
    const audit = window.__qaClock.audit;
    return {
      mode: audit.mode,
      frozenAt: audit.frozenAt,
      clock: {
        created: audit.clock.created.map((entry) => ({ ...entry })),
        cleared: [...audit.clock.cleared],
        active: [...audit.clock.active],
        calls: audit.clock.calls,
      },
      otherIntervals: audit.otherIntervals,
      now: Date.now(),
    };
  });
}

/**
 * Waits until the shared clock has fired at least `minimum` callbacks past `afterCalls`, then gives
 * React a moment to commit. Returns the audit snapshot at the observed count.
 */
export async function waitForClockCalls(page, afterCalls, minimum = 2, timeout = 10000) {
  await page.waitForFunction(
    (previous, needed) => window.__qaClock.audit.clock.calls >= previous + needed,
    { timeout },
    afterCalls,
    minimum,
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  return readClockAudit(page);
}
