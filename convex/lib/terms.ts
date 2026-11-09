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

/** The GC funding ledger's nouns. Residential never says "tranche"; commercial keeps today's bytes. */
export type FundingTerms = {
  ledgerTitle: string;
  ledgerLower: string;
  item: string;
  items: string;
  itemTitle: string;
  itemsTitle: string;
  totalLabel: string;
  authorizationNote: string;
  emptyReadOnly: string;
  emptyEditable: string;
  addTitle: string;
  addAction: string;
  saveAction: string;
  amountRequired: string;
  nameRequired: string;
  saveFailed: string;
  moveFailed: string;
  addFailed: string;
  closeFailed: string;
  deleteEffect: string;
  closeEffect: string;
  addedNotice: string;
};

/** Owner-income rows on the GC ledger. Residential drops "Prime"; commercial keeps today's bytes. */
export type LedgerTerms = {
  ownerInvoicesUnpaid: string;
  ownerIncomePaid: string;
  ownerIncomeNote: string;
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
  funding: FundingTerms;
  ledger: LedgerTerms;
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
  funding: {
    ledgerTitle: "Milestone funding",
    ledgerLower: "milestone funding",
    item: "funded milestone",
    items: "funded milestones",
    itemTitle: "Funded milestone",
    itemsTitle: "Funded milestones",
    totalLabel: "Milestone funding total",
    authorizationNote: "Funding a milestone authorizes money at PayPal. The sub is paid only from an approved pay app's Payment panel.",
    emptyReadOnly: "No milestone funding yet.",
    emptyEditable: "No milestone funding yet. Add the first one below.",
    addTitle: "Add milestone funding",
    addAction: "Add milestone",
    saveAction: "Save milestone",
    amountRequired: "Enter the milestone amount.",
    nameRequired: "Enter a milestone name.",
    saveFailed: "The milestone could not be saved.",
    moveFailed: "The milestone could not be moved.",
    addFailed: "The milestone could not be added.",
    closeFailed: "The milestone could not be closed.",
    deleteEffect: "Removes this unfunded milestone. No money moves.",
    closeEffect: "Voids the rest of this milestone's PayPal authorization. The voided money can't be captured again; fund a new milestone if needed.",
    addedNotice: "Milestone funding added.",
  },
  ledger: {
    ownerInvoicesUnpaid: "Owner change-order invoices unpaid (project income)",
    ownerIncomePaid: "Owner change-order income paid (not this subcontract)",
    ownerIncomeNote:
      "Statuses are recorded from PayPal webhooks/API responses at the time shown; this page does not re-query PayPal. Owner change-order income belongs to the project, not this subcontract's scope or balance.",
  },
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
  funding: {
    ledgerTitle: "Funding tranches",
    ledgerLower: "funding tranches",
    item: "tranche",
    items: "tranches",
    itemTitle: "Tranche",
    itemsTitle: "Tranches",
    totalLabel: "Tranches total",
    authorizationNote: "Funding a tranche authorizes money at PayPal. The sub is paid only from an approved pay app's Payment panel.",
    emptyReadOnly: "No funding tranches yet.",
    emptyEditable: "No funding tranches yet. Add the first one below.",
    addTitle: "Add a funding tranche",
    addAction: "Add tranche",
    saveAction: "Save tranche",
    amountRequired: "Enter the tranche amount.",
    nameRequired: "Enter a tranche name.",
    saveFailed: "The tranche could not be saved.",
    moveFailed: "The tranche could not be moved.",
    addFailed: "The tranche could not be added.",
    closeFailed: "The tranche could not be closed.",
    deleteEffect: "Removes this unfunded tranche. No money moves.",
    closeEffect: "Voids the rest of this tranche's PayPal authorization. The voided money can't be captured again; fund a new tranche if needed.",
    addedNotice: "Tranche added.",
  },
  ledger: {
    ownerInvoicesUnpaid: "Owner prime CO invoices unpaid (project income)",
    ownerIncomePaid: "Owner prime CO income paid (not this subcontract)",
    ownerIncomeNote:
      "Statuses are recorded from PayPal webhooks/API responses at the time shown; this page does not re-query PayPal. Owner prime change-order income belongs to the project, not this subcontract's scope or balance.",
  },
  commercialBadge: true,
  commercialBadgeLabel: "Commercial reference job",
};

/** A missing kind means commercial: the project model predates the residential vocabulary. */
export function termsForKind(kind?: ProjectKind | null): Terms {
  return kind === "residential" ? RESIDENTIAL_TERMS : COMMERCIAL_TERMS;
}

export { COMMERCIAL_TERMS, RESIDENTIAL_TERMS };
