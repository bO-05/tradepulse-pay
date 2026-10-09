/**
 * Schedule-of-values limits and line checks shared by the SOV editor, the CSV/XLSX import preview
 * and the server mutations. The server re-checks everything the browser checks.
 */
import { formatCents } from "./money";

export const SOV_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SOV_MAX_ROWS = 1000;
export const SOV_MAX_DESCRIPTION = 200;
export const SOV_MAX_CSI = 32;
/** $1,000,000,000.00 per line. */
export const SOV_MAX_LINE_CENTS = 100_000_000_000;

export const SOV_FILE_TOO_LARGE = "SOV files must be 2 MB or smaller.";
export const SOV_TOO_MANY_ROWS = `SOV imports are limited to ${SOV_MAX_ROWS.toLocaleString("en-US")} rows.`;
export const SOV_LOCKED_MESSAGE = "SOV is locked. Changes only through change orders.";
export const SOV_NOT_APPROVED_MESSAGE = "Waiting for the GC to approve the schedule of values.";

export type SovLineInput = { description: string; csiCode?: string; scheduledValueCents: number };

/** Problems with one line, as short reasons ("description is required"). */
export function sovLineProblems(line: { description: string; csiCode?: string; scheduledValueCents: number }): string[] {
  const problems: string[] = [];
  const description = line.description.trim();
  if (description === "") problems.push("description is required");
  else if (description.length > SOV_MAX_DESCRIPTION) {
    problems.push(`description is longer than ${SOV_MAX_DESCRIPTION} characters (${description.length})`);
  }
  const csi = (line.csiCode ?? "").trim();
  if (csi.length > SOV_MAX_CSI) problems.push(`CSI code is longer than ${SOV_MAX_CSI} characters (${csi.length})`);
  const cents = line.scheduledValueCents;
  if (!Number.isSafeInteger(cents)) problems.push("scheduled value must be a whole number of cents");
  else if (cents < 0) problems.push("scheduled value can't be negative");
  else if (cents > SOV_MAX_LINE_CENTS) problems.push(`scheduled value is more than ${formatCents(SOV_MAX_LINE_CENTS)}`);
  return problems;
}

const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const PLAIN = /^\d+(?:\.\d+)?$/;

export type MoneyParse = { ok: true; cents: number } | { ok: false; reason: string };

/**
 * Strict spreadsheet money: `31500`, `31500.00`, `8,000.00`, `$8,000.00`. Rejects letters, misplaced
 * thousands separators, exponents, negatives and more than two decimals instead of coercing them.
 */
export function parseSovMoney(raw: unknown): MoneyParse {
  if (raw === null || raw === undefined) return { ok: false, reason: "scheduled value is required" };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, reason: "scheduled value is not a number" };
    return parseSovMoney(String(raw));
  }
  if (typeof raw !== "string") return { ok: false, reason: "scheduled value is not a number" };
  let text = raw.trim();
  if (text === "") return { ok: false, reason: "scheduled value is required" };
  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1).trim();
  }
  if (text.startsWith("$")) text = text.slice(1).trim();
  if (!GROUPED.test(text) && !PLAIN.test(text)) return { ok: false, reason: "scheduled value is not a number" };
  const [whole, frac = ""] = text.replace(/,/g, "").split(".");
  if (frac.length > 2) return { ok: false, reason: "scheduled value has more than two decimals (sub-cent amount)" };
  if (negative) return { ok: false, reason: "scheduled value can't be negative" };
  if (whole.length > 13) return { ok: false, reason: `scheduled value is more than ${formatCents(SOV_MAX_LINE_CENTS)}` };
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (cents > SOV_MAX_LINE_CENTS) return { ok: false, reason: `scheduled value is more than ${formatCents(SOV_MAX_LINE_CENTS)}` };
  return { ok: true, cents };
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Spreadsheet-safe text cell: a leading `'` keeps `=`, `+`, `-`, `@`, tab and CR from running as a formula. */
export function escapeSpreadsheetText(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** Reverses escapeSpreadsheetText on import, so an exported file round-trips unchanged. */
export function unescapeSpreadsheetText(text: string): string {
  return text.startsWith("'") && FORMULA_START.test(text.slice(1)) ? text.slice(1) : text;
}

/** Plain-number export of cents, e.g. 3150000 -> "31500.00", -120000 -> "-1200.00". */
export function centsToPlainAmount(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function sumSovCents(lines: readonly { scheduledValueCents: number }[]): number {
  let total = 0;
  for (const l of lines) total += l.scheduledValueCents;
  return total;
}

/** Signed difference "SOV total − contract sum" as text, e.g. "−$200.00", "$0.00", "+$0.01". */
export function formatDifference(cents: number): string {
  if (cents === 0) return formatCents(0);
  return `${cents < 0 ? "−" : "+"}${formatCents(Math.abs(cents))}`;
}

/** Why the SOV cannot be approved, or null when the lines sum exactly to the contract sum. */
export function sovApprovalProblem(contractSumCents: number, lines: readonly { scheduledValueCents: number }[]): string | null {
  if (lines.length === 0) return "Add at least one line before approving the schedule of values.";
  const total = sumSovCents(lines);
  if (total === contractSumCents) return null;
  const diff = total - contractSumCents;
  return `The SOV total ${formatCents(total)} does not equal the contract sum ${formatCents(contractSumCents)}: it is ${formatCents(
    Math.abs(diff),
  )} ${diff < 0 ? "short" : "over"} (difference ${formatDifference(diff)}). Lines must sum exactly to the contract sum.`;
}
