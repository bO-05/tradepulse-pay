/**
 * Per-agreement subcontract terms (architecture §14): defaults, validation and display text.
 * Pure TS, shared by the Terms editor and `agreementTerms.updateAgreementTerms`.
 */
import { US_STATES } from "./companyProfile";
import { checkRetainage, defaultRetainage, formatRetainagePercent, MAX_RETAINAGE_BPS, NOT_LEGAL_ADVICE, retainageRuleFor } from "./retainageRules";
import { formatCents } from "./money";

export type PaymentTermsType = "net" | "pay_when_paid";

export type AgreementTerms = {
  retainageBps: number;
  retainageReductionBpsAt50?: number;
  paymentTerms: { type: PaymentTermsType; days: number };
  liquidatedDamagesCentsPerDay?: number;
  insurance: {
    glEachOccurrenceCents: number;
    glAggregateCents: number;
    autoCents: number;
    umbrellaCents: number;
    workersComp: boolean;
    additionalInsured: boolean;
  };
  warrantyMonths: number;
  governingState: string;
};

export const DEFAULT_PAYMENT_TERMS = { type: "net" as const, days: 30 };
export const DEFAULT_WARRANTY_MONTHS = 12;
export const DEFAULT_INSURANCE: AgreementTerms["insurance"] = {
  glEachOccurrenceCents: 100_000_000,
  glAggregateCents: 200_000_000,
  autoCents: 100_000_000,
  umbrellaCents: 500_000_000,
  workersComp: true,
  additionalInsured: true,
};

/** $1 billion: keeps limits far inside safe integers. */
const MAX_LIMIT_CENTS = 100_000_000_000;
/** $1,000,000 per day. */
const MAX_LD_CENTS_PER_DAY = 100_000_000;
const MAX_PAYMENT_DAYS = 365;
const MAX_WARRANTY_MONTHS = 120;

const STATE_NAMES = new Map(US_STATES.map((s) => [s.code, s.name]));

export function stateName(code: string | null | undefined): string | null {
  return code ? STATE_NAMES.get(code.trim().toUpperCase()) ?? null : null;
}

export type TermsDefaultsInput = {
  projectState: string | null;
  projectRetainageBps: number | null;
  companyDefaultRetainageBps: number | null;
  contractSumCents: number | null;
};

/** Project retainage first, else the company default lowered to the state cap. */
export function defaultAgreementTerms(input: TermsDefaultsInput): AgreementTerms {
  const fallback = defaultRetainage(input.companyDefaultRetainageBps, input.projectState, input.contractSumCents).bps;
  let retainageBps = input.projectRetainageBps ?? fallback;
  const check = checkRetainage(input.projectState, input.contractSumCents, retainageBps);
  if (!check.ok) retainageBps = check.capBps;
  return {
    retainageBps,
    paymentTerms: { ...DEFAULT_PAYMENT_TERMS },
    insurance: { ...DEFAULT_INSURANCE },
    warrantyMonths: DEFAULT_WARRANTY_MONTHS,
    governingState: (input.projectState ?? "").toUpperCase(),
  };
}

export type TermsField =
  | "retainageBps"
  | "retainageReductionBpsAt50"
  | "paymentTermsType"
  | "paymentTermsDays"
  | "liquidatedDamagesCentsPerDay"
  | "glEachOccurrenceCents"
  | "glAggregateCents"
  | "autoCents"
  | "umbrellaCents"
  | "warrantyMonths"
  | "governingState";

export type TermsErrors = Partial<Record<TermsField, string>>;

export const TERMS_FIELDS: TermsField[] = [
  "retainageBps",
  "retainageReductionBpsAt50",
  "paymentTermsType",
  "paymentTermsDays",
  "liquidatedDamagesCentsPerDay",
  "glEachOccurrenceCents",
  "glAggregateCents",
  "autoCents",
  "umbrellaCents",
  "warrantyMonths",
  "governingState",
];

/** Editor state: numeric fields are null while empty or unparseable. */
export type TermsDraft = {
  retainageBps: number | null;
  retainageReductionBpsAt50: number | null;
  paymentTerms: { type: string; days: number | null };
  liquidatedDamagesCentsPerDay: number | null;
  insurance: {
    glEachOccurrenceCents: number | null;
    glAggregateCents: number | null;
    autoCents: number | null;
    umbrellaCents: number | null;
    workersComp: boolean;
    additionalInsured: boolean;
  };
  warrantyMonths: number | null;
  governingState: string;
};

export type TermsContext = {
  projectState: string | null;
  contractSumCents: number | null;
  /** The prime contract's retainage, for states where a sub's rate cannot exceed it. */
  primeRetainageBps: number | null;
};

function limitError(value: number | null, label: string): string | undefined {
  if (value === null) return `Enter the ${label}.`;
  if (!Number.isSafeInteger(value)) return `${label[0].toUpperCase()}${label.slice(1)} must be a whole number of cents.`;
  if (value < 0) return `${label[0].toUpperCase()}${label.slice(1)} can't be negative.`;
  if (value > MAX_LIMIT_CENTS) return `${label[0].toUpperCase()}${label.slice(1)} can't be more than ${formatCents(MAX_LIMIT_CENTS)}.`;
  return undefined;
}

export function validateAgreementTerms(draft: TermsDraft, ctx: TermsContext): TermsErrors {
  const errors: TermsErrors = {};

  const r = draft.retainageBps;
  if (r === null) errors.retainageBps = "Enter the retainage percent.";
  else if (!Number.isSafeInteger(r)) errors.retainageBps = "Retainage must be a percent with at most two decimals.";
  else if (r < 0 || r > MAX_RETAINAGE_BPS) errors.retainageBps = "Retainage must be between 0% and 100%.";
  else {
    const check = checkRetainage(ctx.projectState, ctx.contractSumCents, r);
    if (!check.ok) errors.retainageBps = check.message;
    else {
      const rule = retainageRuleFor(ctx.projectState);
      if (rule?.subCannotExceedPrime && ctx.primeRetainageBps !== null && r > ctx.primeRetainageBps) {
        errors.retainageBps = `${rule.stateName} does not allow a subcontract's retainage to exceed the prime contract's ${formatRetainagePercent(ctx.primeRetainageBps)} (${rule.citation}). ${NOT_LEGAL_ADVICE}`;
      }
    }
  }

  const red = draft.retainageReductionBpsAt50;
  if (red !== null) {
    if (!Number.isSafeInteger(red) || red < 0) errors.retainageReductionBpsAt50 = "The reduced retainage must be 0% or more.";
    else if (r !== null && Number.isSafeInteger(r) && red > r) {
      errors.retainageReductionBpsAt50 = "The reduced retainage at 50% complete can't be higher than the retainage.";
    }
  }

  if (draft.paymentTerms.type !== "net" && draft.paymentTerms.type !== "pay_when_paid") {
    errors.paymentTermsType = "Choose net or pay-when-paid.";
  }
  const days = draft.paymentTerms.days;
  if (days === null || !Number.isInteger(days) || days < 1 || days > MAX_PAYMENT_DAYS) {
    errors.paymentTermsDays = `Payment days must be a whole number from 1 to ${MAX_PAYMENT_DAYS}.`;
  }

  const ld = draft.liquidatedDamagesCentsPerDay;
  if (ld !== null) {
    if (!Number.isSafeInteger(ld) || ld < 0) errors.liquidatedDamagesCentsPerDay = "Liquidated damages can't be negative.";
    else if (ld > MAX_LD_CENTS_PER_DAY) {
      errors.liquidatedDamagesCentsPerDay = `Liquidated damages can't be more than ${formatCents(MAX_LD_CENTS_PER_DAY)} per day.`;
    }
  }

  const ins = draft.insurance;
  const each = limitError(ins.glEachOccurrenceCents, "general liability each-occurrence limit");
  if (each) errors.glEachOccurrenceCents = each;
  const agg = limitError(ins.glAggregateCents, "general liability aggregate limit");
  if (agg) errors.glAggregateCents = agg;
  else if (!each && ins.glAggregateCents! < ins.glEachOccurrenceCents!) {
    errors.glAggregateCents = "The general liability aggregate can't be lower than the each-occurrence limit.";
  }
  const auto = limitError(ins.autoCents, "auto liability limit");
  if (auto) errors.autoCents = auto;
  const umbrella = limitError(ins.umbrellaCents, "umbrella limit");
  if (umbrella) errors.umbrellaCents = umbrella;

  const w = draft.warrantyMonths;
  if (w === null || !Number.isInteger(w) || w < 0 || w > MAX_WARRANTY_MONTHS) {
    errors.warrantyMonths = `Warranty must be a whole number of months from 0 to ${MAX_WARRANTY_MONTHS}.`;
  }

  if (!STATE_NAMES.has(draft.governingState.trim().toUpperCase())) errors.governingState = "Choose the governing state.";
  return errors;
}

export function firstTermsError(errors: TermsErrors): { field: TermsField; message: string } | null {
  for (const field of TERMS_FIELDS) {
    const message = errors[field];
    if (message) return { field, message };
  }
  return null;
}

export function draftFromTerms(terms: AgreementTerms): TermsDraft {
  return {
    retainageBps: terms.retainageBps,
    retainageReductionBpsAt50: terms.retainageReductionBpsAt50 ?? null,
    paymentTerms: { ...terms.paymentTerms },
    liquidatedDamagesCentsPerDay: terms.liquidatedDamagesCentsPerDay ?? null,
    insurance: { ...terms.insurance },
    warrantyMonths: terms.warrantyMonths,
    governingState: terms.governingState,
  };
}

/** Call only after validateAgreementTerms returned no errors. */
export function termsFromDraft(draft: TermsDraft): AgreementTerms {
  const terms: AgreementTerms = {
    retainageBps: draft.retainageBps!,
    paymentTerms: { type: draft.paymentTerms.type as PaymentTermsType, days: draft.paymentTerms.days! },
    insurance: {
      glEachOccurrenceCents: draft.insurance.glEachOccurrenceCents!,
      glAggregateCents: draft.insurance.glAggregateCents!,
      autoCents: draft.insurance.autoCents!,
      umbrellaCents: draft.insurance.umbrellaCents!,
      workersComp: draft.insurance.workersComp,
      additionalInsured: draft.insurance.additionalInsured,
    },
    warrantyMonths: draft.warrantyMonths!,
    governingState: draft.governingState.trim().toUpperCase(),
  };
  if (draft.retainageReductionBpsAt50 !== null) terms.retainageReductionBpsAt50 = draft.retainageReductionBpsAt50;
  if (draft.liquidatedDamagesCentsPerDay !== null) terms.liquidatedDamagesCentsPerDay = draft.liquidatedDamagesCentsPerDay;
  return terms;
}

export function paymentTermsText(p: AgreementTerms["paymentTerms"]): string {
  return p.type === "pay_when_paid" ? `pay-when-paid, ${p.days} days` : `net ${p.days} days`;
}

export function retainageText(terms: Pick<AgreementTerms, "retainageBps" | "retainageReductionBpsAt50">): string {
  const base = formatRetainagePercent(terms.retainageBps);
  return terms.retainageReductionBpsAt50 === undefined
    ? base
    : `${base}, reduced to ${formatRetainagePercent(terms.retainageReductionBpsAt50)} at 50% complete`;
}

export function liquidatedDamagesText(cents: number | undefined): string {
  return cents === undefined ? "None stated" : `${formatCents(cents)} per day`;
}

export function warrantyText(months: number): string {
  return `${months} ${months === 1 ? "month" : "months"}`;
}
