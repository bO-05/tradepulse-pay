/**
 * How the guided-demo page presents old runs. A run that never reached its change-order invoice
 * within an hour of starting was abandoned (a closed PayPal popup, a judge who walked away, a
 * provider error). The page labels those runs, stops their elapsed timer and keeps them behind a
 * toggle, so the run history reads as a record instead of a list of failures. Presentation only:
 * no run, payment or ledger row is changed or deleted.
 */

/** A guided run finishes in minutes (4–18 recorded); an unfinished run older than this is abandoned. */
export const ABANDONED_AFTER_MS = 60 * 60 * 1000;

export type RunHistoryItem = {
  runId: string;
  agreementNumber: string;
  createdAt: number;
  payAppsPaid: boolean;
  ownerPaid: boolean;
};

export type RunHistoryState = "complete" | "owner_pending" | "in_progress" | "abandoned";

/**
 * The Owner paying is complete. Paid pay apps alone mean the run is waiting on the Owner, which is
 * a human step with no deadline: that state stays owner-payment-open indefinitely, invoice or not.
 * Only a run with neither is time-limited, and it turns abandoned strictly after the hour.
 */
export function runHistoryState(item: RunHistoryItem, now: number): RunHistoryState {
  if (item.ownerPaid) return "complete";
  if (item.payAppsPaid) return "owner_pending";
  return now - item.createdAt > ABANDONED_AFTER_MS ? "abandoned" : "in_progress";
}

const STATE_LABEL: Record<RunHistoryState, string> = {
  complete: "Complete · Owner paid",
  owner_pending: "Pay apps paid · Owner payment open",
  in_progress: "In progress",
  abandoned: "Abandoned · not finished",
};

export function runOptionLabel(item: RunHistoryItem, now: number): string {
  return `${item.agreementNumber} · ${new Date(item.createdAt).toLocaleDateString()} · ${STATE_LABEL[runHistoryState(item, now)]}`;
}

/** Splits the history into what the selector shows by default and the abandoned runs behind the toggle. */
export function partitionRunHistory<T extends RunHistoryItem>(
  history: readonly T[],
  now: number,
): { visible: T[]; abandoned: T[] } {
  const visible: T[] = [];
  const abandoned: T[] = [];
  for (const item of history) (runHistoryState(item, now) === "abandoned" ? abandoned : visible).push(item);
  return { visible, abandoned };
}

/**
 * What the selector lists. The default keeps the server order; showing abandoned runs appends them
 * and restores one descending-started order across both groups.
 */
export function listedRunHistory<T extends RunHistoryItem>(
  history: readonly T[],
  now: number,
  showAbandoned: boolean,
): T[] {
  const { visible, abandoned } = partitionRunHistory(history, now);
  return showAbandoned ? [...visible, ...abandoned].sort((a, b) => b.createdAt - a.createdAt) : visible;
}

/**
 * Whether any history entry still has a state that changes with the clock. Every time-limited entry
 * ages independently of which run is selected, so the page keeps one shared clock while at least one
 * entry is in progress; once they are all complete, owner-open or abandoned, no interval is needed.
 */
export function runHistoryNeedsClock(
  history: readonly RunHistoryItem[],
  selected: RunHistoryItem | null,
  now: number,
): boolean {
  return (
    history.some((item) => runHistoryState(item, now) === "in_progress") ||
    (selected !== null && runHistoryState(selected, now) === "in_progress")
  );
}

/**
 * The selected run's timer, driven by the same state as its selector label. A completed or
 * owner-open run shows its fixed start-to-invoice time when there is one; an owner-open run without
 * an invoice says so instead of inventing a clock. An unfinished run counts up only during its first
 * hour, then reads as abandoned with a frozen value instead of an elapsed clock that climbs forever.
 */
export function runTimerText(item: RunHistoryItem, invoicedAt: number | null, now: number): { text: string; abandoned: boolean } {
  const state = runHistoryState(item, now);
  if (state === "complete") {
    return {
      text: invoicedAt !== null
        ? `Finished in ${clock(invoicedAt - item.createdAt)} (start to change-order invoice)`
        : "Complete · Owner paid",
      abandoned: false,
    };
  }
  if (state === "owner_pending") {
    return {
      text: invoicedAt !== null
        ? `Finished in ${clock(invoicedAt - item.createdAt)} (start to change-order invoice) · Owner payment open`
        : "Pay apps paid · Owner payment open",
      abandoned: false,
    };
  }
  if (state === "abandoned") {
    return { text: "Abandoned · not finished within an hour of starting; the timer is stopped", abandoned: true };
  }
  return { text: `Elapsed ${clock(now - item.createdAt)}`, abandoned: false };
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
