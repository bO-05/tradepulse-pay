/**
 * Keyword/phrase match of pay-app text against the agreement's "Excluded scope (not in contract)"
 * notes, used by the offline rules engine (architecture §22). A note matches text when one of its
 * key phrases appears in it: two adjacent significant words of the note (for example "seismic
 * bracing"), or the note's only significant word. Words are lowercased and lightly stemmed, so
 * "bracing", "braces" and "braced" match each other.
 */

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "by", "with", "without", "from", "per", "as",
  "is", "are", "be", "been", "was", "were", "this", "that", "these", "those", "it", "its", "all", "any", "other",
  "others", "not", "no", "n", "s", "sub", "subs", "subcontractor", "contractor", "gc", "owner", "excluded",
  "exclude", "excludes", "exclusion", "exclusions", "scope", "contract", "work", "include", "includes",
  "included", "including", "incl", "provide", "provided", "providing", "furnish", "furnished", "install",
  "installed", "installing", "installation", "period", "item", "items", "line", "lines", "section", "see",
  "note", "notes", "only", "na", "etc", "complete", "completed", "done", "billed", "billing",
]);

function stem(word: string): string {
  if (word.length <= 4 || /^\d+$/.test(word)) return word;
  for (const suffix of ["ing", "ed", "es", "s", "e"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) return word.slice(0, -suffix.length);
  }
  return word;
}

/** Significant words of a text, in order: lowercased, stop words dropped, stemmed. */
export function significantTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw === "" || STOP_WORDS.has(raw)) continue;
    const s = stem(raw);
    if (STOP_WORDS.has(s)) continue;
    out.push(s);
  }
  return out;
}

/** The key phrases of an exclusion note, each a list of one or two stemmed words. */
export function exclusionPhrases(note: string): string[][] {
  const tokens = significantTokens(note);
  if (tokens.length === 0) return [];
  if (tokens.length === 1) return [tokens];
  const out: string[][] = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push([tokens[i], tokens[i + 1]]);
  return out;
}

function containsPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((p, j) => tokens[i + j] === p)) return true;
  }
  return false;
}

/**
 * The first exclusion note that one of the texts claims, or null. Phrases that also appear in one of
 * the contractScope texts (approved SOV line descriptions) are contract work and never count.
 */
export function matchExcludedScope(
  texts: readonly (string | null | undefined)[],
  notes: readonly string[],
  contractScope: readonly string[] = [],
): string | null {
  const tokenized = texts.filter((t): t is string => typeof t === "string" && t.trim() !== "").map(significantTokens);
  if (tokenized.length === 0) return null;
  const contractTokens = contractScope.map(significantTokens);
  for (const note of notes) {
    const phrases = exclusionPhrases(note).filter((p) => !contractTokens.some((tokens) => containsPhrase(tokens, p)));
    if (phrases.some((p) => tokenized.some((tokens) => containsPhrase(tokens, p)))) return note;
  }
  return null;
}

/** Splits free-text notes into clauses (sentences, semicolons, line breaks). */
export function noteClauses(notes: string): string[] {
  return notes
    .split(/[.;!?\n]+/)
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

export type ExclusionLine = { sovLineId: string; lineNo: number; description: string; note?: string | null; requestedCents: number };

export type ExcludedScopeClaims = {
  /** Per sovLineId: the exclusion note the line claims. */
  byLine: Map<string, string>;
  /** Pay-app note clauses that claim excluded scope without naming a line we could attribute. */
  unattributed: { clause: string; note: string }[];
};

const LINE_REF = /\b(?:line|item)\s*(?:no\.?\s*)?#?\s*(\d{1,4})\b/gi;

/**
 * Lines that claim excluded scope: through the sub's own work-this-period note on the line, or through
 * a pay-app note clause that names the line ("line 3"), shares a word with its description, or, when
 * only one line is billed this period, through any clause. Clauses that cannot be tied to a line are
 * reported apart and never zero a line.
 *
 * The SOV line description itself is never matched: the GC approved that line into the schedule of
 * values, so it is contract scope even when it reads like an exclusion note (for example "Low-voltage &
 * data" next to the exclusion "Low-voltage cabling"). A note that only restates a line's description
 * ("low-voltage pulled on level 2" on that line) is therefore not a claim either. The description is
 * otherwise used only to attribute a pay-app clause to a line.
 */
export function excludedScopeClaims(input: {
  lines: readonly ExclusionLine[];
  payAppNotes: string;
  excludedScopeNotes: readonly string[];
}): ExcludedScopeClaims {
  const byLine = new Map<string, string>();
  const unattributed: ExcludedScopeClaims["unattributed"] = [];
  const notes = input.excludedScopeNotes.filter((n) => n.trim() !== "");
  if (notes.length === 0) return { byLine, unattributed };
  for (const l of input.lines) {
    const hit = matchExcludedScope([l.note], notes, [l.description]);
    if (hit !== null) byLine.set(l.sovLineId, hit);
  }
  const billed = input.lines.filter((l) => l.requestedCents > 0);
  const allDescriptions = input.lines.map((l) => l.description);
  for (const clause of noteClauses(input.payAppNotes)) {
    const hit = matchExcludedScope([clause], notes, allDescriptions);
    if (hit === null) continue;
    const referenced = new Set<number>();
    for (const m of clause.matchAll(LINE_REF)) referenced.add(Number(m[1]));
    let targets = input.lines.filter((l) => referenced.has(l.lineNo));
    if (targets.length === 0) {
      const exclusionWords = new Set(significantTokens(hit));
      const clauseWords = new Set(significantTokens(clause).filter((w) => !exclusionWords.has(w)));
      targets = billed.filter((l) => significantTokens(l.description).some((w) => clauseWords.has(w)));
    }
    if (targets.length === 0 && billed.length === 1) targets = billed;
    if (targets.length === 0) {
      unattributed.push({ clause, note: hit });
      continue;
    }
    for (const l of targets) if (!byLine.has(l.sovLineId)) byLine.set(l.sovLineId, hit);
  }
  return { byLine, unattributed };
}
