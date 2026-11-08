/**
 * The residential/commercial vocabulary layer (architecture §5).
 *
 * `projects.projectKind` is the only switch: a missing value is commercial, so every project that
 * predates the field keeps today's AIA wording. These are display terms only — schema field names,
 * status codes, routes, data-testids and CSV/PDF contracts never change with the kind.
 *
 * This module is deliberately pure so the Convex side can import it for generated labels and the
 * client can re-export it from `src/lib/terms.ts`. One source of truth, no drift between the two.
 */

export type ProjectKind = "residential" | "commercial";

export type DrawColumns = {
  /** The line's total completed work to date. */
  workCompleted: string;
  /** What earlier applications already paid. */
  previouslyPaid: string;
  /** The amount billed in this application. */
  thisDraw: string;
  retainage: string;
};

export type Terms = {
  kind: ProjectKind;
  /** "Draw" on a residential job, "Owner pay app" on a commercial one. */
  ownerBill: string;
  ownerBills: string;
  /** Titled singular noun; components append the application number ("Draw #1"). */
  ownerBillTitle: string;
  /** Lower-case sentence forms: "paid draw", "paid pay app". */
  ownerBillLower: string;
  ownerBillsLower: string;
  /** The owner draw's line-item sheet. */
  breakdown: string;
  /** The owner draw's numbered summary rows. */
  summary: string;
  /** The subcontractor's own application sheet (a different object from the owner draw). */
  payAppBreakdown: string;
  payAppSummary: string;
  /** Empty on residential: the stored-materials row is not rendered at all. */
  materialsStored: string;
  previousCertificates: string;
  drawColumns: DrawColumns;
  trades: string;
  trade: string;
  primePrefix: string;
  signed: string;
  fundedMilestone: string;
  fundedMilestones: string;
  commercialBadge: boolean;
  commercialBadgeLabel: string;
};

const RESIDENTIAL_TERMS: Terms = {
  kind: "residential",
  ownerBill: "Draw",
  ownerBills: "Draws",
  ownerBillTitle: "Draw",
  ownerBillLower: "draw",
  ownerBillsLower: "draws",
  breakdown: "Draw breakdown",
  summary: "Draw summary",
  payAppBreakdown: "Pay app breakdown",
  payAppSummary: "Pay app summary",
  materialsStored: "",
  previousCertificates: "Previously paid",
  drawColumns: {
    workCompleted: "Work completed",
    previouslyPaid: "Previously paid",
    thisDraw: "This draw",
    retainage: "Retainage",
  },
  trades: "Trades",
  trade: "Trade",
  primePrefix: "",
  signed: "Signed",
  fundedMilestone: "Funded milestone",
  fundedMilestones: "Funded milestones",
  commercialBadge: false,
  commercialBadgeLabel: "",
};

/**
 * The commercial wording is the pre-mission output, unchanged, because existing screens and tests
 * pin these strings. Do not reword a commercial label to make it match a residential one.
 */
const COMMERCIAL_TERMS: Terms = {
  kind: "commercial",
  ownerBill: "Owner pay app",
  ownerBills: "Owner pay apps",
  ownerBillTitle: "Owner pay app",
  ownerBillLower: "pay app",
  ownerBillsLower: "pay apps",
  breakdown: "Continuation sheet (G703)",
  summary: "Application summary (G702)",
  payAppBreakdown: "Continuation sheet (G703)",
  payAppSummary: "Application summary (G702)",
  materialsStored: "Materials stored",
  previousCertificates: "Less previous certificates for payment",
  drawColumns: {
    workCompleted: "Work completed",
    previouslyPaid: "Less previous certificates for payment",
    thisDraw: "Current payment due",
    retainage: "Retainage",
  },
  trades: "Trade packages",
  trade: "Trade package",
  primePrefix: "Prime ",
  signed: "Executed",
  fundedMilestone: "Tranche",
  fundedMilestones: "Funding tranches",
  commercialBadge: true,
  commercialBadgeLabel: "Commercial reference job",
};

/** A missing kind means commercial: the project model predates the residential vocabulary. */
export function termsForKind(kind?: ProjectKind | null): Terms {
  return kind === "residential" ? RESIDENTIAL_TERMS : COMMERCIAL_TERMS;
}

export { COMMERCIAL_TERMS, RESIDENTIAL_TERMS };
