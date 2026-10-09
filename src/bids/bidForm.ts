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

export type AlternateRow = { rowId: string; description: string; amountCents: number | null };
export type UnitPriceRow = { rowId: string; item: string; unit: string; unitPriceCents: number | null };

export type BidFormState = {
  baseAmountCents: number | null;
  alternates: AlternateRow[];
  exclusions: string;
  inclusions: string;
  unitPrices: UnitPriceRow[];
  qualifications: string;
  validUntil: string;
  note: string;
};

export type BidFormList = "alternates" | "unitPrices";

let rowSeq = 0;
/** Row ids only need to be unique within one form; they keep a row's input state and errors attached to it. */
export function newRowId(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

export const blankAlternate = (): AlternateRow => ({ rowId: newRowId(), description: "", amountCents: null });
export const blankUnitPrice = (): UnitPriceRow => ({ rowId: newRowId(), item: "", unit: "", unitPriceCents: null });

/** Mask-error key for a money input in a row, tied to the row id rather than its position. */
export function rowMaskKey(list: BidFormList, rowId: string): string {
  return `${list}#${rowId}`;
}

const MASK_FIELD: Record<BidFormList, string> = { alternates: "amount", unitPrices: "price" };

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
  alternates: [{ rowId: "alt-initial", description: "", amountCents: null }],
  exclusions: "",
  inclusions: "",
  unitPrices: [{ rowId: "unit-initial", item: "", unit: "", unitPriceCents: null }],
  qualifications: "",
  validUntil: "",
  note: "",
};

/** Prefills the form from the current bid so a revision starts from what was last submitted. */
export function bidFormFrom(terms: BidTermsValue | null | undefined): BidFormState {
  if (!terms) return EMPTY_BID_FORM;
  return {
    baseAmountCents: terms.baseAmountCents,
    alternates:
      terms.alternates.length > 0
        ? terms.alternates.map((a) => ({ rowId: newRowId(), description: a.description, amountCents: a.amountCents }))
        : [blankAlternate()],
    exclusions: terms.exclusions.join("\n"),
    inclusions: terms.inclusions.join("\n"),
    unitPrices:
      terms.unitPrices.length > 0
        ? terms.unitPrices.map((u) => ({ rowId: newRowId(), item: u.item, unit: u.unit, unitPriceCents: u.unitPriceCents }))
        : [blankUnitPrice()],
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
  const masks = positionalMaskErrors(form, maskErrors);
  if (Object.keys(masks).length === 0) return result;
  return { ok: false, errors: { ...(result.ok ? {} : result.errors), ...masks } };
}

/**
 * Turns row-keyed mask errors into the positional keys the validator uses. Errors of rows that are
 * no longer in the form are dropped, so a removed row can never block a submit.
 */
function positionalMaskErrors(form: BidFormState, maskErrors: Record<string, string | null>): Record<string, string> {
  const rowIndex = new Map<string, string>();
  for (const list of ["alternates", "unitPrices"] as const) {
    form[list].forEach((row, i) => rowIndex.set(rowMaskKey(list, row.rowId), `${list}.${i}.${MASK_FIELD[list]}`));
  }
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(maskErrors)) {
    if (typeof message !== "string" || message === "") continue;
    if (key.includes("#")) {
      const positional = rowIndex.get(key);
      if (positional) out[positional] = message;
    } else {
      out[key] = message;
    }
  }
  return out;
}

/**
 * Removes one alternate or unit-price row with its errors. Shown errors for later rows in the same
 * list move up one position so they stay next to their row.
 */
export function removeBidFormRow(
  state: { form: BidFormState; maskErrors: Record<string, string | null>; errors: Record<string, string> },
  list: BidFormList,
  rowId: string,
): { form: BidFormState; maskErrors: Record<string, string | null>; errors: Record<string, string> } {
  const index = state.form[list].findIndex((r) => r.rowId === rowId);
  if (index < 0) return state;
  const form = { ...state.form, [list]: state.form[list].filter((r) => r.rowId !== rowId) } as BidFormState;
  const maskErrors = { ...state.maskErrors };
  delete maskErrors[rowMaskKey(list, rowId)];
  const errors: Record<string, string> = {};
  const prefix = `${list}.`;
  for (const [key, message] of Object.entries(state.errors)) {
    if (!key.startsWith(prefix)) {
      errors[key] = message;
      continue;
    }
    const [, pos, ...field] = key.split(".");
    const i = Number(pos);
    if (!Number.isInteger(i) || field.length === 0) continue;
    if (i < index) errors[key] = message;
    else if (i > index) errors[`${list}.${i - 1}.${field.join(".")}`] = message;
  }
  return { form, maskErrors, errors };
}
