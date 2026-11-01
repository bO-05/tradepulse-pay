import { expect, test } from "vitest";
import Papa from "papaparse";
import { parseVendorCsv, vendorsToCsv } from "./vendorCsv";

const HEADER = "name,trades,contactName,email,phone,licenseNumber,licenseState";

test("export: one row per vendor, fixed columns, formula cells escaped", async () => {
  const csv = await vendorsToCsv([
    { name: '=HYPERLINK("http://evil.example","x")', trades: ["09 00 00"], contactName: "+1", email: "eve@evil.example.com", phone: "-5", licenseNumber: "@x", licenseState: "CA", status: "active" },
    { name: "Eastbay Electric", trades: ["26 00 00", "27 00 00"], contactName: "Kim Tran", email: "kim@example.com", phone: "(510) 555-0199", licenseNumber: "1098765", licenseState: "CA", status: "active" },
  ]);
  const parsed = Papa.parse<string[]>(csv.trim());
  expect(parsed.data[0]).toEqual(["name", "trades", "contactName", "email", "phone", "licenseNumber", "licenseState", "status"]);
  expect(parsed.data).toHaveLength(3);
  for (const row of parsed.data.slice(1)) for (const cell of row) expect(cell).not.toMatch(/^[=+\-@]/);
  expect(parsed.data[1][0]).toBe(`'=HYPERLINK("http://evil.example","x")`);
  expect(parsed.data[2][1]).toBe("26 00 00; 27 00 00");
});

test("import: wrong header and oversize files are refused with a readable message", async () => {
  const wrong = await parseVendorCsv(new File(["company,email\nA,a@b.com\n"], "v.csv"), []);
  expect(wrong).toEqual({ ok: false, message: expect.stringMatching(/The CSV header must be: name,trades/) });
  const big = await parseVendorCsv(new File([`${HEADER}\n${"x".repeat(2 * 1024 * 1024)}`], "big.csv"), []);
  expect(big).toEqual({ ok: false, message: expect.stringMatching(/limit is 2 MB/) });
});

test("import: preview shows valid rows, row errors and existing vendors", async () => {
  const text = [
    HEADER,
    "Bay Area Mechanical,23 00 00,Ana,ana@bam.example.com,,,",
    "Peninsula Plumbing,22 00 00,Raj,raj@pp.example.com,,,",
    '"=HYPERLINK(""http://evil.example"",""x"")",09 00 00,Eve,eve@evil.example.com,,,',
    "No Email Co,26 00 00,N,,,,",
    "Vague HVAC,HVAC stuff,V,v@vh.example.com,,,",
    "Eastbay Electric,26 00 00,Kim,KIM@example.com,,,",
  ].join("\r\n");
  const res = await parseVendorCsv(new File([text], "v.csv"), ["kim@example.com"]);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.preview.valid.map((r) => r.vendor.name)).toEqual(["Bay Area Mechanical", "Peninsula Plumbing", '=HYPERLINK("http://evil.example","x")']);
  expect(res.preview.errors.map((e) => e.message)).toEqual([
    "Row 4: email is required.",
    'Row 5: "HVAC stuff" is not a CSI division. Use the format NN NN NN, for example 26 00 00.',
  ]);
  expect(res.preview.duplicates.map((d) => d.row)).toEqual([6]);
});
