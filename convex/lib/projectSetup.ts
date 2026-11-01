/**
 * Project setup rules (architecture §14) shared by the New project wizard, Project settings and
 * the `projects.createProject` / `projects.updateProject` mutations. Pure TS.
 */
import { US_STATES } from "./companyProfile";
import { checkRetainage, MAX_RETAINAGE_BPS } from "./retainageRules";

const STATE_CODES = new Set(US_STATES.map((s) => s.code));
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** $1 billion; keeps contract values well inside safe integers and PayPal limits. */
export const MAX_CONTRACT_VALUE_CENTS = 100_000_000_000;

export type ProjectSetupInput = {
  title: string;
  ownerName: string;
  address: { line1: string; city: string; zip: string };
  state: string;
  /** Integer cents; null when the field is empty or unparseable. */
  contractValueCents: number | null;
  /** Basis points; null when empty or unparseable. */
  retainageBps: number | null;
  billingDay: number | null;
  /** `YYYY-MM-DD`. */
  startDate: string;
  substantialCompletionDate?: string;
};

export type ProjectSetupField =
  | "title"
  | "ownerName"
  | "line1"
  | "city"
  | "state"
  | "zip"
  | "contractValueCents"
  | "retainageBps"
  | "billingDay"
  | "startDate"
  | "substantialCompletionDate";

export type ProjectSetupErrors = Partial<Record<ProjectSetupField, string>>;

/** Field order used to pick the first error (top of the form first). */
export const PROJECT_SETUP_FIELDS: ProjectSetupField[] = [
  "title",
  "ownerName",
  "line1",
  "city",
  "state",
  "zip",
  "contractValueCents",
  "retainageBps",
  "billingDay",
  "startDate",
  "substantialCompletionDate",
];

export function isCalendarDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d && y >= 1900 && y <= 2200;
}

function textError(value: string, label: string, max: number): string | undefined {
  const v = value.trim();
  if (v.length === 0) return `Enter the ${label}.`;
  if (v.length > max) return `${label[0].toUpperCase()}${label.slice(1)} must be at most ${max} characters.`;
  return undefined;
}

export function validateProjectSetup(input: ProjectSetupInput): ProjectSetupErrors {
  const errors: ProjectSetupErrors = {};
  const title = textError(input.title, "project name", 160);
  if (title) errors.title = title;
  const owner = textError(input.ownerName, "owner name", 160);
  if (owner) errors.ownerName = owner;
  const line1 = textError(input.address.line1, "street address", 200);
  if (line1) errors.line1 = line1;
  const city = textError(input.address.city, "city", 100);
  if (city) errors.city = city;
  const state = input.state.trim().toUpperCase();
  if (!STATE_CODES.has(state)) errors.state = "Choose the project's state.";
  if (!/^\d{5}(-\d{4})?$/.test(input.address.zip.trim())) errors.zip = "Enter a 5-digit ZIP code.";

  const cv = input.contractValueCents;
  if (cv === null) errors.contractValueCents = "Enter the contract value.";
  else if (!Number.isSafeInteger(cv)) errors.contractValueCents = "Contract value must be a whole number of cents.";
  else if (cv <= 0) errors.contractValueCents = "Contract value must be greater than $0.00.";
  else if (cv > MAX_CONTRACT_VALUE_CENTS) errors.contractValueCents = "Contract value can't be more than $1,000,000,000.00.";

  const r = input.retainageBps;
  if (r === null) errors.retainageBps = "Enter the retainage percent.";
  else if (!Number.isSafeInteger(r)) errors.retainageBps = "Retainage must be a percent with at most two decimals.";
  else if (r < 0 || r > MAX_RETAINAGE_BPS) errors.retainageBps = "Retainage must be between 0% and 100%.";
  else if (STATE_CODES.has(state) && errors.contractValueCents === undefined) {
    const check = checkRetainage(state, cv, r);
    if (!check.ok) errors.retainageBps = check.message;
  }

  const bd = input.billingDay;
  if (bd === null || !Number.isInteger(bd) || bd < 1 || bd > 28) errors.billingDay = "Billing day must be between 1 and 28.";

  if (!isCalendarDate(input.startDate)) errors.startDate = "Enter the start date.";
  const sc = input.substantialCompletionDate ?? "";
  if (sc !== "") {
    if (!isCalendarDate(sc)) errors.substantialCompletionDate = "Enter a valid date.";
    else if (errors.startDate === undefined && sc < input.startDate) {
      errors.substantialCompletionDate = "Substantial completion can't be before the start date.";
    }
  }
  return errors;
}

export function firstProjectSetupError(errors: ProjectSetupErrors): { field: ProjectSetupField; message: string } | null {
  for (const field of PROJECT_SETUP_FIELDS) {
    const message = errors[field];
    if (message) return { field, message };
  }
  return null;
}

/** Parses the billing day field: digits only, else null. */
export function parseBillingDay(text: string): number | null {
  const v = text.trim();
  if (!/^\d{1,3}$/.test(v)) return null;
  return Number(v);
}
