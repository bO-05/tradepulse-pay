/**
 * Text helpers for generated PDFs and CSVs. The standard Helvetica fonts of pdf-lib use WinAnsi
 * encoding and `drawText` throws on any character outside it, so every string that reaches a PDF
 * goes through `winAnsi` first.
 */

// WinAnsi (CP-1252) code points above Latin-1 that Helvetica can draw.
const WIN_ANSI_EXTRA = new Set(
  [0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178],
);

const REPLACEMENTS: Record<string, string> = {
  "\u2212": "-", // minus sign
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2015": "-",
  "\u00a0": " ",
  "\u2007": " ",
  "\u2009": " ",
  "\u202f": " ",
  "\u2032": "'",
  "\u2033": '"',
  "\u201b": "'",
  "\u201f": '"',
  "\u2264": "<=",
  "\u2265": ">=",
  "\u2190": "<-",
  "\u2192": "->",
  "\u2713": "x",
  "\u2714": "x",
  // Letters with no Unicode decomposition to a base letter.
  "\u0141": "L",
  "\u0142": "l",
  "\u0110": "D",
  "\u0111": "d",
  "\u0131": "i",
};

function drawable(code: number): boolean {
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || WIN_ANSI_EXTRA.has(code);
}

/** One line of text Helvetica can draw: whitespace runs collapse to a space, unknown characters become "?". */
export function winAnsi(input: string): string {
  let out = "";
  for (const ch of input.replace(/[\t\r\n\f\v]+/g, " ")) {
    const code = ch.codePointAt(0)!;
    if (drawable(code)) {
      out += ch;
      continue;
    }
    const mapped = REPLACEMENTS[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const stripped = ch.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    out += stripped.length > 0 && [...stripped].every((c) => drawable(c.codePointAt(0)!)) ? stripped : "?";
  }
  return out;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function absAmount(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`cents must be an integer, got ${cents}`);
  const abs = Math.abs(cents);
  return `${groupThousands(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, "0")}`;
}

/** "172,400.00"; negatives in accounting parentheses, "(1,200.00)". Amounts are US dollars. */
export function pdfAmount(cents: number): string {
  return cents < 0 ? `(${absAmount(cents)})` : absAmount(cents);
}

/** A change to a sum: "+8,750.00", "(1,200.00)" for a deduction, "0.00" for none. */
export function pdfSignedAmount(cents: number): string {
  if (cents > 0) return `+${absAmount(cents)}`;
  return pdfAmount(cents);
}

/** "5%" or "4.75%" from basis points. */
export function bpsPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}

/** A file-name-safe slug: letters, digits, dashes. */
export function fileSlug(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "document";
}
