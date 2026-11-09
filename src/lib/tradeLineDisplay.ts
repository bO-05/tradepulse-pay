/**
 * Display-only normalization of a frozen owner-draw trade line.
 *
 * The settled Lopez draw stores "Plumbing (22 00 00) – Ortiz Plumbing" (en dash). Another stored
 * copy was written with a literal "?" where the dash should be. A residential draw names the trade
 * and the sub, never a CSI division code, so the division is dropped here and the separator becomes
 * an em dash. The stored string is never edited.
 */
export function tradeLineDisplay(description: string): string {
  return description
    .replace(/\s*\(\d{2}\s+\d{2}\s+\d{2}\)\s*(?:[\u2013\u2014-]|\?)\s*/g, " \u2014 ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** True when the display helper changed the string; used by tests and the leak scan evidence. */
export function hasDivisionCode(description: string): boolean {
  return /\(\d{2}\s+\d{2}\s+\d{2}\)/.test(description);
}
