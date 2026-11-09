/**
 * The reviewer's vocabulary is the job's vocabulary (architecture §5.1, VAL-LANG-006).
 *
 * A residential job is explained in its own words: draw, funded milestone and trade. It never uses
 * the commercial document vocabulary (tranche, prime, G702/G703, AIA, CSI, materials stored,
 * certificates for payment). A commercial job keeps today's text byte-for-byte, because stored
 * reviews, the eval fixtures and the tests pin that text. A missing kind reads commercial, exactly
 * like `projects.projectKind`.
 *
 * These are words only. Field names on stored rows, verdict codes, percents and cents never change
 * with the kind; the residential model payload renames its own keys so the model never reads the
 * commercial identifiers either.
 */
import type { ProjectKind } from "../lib/projectKind";

/** One percent already formatted the way the reviewer writes it, for example "33.3%". */
type Percent = string;

export type ReviewReasonWords = {
  excludedScopeLine(lineNo: number): string;
  excludedScopeClaim(lineNo: number, claim: string): string;
  outOfSequence(lineNo: number, previousPct: Percent): string;
  overbilled(lineNo: number, claimedPct: Percent, ceilingPct: Percent): string;
  frontLoaded(lineNo: number, workInPlacePct: Percent, otherPct: Percent): string;
  okWithoutCeiling(lineNo: number, claimedPct: Percent): string;
  okWithinCeiling(lineNo: number, claimedPct: Percent, ceilingPct: Percent): string;
  credit(lineNo: number, amount: string): string;
  unbilled(lineNo: number): string;
  /** First sentence of the rules notes: how many lines the deterministic rules flagged. */
  flaggedSummary(flagged: number, total: number, tradeName: string): string;
  /** One sentence per excluded-scope claim the pay-app notes made without naming a line. */
  excludedScopeNotice(note: string): string;
};

export type ReviewVocabulary = {
  kind: ProjectKind;
  residential: boolean;
  /** Key names in the model payload. The instructions name the same fields. */
  fields: {
    fundingBuckets: string;
    ceiling: string;
    closeout: string;
    division: string;
  };
  instructions: {
    /** The opening sentence of the reviewer instructions. */
    introduction: string;
    /** The vocabulary rule, stated once on residential. Empty on commercial. */
    vocabularyRule: string;
    fundingBuckets: string;
    fundingBucketsTitle: string;
    /** One funding bucket as a bare noun: "tranche" | "milestone". */
    bucket: string;
    /** One funding bucket in prose: "funding tranche" | "funded milestone". */
    fundingBucket: string;
    /** Where work in place sits on the sub's sheet. */
    workInPlaceColumns: string;
    storedMaterialGuidance: string;
  };
  prompt: {
    noMilestoneCovers: string;
    coveringMilestonesSupport(pct: Percent): string;
  };
  reasons: ReviewReasonWords;
};

/**
 * The rule a residential review states once. It names the commercial words only to forbid them;
 * every other sentence of the instruction is free of them.
 */
export const RESIDENTIAL_REVIEW_VOCABULARY = `Residential vocabulary: this is a residential remodel job, so write every reason and note in the job's own words. Say draw for owner billing, funded milestone for a funding bucket, and trade for the subcontractor's scope. Never write the commercial wording: "tranche", "Prime", "G702", "G703", "AIA", "CSI", "Materials stored", or "certificates for payment".`;

const COMMERCIAL_REASONS: ReviewReasonWords = {
  excludedScopeLine: (lineNo) =>
    `Line ${lineNo} is excluded scope (from the leveled bid exclusions) and is not billable under this agreement.`,
  excludedScopeClaim: (lineNo, claim) =>
    `Line ${lineNo} bills work the agreement lists as excluded scope (not in contract): "${claim}". That work is not billable under this agreement.`,
  outOfSequence: (lineNo, previousPct) =>
    `Line ${lineNo} is closeout-phase work billed before the earlier funding tranches that cover it are complete; held at the previous ${previousPct} to date.`,
  overbilled: (lineNo, claimedPct, ceilingPct) =>
    `Line ${lineNo} claims ${claimedPct} complete to date, but the funding-tranche statuses that cover this line support at most ${ceilingPct}.`,
  frontLoaded: (lineNo, workInPlacePct, otherPct) =>
    `Line ${lineNo} claims ${workInPlacePct} work in place while the rest of the job is at ${otherPct}; work in place reduced to the job-wide progress.`,
  okWithoutCeiling: (lineNo, claimedPct) =>
    `Line ${lineNo} claims ${claimedPct}; no funding tranche covers this line, so tranche status sets no ceiling.`,
  okWithinCeiling: (lineNo, claimedPct, ceilingPct) =>
    `Line ${lineNo} claims ${claimedPct}, within the ${ceilingPct} the covering funding tranches support.`,
  credit: (lineNo, amount) =>
    `Line ${lineNo} is a deductive change-order credit of ${amount}; it is applied in full and reduces the payment.`,
  unbilled: (lineNo) => `Nothing billed on line ${lineNo} this period.`,
  flaggedSummary: (flagged, total, _tradeName) => `${flagged} of ${total} line(s) flagged by deterministic rules.`,
  excludedScopeNotice: (note) =>
    `The pay-app notes mention excluded scope ("${note}") without naming a line; confirm before approving.`,
};

const RESIDENTIAL_REASONS: ReviewReasonWords = {
  excludedScopeLine: (lineNo) =>
    `Line ${lineNo} is excluded scope (from the leveled bid exclusions) and is not billable under this trade's contract.`,
  excludedScopeClaim: (lineNo, claim) =>
    `Line ${lineNo} bills work the agreement lists as excluded scope (not in contract): "${claim}". That work is not billable under this trade's contract.`,
  outOfSequence: (lineNo, previousPct) =>
    `Line ${lineNo} is closeout-phase work billed before the earlier funded milestones that cover it are complete; held at the previous ${previousPct} to date.`,
  overbilled: (lineNo, claimedPct, ceilingPct) =>
    `Line ${lineNo} claims ${claimedPct} complete to date, but the funded-milestone statuses that cover this line support at most ${ceilingPct}.`,
  frontLoaded: (lineNo, workInPlacePct, otherPct) =>
    `Line ${lineNo} claims ${workInPlacePct} work in place while the rest of the job is at ${otherPct}; work in place reduced to the job-wide progress.`,
  okWithoutCeiling: (lineNo, claimedPct) =>
    `Line ${lineNo} claims ${claimedPct}; no funded milestone covers this line, so milestone status sets no ceiling.`,
  okWithinCeiling: (lineNo, claimedPct, ceilingPct) =>
    `Line ${lineNo} claims ${claimedPct}, within the ${ceilingPct} the covering funded milestones support.`,
  credit: (lineNo, amount) =>
    `Line ${lineNo} is a deductive change-order credit of ${amount}; it is applied in full and reduces the payment.`,
  unbilled: (lineNo) => `Nothing billed on line ${lineNo} this period.`,
  flaggedSummary: (flagged, total, tradeName) => {
    const trade = tradeName.trim();
    const first = `${flagged} of ${total} line(s) flagged by deterministic rules${trade ? ` on the ${trade} trade` : ""}.`;
    const second = trade
      ? `Payments to the ${trade} trade come from a funded milestone; the owner's draw is billed separately.`
      : "Payments to the subcontractor come from a funded milestone; the owner's draw is billed separately.";
    return `${first} ${second}`;
  },
  excludedScopeNotice: (note) =>
    `The pay-app notes mention work outside this trade's contract ("${note}") without naming a line; confirm before approving.`,
};

const COMMERCIAL_VOCABULARY: ReviewVocabulary = {
  kind: "commercial",
  residential: false,
  fields: {
    fundingBuckets: "fundingTranches",
    ceiling: "trancheCeilingPctToDate",
    closeout: "closeoutWorkBeforeEarlierTranches",
    division: "csiDivision",
  },
  instructions: {
    introduction: "You review construction subcontractor pay applications (AIA G702/G703 style) for the general contractor.",
    vocabularyRule: "",
    fundingBuckets: "funding tranches",
    fundingBucketsTitle: "Funding tranches",
    bucket: "tranche",
    fundingBucket: "funding tranche",
    workInPlaceColumns: "G703 columns D + E",
    storedMaterialGuidance:
      "Stored materials (column F) are paid on delivery and are not progress: a line billing mostly stored materials is not front-loaded because of them.",
  },
  prompt: {
    noMilestoneCovers: "no funding tranche covers this line (no tranche ceiling)",
    coveringMilestonesSupport: (pct) => `covering funding tranches support ${pct}`,
  },
  reasons: COMMERCIAL_REASONS,
};

const RESIDENTIAL_VOCABULARY: ReviewVocabulary = {
  kind: "residential",
  residential: true,
  fields: {
    fundingBuckets: "fundedMilestones",
    ceiling: "fundedMilestoneCeilingPctToDate",
    closeout: "closeoutWorkBeforeEarlierMilestones",
    division: "tradeCode",
  },
  instructions: {
    introduction:
      "You review residential remodel subcontractor pay applications (draws against funded milestones) for the general contractor.",
    vocabularyRule: RESIDENTIAL_REVIEW_VOCABULARY,
    fundingBuckets: "funded milestones",
    fundingBucketsTitle: "Funded milestones",
    bucket: "milestone",
    fundingBucket: "funded milestone",
    workInPlaceColumns: "columns D + E of the pay app breakdown",
    storedMaterialGuidance:
      "Material delivered and stored on the job is paid for delivery and is not progress: a line billing mostly delivered material is not front-loaded because of it.",
  },
  prompt: {
    noMilestoneCovers: "no funded milestone covers this line (no milestone ceiling)",
    coveringMilestonesSupport: (pct) => `covering funded milestones support ${pct}`,
  },
  reasons: RESIDENTIAL_REASONS,
};

/** A missing kind reads commercial: every project that predates `projectKind` keeps today's words. */
export function reviewVocabularyFor(kind?: ProjectKind | null): ReviewVocabulary {
  return kind === "residential" ? RESIDENTIAL_VOCABULARY : COMMERCIAL_VOCABULARY;
}

export { COMMERCIAL_VOCABULARY, RESIDENTIAL_VOCABULARY };
