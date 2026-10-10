/**
 * Vendor directory rules (architecture §14), shared by convex/vendors.ts and the UI so the form,
 * the CSV import preview and the server agree. Pure TS, no Convex imports.
 */
import { INVALID_EMAIL_MESSAGE, normalizeInviteEmail } from "./inviteRules";

export const VENDOR_CSV_HEADERS = ["name", "trades", "contactName", "email", "phone", "licenseNumber", "licenseState"] as const;
export const VENDOR_EXPORT_HEADERS = [...VENDOR_CSV_HEADERS, "status"] as const;
export const VENDOR_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const VENDOR_IMPORT_MAX_ROWS = 1000;
export const DUPLICATE_VENDOR_EMAIL_MESSAGE = "A vendor with this email already exists.";

export type VendorField = "name" | "trades" | "contactName" | "email" | "phone" | "licenseNumber" | "licenseState";

export type VendorInput = {
  name: string;
  trades: string[];
  contactName: string;
  email: string;
  phone?: string;
  licenseNumber?: string;
  licenseState?: string;
};

export type VendorValidation = { ok: true; value: VendorInput } | { ok: false; errors: Partial<Record<VendorField, string>> };

const CSI_PATTERN = /^\d{2} \d{2} \d{2}$/;
const STATE_PATTERN = /^[A-Z]{2}$/;
const PHONE_PATTERN = /^[0-9()+.\-\s x]{7,30}$/i;
const LICENSE_PATTERN = /^[A-Za-z0-9\-./ ]{1,40}$/;
const INVISIBLE_CONTROL = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

function clean(value: string | undefined | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

/** "26 00 00"; also accepts "260000" and extra spaces. Returns null when the code is not a CSI division. */
export function normalizeTrade(raw: string): string | null {
  const compact = raw.trim().replace(/\s+/g, " ");
  const digits = /^\d{6}$/.test(compact) ? `${compact.slice(0, 2)} ${compact.slice(2, 4)} ${compact.slice(4, 6)}` : compact;
  if (!CSI_PATTERN.test(digits)) return null;
  const division = Number.parseInt(digits.slice(0, 2), 10);
  if (division < 0 || division > 49) return null;
  return digits;
}

/** A CSV trades cell: codes separated by ";", "|" or ",". */
export function splitTrades(cell: string): string[] {
  return cell
    .split(/[;|,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Placeholder addresses of discovered bidders whose contact is not published; never treated as a vendor identity. */
export function isPlaceholderEmail(email: string): boolean {
  return /\.invalid$/i.test(email.trim());
}

export function validateVendorInput(raw: {
  name?: string;
  trades?: string[];
  contactName?: string;
  email?: string;
  phone?: string;
  licenseNumber?: string;
  licenseState?: string;
}): VendorValidation {
  const errors: Partial<Record<VendorField, string>> = {};
  const name = clean(raw.name);
  if (name.length === 0) errors.name = "Enter the vendor's company name.";
  else if (name.length < 2 || name.length > 120) errors.name = "Company name must be 2–120 characters.";
  else if (INVISIBLE_CONTROL.test(raw.name ?? "")) errors.name = "Company name contains unsupported invisible characters.";

  const trades: string[] = [];
  const rawTrades = (raw.trades ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (rawTrades.length === 0) errors.trades = "Add at least one trade (CSI division, for example 26 00 00).";
  for (const t of rawTrades) {
    const normalized = normalizeTrade(t);
    if (normalized === null) {
      errors.trades = `"${t}" is not a CSI division. Use the format NN NN NN, for example 26 00 00.`;
      break;
    }
    if (!trades.includes(normalized)) trades.push(normalized);
  }
  if (trades.length > 20) errors.trades = "Add at most 20 trades.";

  const contactName = clean(raw.contactName);
  if (contactName.length > 120) errors.contactName = "Contact name must be at most 120 characters.";
  else if (INVISIBLE_CONTROL.test(raw.contactName ?? "")) errors.contactName = "Contact name contains unsupported invisible characters.";

  const emailRaw = (raw.email ?? "").trim();
  const email = normalizeInviteEmail(emailRaw);
  if (emailRaw.length === 0) errors.email = "Email is required.";
  else if (email === null) errors.email = INVALID_EMAIL_MESSAGE;

  const phone = clean(raw.phone);
  if (phone && !PHONE_PATTERN.test(phone)) errors.phone = "Enter a phone number like (510) 555-0142.";

  const licenseNumber = clean(raw.licenseNumber);
  if (licenseNumber && !LICENSE_PATTERN.test(licenseNumber)) {
    errors.licenseNumber = "License number may use letters, digits, spaces and - . / (up to 40 characters).";
  }
  const licenseState = clean(raw.licenseState).toUpperCase();
  if (licenseState && !STATE_PATTERN.test(licenseState)) errors.licenseState = "Use the 2-letter state code, for example CA.";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      trades,
      contactName,
      email: email!,
      ...(phone ? { phone } : {}),
      ...(licenseNumber ? { licenseNumber } : {}),
      ...(licenseState ? { licenseState } : {}),
    },
  };
}

/** First error of a failed validation, in field order, for one-line messages (CSV row errors). */
export function firstVendorError(errors: Partial<Record<VendorField, string>>): string {
  for (const field of VENDOR_CSV_HEADERS) {
    const message = errors[field];
    if (message) return message;
  }
  return "Invalid row.";
}

export type CsvRowError = { row: number; message: string };
export type CsvPreviewRow = { row: number; vendor: VendorInput };
export type VendorCsvPreview = {
  valid: CsvPreviewRow[];
  duplicates: { row: number; name: string; email: string }[];
  errors: CsvRowError[];
};

/** Lowercased header check; the column order may differ but every column must be present and no extra ones. */
export function checkVendorCsvHeader(header: string[]): string | null {
  const got = header.map((h) => h.trim().replace(/^\uFEFF/, ""));
  const missing = VENDOR_CSV_HEADERS.filter((h) => !got.includes(h));
  const extra = got.filter((h) => h.length > 0 && !(VENDOR_CSV_HEADERS as readonly string[]).includes(h));
  if (missing.length === 0 && extra.length === 0) return null;
  const parts = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
  if (extra.length > 0) parts.push(`unexpected ${extra.join(", ")}`);
  return `The CSV header must be: ${VENDOR_CSV_HEADERS.join(",")} (${parts.join("; ")}).`;
}

/**
 * Validates parsed CSV records (header row excluded). Row numbers are the spreadsheet row numbers
 * of the data rows counted from 1, so the first data row is "Row 1".
 */
export function previewVendorCsv(records: Record<string, string>[], existingEmails: Iterable<string>): VendorCsvPreview {
  const known = new Set([...existingEmails].map((e) => e.toLowerCase()));
  const seenInFile = new Set<string>();
  const out: VendorCsvPreview = { valid: [], duplicates: [], errors: [] };
  records.forEach((record, index) => {
    const row = index + 1;
    const result = validateVendorInput({
      name: record.name,
      trades: splitTrades(record.trades ?? ""),
      contactName: record.contactName,
      email: record.email,
      phone: record.phone,
      licenseNumber: record.licenseNumber,
      licenseState: record.licenseState,
    });
    if (!result.ok) {
      out.errors.push({ row, message: `Row ${row}: ${lowerFirst(firstVendorError(result.errors))}` });
      return;
    }
    const email = result.value.email;
    if (known.has(email)) {
      out.duplicates.push({ row, name: result.value.name, email });
      return;
    }
    if (seenInFile.has(email)) {
      out.errors.push({ row, message: `Row ${row}: the email ${email} appears earlier in this file.` });
      return;
    }
    seenInFile.add(email);
    out.valid.push({ row, vendor: result.value });
  });
  return out;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
