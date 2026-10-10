import {
  SOV_FILE_TOO_LARGE,
  SOV_MAX_FILE_BYTES,
  SOV_MAX_ROWS,
  SOV_TOO_MANY_ROWS,
  centsToPlainAmount,
  escapeSpreadsheetText,
  parseSovMoney,
  sovLineProblems,
  sumSovCents,
  unescapeSpreadsheetText,
  type SovLineInput,
} from "../../convex/lib/sovRules";
import type { SheetData } from "write-excel-file/browser";

/**
 * SOV spreadsheet import and export. papaparse, read-excel-file, write-excel-file and fflate are
 * loaded only when a file is imported or exported, so none of them is in the main bundle.
 */

export const SOV_FILE_HEADERS = ["line_no", "description", "csi_code", "scheduled_value"] as const;
export const SOV_FORMULA_MESSAGE = "formula cells are not allowed";

export type SovExportLine = { lineNo: number; description: string; csiCode: string; scheduledValueCents: number };

export type SovImportResult =
  | { ok: true; rows: SovLineInput[]; totalCents: number }
  | { ok: false; message: string; errors: string[] };

type RawRow = { rowNumber: number; cells: unknown[] };

function fail(message: string, errors: string[] = []): SovImportResult {
  return { ok: false, message, errors };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function normalizeHeader(cell: unknown): string {
  return cellText(cell).replace(/^\uFEFF/, "").trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * Turns parsed spreadsheet rows (header first) into SOV lines. Every defective row is reported by
 * its spreadsheet row number, the same row Excel shows and cell references use (with the header in
 * row 1, the first SOV row is row 2); any defect refuses the whole file.
 */
export function rowsToSovLines(raw: RawRow[], formulaRows: Map<number, string[]> = new Map()): SovImportResult {
  const nonEmpty = raw.filter((r) => r.cells.some((c) => cellText(c).trim() !== ""));
  if (nonEmpty.length === 0) return fail("This file is empty.");
  const [headerRow, ...dataRows] = nonEmpty;
  const header = headerRow.cells.map(normalizeHeader);
  const col = (name: (typeof SOV_FILE_HEADERS)[number]) => header.indexOf(name);
  const missing = ["description", "scheduled_value"].filter((h) => !header.includes(h));
  if (missing.length > 0) {
    return fail(`The first row must be the header ${SOV_FILE_HEADERS.join(",")}. Missing: ${missing.join(", ")}.`);
  }
  if (dataRows.length === 0) return fail("The file has a header but no SOV rows.");
  if (dataRows.length > SOV_MAX_ROWS) {
    return fail(`${SOV_TOO_MANY_ROWS} This file has ${dataRows.length.toLocaleString("en-US")} rows.`);
  }
  const descriptionCol = col("description");
  const csiCol = col("csi_code");
  const amountCol = col("scheduled_value");
  const errors: string[] = [];
  const rows: SovLineInput[] = [];
  for (const row of dataRows) {
    const label = `Row ${row.rowNumber}`;
    const formulaCells = formulaRows.get(row.rowNumber);
    if (formulaCells && formulaCells.length > 0) {
      errors.push(`${label}: ${SOV_FORMULA_MESSAGE} (${formulaCellList(formulaCells)}).`);
      continue;
    }
    const description = unescapeSpreadsheetText(cellText(row.cells[descriptionCol]).trim());
    const csiCode = csiCol >= 0 ? unescapeSpreadsheetText(cellText(row.cells[csiCol]).trim()) : "";
    const money = parseSovMoney(row.cells[amountCol]);
    const problems: string[] = [];
    if (!money.ok) problems.push(money.reason);
    const lineProblems = sovLineProblems({ description, csiCode, scheduledValueCents: money.ok ? money.cents : 0 });
    problems.push(...lineProblems);
    if (problems.length > 0) {
      errors.push(`${label}: ${problems.join("; ")}.`);
      continue;
    }
    if (money.ok) rows.push({ description, ...(csiCode ? { csiCode } : {}), scheduledValueCents: money.cents });
  }
  const checkedRows = new Set(dataRows.map((r) => r.rowNumber));
  for (const [rowNumber, cells] of [...formulaRows].sort((a, b) => a[0] - b[0])) {
    if (checkedRows.has(rowNumber) || cells.length === 0) continue;
    const label = rowNumber === headerRow.rowNumber ? "Header row" : `Row ${rowNumber}`;
    errors.push(`${label}: ${SOV_FORMULA_MESSAGE} (${formulaCellList(cells)}).`);
  }
  if (errors.length > 0) {
    return fail(`Nothing was imported. Fix ${errors.length === 1 ? "this row" : `these ${errors.length} rows`} and try again.`, errors);
  }
  return { ok: true, rows, totalCents: sumSovCents(rows) };
}

function formulaCellList(cells: string[]): string {
  return `${cells.length === 1 ? "cell" : "cells"} ${cells.join(", ")}`;
}

function checkFileSize(size: number): SovImportResult | null {
  if (size > SOV_MAX_FILE_BYTES) return fail(`${SOV_FILE_TOO_LARGE} This file is ${(size / 1024 / 1024).toFixed(1)} MB.`);
  if (size === 0) return fail("This file is empty.");
  return null;
}

export async function parseSovCsvText(text: string): Promise<SovImportResult> {
  const Papa = (await import("papaparse")).default;
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { skipEmptyLines: false });
  const raw = result.data.map((cells, i) => ({ rowNumber: i + 1, cells }));
  const problems = csvStructureProblems(raw, result.errors);
  if (problems) return problems;
  return rowsToSovLines(raw);
}

const CSV_ERROR_TEXT: Record<string, string> = {
  MissingQuotes: "a quoted value is missing its closing quote",
  InvalidQuotes: "a quoted value has a stray quote",
  UndetectableDelimiter: "the column separator could not be detected",
};

/**
 * CSV-only checks that run before any value is read: parser errors and rows whose cell count
 * differs from the header. Either refuses the whole file, so a misplaced comma (an unquoted
 * `38,200.00`) can never shift an amount into a different column.
 */
function csvStructureProblems(raw: RawRow[], parseErrors: { code: string; message: string; row?: number }[]): SovImportResult | null {
  const isBlank = (r: RawRow) => r.cells.every((c) => cellText(c).trim() === "");
  const headerRow = raw.find((r) => !isBlank(r));
  if (!headerRow) return null;
  const label = (rowNumber: number) => (rowNumber === headerRow.rowNumber ? "Header row" : `Row ${rowNumber}`);
  const byRow = new Map<number, string[]>();
  const add = (rowNumber: number, problem: string) => byRow.set(rowNumber, [...(byRow.get(rowNumber) ?? []), problem]);
  for (const e of parseErrors) {
    const rowNumber = typeof e.row === "number" ? e.row + 1 : headerRow.rowNumber;
    add(rowNumber, CSV_ERROR_TEXT[e.code] ?? e.message);
  }
  const width = headerRow.cells.length;
  for (const row of raw) {
    if (row === headerRow || isBlank(row) || row.cells.length === width) continue;
    const hint = row.cells.length > width ? " (quote amounts that contain commas)" : "";
    add(row.rowNumber, `has ${row.cells.length} columns but the header has ${width}${hint}`);
  }
  if (byRow.size === 0) return null;
  const errors = [...byRow].sort((a, b) => a[0] - b[0]).map(([rowNumber, list]) => `${label(rowNumber)}: ${list.join("; ")}.`);
  return fail(`Nothing was imported. Fix ${errors.length === 1 ? "this row" : `these ${errors.length} rows`} and try again.`, errors);
}

export async function parseSovCsv(file: File): Promise<SovImportResult> {
  const sizeProblem = checkFileSize(file.size);
  if (sizeProblem) return sizeProblem;
  return parseSovCsvText(await file.text());
}

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function columnName(index: number): string {
  let name = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * Element tags by local name, whatever namespace prefix they carry (`<c>`, `<x:c>`, `</x:f>`).
 * read-excel-file drops prefixes too, so any prefix is treated as SpreadsheetML.
 */
const XML_TAG = /<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:\s[^>]*?)?)(\/?)>/g;

function xmlAttr(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)(?:[A-Za-z_][\\w.-]*:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)?.slice(1).find((v) => v !== undefined);
}

/**
 * Row number -> cell refs holding a formula in the first worksheet. read-excel-file returns a
 * formula's cached result, so formulas are found by reading the sheet XML directly. Cells and rows
 * without an `r` attribute take the position after the previous one, as spreadsheet readers do.
 */
export async function findXlsxFormulaCells(bytes: Uint8Array): Promise<Map<number, string[]>> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const files = unzipSync(bytes, { filter: (f) => f.name.startsWith("xl/") && (f.name.endsWith(".xml") || f.name.endsWith(".rels")) });
  const workbook = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  const rels = files["xl/_rels/workbook.xml.rels"] ? strFromU8(files["xl/_rels/workbook.xml.rels"]) : "";
  let sheetPath = "xl/worksheets/sheet1.xml";
  let firstSheetRid: string | undefined;
  for (const m of workbook.matchAll(XML_TAG)) {
    if (m[1] === "" && m[2] === "sheet") {
      firstSheetRid = xmlAttr(m[3], "id");
      break;
    }
  }
  if (firstSheetRid) {
    for (const m of rels.matchAll(XML_TAG)) {
      if (m[1] !== "" || m[2] !== "Relationship" || xmlAttr(m[3], "Id") !== firstSheetRid) continue;
      const target = xmlAttr(m[3], "Target");
      if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    }
  }
  const sheet = files[sheetPath] ? strFromU8(files[sheetPath]) : "";
  const found = new Map<number, string[]>();
  let inSheetData = false;
  let rowNumber = 0;
  let colNumber = 0;
  let cell: { row: number; col: number } | null = null;
  let cellHasFormula = false;
  for (const m of sheet.matchAll(XML_TAG)) {
    const [, closing, local, attrs, selfClosing] = m;
    if (local === "sheetData") {
      inSheetData = closing === "" && selfClosing === "";
      continue;
    }
    if (!inSheetData) continue;
    if (local === "row" && closing === "") {
      const r = Number(xmlAttr(attrs, "r"));
      rowNumber = Number.isInteger(r) && r > 0 ? r : rowNumber + 1;
      colNumber = 0;
    } else if (local === "c" && closing === "") {
      const ref = /^([A-Za-z]+)(\d+)$/.exec(xmlAttr(attrs, "r") ?? "");
      colNumber = ref ? columnIndex(ref[1].toUpperCase()) : colNumber + 1;
      cell = { row: ref ? Number(ref[2]) : rowNumber, col: colNumber };
      cellHasFormula = false;
      if (selfClosing) cell = null;
    } else if (local === "f" && closing === "" && cell) {
      cellHasFormula = true;
    } else if (local === "c" && closing === "/" && cell) {
      if (cellHasFormula) found.set(cell.row, [...(found.get(cell.row) ?? []), `${columnName(cell.col)}${cell.row}`]);
      cell = null;
    }
  }
  return found;
}

export async function parseSovXlsxBytes(bytes: Uint8Array): Promise<SovImportResult> {
  let formulaRows: Map<number, string[]>;
  let sheetRows: unknown[][];
  try {
    formulaRows = await findXlsxFormulaCells(bytes);
    const { readSheet } = await import("read-excel-file/universal");
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    sheetRows = (await readSheet(buffer, { trim: false })) as unknown[][];
  } catch {
    return fail("This file could not be read as an .xlsx workbook.");
  }
  const raw = sheetRows.map((cells, i) => ({ rowNumber: i + 1, cells }));
  return rowsToSovLines(raw, formulaRows);
}

export async function parseSovXlsx(file: File): Promise<SovImportResult> {
  const sizeProblem = checkFileSize(file.size);
  if (sizeProblem) return sizeProblem;
  return parseSovXlsxBytes(new Uint8Array(await file.arrayBuffer()));
}

export async function parseSovFile(file: File): Promise<SovImportResult> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx")) return parseSovXlsx(file);
  if (name.endsWith(".csv") || file.type === "text/csv") return parseSovCsv(file);
  return fail("Choose a .csv or .xlsx file.");
}

/** Text cells escaped against formula injection; amounts as plain numbers that are never prefixed. */
export async function sovToCsv(lines: SovExportLine[]): Promise<string> {
  const Papa = (await import("papaparse")).default;
  const header = SOV_FILE_HEADERS.join(",");
  if (lines.length === 0) return header;
  const body = Papa.unparse(
    lines.map((l) => [
      String(l.lineNo),
      escapeSpreadsheetText(l.description),
      escapeSpreadsheetText(l.csiCode),
      centsToPlainAmount(l.scheduledValueCents),
    ]),
    { quotes: [false, true, true, false], newline: "\r\n" },
  );
  return `${header}\r\n${body}`;
}

/** Rows for write-excel-file: every text cell is a String cell, never a formula. */
export function sovXlsxSheetData(lines: SovExportLine[]): SheetData {
  const header = SOV_FILE_HEADERS.map((h) => ({ value: h, type: String, fontWeight: "bold" as const }));
  const body = lines.map((l) => [
    { value: l.lineNo, type: Number },
    { value: escapeSpreadsheetText(l.description), type: String },
    { value: escapeSpreadsheetText(l.csiCode), type: String },
    { value: l.scheduledValueCents / 100, type: Number, format: "0.00" },
  ]);
  return [header, ...body];
}

export async function sovToXlsxBlob(lines: SovExportLine[]): Promise<Blob> {
  const writeXlsxFile = (await import("write-excel-file/browser")).default;
  return writeXlsxFile(sovXlsxSheetData(lines), { columns: [{ width: 8 }, { width: 48 }, { width: 14 }, { width: 16 }] }).toBlob();
}

export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function sovFileName(agreementNumber: string, ext: "csv" | "xlsx"): string {
  return `sov-${agreementNumber.replace(/[^A-Za-z0-9_-]+/g, "-")}.${ext}`;
}
