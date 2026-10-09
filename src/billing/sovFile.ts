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
 * its data row number (the first row under the header is row 1); any defect refuses the whole file.
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
    const label = `Row ${row.rowNumber - headerRow.rowNumber}`;
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
    const label = rowNumber === headerRow.rowNumber ? "Header row" : `Row ${rowNumber - headerRow.rowNumber}`;
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
  return rowsToSovLines(raw);
}

export async function parseSovCsv(file: File): Promise<SovImportResult> {
  const sizeProblem = checkFileSize(file.size);
  if (sizeProblem) return sizeProblem;
  return parseSovCsvText(await file.text());
}

function columnLetters(ref: string): string {
  return ref.replace(/\d+$/, "");
}

/**
 * Row number -> cell refs holding a formula in the first worksheet. read-excel-file returns a
 * formula's cached result, so formulas are found by reading the sheet XML directly.
 */
export async function findXlsxFormulaCells(bytes: Uint8Array): Promise<Map<number, string[]>> {
  const { unzipSync, strFromU8 } = await import("fflate");
  const files = unzipSync(bytes, { filter: (f) => f.name.startsWith("xl/") && (f.name.endsWith(".xml") || f.name.endsWith(".rels")) });
  const workbook = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  const rels = files["xl/_rels/workbook.xml.rels"] ? strFromU8(files["xl/_rels/workbook.xml.rels"]) : "";
  let sheetPath = "xl/worksheets/sheet1.xml";
  const firstSheetRid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  if (firstSheetRid) {
    const relRe = /<Relationship\b[^>]*>/g;
    for (const rel of rels.match(relRe) ?? []) {
      if (rel.includes(`Id="${firstSheetRid}"`)) {
        const target = /Target="([^"]+)"/.exec(rel)?.[1];
        if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      }
    }
  }
  const sheet = files[sheetPath] ? strFromU8(files[sheetPath]) : "";
  const found = new Map<number, string[]>();
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  for (const match of sheet.matchAll(cellRe)) {
    const body = match[2] ?? "";
    if (!/<f\b/.test(body)) continue;
    const ref = /\br="([A-Z]+)(\d+)"/.exec(match[1]);
    if (!ref) continue;
    const rowNumber = Number(ref[2]);
    found.set(rowNumber, [...(found.get(rowNumber) ?? []), `${columnLetters(ref[1])}${rowNumber}`]);
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
