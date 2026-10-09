/**
 * Validation for the bidder-facing terms of a bid (bid portal, GC entry on behalf, GC edits of an
 * AI-parsed bid). Pure, so the portal form shows the same messages the server enforces.
 */

export const MAX_BID_TERM_CENTS = 100_000_000_000; // $1,000,000,000.00
const MAX_LIST_ITEMS = 50;
const MAX_ITEM_CHARS = 300;
const MAX_QUALIFICATIONS_CHARS = 4000;
const MAX_NOTE_CHARS = 500;

export type BidTermsInput = {
  baseAmountCents: number | null;
  alternates: { description: string; amountCents: number | null }[];
  exclusions: string[];
  inclusions: string[];
  unitPrices: { item: string; unit: string; unitPriceCents: number | null }[];
  qualifications?: string;
  validUntil?: string;
  note?: string;
};

export type CleanBidTerms = {
  baseAmountCents: number;
  alternates: { description: string; amountCents: number }[];
  exclusions: string[];
  inclusions: string[];
  unitPrices: { item: string; unit: string; unitPriceCents: number }[];
  qualifications?: string;
  validUntil?: string;
  note?: string;
};

/** Field key → message. Keys: base, alternates.N.description, alternates.N.amount, unitPrices.N.item|unit|price, exclusions, inclusions, qualifications, validUntil, note. */
export type BidTermErrors = Record<string, string>;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's calendar date as YYYY-MM-DD in UTC. */
export function todayIsoDate(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function isRealDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function cleanList(items: string[], label: string, key: string, errors: BidTermErrors): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim().replace(/\s+/g, " ");
    if (item === "") continue;
    if (item.length > MAX_ITEM_CHARS) errors[key] = `Keep each ${label} under ${MAX_ITEM_CHARS} characters.`;
    if (!out.includes(item)) out.push(item);
  }
  if (out.length > MAX_LIST_ITEMS) errors[key] = `List at most ${MAX_LIST_ITEMS} ${label}s.`;
  return out;
}

function wholeCents(value: number | null): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Validates and normalizes bid terms. Base must be more than $0; alternates need a description and
 * a non-zero amount (negative = deduct); unit prices need an item, a unit and a price above $0;
 * valid-until must be a real date that is not in the past.
 */
export function validateBidTerms(
  input: BidTermsInput,
  opts: { today?: string } = {},
): { ok: true; terms: CleanBidTerms } | { ok: false; errors: BidTermErrors } {
  const errors: BidTermErrors = {};
  const today = opts.today ?? todayIsoDate();

  const base = input.baseAmountCents;
  if (base === null || base === undefined) errors.base = "Enter the base bid amount.";
  else if (!wholeCents(base)) errors.base = "Enter the base bid as a dollar amount with up to two decimals.";
  else if (base <= 0) errors.base = "The base bid must be more than $0.00.";
  else if (base > MAX_BID_TERM_CENTS) errors.base = "The base bid can't be more than $1,000,000,000.00.";

  const alternates: CleanBidTerms["alternates"] = [];
  input.alternates.forEach((alt, i) => {
    const description = alt.description.trim().replace(/\s+/g, " ");
    const amount = alt.amountCents;
    if (description === "" && (amount === null || amount === 0)) return;
    if (description === "") errors[`alternates.${i}.description`] = "Describe this alternate.";
    else if (description.length > MAX_ITEM_CHARS) errors[`alternates.${i}.description`] = `Keep the description under ${MAX_ITEM_CHARS} characters.`;
    if (amount === null || amount === undefined) errors[`alternates.${i}.amount`] = "Enter the alternate amount (use a minus sign for a deduct).";
    else if (!wholeCents(amount)) errors[`alternates.${i}.amount`] = "Enter a dollar amount with up to two decimals.";
    else if (amount === 0) errors[`alternates.${i}.amount`] = "An alternate can't be $0.00.";
    else if (Math.abs(amount) > MAX_BID_TERM_CENTS) errors[`alternates.${i}.amount`] = "The amount is too large.";
    if (description !== "" && wholeCents(amount) && amount !== 0) alternates.push({ description, amountCents: amount });
  });
  if (alternates.length > MAX_LIST_ITEMS) errors.alternates = `List at most ${MAX_LIST_ITEMS} alternates.`;

  const unitPrices: CleanBidTerms["unitPrices"] = [];
  input.unitPrices.forEach((up, i) => {
    const item = up.item.trim().replace(/\s+/g, " ");
    const unit = up.unit.trim();
    const price = up.unitPriceCents;
    if (item === "" && unit === "" && (price === null || price === 0)) return;
    if (item === "") errors[`unitPrices.${i}.item`] = "Name the item this unit price is for.";
    else if (item.length > MAX_ITEM_CHARS) errors[`unitPrices.${i}.item`] = `Keep the item under ${MAX_ITEM_CHARS} characters.`;
    if (unit === "") errors[`unitPrices.${i}.unit`] = "Enter the unit (for example each, LF, SF).";
    else if (unit.length > 40) errors[`unitPrices.${i}.unit`] = "Keep the unit under 40 characters.";
    if (price === null || price === undefined) errors[`unitPrices.${i}.price`] = "Enter the unit price.";
    else if (!wholeCents(price) || price <= 0) errors[`unitPrices.${i}.price`] = "The unit price must be more than $0.00.";
    else if (price > MAX_BID_TERM_CENTS) errors[`unitPrices.${i}.price`] = "The unit price is too large.";
    if (item !== "" && unit !== "" && wholeCents(price) && price > 0) unitPrices.push({ item, unit, unitPriceCents: price });
  });
  if (unitPrices.length > MAX_LIST_ITEMS) errors.unitPrices = `List at most ${MAX_LIST_ITEMS} unit prices.`;

  const exclusions = cleanList(input.exclusions, "exclusion", "exclusions", errors);
  const inclusions = cleanList(input.inclusions, "inclusion", "inclusions", errors);

  const qualifications = (input.qualifications ?? "").trim();
  if (qualifications.length > MAX_QUALIFICATIONS_CHARS) {
    errors.qualifications = `Keep qualifications under ${MAX_QUALIFICATIONS_CHARS} characters.`;
  }

  const validUntil = (input.validUntil ?? "").trim();
  if (validUntil !== "") {
    if (!isRealDate(validUntil)) errors.validUntil = "Enter a valid date.";
    else if (validUntil < today) errors.validUntil = "The valid-until date can't be in the past.";
  }

  const note = (input.note ?? "").trim();
  if (note.length > MAX_NOTE_CHARS) errors.note = `Keep the note under ${MAX_NOTE_CHARS} characters.`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    terms: {
      baseAmountCents: base as number,
      alternates,
      exclusions,
      inclusions,
      unitPrices,
      ...(qualifications ? { qualifications } : {}),
      ...(validUntil ? { validUntil } : {}),
      ...(note ? { note } : {}),
    },
  };
}

/** The first validation message, for server errors. */
export function firstBidTermError(errors: BidTermErrors): string {
  return Object.values(errors)[0] ?? "Check the bid and try again.";
}
