/**
 * Compliance rules (architecture §17), pure TS shared by the upload form and convex/compliance:
 * field validation, the file-type check on the uploaded bytes, and the computed compliance state of a
 * vendor on a project (compliant / expiring / expired / missing / not compliant) against the
 * agreement's insurance terms. Dates are YYYY-MM-DD calendar days compared in UTC, like the rest of
 * the app's server-side dates.
 */
import { formatIsoDate, isIsoDate } from "../payApps/g703Math";
import type { CoiFields, ComplianceInput, ComplianceKind, LicenseInput, W9EntityType, W9Fields } from "../compliance/validators";
import type { AgreementTerms } from "./agreementTerms";
import { US_STATES } from "./companyProfile";
import { formatCents } from "./money";

export const MAX_COMPLIANCE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_COMPLIANCE_FILE_LABEL = "10 MB";
export const FILE_TYPE_ERROR = "This file isn't a valid PDF, PNG or JPEG. Upload a PDF, PNG or JPEG file.";
export const EXPIRING_WINDOW_DAYS = 30;
export const REJECTION_REASON_MAX = 500;
/** $1 billion: keeps limits far inside safe integers. */
const MAX_LIMIT_CENTS = 100_000_000_000;
const TEXT_MAX = 120;

export const COMPLIANCE_KIND_LABEL: Record<ComplianceKind, string> = {
  coi: "Certificate of insurance",
  w9: "W-9",
  license: "Contractor license",
};

export const W9_ENTITY_LABEL: Record<W9EntityType, string> = {
  individual: "Individual / sole proprietor",
  c_corporation: "C corporation",
  s_corporation: "S corporation",
  partnership: "Partnership",
  trust_estate: "Trust / estate",
  llc_c: "LLC taxed as C corporation",
  llc_s: "LLC taxed as S corporation",
  llc_p: "LLC taxed as partnership",
  other: "Other",
};

const STATE_CODES = new Set(US_STATES.map((s) => s.code));

export function fileTooLargeMessage(sizeBytes: number): string {
  const mb = (sizeBytes / (1024 * 1024)).toFixed(1);
  return `This file is ${mb} MB. The limit is ${MAX_COMPLIANCE_FILE_LABEL}.`;
}

export type SniffedContentType = "application/pdf" | "image/png" | "image/jpeg";

/** The file type from its first bytes; the file name and the browser's content type are ignored. */
export function sniffContentType(head: Uint8Array): SniffedContentType | null {
  const starts = (sig: number[]) => head.length >= sig.length && sig.every((b, i) => head[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  return null;
}

export const EXTENSION_FOR: Record<SniffedContentType, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
};

/** A safe stored file name: the uploaded base name with the extension of the real file type. */
export function storedFileName(original: string, contentType: SniffedContentType): string {
  const base = original.replace(/\.[^./\\]*$/, "").replace(/[^A-Za-z0-9._ -]/g, "_").trim().slice(0, 80) || "document";
  return `${base}.${EXTENSION_FOR[contentType]}`;
}

/** The last four digits of a TIN typed in the browser; null unless exactly 9 digits were entered. */
export function tinLast4(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 9 ? digits.slice(5) : null;
}

export function todayIso(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function dayNumber(iso: string): number {
  return Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000);
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysUntil(fromIso: string, toIso: string): number {
  return dayNumber(toIso) - dayNumber(fromIso);
}

export type ComplianceFieldErrors = Record<string, string>;

function requiredText(errors: ComplianceFieldErrors, key: string, value: string | undefined, label: string): void {
  const v = (value ?? "").trim();
  if (v === "") errors[key] = `${label} is required.`;
  else if (v.length > TEXT_MAX) errors[key] = `${label} must be ${TEXT_MAX} characters or fewer.`;
}

function optionalText(errors: ComplianceFieldErrors, key: string, value: string | undefined, label: string): void {
  if (value !== undefined && value.trim().length > TEXT_MAX) errors[key] = `${label} must be ${TEXT_MAX} characters or fewer.`;
}

function limit(errors: ComplianceFieldErrors, key: string, cents: number, label: string): void {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_LIMIT_CENTS) errors[key] = `${label} must be a dollar amount.`;
}

function date(errors: ComplianceFieldErrors, key: string, value: string, label: string): boolean {
  if (!isIsoDate(value)) {
    errors[key] = `${label} is required.`;
    return false;
  }
  return true;
}

export function validateCoi(coi: CoiFields): ComplianceFieldErrors {
  const errors: ComplianceFieldErrors = {};
  requiredText(errors, "insurer", coi.insurer, "Insurer");
  requiredText(errors, "glPolicyNumber", coi.glPolicyNumber, "GL policy number");
  optionalText(errors, "autoPolicyNumber", coi.autoPolicyNumber, "Auto policy number");
  optionalText(errors, "umbrellaPolicyNumber", coi.umbrellaPolicyNumber, "Umbrella policy number");
  optionalText(errors, "wcPolicyNumber", coi.wcPolicyNumber, "Workers' comp policy number");
  limit(errors, "glEachOccurrenceCents", coi.glEachOccurrenceCents, "GL each occurrence");
  limit(errors, "glAggregateCents", coi.glAggregateCents, "GL aggregate");
  limit(errors, "autoCents", coi.autoCents, "Auto liability");
  limit(errors, "umbrellaCents", coi.umbrellaCents, "Umbrella");
  const eff = date(errors, "effectiveDate", coi.effectiveDate, "Effective date");
  const exp = date(errors, "expiryDate", coi.expiryDate, "Expiry date");
  if (eff && exp && coi.expiryDate <= coi.effectiveDate) errors.expiryDate = "Expiry date must be after the effective date.";
  return errors;
}

export function validateW9(w9: W9Fields, today: string): ComplianceFieldErrors {
  const errors: ComplianceFieldErrors = {};
  if (!(w9.entityType in W9_ENTITY_LABEL)) errors.entityType = "Entity type is required.";
  if (!/^\d{4}$/.test(w9.tinLast4)) errors.tin = "Enter the 9-digit TIN (EIN or SSN).";
  if (date(errors, "signedDate", w9.signedDate, "Signed date") && w9.signedDate > today) {
    errors.signedDate = "Signed date can't be in the future.";
  }
  return errors;
}

export function validateLicense(license: LicenseInput): ComplianceFieldErrors {
  const errors: ComplianceFieldErrors = {};
  requiredText(errors, "licenseNumber", license.licenseNumber, "License number");
  requiredText(errors, "classification", license.classification, "Classification");
  if (!STATE_CODES.has(license.state.trim().toUpperCase())) errors.state = "State is required.";
  date(errors, "expiryDate", license.expiryDate, "Expiry date");
  return errors;
}

export function validateComplianceInput(input: ComplianceInput, today: string): ComplianceFieldErrors {
  if (input.kind === "coi") return validateCoi(input.coi);
  if (input.kind === "w9") return validateW9(input.w9, today);
  return validateLicense(input.license);
}

/** Trimmed copy of the input as stored. */
export function normalizeComplianceInput(input: ComplianceInput): ComplianceInput {
  if (input.kind === "coi") {
    const { autoPolicyNumber, umbrellaPolicyNumber, wcPolicyNumber, ...c } = input.coi;
    const coi: CoiFields = { ...c, insurer: c.insurer.trim(), glPolicyNumber: c.glPolicyNumber.trim() };
    if (autoPolicyNumber?.trim()) coi.autoPolicyNumber = autoPolicyNumber.trim();
    if (umbrellaPolicyNumber?.trim()) coi.umbrellaPolicyNumber = umbrellaPolicyNumber.trim();
    if (wcPolicyNumber?.trim()) coi.wcPolicyNumber = wcPolicyNumber.trim();
    return { kind: "coi", coi };
  }
  if (input.kind === "w9") return { kind: "w9", w9: { ...input.w9 } };
  const l = input.license;
  return {
    kind: "license",
    license: {
      licenseNumber: l.licenseNumber.trim(),
      state: l.state.trim().toUpperCase(),
      classification: l.classification.trim(),
      expiryDate: l.expiryDate,
    },
  };
}

export function firstComplianceError(errors: ComplianceFieldErrors): string | null {
  const first = Object.values(errors)[0];
  return first ?? null;
}

// ---------------------------------------------------------------------------------------------
// Computed state

export type InsuranceRequirements = AgreementTerms["insurance"];

export type ComplianceRecord = {
  kind: ComplianceKind;
  status: "pending_review" | "accepted" | "rejected";
  createdAt: number;
  coi?: CoiFields;
  w9?: W9Fields;
  license?: { licenseNumber: string; state: string; classification: string; expiryDate: string };
};

export type ComputedStatus = "compliant" | "expiring" | "expired" | "missing" | "non_compliant";

export type ComplianceReasonCode = "missing" | "expired" | "expiring" | "below_limit" | "coverage_missing" | "not_yet_effective";

export type ComplianceReason = { kind: ComplianceKind; code: ComplianceReasonCode; message: string };

export type ComplianceResult<T extends ComplianceRecord> = {
  status: ComputedStatus;
  reasons: ComplianceReason[];
  /** The accepted record of each kind that counts (the newest accepted one). */
  current: Partial<Record<ComplianceKind, T>>;
  /** Per kind: the state of that requirement. */
  byKind: Record<ComplianceKind, ComputedStatus>;
};

const KINDS: ComplianceKind[] = ["coi", "w9", "license"];

function expiryState(kind: ComplianceKind, expiryDate: string, today: string, out: ComplianceReason[]): ComputedStatus {
  const days = daysUntil(today, expiryDate);
  const label = COMPLIANCE_KIND_LABEL[kind];
  if (days < 0) {
    out.push({ kind, code: "expired", message: `${label} expired on ${formatIsoDate(expiryDate)}.` });
    return "expired";
  }
  if (days <= EXPIRING_WINDOW_DAYS) {
    const when = days === 0 ? "today" : days === 1 ? "in 1 day" : `in ${days} days`;
    out.push({ kind, code: "expiring", message: `${label} expires ${when} (${formatIsoDate(expiryDate)}).` });
    return "expiring";
  }
  return "compliant";
}

function coiShortfalls(coi: CoiFields, req: InsuranceRequirements, today: string, out: ComplianceReason[]): boolean {
  const before = out.length;
  const check = (have: number, need: number, label: string) => {
    if (have < need) {
      out.push({ kind: "coi", code: "below_limit", message: `${label} ${formatCents(have)} is below the required ${formatCents(need)}.` });
    }
  };
  check(coi.glEachOccurrenceCents, req.glEachOccurrenceCents, "GL each occurrence");
  check(coi.glAggregateCents, req.glAggregateCents, "GL aggregate");
  check(coi.autoCents, req.autoCents, "Auto liability");
  check(coi.umbrellaCents, req.umbrellaCents, "Umbrella");
  if (req.workersComp && !coi.workersComp) {
    out.push({ kind: "coi", code: "coverage_missing", message: "Workers' compensation: No. The subcontract requires workers' compensation coverage." });
  }
  if (req.additionalInsured && !coi.additionalInsured) {
    out.push({ kind: "coi", code: "coverage_missing", message: "Additional insured: No. The subcontract requires additional insured status." });
  }
  if (coi.effectiveDate > today) {
    out.push({ kind: "coi", code: "not_yet_effective", message: `Certificate of insurance is not effective until ${formatIsoDate(coi.effectiveDate)}.` });
  }
  return out.length > before;
}

const SEVERITY: ComputedStatus[] = ["expired", "missing", "non_compliant", "expiring", "compliant"];

/**
 * The compliance state of one vendor on one project. Only accepted records count (pending and
 * rejected ones never do); of several accepted records of a kind the newest supersedes the rest.
 * The overall state is the worst requirement: expired, then missing, then not compliant, then
 * expiring (within 30 days, inclusive), else compliant.
 */
export function computeCompliance<T extends ComplianceRecord>(records: T[], requirements: InsuranceRequirements, today: string): ComplianceResult<T> {
  const reasons: ComplianceReason[] = [];
  const current: Partial<Record<ComplianceKind, T>> = {};
  const byKind = {} as Record<ComplianceKind, ComputedStatus>;
  for (const kind of KINDS) {
    const accepted = records
      .filter((r) => r.kind === kind && r.status === "accepted")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (accepted === undefined) {
      reasons.push({ kind, code: "missing", message: `Missing: ${COMPLIANCE_KIND_LABEL[kind]}.` });
      byKind[kind] = "missing";
      continue;
    }
    current[kind] = accepted;
    if (kind === "coi" && accepted.coi) {
      const deficient = coiShortfalls(accepted.coi, requirements, today, reasons);
      const exp = expiryState("coi", accepted.coi.expiryDate, today, reasons);
      byKind.coi = exp === "expired" ? "expired" : deficient ? "non_compliant" : exp;
    } else if (kind === "license" && accepted.license) {
      byKind.license = expiryState("license", accepted.license.expiryDate, today, reasons);
    } else {
      byKind[kind] = "compliant";
    }
  }
  const status = SEVERITY.find((s) => KINDS.some((k) => byKind[k] === s)) ?? "compliant";
  reasons.sort((a, b) => reasonRank(a) - reasonRank(b));
  return { status, reasons, current, byKind };
}

function reasonRank(r: ComplianceReason): number {
  const order: ComplianceReasonCode[] = ["expired", "missing", "below_limit", "coverage_missing", "not_yet_effective", "expiring"];
  return order.indexOf(r.code) * 10 + KINDS.indexOf(r.kind);
}

export const COMPUTED_STATUS_LABEL: Record<ComputedStatus, string> = {
  compliant: "Compliant",
  expiring: "Expiring",
  expired: "Expired",
  missing: "Missing",
  non_compliant: "Not compliant",
};

/** "•••-••-4567": how a stored TIN is shown anywhere in the app. */
export function maskedTin(last4: string): string {
  return `•••-••-${last4}`;
}
