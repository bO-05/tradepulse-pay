/**
 * Presentation for stored review text.
 *
 * A frozen run's narrative is recorded history: the stored words are never rewritten, hidden or
 * paraphrased. Two presentation rules apply around it:
 *   - a plain attribution heading names the run date, and
 *   - model commentary that happened to print a raw rule key is shown with the rule's plain words.
 * The second rule only fires when a key is present; the frozen Lopez narrative contains none, so
 * its bytes pass through unchanged.
 */

const RULE_WORDS: readonly [RegExp, string][] = [
  [/\bcloseoutWorkBeforeEarlierTranches\b/g, "closeout work before earlier funding tranches"],
  [/\bcloseoutWorkBeforeEarlierMilestones\b/g, "closeout work before earlier funded milestones"],
  [/\btrancheCeilingPctToDate\b/g, "funding ceiling to date"],
  [/\bfundedMilestoneCeilingPctToDate\b/g, "funded-milestone ceiling to date"],
  [/\bexcludedScopeNotes\b/g, "excluded scope notes"],
];

/** Replace a raw rule identifier with the words it stands for; leave ordinary prose untouched. */
export function reviewText(value: string): string {
  return RULE_WORDS.reduce((text, [pattern, words]) => text.replace(pattern, words), value);
}

/** "Recorded review · Nov 8, 2026" — the plain heading above quoted recorded history. */
export function recordedReviewHeading(at: number, label = "Recorded review"): string {
  return `${label} · ${new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })}`;
}
