/**
 * Fixed inputs of the one-click TradePulse Pay judge demo (pure, unit tested). Figures are demo data,
 * kept small so sandbox card approvals, captures and payouts stay quick. Every dollar the demo moves is
 * still computed by the regular review, proposal and payout code; this file only decides what the
 * stand-in sub and billing agent ask for and how far the GC edits the proposal down.
 */
import { percentageOfCents } from "../lib/money";

export const DEMO_CONTRACTOR_NAME = "Rosendin Electric, Inc.";
export const DEMO_BILLING_AGENT_EMAIL = "boldlevel182@agentmail.to";
export const DEMO_AGREEMENT_PREFIX = "A401-DEMO-PAY-";
export const DEMO_PROJECT_TITLE = "Demo · TradePulse Pay judge demo";
export const DEMO_FUNDED_MILESTONE = "Mobilization";

export const DEMO_LINE_ITEMS = [
  { item: "1600A main switchboard & transformers", totalCost: 22_000 },
  { item: "Branch conduit & wire feeder runs", totalCost: 18_000 },
  { item: "Grounding & bonding system", totalCost: 10_000 },
  { item: "Closeout: testing, commissioning & O&M manuals", totalCost: 5_000 },
] as const;

export const DEMO_EXCLUSION = {
  canonicalCode: "CSI_26_SEISMIC",
  description: "IBC Section 1613 engineered seismic bracing (excluded by the sub; by others)",
  costImpact: 4_500,
  severity: "critical",
  isWaived: false,
} as const;

export const DEMO_CONTRACT_SUM = DEMO_LINE_ITEMS.reduce((a, l) => a + l.totalCost, 0) + DEMO_EXCLUSION.costImpact;

export type DemoPayAppKind = "honest" | "agent";

/** % complete to date each stand-in claims, by kind of SOV line. */
export const DEMO_TARGET_PCT: Record<DemoPayAppKind, { base: number; closeout: number; excluded: number }> = {
  // Within what a funded Mobilization supports; nothing on closeout or excluded scope.
  honest: { base: 4, closeout: 0, excluded: 0 },
  // Far ahead of the milestones, closeout work billed early, and the excluded seismic bracing billed in full.
  agent: { base: 30, closeout: 10, excluded: 100 },
};

export const DEMO_PAY_APP_TEXT: Record<DemoPayAppKind, { periodLabel: string; notes: string; lienWaiver: boolean }> = {
  honest: {
    periodLabel: "Judge demo · Period 1 (honest)",
    notes: "Judge demo stand-in for sub1: early mobilization progress on the base scope. Conditional lien waiver attached.",
    lienWaiver: true,
  },
  agent: {
    periodLabel: "Judge demo · Period 2 (billing agent)",
    notes:
      "Judge demo stand-in for the billing agent: claims 30% on the base scope, early closeout testing and the full seismic bracing line.",
    lienWaiver: false,
  },
};

export type DemoSovLine = {
  _id: string;
  description: string;
  excludedScope: boolean;
  scheduledValueCents: number;
  previouslyBilledCents: number;
  previousPctToDate: number;
  pendingRequestedCents: number;
  remainingCents: number;
};

const CLOSEOUT = /\bclose-?out\b|commissioning|o&m/i;

/** Pay-app lines for a stand-in: requested cents = scheduled × target − approved and pending, within what remains. */
export function demoPayAppLines(kind: DemoPayAppKind, sov: readonly DemoSovLine[]) {
  const t = DEMO_TARGET_PCT[kind];
  const lines = [];
  for (const s of sov) {
    const target = s.excludedScope ? t.excluded : CLOSEOUT.test(s.description) ? t.closeout : t.base;
    const toDate = Math.max(target, s.previousPctToDate);
    const due = percentageOfCents(s.scheduledValueCents, toDate) - s.previouslyBilledCents - s.pendingRequestedCents;
    const requestedCents = Math.min(Math.max(0, due), s.remainingCents);
    const pctCompleteThisPeriod = Math.max(0, toDate - s.previousPctToDate);
    if (requestedCents === 0 && pctCompleteThisPeriod === 0) continue;
    lines.push({ sovLineId: s._id, pctCompleteThisPeriod, pctCompleteToDate: toDate, requestedCents });
  }
  return lines;
}

/**
 * The GC's edited amount for the billing agent's pay app: 90% of the code-computed proposal, rounded
 * down to whole dollars. Null when the proposal is too small to edit down meaningfully.
 */
export function demoEditedApprovalCents(proposedCents: number): number | null {
  if (!Number.isSafeInteger(proposedCents) || proposedCents < 200) return null;
  const edited = Math.floor((proposedCents * 9) / 1000) * 100;
  return edited > 0 && edited < proposedCents ? edited : null;
}

/** Prime change order approved for the demo owner and invoiced to it at the end of the demo. */
export const DEMO_CHANGE_ORDER = {
  title: "Judge demo: add two EV charger circuits in the garage",
  description: "Owner-requested change, billed to the owner as a PayPal invoice.",
  amountCents: 1_850_00,
};

export function demoAgreementNumber(now: number, sequence: number): string {
  const d = new Date(now);
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${DEMO_AGREEMENT_PREFIX}${stamp}-${String(sequence).padStart(2, "0")}`;
}
