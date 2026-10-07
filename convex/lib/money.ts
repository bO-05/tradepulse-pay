/**
 * Integer-cents money helpers. All stored amounts are integer cents; these are
 * the only sanctioned conversions to and from dollars and PayPal amount strings.
 */

export function assertCents(cents: number, label = "amount"): number {
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`${label} must be an integer number of cents, got ${cents}`);
  }
  return cents;
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d*))?$/;

/**
 * Converts a dollar amount to integer cents, rounding half away from zero at
 * the third decimal. Strings are parsed digit by digit so values such as
 * "1.005" round to 101 rather than suffering binary float error.
 */
export function fromDollars(dollars: number | string): number {
  let text: string;
  if (typeof dollars === "number") {
    if (!Number.isFinite(dollars)) throw new Error(`Invalid dollar amount: ${dollars}`);
    // Shortest round-trip representation; exponent forms only occur for
    // magnitudes that are not valid money anyway.
    text = String(dollars);
    if (/e/i.test(text)) {
      return assertCents(Math.round(dollars * 100), "dollars");
    }
  } else {
    text = dollars.trim().replace(/[$,\s]/g, "");
  }
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new Error(`Invalid dollar amount: ${String(dollars)}`);
  const negative = m[1] === "-";
  const whole = m[2];
  const frac = (m[3] ?? "").padEnd(3, "0");
  let cents = BigInt(whole) * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n;
  const result = Number(negative ? -cents : cents);
  return assertCents(result === 0 ? 0 : result, "dollars");
}

/** Cents as a plain decimal dollar string with exactly two decimals, e.g. "1234.56". */
function toDecimalString(cents: number): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${frac.toString().padStart(2, "0")}`;
}

/**
 * PayPal `amount.value` string ("1234.56"). PayPal rejects negative amounts,
 * so this throws instead of producing one.
 */
export function toPayPalString(cents: number): string {
  assertCents(cents);
  if (cents < 0) throw new Error(`PayPal amounts cannot be negative, got ${cents} cents`);
  return toDecimalString(cents);
}

/** Parses a PayPal `amount.value` string back to integer cents. */
export function fromPayPalString(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error(`Invalid PayPal amount string: ${value}`);
  }
  return fromDollars(value);
}

/** Display format for the UI: "$1,234.56", "-$1,234.56". */
export function formatCents(cents: number): string {
  const [whole, frac] = toDecimalString(Math.abs(cents)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}$${grouped}.${frac}`;
}

/** Cents to dollars as a number, for display-only consumers such as charts. */
export function centsToDollarsForDisplay(cents: number): number {
  assertCents(cents);
  return cents / 100;
}

const PERCENT_SCALE = 1_000_000n;

/**
 * `percent`% of `cents` (percent on a 0-100 scale, up to 6 decimals), rounded
 * to the nearest cent with halves away from zero. Uses BigInt so the result is
 * exact for any safe-integer amount.
 */
export function percentageOfCents(cents: number, percent: number): number {
  assertCents(cents);
  if (!Number.isFinite(percent)) throw new Error(`Invalid percent: ${percent}`);
  const scaledPct = BigInt(Math.round(percent * Number(PERCENT_SCALE)));
  const numerator = BigInt(cents) * scaledPct;
  const denominator = 100n * PERCENT_SCALE;
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  let q = abs / denominator;
  if ((abs % denominator) * 2n >= denominator) q += 1n;
  const result = Number(negative ? -q : q);
  return result === 0 ? 0 : result;
}

/** Splits a gross amount into retainage held and net paid; the two always sum to gross. */
export function splitRetainage(
  grossCents: number,
  retainagePercent: number,
): { retainageCents: number; netCents: number } {
  const retainageCents = percentageOfCents(grossCents, retainagePercent);
  return { retainageCents, netCents: grossCents - retainageCents };
}

export function sumCents(values: readonly number[]): number {
  return values.reduce((acc, c) => acc + assertCents(c), 0);
}
