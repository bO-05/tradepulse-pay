/**
 * Numeric input masks. Typing is filtered to digits, one decimal point and (when allowed) a leading
 * minus; at most two decimals are kept. Parsing is strict and returns integer cents / basis points,
 * so a float or letters never reach the server.
 */

export interface MaskResult {
  /** The text to show in the input after filtering. */
  text: string;
  /** True when the raw input contained characters the mask removed (letters, a second dot, ...). */
  rejected: boolean;
}

function maskDecimal(raw: string, maxDecimals: number, allowNegative: boolean): MaskResult {
  // Thousands separators, currency and percent symbols are formatting, not rejected input.
  const cleaned = raw.replace(/[\s,$%]/g, "");
  let out = "";
  let rejected = false;
  let seenDot = false;
  let decimals = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch >= "0" && ch <= "9") {
      if (seenDot) {
        if (decimals >= maxDecimals) {
          rejected = true;
          continue;
        }
        decimals += 1;
      }
      out += ch;
    } else if (ch === "." && !seenDot && maxDecimals > 0) {
      seenDot = true;
      out += ch;
    } else if (ch === "-" && allowNegative && out === "") {
      out += ch;
    } else {
      rejected = true;
    }
  }
  return { text: out, rejected };
}

export function maskMoneyInput(raw: string, options: { allowNegative?: boolean } = {}): MaskResult {
  return maskDecimal(raw, 2, options.allowNegative ?? false);
}

export function maskPercentInput(raw: string): MaskResult {
  return maskDecimal(raw, 2, false);
}

const DECIMAL_TEXT = /^(-)?(\d*)(?:\.(\d*))?$/;

export type ParseResult = { ok: true; value: number | null } | { ok: false; error: string };

/** Parses `1,234.5`, `$1,234.56`, `-5` (when allowed) into integer cents. Empty text is `null`. */
export function parseMoneyToCents(text: string, options: { allowNegative?: boolean } = {}): ParseResult {
  const cleaned = text.replace(/[\s,$]/g, "");
  if (cleaned === "") return { ok: true, value: null };
  const m = DECIMAL_TEXT.exec(cleaned);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
    return { ok: false, error: "Enter a dollar amount using numbers only." };
  }
  const sign = m[1] ?? "";
  const whole = m[2] || "0";
  const frac = m[3] ?? "";
  if (frac.length > 2) return { ok: false, error: "Use at most two decimals (cents)." };
  if (sign && !options.allowNegative) return { ok: false, error: "Amount can't be negative." };
  if (whole.length > 13) return { ok: false, error: "Amount is too large." };
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return { ok: false, error: "Amount is too large." };
  return { ok: true, value: sign && cents !== 0 ? -cents : cents };
}

/** Parses `5`, `7.5`, `12.25%` into basis points. Empty text is `null`. */
export function parsePercentToBps(text: string, options: { max?: number } = {}): ParseResult {
  const max = options.max ?? 100;
  const cleaned = text.replace(/[\s%]/g, "");
  if (cleaned === "") return { ok: true, value: null };
  const m = DECIMAL_TEXT.exec(cleaned);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
    return { ok: false, error: "Enter a percent using numbers only." };
  }
  if (m[1]) return { ok: false, error: "Percent can't be negative." };
  const frac = m[3] ?? "";
  if (frac.length > 2) return { ok: false, error: "Use at most two decimals." };
  if ((m[2] || "0").length > 6) return { ok: false, error: `Percent can't be more than ${max}%.` };
  const bps = Number(m[2] || "0") * 100 + Number(frac.padEnd(2, "0"));
  if (bps > max * 100) return { ok: false, error: `Percent can't be more than ${max}%.` };
  return { ok: true, value: bps };
}

/** Plain editable text for a cents value, e.g. 123456 -> "1234.56". */
export function centsToEditableText(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${(abs % 100).toString().padStart(2, "0")}`;
}

/** Plain editable text for basis points, e.g. 750 -> "7.5". */
export function bpsToEditableText(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "";
  const abs = Math.round(bps);
  const frac = (abs % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return `${Math.floor(abs / 100)}${frac ? `.${frac}` : ""}`;
}
