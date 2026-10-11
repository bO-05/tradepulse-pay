import {
  VENDOR_CSV_HEADERS,
  VENDOR_EXPORT_HEADERS,
  VENDOR_IMPORT_MAX_BYTES,
  VENDOR_IMPORT_MAX_ROWS,
  checkVendorCsvHeader,
  previewVendorCsv,
  type VendorCsvPreview,
} from "../../convex/lib/vendorRules";

/** papaparse is loaded only when a CSV is imported or exported, so it stays out of the main bundle. */
async function papa() {
  return (await import("papaparse")).default;
}

export type ParsedVendorCsv = { ok: true; preview: VendorCsvPreview; rowCount: number } | { ok: false; message: string };

export async function parseVendorCsv(file: File, existingEmails: string[]): Promise<ParsedVendorCsv> {
  if (file.size > VENDOR_IMPORT_MAX_BYTES) {
    return { ok: false, message: `This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 2 MB.` };
  }
  if (file.size === 0) return { ok: false, message: "This file is empty." };
  const text = await file.text();
  const Papa = await papa();
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().replace(/^\uFEFF/, ""),
  });
  const header = result.meta.fields ?? [];
  const headerError = checkVendorCsvHeader(header);
  if (headerError) return { ok: false, message: headerError };
  if (result.data.length === 0) return { ok: false, message: "The file has a header but no vendor rows." };
  if (result.data.length > VENDOR_IMPORT_MAX_ROWS) {
    return { ok: false, message: `The file has ${result.data.length} rows. The limit is ${VENDOR_IMPORT_MAX_ROWS} rows per import.` };
  }
  return { ok: true, preview: previewVendorCsv(result.data, existingEmails), rowCount: result.data.length };
}

export type ExportVendor = {
  name: string;
  trades: string[];
  contactName: string;
  email: string;
  phone: string;
  licenseNumber: string;
  licenseState: string;
  status: string;
};

/** CSV text with cells starting with = + - @ (and tab/CR) prefixed by an apostrophe. */
export async function vendorsToCsv(vendors: ExportVendor[]): Promise<string> {
  const Papa = await papa();
  return Papa.unparse(
    {
      fields: [...VENDOR_EXPORT_HEADERS],
      data: vendors.map((v) => [v.name, v.trades.join("; "), v.contactName, v.email, v.phone, v.licenseNumber, v.licenseState, v.status]),
    },
    { escapeFormulae: true, quotes: true, newline: "\r\n" },
  );
}

export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob([`\uFEFF${csv}\r\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const VENDOR_CSV_TEMPLATE_HEADER = VENDOR_CSV_HEADERS.join(",");
