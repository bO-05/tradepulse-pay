import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { formatIsoDate } from "../payApps/g703Math";
import type { ComplianceReason } from "../lib/complianceRules";
import { complianceForAgreement } from "./status";

/**
 * Compliance payment hold (architecture §17): a vendor that is not compliant on the project (a
 * record expired or missing, limits below the subcontract terms, coverage missing or not yet in
 * effect) cannot be paid. Expiring records only warn. A GC company admin may lift the hold for one
 * pay app with a reason (convex/compliance/override.ts).
 */

export const COMPLIANCE_HOLD_CODE = "COMPLIANCE_HOLD";
export const COMPLIANCE_HOLD_PREFIX = "Payment on hold: ";
export const NO_VENDOR_HOLD = "no compliance records can be checked because the subcontractor is not linked to a vendor";
export const OVERRIDE_REASON_MAX = 500;

const MISSING_LABEL: Record<ComplianceReason["kind"], string> = {
  coi: "certificate of insurance",
  w9: "W-9",
  license: "contractor license",
};

/** Lowercases a leading capital unless it starts an abbreviation such as "GL". */
function lowerFirst(s: string): string {
  if (s.length < 2 || s[1] !== s[1].toLowerCase()) return s;
  return s[0].toLowerCase() + s.slice(1);
}

function withoutPeriod(s: string): string {
  return s.replace(/\.\s*$/, "");
}

/** One hold reason in the pay app's wording. */
function holdPart(r: ComplianceReason, result: NonNullable<Awaited<ReturnType<typeof complianceForAgreement>>>["result"]): string {
  if (r.code === "expired") {
    const expiry = r.kind === "coi" ? result.current.coi?.coi?.expiryDate : result.current.license?.license?.expiryDate;
    const what = r.kind === "coi" ? "insurance certificate" : "contractor license";
    return expiry ? `${what} expired on ${formatIsoDate(expiry)}` : `${what} expired`;
  }
  if (r.code === "missing") return `missing ${MISSING_LABEL[r.kind]}`;
  if (r.code === "coverage_missing") {
    return r.message.startsWith("Workers'")
      ? "insurance certificate does not include the required workers' compensation coverage"
      : "insurance certificate does not include the required additional insured status";
  }
  if (r.code === "below_limit") return `insurance ${lowerFirst(withoutPeriod(r.message))}`;
  return lowerFirst(withoutPeriod(r.message));
}

export type ComplianceHold = {
  /** "Payment on hold: …" when the vendor is not compliant; null otherwise. */
  holdMessage: string | null;
  /** Records that expire within 30 days (no hold). */
  warnings: string[];
};

export async function complianceHoldFor(ctx: QueryCtx, agreement: Doc<"agreements">, now: number = Date.now()): Promise<ComplianceHold> {
  const vc = await complianceForAgreement(ctx, agreement, now);
  if (vc === null) return { holdMessage: `${COMPLIANCE_HOLD_PREFIX}${NO_VENDOR_HOLD}`, warnings: [] };
  const blocking = vc.result.reasons.filter((r) => r.code !== "expiring");
  const warnings = vc.result.reasons.filter((r) => r.code === "expiring").map((r) => r.message);
  if (blocking.length === 0) return { holdMessage: null, warnings };
  const parts = [...new Set(blocking.map((r) => holdPart(r, vc.result)))];
  return { holdMessage: `${COMPLIANCE_HOLD_PREFIX}${parts.join("; ")}`, warnings };
}

/** What the pay app shows: the hold, the warnings and the override that lifted the hold, if any. */
export async function payAppCompliance(ctx: QueryCtx, payApp: Doc<"payApplications">, agreement: Doc<"agreements">) {
  const hold = await complianceHoldFor(ctx, agreement);
  const o = payApp.complianceOverride;
  return {
    holdMessage: hold.holdMessage,
    warnings: hold.warnings,
    override: o === undefined ? null : { byName: o.byName, reason: o.reason, at: o.at, holdMessage: o.holdMessage },
    onHold: hold.holdMessage !== null && o === undefined && payApp.status !== "paid",
  };
}
