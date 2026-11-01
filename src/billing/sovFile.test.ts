import { describe, expect, test } from "vitest";
import writeXlsxFile, { type SheetData } from "write-excel-file/universal";
import { unzipSync, strFromU8, strToU8, zipSync } from "fflate";
import { SOV_FILE_TOO_LARGE, SOV_MAX_FILE_BYTES } from "../../convex/lib/sovRules";
import { findXlsxFormulaCells, parseSovCsv, parseSovCsvText, parseSovFile, parseSovXlsxBytes, sovToCsv, sovXlsxSheetData, type SovExportLine } from "./sovFile";

const EXAMPLE: SovExportLine[] = [
  { lineNo: 1, description: "Mobilization & submittals", csiCode: "26 01 00", scheduledValueCents: 850_000 },
  { lineNo: 2, description: "Rough-in, branch circuits", csiCode: "26 05 19", scheduledValueCents: 3_150_000 },
  { lineNo: 3, description: "Panelboards & distribution", csiCode: "26 24 16", scheduledValueCents: 2_840_000 },
  { lineNo: 4, description: "Lighting fixtures", csiCode: "26 51 00", scheduledValueCents: 3_820_000 },
  { lineNo: 5, description: "Low-voltage & data", csiCode: "27 10 00", scheduledValueCents: 1_270_000 },
  { lineNo: 6, description: "Fire alarm devices", csiCode: "28 31 00", scheduledValueCents: 2_160_000 },
  { lineNo: 7, description: "Trim & devices", csiCode: "26 27 26", scheduledValueCents: 800_000 },
  { lineNo: 8, description: "Testing, closeout & as-builts", csiCode: "26 08 00", scheduledValueCents: 2_350_000 },
];

const HEADER = "line_no,description,csi_code,scheduled_value";

function csvFile(text: string, name = "eastbay-sov.csv"): File {
  return new File([text], name, { type: "text/csv" });
}

async function xlsxBytes(data: SheetData): Promise<Uint8Array> {
  const blob = await writeXlsxFile(data).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

describe("SOV CSV import", () => {
  test("parses plain and grouped amounts into exact cents", async () => {
    const text = [
      HEADER,
      ...EXAMPLE.map((l) => {
        const amount = (l.scheduledValueCents / 100).toFixed(2);
        return l.lineNo === 7 ? `${l.lineNo},"${l.description}",${l.csiCode},"8,000.00"` : `${l.lineNo},"${l.description}",${l.csiCode},${amount}`;
      }),
    ].join("\n");
    const result = await parseSovCsv(csvFile(`\uFEFF${text}`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(8);
    expect(result.totalCents).toBe(17_240_000);
    expect(result.rows[1]).toEqual({ description: "Rough-in, branch circuits", csiCode: "26 05 19", scheduledValueCents: 3_150_000 });
  });

  test("reports every defective row by spreadsheet row number and keeps nothing", async () => {
    const text = [
      HEADER,
      "1,Mobilization,26 01 00,8500.00",
      "2,Rough-in,26 05 19,31500.00",
      "3,,26 24 16,28400.00",
      '4,Lighting,26 51 00,"12,7OO.00"',
      "5,Low-voltage,27 10 00,-500.00",
      `6,${"x".repeat(201)},28 31 00,100.00`,
      `7,Trim,${"9".repeat(33)},100.00`,
      "8,Testing,26 08 00,1250.005",
    ].join("\n");
    const result = await parseSovCsvText(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(6);
    expect(result.errors[0]).toMatch(/^Row 4: description is required/);
    expect(result.errors[1]).toBe("Row 5: scheduled value is not a number.");
    expect(result.errors[2]).toMatch(/^Row 6: scheduled value can't be negative/);
    expect(result.errors[3]).toMatch(/^Row 7: description is longer than 200 characters/);
    expect(result.errors[4]).toMatch(/^Row 8: CSI code is longer than 32 characters/);
    expect(result.errors[5]).toMatch(/^Row 9: scheduled value has more than two decimals/);
  });

  test("rejects files over 2 MB before reading them", async () => {
    const big = csvFile(`${HEADER}\n${"1,a,,1.00\n".repeat(Math.ceil((SOV_MAX_FILE_BYTES + 100_000) / 10))}`);
    const result = await parseSovFile(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(SOV_FILE_TOO_LARGE);
  });

  test("rejects more than 1,000 data rows", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => `${i + 1},Line ${i + 1},,1.00`);
    const result = await parseSovCsvText([HEADER, ...rows].join("\n"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("1,000 rows");
  });

  test("refuses a row with more cells than the header (unquoted 1,000 amount) and imports nothing", async () => {
    const text = [HEADER, "1,Mobilization,26 01 00,8500.00", "2,Lighting,26 51 00,38,200.00", "3,Trim,26 27 26,100.00"].join("\n");
    const result = await parseSovCsvText(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["Row 3: has 5 columns but the header has 4 (quote amounts that contain commas)."]);
    expect(result.message).toMatch(/^Nothing was imported/);
  });

  test("refuses a row with fewer cells than the header", async () => {
    const result = await parseSovCsvText([HEADER, "1,Mobilization,26 01 00,8500.00", "2,Lighting,100.00"].join("\n"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(["Row 3: has 3 columns but the header has 4."]);
  });

  test("refuses an unterminated quoted amount", async () => {
    const result = await parseSovCsvText([HEADER, "1,Mobilization,26 01 00,8500.00", '2,Lighting,26 51 00,"38200.00'].join("\n"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => /^Row 3: .*quote/i.test(e))).toBe(true);
  });

  test("requires the header", async () => {
    const result = await parseSovCsvText("1,Mobilization,26 01 00,8500.00");
    expect(result.ok).toBe(false);
  });
});

describe("SOV export", () => {
  test("CSV has plain amounts and escapes formula-looking text only", async () => {
    const lines = EXAMPLE.map((l) => (l.lineNo === 8 ? { ...l, description: '=HYPERLINK("http://example.com","Testing")' } : l));
    lines.push({ lineNo: 9, description: "Credit", csiCode: "", scheduledValueCents: -120_000 });
    const csv = await sovToCsv(lines);
    const rows = csv.split("\r\n");
    expect(rows[0]).toBe(HEADER);
    expect(rows[2]).toBe('2,"Rough-in, branch circuits","26 05 19",31500.00');
    expect(rows[8]).toBe(`8,"'=HYPERLINK(""http://example.com"",""Testing"")","26 08 00",23500.00`);
    expect(rows[9]).toBe('9,"Credit","",-1200.00');

    const back = await parseSovCsvText(await sovToCsv(lines.slice(0, 8)));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.rows[7].description).toBe('=HYPERLINK("http://example.com","Testing")');
    expect(back.rows.slice(0, 8).map((r) => r.scheduledValueCents)).toEqual(EXAMPLE.map((l) => l.scheduledValueCents));
  });

  test("XLSX stores escaped text as strings, never formulas, and round-trips", async () => {
    const lines = EXAMPLE.map((l) => (l.lineNo === 8 ? { ...l, description: '=HYPERLINK("http://example.com","Testing")' } : l));
    const bytes = await xlsxBytes(sovXlsxSheetData(lines));
    const sheet = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]);
    expect(sheet).not.toMatch(/<f\b/);
    const result = await parseSovXlsxBytes(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalCents).toBe(17_240_000);
    expect(result.rows[7].description).toBe('=HYPERLINK("http://example.com","Testing")');
  });
});

describe("SOV XLSX import", () => {
  test("imports numeric amount cells exactly", async () => {
    const bytes = await xlsxBytes(sovXlsxSheetData(EXAMPLE));
    const result = await parseSovXlsxBytes(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(8);
    expect(result.totalCents).toBe(17_240_000);
  });

  test("reports formula cells by row and imports nothing", async () => {
    const data = sovXlsxSheetData(EXAMPLE);
    data[3][1] = { value: 'HYPERLINK("http://example.com","x")', type: "Formula" };
    data[5][3] = { value: "1000*2", type: "Formula" };
    const bytes = await xlsxBytes(data);
    const result = await parseSovXlsxBytes(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      "Row 4: formula cells are not allowed (cell B4).",
      "Row 6: formula cells are not allowed (cell D6).",
    ]);
  });

  test("the first SOV row under the header is spreadsheet row 2, matching its cell reference", async () => {
    const data = sovXlsxSheetData(EXAMPLE);
    data[1][1] = { value: "1+1", type: "Formula" };
    const result = await parseSovXlsxBytes(await xlsxBytes(data));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["Row 2: formula cells are not allowed (cell B2)."]);
    const csv = await parseSovCsvText([HEADER, "1,,26 01 00,8500.00"].join("\n"));
    expect(csv.ok).toBe(false);
    if (!csv.ok) expect(csv.errors[0]).toMatch(/^Row 2: description is required/);
  });

  test("rejects formula cells written with a SpreadsheetML namespace prefix", async () => {
    const data = sovXlsxSheetData(EXAMPLE);
    data[5][3] = { value: "1000*2", type: "Formula" };
    const files = unzipSync(await xlsxBytes(data));
    const plain = strFromU8(files["xl/worksheets/sheet1.xml"]);
    expect(plain).toMatch(/<f>/);
    const prefixed = plain
      .replace(/<(\/?)(worksheet|sheetData|row|c|f|v|is|t|cols|col|sheetViews|sheetView|sheetFormatPr|pageMargins)\b/g, "<$1x:$2")
      .replace(/<x:worksheet\b([^>]*?)\sxmlns="([^"]+)"/, '<x:worksheet$1 xmlns:x="$2"');
    expect(prefixed).toMatch(/<x:f>1000\*2<\/x:f>/);
    expect(prefixed).not.toMatch(/<f>/);
    const workbook = strFromU8(files["xl/workbook.xml"])
      .replace(/<(\/?)(workbook|sheets|sheet|bookViews|workbookView|workbookPr)\b/g, "<$1x:$2")
      .replace(/<x:workbook\b([^>]*?)\sxmlns="([^"]+)"/, '<x:workbook$1 xmlns:x="$2"');
    files["xl/worksheets/sheet1.xml"] = strToU8(prefixed);
    files["xl/workbook.xml"] = strToU8(workbook);
    const result = await parseSovXlsxBytes(zipSync(files));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(["Row 6: formula cells are not allowed (cell D6)."]);
  });

  test("rejects a formula in a cell without an r attribute", async () => {
    const data = sovXlsxSheetData(EXAMPLE);
    data[5][3] = { value: "1000*2", type: "Formula" };
    const files = unzipSync(await xlsxBytes(data));
    files["xl/worksheets/sheet1.xml"] = strToU8(strFromU8(files["xl/worksheets/sheet1.xml"]).replace(/<c r="D6"/, "<c"));
    const bytes = zipSync(files);
    expect(await findXlsxFormulaCells(bytes)).toEqual(new Map([[6, ["D6"]]]));
    const result = await parseSovXlsxBytes(bytes);
    expect(result.ok).toBe(false);
  });

  test("a non-workbook file is refused without crashing", async () => {
    const result = await parseSovXlsxBytes(new TextEncoder().encode("not a zip"));
    expect(result.ok).toBe(false);
  });
});
