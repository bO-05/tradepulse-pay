/**
 * Read-only reference copy, keyed on the stored `projectKind`.
 *
 * A residential reference (the settled Lopez kitchen job) is a settled sandbox record; commercial
 * and missing-kind projects keep the established "reference job" wording. The kind is the stored
 * field only — never the title text — so no surface guesses.
 */
import type { ProjectKind } from "./terms";

export const RESIDENTIAL_READ_ONLY_TITLE = "Settled sandbox record · read-only.";
export const COMMERCIAL_READ_ONLY_TITLE = "Preserved reference job · read-only.";

/** The one-line notice shown above a frozen record. A missing kind means commercial. */
export function readOnlyTitle(kind?: ProjectKind | null): string {
  return kind === "residential" ? RESIDENTIAL_READ_ONLY_TITLE : COMMERCIAL_READ_ONLY_TITLE;
}

/** The explanation beside a locked field, matching the same kind split. */
export function readOnlyReason(kind?: ProjectKind | null): string {
  return kind === "residential"
    ? "This settled sandbox record is read-only."
    : "This preserved reference job is read-only.";
}
