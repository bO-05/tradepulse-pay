import type { PayAppLinesCsvInput, RetainageCsvInput, SheetLine, SovCsvInput } from "./inputTypes";

/**
 * CSV exports (architecture §16). Money is written as plain numbers ("1234.56", "-1200.00") that are
 * never escaped, so sums work in a spreadsheet. Every text cell is quoted and, when it starts with a
 * character a spreadsheet would treat as a formula (= + - @ tab CR), prefixed with "'" (CWE-1236).
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvText(value: string): string {
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvAmount(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`cents must be an integer, got ${cents}`);
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** "70.04" from "70.04%"; empty when the line has no scheduled value. */
function csvPercent(text: string): string {
  const m = text.match(/^-?\d+(\.\d+)?/);
  return m ? m[0] : "";
}

function csv(header: readonly string[], rows: readonly string[][]): string {
  return `\uFEFF${[header.join(","), ...rows.map((r) => r.join(","))].join("\r\n")}\r\n`;
}

/** Same columns as the SOV import template, so an export re-imports as is. */
export function buildSovCsv(d: SovCsvInput): string {
  return csv(
    ["line_no", "description", "csi_code", "scheduled_value"],
    d.lines.map((l) => [String(l.lineNo), csvText(l.description), csvText(l.csiCode), csvAmount(l.scheduledValueCents)]),
  );
}

function sheetCells(l: Omit<SheetLine, "item" | "description">): string[] {
  return [
    csvAmount(l.scheduledValueCents),
    csvAmount(l.previousCents),
    csvAmount(l.thisPeriodCents),
    csvAmount(l.storedCents),
    csvAmount(l.totalCents),
    csvPercent(l.percentText),
    csvAmount(l.balanceCents),
    csvAmount(l.retainageCents),
  ];
}

export function buildPayAppLinesCsv(d: PayAppLinesCsvInput): string {
  return csv(
    [
      "item",
      "description",
      "scheduled_value_c",
      "from_previous_d",
      "this_period_e",
      "materials_stored_f",
      "total_completed_stored_g",
      "percent_g_over_c",
      "balance_to_finish_h",
      "retainage_i",
    ],
    [
      ...d.lines.map((l) => [csvText(l.item), csvText(l.description), ...sheetCells(l)]),
      [csvText("Totals"), csvText(""), ...sheetCells(d.totals)],
    ],
  );
}

/** One row per ledger entry with a running balance. */
export function buildRetainageCsv(d: RetainageCsvInput): string {
  let balance = 0;
  return csv(
    ["date", "reference", "description", "amount", "balance"],
    d.rows.map((r) => {
      balance += r.amountCents;
      return [csvText(r.date), csvText(r.reference), csvText(r.description), csvAmount(r.amountCents), csvAmount(balance)];
    }),
  );
}
