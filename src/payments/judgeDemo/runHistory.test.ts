import { describe, expect, test } from "vitest";
import {
  ABANDONED_AFTER_MS,
  listedRunHistory,
  partitionRunHistory,
  runHistoryNeedsClock,
  runHistoryState,
  runOptionLabel,
  runTimerText,
} from "./runHistory";

const NOW = Date.UTC(2026, 10, 11, 8, 0, 0);
const item = (id: string, ageMs: number, payAppsPaid = false, ownerPaid = false) => ({
  runId: id,
  agreementNumber: `A401-DEMO-PAY-${id}`,
  createdAt: NOW - ageMs,
  payAppsPaid,
  ownerPaid,
});

describe("guided-demo run history", () => {
  test("states: complete, owner pending, in progress, abandoned after an hour", () => {
    expect(runHistoryState(item("a", 3 * ABANDONED_AFTER_MS, true, true), NOW)).toBe("complete");
    expect(runHistoryState(item("b", 3 * ABANDONED_AFTER_MS, true, false), NOW)).toBe("owner_pending");
    expect(runHistoryState(item("c", 5 * 60_000), NOW)).toBe("in_progress");
    expect(runHistoryState(item("d", ABANDONED_AFTER_MS), NOW)).toBe("in_progress");
    expect(runHistoryState(item("e", ABANDONED_AFTER_MS + 1), NOW)).toBe("abandoned");
  });

  test("a run with paid pay apps is never abandoned, even when the Owner never paid", () => {
    expect(runHistoryState(item("old", 30 * 24 * ABANDONED_AFTER_MS, true, false), NOW)).toBe("owner_pending");
  });

  test("labels name the state instead of 'Pay apps incomplete · Owner unpaid'", () => {
    expect(runOptionLabel(item("x", 2 * ABANDONED_AFTER_MS), NOW)).toContain("Abandoned · not finished");
    expect(runOptionLabel(item("y", 2 * ABANDONED_AFTER_MS, true, true), NOW)).toContain("Complete · Owner paid");
    expect(runOptionLabel(item("z", 2 * ABANDONED_AFTER_MS, true), NOW)).toContain("Owner payment open");
    expect(runOptionLabel(item("x", 2 * ABANDONED_AFTER_MS), NOW)).not.toMatch(/incomplete|unpaid/i);
  });

  test("partition keeps server order and moves only abandoned runs behind the toggle", () => {
    const history = [item("20", 20 * ABANDONED_AFTER_MS), item("19", 21 * ABANDONED_AFTER_MS), item("12", 90 * ABANDONED_AFTER_MS, true), item("now", 60_000), item("02", 200 * ABANDONED_AFTER_MS, true, true)];
    const { visible, abandoned } = partitionRunHistory(history, NOW);
    expect(visible.map((r) => r.runId)).toEqual(["12", "now", "02"]);
    expect(abandoned.map((r) => r.runId)).toEqual(["20", "19"]);
  });

  test("the timer counts during the first hour, then freezes as abandoned; finished runs keep their fixed time", () => {
    const fresh = item("fresh", 90_000);
    expect(runTimerText(fresh, null, NOW)).toEqual({ text: "Elapsed 1:30", abandoned: false });
    const staleItem = item("stale", 1221 * 60_000);
    const stale = runTimerText(staleItem, null, NOW);
    expect(stale.abandoned).toBe(true);
    expect(stale.text).not.toMatch(/Elapsed|\d+:\d{2}/);
    // The same stale run reads identically later: nothing counts up.
    expect(runTimerText(staleItem, null, NOW + 10 * ABANDONED_AFTER_MS)).toEqual(stale);
    const finishedItem = item("finished", 90_000, true, true);
    expect(runTimerText(finishedItem, NOW - 90_000 + 252_000, NOW + 99 * ABANDONED_AFTER_MS)).toEqual({
      text: "Finished in 4:12 (start to change-order invoice)",
      abandoned: false,
    });
  });

  test("ownerPaid is complete even if the pay-app flag lags; the boundary is strictly one hour", () => {
    expect(runHistoryState(item("paid", 5 * ABANDONED_AFTER_MS, false, true), NOW)).toBe("complete");
    const exactlyOneHour = item("boundary", ABANDONED_AFTER_MS);
    expect(runHistoryState(exactlyOneHour, NOW)).toBe("in_progress");
    expect(runHistoryState(item("past", ABANDONED_AFTER_MS + 1), NOW)).toBe("abandoned");
  });

  test("paid pay apps without an invoice never read as abandoned in the selected detail", () => {
    const ownerOpen = item("open", 30 * ABANDONED_AFTER_MS, true, false);
    expect(runHistoryState(ownerOpen, NOW)).toBe("owner_pending");
    expect(runTimerText(ownerOpen, null, NOW)).toEqual({
      text: "Pay apps paid · Owner payment open",
      abandoned: false,
    });
    // With an invoice the detail keeps the fixed start-to-invoice duration and still says who owes.
    expect(runTimerText(ownerOpen, ownerOpen.createdAt + 252_000, NOW)).toEqual({
      text: "Finished in 4:12 (start to change-order invoice) · Owner payment open",
      abandoned: false,
    });
  });

  test("every time-limited entry advances while a completed run is selected, and the clock stops after the last one", () => {
    const completed = item("done", 30 * ABANDONED_AFTER_MS, true, true);
    const nearlyAnHour = item("fresh", ABANDONED_AFTER_MS - 60_000);
    const history = [completed, nearlyAnHour];
    let now = NOW;
    expect(runHistoryNeedsClock(history, completed, now)).toBe(true);
    now += 61_000;
    expect(runHistoryState(nearlyAnHour, now)).toBe("abandoned");
    expect(partitionRunHistory(history, now).abandoned.map((run) => run.runId)).toEqual(["fresh"]);
    expect(runHistoryNeedsClock(history, completed, now)).toBe(false);
  });

  test("the clock also follows a selected in-progress run that has aged out of the history list", () => {
    const selected = item("outside", 30 * 60_000);
    expect(runHistoryNeedsClock([], selected, NOW)).toBe(true);
    expect(runHistoryNeedsClock([], item("outside-done", ABANDONED_AFTER_MS + 1), NOW)).toBe(false);
    expect(runHistoryNeedsClock([selected], selected, NOW)).toBe(true);
  });

  test("no timer runs for owner-open, completed or abandoned selections", () => {
    const ownerOpen = item("open", 30 * ABANDONED_AFTER_MS, true, false);
    const completed = item("done", 30 * ABANDONED_AFTER_MS, true, true);
    const abandoned = item("lost", ABANDONED_AFTER_MS + 1);
    expect(runHistoryNeedsClock([ownerOpen], ownerOpen, NOW)).toBe(false);
    expect(runHistoryNeedsClock([completed], completed, NOW)).toBe(false);
    expect(runHistoryNeedsClock([abandoned], abandoned, NOW)).toBe(false);
  });

  test("the abandoned toggle appends and removes entries in descending createdAt order", () => {
    const history = [
      item("new", 60_000),
      item("old", 30 * ABANDONED_AFTER_MS),
      item("done", 50 * ABANDONED_AFTER_MS, true, true),
      item("older", 40 * ABANDONED_AFTER_MS),
    ];
    expect(listedRunHistory(history, NOW, false).map((run) => run.runId)).toEqual(["new", "done"]);
    // Descending createdAt across both groups: newest first, then the older abandoned runs.
    expect(listedRunHistory(history, NOW, true).map((run) => run.runId)).toEqual(["new", "old", "older", "done"]);
  });
});
