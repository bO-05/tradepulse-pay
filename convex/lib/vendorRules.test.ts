import { describe, expect, test } from "vitest";
import { checkVendorCsvHeader, normalizeTrade, previewVendorCsv, splitTrades, validateVendorInput } from "./vendorRules";

const kim = {
  name: "Eastbay Electric",
  trades: ["26 00 00"],
  contactName: "Kim Tran",
  email: "Kim@Example.com",
  phone: "(510) 555-0142",
  licenseNumber: "1098765",
  licenseState: "ca",
};

describe("validateVendorInput", () => {
  test("accepts a complete vendor and normalizes email and state", () => {
    const r = validateVendorInput(kim);
    expect(r).toEqual({ ok: true, value: { ...kim, email: "kim@example.com", licenseState: "CA" } });
  });

  test("blocks blank name, bad email, non-CSI trade and bad state with field errors", () => {
    const r = validateVendorInput({ ...kim, name: " ", email: "kim@", trades: ["Electric"], licenseState: "Calif" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["email", "licenseState", "name", "trades"]);
    expect(r.errors.trades).toMatch(/"Electric" is not a CSI division/);
  });

  test("requires an email and at least one trade", () => {
    const r = validateVendorInput({ ...kim, email: "", trades: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.email).toBe("Email is required.");
      expect(r.errors.trades).toMatch(/at least one trade/);
    }
  });

  test("keeps formula-looking names as plain text", () => {
    const r = validateVendorInput({ ...kim, name: '=HYPERLINK("http://evil.example","x")' });
    expect(r.ok && r.value.name).toBe('=HYPERLINK("http://evil.example","x")');
  });
});

test("trade parsing", () => {
  expect(normalizeTrade("260000")).toBe("26 00 00");
  expect(normalizeTrade(" 26  00 00 ")).toBe("26 00 00");
  expect(normalizeTrade("HVAC stuff")).toBeNull();
  expect(normalizeTrade("99 00 00")).toBeNull();
  expect(splitTrades("26 00 00; 27 00 00|28 00 00")).toEqual(["26 00 00", "27 00 00", "28 00 00"]);
});

test("CSV header check names missing and unexpected columns", () => {
  expect(checkVendorCsvHeader(["name", "trades", "contactName", "email", "phone", "licenseNumber", "licenseState"])).toBeNull();
  expect(checkVendorCsvHeader(["\uFEFFname", "trades", "contactName", "email", "phone", "licenseNumber", "licenseState"])).toBeNull();
  expect(checkVendorCsvHeader(["company", "trades"])).toMatch(/missing name, contactName, email, phone, licenseNumber, licenseState; unexpected company/);
});

test("CSV preview: valid rows, per-row errors, duplicates against the directory and within the file", () => {
  const rec = (name: string, trades: string, email: string) => ({ name, trades, contactName: "C", email, phone: "", licenseNumber: "", licenseState: "" });
  const preview = previewVendorCsv(
    [
      rec("Bay Area Mechanical", "23 00 00", "bam@example.com"),
      rec("Peninsula Plumbing", "22 00 00", "pp@example.com"),
      rec("Delta Drywall", "09 00 00", "dd@example.com"),
      rec("No Email Co", "26 00 00", ""),
      rec("Vague HVAC", "HVAC stuff", "vh@example.com"),
      rec("Existing Co", "26 00 00", "Known@Example.com"),
      rec("Repeat Co", "26 00 00", "bam@example.com"),
    ],
    ["known@example.com"],
  );
  expect(preview.valid.map((v) => v.row)).toEqual([1, 2, 3]);
  expect(preview.errors).toEqual([
    { row: 4, message: "Row 4: email is required." },
    { row: 5, message: 'Row 5: "HVAC stuff" is not a CSI division. Use the format NN NN NN, for example 26 00 00.' },
    { row: 7, message: "Row 7: the email bam@example.com appears earlier in this file." },
  ]);
  expect(preview.duplicates).toEqual([{ row: 6, name: "Existing Co", email: "known@example.com" }]);
});
