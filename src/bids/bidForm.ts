import { todayIsoDate, validateBidTerms, type BidTermErrors, type CleanBidTerms } from "../../convex/lib/bidTerms";

/** Where a bid (or one of its revisions) came from, in the GC's words. */
export const BID_SOURCE_LABELS: Record<string, string> = {
  portal: "Bid portal",
  gc_entered: "Entered by GC",
  email_ai: "From email (AI-parsed)",
  document_ai: "From quote PDF (AI-parsed)",
  gc_edit: "GC correction",
  seed: "Sample data",
  legacy: "Recorded before the bid portal",
};

export function bidSourceLabel(source: string | null | undefined): string {
  return (source && BID_SOURCE_LABELS[source]) || "Recorded before the bid portal";
}

/** Invitation status codes from bidPortal.listMyBidInvitations, as the bidder reads them. */
export const INVITATION_STATUS: Record<string, { label: string; tone: "neutral" | "info" | "success" | "muted" | "warning" }> = {
  not_submitted: { label: "Not submitted", tone: "warning" },
  submitted: { label: "Submitted", tone: "info" },
  awarded: { label: "Awarded to you", tone: "success" },
  not_awarded: { label: "Awarded to another bidder", tone: "muted" },
  closed: { label: "Closed", tone: "muted" },
};

export type BidFormState = {
  baseAmountCents: number | null;
  alternates: { description: string; amountCents: number | null }[];
  exclusions: string;
  inclusions: string;
  unitPrices: { item: string; unit: string; unitPriceCents: number | null }[];
  qualifications: string;
  validUntil: string;
  note: string;
};

export type BidTermsValue = {
  baseAmountCents: number;
  alternates: { description: string; amountCents: number }[];
  exclusions: string[];
  inclusions: string[];
  unitPrices: { item: string; unit: string; unitPriceCents: number }[];
  qualifications?: string;
  validUntil?: string;
};

export const EMPTY_BID_FORM: BidFormState = {
  baseAmountCents: null,
  alternates: [{ description: "", amountCents: null }],
  exclusions: "",
  inclusions: "",
  unitPrices: [{ item: "", unit: "", unitPriceCents: null }],
  qualifications: "",
  validUntil: "",
  note: "",
};

/** Prefills the form from the current bid so a revision starts from what was last submitted. */
export function bidFormFrom(terms: BidTermsValue | null | undefined): BidFormState {
  if (!terms) return EMPTY_BID_FORM;
  return {
    baseAmountCents: terms.baseAmountCents,
    alternates: terms.alternates.length > 0 ? terms.alternates.map((a) => ({ ...a })) : [{ description: "", amountCents: null }],
    exclusions: terms.exclusions.join("\n"),
    inclusions: terms.inclusions.join("\n"),
    unitPrices: terms.unitPrices.length > 0 ? terms.unitPrices.map((u) => ({ ...u })) : [{ item: "", unit: "", unitPriceCents: null }],
    qualifications: terms.qualifications ?? "",
    validUntil: terms.validUntil ?? "",
    note: "",
  };
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");

/** Today as YYYY-MM-DD in the browser's time zone, so "not in the past" matches the bidder's calendar. */
export function localToday(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return todayIsoDate(local.getTime());
}

/**
 * Checks the form with the same rules the server enforces. `maskErrors` are the money inputs'
 * own messages (letters, a minus sign on a base bid), which win over "enter an amount".
 */
export function checkBidForm(
  form: BidFormState,
  maskErrors: Record<string, string | null>,
  today: string = localToday(),
): { ok: true; terms: CleanBidTerms } | { ok: false; errors: BidTermErrors } {
  const result = validateBidTerms(
    {
      baseAmountCents: form.baseAmountCents,
      alternates: form.alternates,
      exclusions: lines(form.exclusions),
      inclusions: lines(form.inclusions),
      unitPrices: form.unitPrices,
      qualifications: form.qualifications,
      validUntil: form.validUntil,
      note: form.note,
    },
    { today },
  );
  const masks = Object.fromEntries(Object.entries(maskErrors).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  if (Object.keys(masks).length === 0) return result;
  return { ok: false, errors: { ...(result.ok ? {} : result.errors), ...masks } };
}
