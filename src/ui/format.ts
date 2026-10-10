/**
 * The one money format and the one date format used by every screen.
 * Money: `$1,234.56`, negatives `-$1,250.00`. Dates: `Oct 8, 2026`; timestamps `Oct 8, 2026, 2:39 PM`.
 */

const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, useGrouping: true });

/** Formats integer cents without going through floating-point dollars. */
export function formatCents(cents: number | null | undefined, options: { showPlus?: boolean } = {}): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  const rounded = Math.round(cents);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const body = `$${GROUPED.format(dollars)}.${rem.toString().padStart(2, "0")}`;
  if (negative) return `-${body}`;
  if (options.showPlus && rounded > 0) return `+${body}`;
  return body;
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
const DATE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  ...DATE_FORMAT,
  hour: "numeric",
  minute: "2-digit",
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Accepts epoch milliseconds or a calendar date string `YYYY-MM-DD`. Calendar dates are formatted in
 * UTC so that a stored `2026-10-08` never shifts to Oct 7 in a western time zone.
 */
export function formatDate(value: number | string | null | undefined, options: { timeZone?: string } = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") {
    const match = ISO_DATE.exec(value);
    if (!match) return "—";
    const ts = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (!Number.isFinite(ts)) return "—";
    return new Intl.DateTimeFormat("en-US", { ...DATE_FORMAT, timeZone: "UTC" }).format(ts);
  }
  if (!Number.isFinite(value)) return "—";
  return new Intl.DateTimeFormat("en-US", { ...DATE_FORMAT, timeZone: options.timeZone }).format(value);
}

export function formatDateTime(ts: number | null | undefined, options: { timeZone?: string } = {}): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "—";
  // Some ICU versions emit a narrow no-break space before AM/PM; normalize to a plain space.
  return new Intl.DateTimeFormat("en-US", { ...DATE_TIME_FORMAT, timeZone: options.timeZone })
    .format(ts)
    .replace(/\u202f/g, " ");
}

/** Basis points to `5%` / `7.5%` / `12.25%`. */
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "—";
  const whole = Math.round(bps);
  const sign = whole < 0 ? "-" : "";
  const abs = Math.abs(whole);
  const intPart = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return `${sign}${intPart}${frac ? `.${frac}` : ""}%`;
}
