/**
 * State retainage caps for private projects (research/documents-waivers-research.md §5).
 * Informational; not legal advice. Reviewed: 2026-10-08. Pure TS, shared by the client and server.
 */

export type RetainageRule = {
  state: string;
  stateName: string;
  /** Basis points; null = no statutory private cap. */
  privateCapBps: number | null;
  base: "per_payment" | "per_payment_and_contract" | "work_completed" | "contract_sum" | null;
  /** ISO date of contract execution the rule applies from. */
  appliesToContractsOnOrAfter?: string;
  /** The cap applies only to contracts of at least this many cents. */
  minContractCents?: number;
  subCannotExceedPrime?: boolean;
  exceptions?: string[];
  /** e.g. TX owner reserved funds. */
  ownerReserveBps?: number;
  citation: string;
  /** Open question for counsel. */
  verify?: string;
};

export const RETAINAGE_RULES: RetainageRule[] = [
  {
    state: "CA",
    stateName: "California",
    privateCapBps: 500,
    base: "per_payment_and_contract",
    appliesToContractsOnOrAfter: "2026-01-01",
    subCannotExceedPrime: true,
    exceptions: ["sub_failed_to_furnish_requested_bond", "residential_not_mixed_use_max_4_stories"],
    citation: "Cal. Civ. Code §8811 (SB 61, 2025)",
  },
  {
    state: "TX",
    stateName: "Texas",
    privateCapBps: null,
    base: null,
    ownerReserveBps: 1000,
    citation: "Tex. Prop. Code §53.101 (reserved funds); public: Gov. Code §2252.032",
  },
  {
    state: "AZ",
    stateName: "Arizona",
    privateCapBps: null,
    base: null,
    citation: "A.R.S. §32-1129.01 (no fixed private cap)",
    verify: "confirm no private % cap",
  },
  {
    state: "NV",
    stateName: "Nevada",
    privateCapBps: 500,
    base: "per_payment",
    appliesToContractsOnOrAfter: "2016-01-01",
    citation: "NRS 624.609(2)(a)(1), 624.624(2)(a)(1)",
  },
  {
    state: "WA",
    stateName: "Washington",
    privateCapBps: 500,
    base: "work_completed",
    appliesToContractsOnOrAfter: "2023-07-23",
    exceptions: ["public_works", "small_single_family_residential"],
    citation: "SB 5528 (2023), new chapter in Title 60 RCW",
    verify: "codified RCW section and residential exclusion wording",
  },
  {
    state: "OR",
    stateName: "Oregon",
    privateCapBps: 500,
    base: "work_completed",
    citation: "ORS 701.420(1)",
    verify: "ORS 701.410 scope",
  },
  {
    state: "NY",
    stateName: "New York",
    privateCapBps: 500,
    base: "contract_sum",
    minContractCents: 150_000_00,
    appliesToContractsOnOrAfter: "2023-11-17",
    citation: "N.Y. Gen. Bus. Law §756-c (S3539 2023; S5655 2025, non-waivable for contracts on/after 2025-12-19)",
  },
  {
    state: "FL",
    stateName: "Florida",
    privateCapBps: null,
    base: null,
    citation: "No private cap; public Fla. Stat. §§255.078, 218.735",
    verify: "confirm no private cap",
  },
  {
    state: "CO",
    stateName: "Colorado",
    privateCapBps: 500,
    base: "work_completed",
    appliesToContractsOnOrAfter: "2021-09-07",
    minContractCents: 150_000_00,
    citation: "C.R.S. §38-46-103 (HB 21-1167)",
    verify: "$150k threshold in §38-46-102",
  },
];

/** Company default when the GC has not set one. */
export const DEFAULT_COMPANY_RETAINAGE_BPS = 1000;
export const MAX_RETAINAGE_BPS = 10_000;

export const NOT_LEGAL_ADVICE = "This is general information, not legal advice.";

export function retainageRuleFor(state: string | null | undefined): RetainageRule | null {
  const code = (state ?? "").trim().toUpperCase();
  return RETAINAGE_RULES.find((r) => r.state === code) ?? null;
}

function percentText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = (bps % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}%`;
}

function dollarsText(cents: number): string {
  const dollars = Math.floor(cents / 100);
  return `$${dollars.toLocaleString("en-US")}.${(cents % 100).toString().padStart(2, "0")}`;
}

/**
 * The cap that applies to this state and contract value, or null when none applies. A threshold
 * state with an unknown contract value is treated as capped, so defaults never start above the cap.
 */
export function effectiveRetainageCapBps(state: string | null | undefined, contractValueCents: number | null): number | null {
  const rule = retainageRuleFor(state);
  if (rule === null || rule.privateCapBps === null) return null;
  if (rule.minContractCents !== undefined && contractValueCents !== null && contractValueCents < rule.minContractCents) {
    return null;
  }
  return rule.privateCapBps;
}

function capScope(rule: RetainageRule): string {
  return rule.minContractCents !== undefined
    ? `on private contracts of ${dollarsText(rule.minContractCents)} or more`
    : "on private projects";
}

export type RetainageCheck =
  | { ok: true; note: string | null }
  | { ok: false; capBps: number; message: string };

/** Blocks a rate above the state's cap with a message citing the rule; otherwise an optional note. */
export function checkRetainage(
  state: string | null | undefined,
  contractValueCents: number | null,
  retainageBps: number,
): RetainageCheck {
  const rule = retainageRuleFor(state);
  if (rule === null) return { ok: true, note: null };
  const cap = effectiveRetainageCapBps(state, contractValueCents);
  if (cap !== null && retainageBps > cap) {
    return {
      ok: false,
      capBps: cap,
      message: `${rule.stateName} caps retainage at ${percentText(cap)} ${capScope(rule)} (${rule.citation}). Enter ${percentText(cap)} or less. ${NOT_LEGAL_ADVICE}`,
    };
  }
  if (rule.privateCapBps === null) {
    return { ok: true, note: `${rule.stateName} has no statutory cap on private retainage (${rule.citation}). ${NOT_LEGAL_ADVICE}` };
  }
  if (cap === null) {
    return {
      ok: true,
      note: `${rule.stateName}'s ${percentText(rule.privateCapBps)} retainage cap applies ${capScope(rule)} (${rule.citation}). ${NOT_LEGAL_ADVICE}`,
    };
  }
  return {
    ok: true,
    note: `${rule.stateName} caps retainage at ${percentText(cap)} ${capScope(rule)} (${rule.citation}). ${NOT_LEGAL_ADVICE}`,
  };
}

export type RetainageDefault = { bps: number; loweredToCap: boolean; companyDefaultBps: number; capBps: number | null };

/** Default retainage = min(company default, state cap). */
export function defaultRetainage(
  companyDefaultBps: number | null | undefined,
  state: string | null | undefined,
  contractValueCents: number | null,
): RetainageDefault {
  const companyDefault = companyDefaultBps ?? DEFAULT_COMPANY_RETAINAGE_BPS;
  const cap = effectiveRetainageCapBps(state, contractValueCents);
  if (cap !== null && cap < companyDefault) return { bps: cap, loweredToCap: true, companyDefaultBps: companyDefault, capBps: cap };
  return { bps: companyDefault, loweredToCap: false, companyDefaultBps: companyDefault, capBps: cap };
}

export function formatRetainagePercent(bps: number): string {
  return percentText(bps);
}
