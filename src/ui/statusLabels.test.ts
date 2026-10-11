import { describe, expect, test } from "vitest";
import schemaSource from "../../convex/schema.ts?raw";
import { STATUS_LABELS, TONE_CLASSES, humanizeStatus, isKnownStatus, statusLabel, statusMeta } from "./statusLabels";

/**
 * Collects every status literal declared in convex/schema.ts:
 * - named validators whose name contains Status or Verdict (`payAppStatusValidator = v.union(...)`),
 * - fields named `status`, `*Status`, `phase` or `*Outcome` with inline `v.literal(...)` unions,
 * - `v.string()` status fields that document their codes in a trailing comment (`// "a" | "b"`).
 */
function extractSchemaStatusLiterals(source: string): Set<string> {
  const found = new Set<string>();
  const starts = /(\b\w*(?:Status|Verdict)\w*Validator\s*=)|(\b(?:\w*[sS]tatus|phase|\w*Outcome)\s*:)/g;
  let match: RegExpExecArray | null;
  while ((match = starts.exec(source))) {
    let i = match.index + match[0].length;
    let depth = 0;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(" || ch === "{" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "}" || ch === "]") {
        if (depth === 0) break;
        depth -= 1;
      } else if ((ch === "," || ch === ";") && depth === 0) break;
    }
    const lineEnd = source.indexOf("\n", i);
    const expression = source.slice(match.index + match[0].length, i);
    const trailing = source.slice(i, lineEnd === -1 ? undefined : lineEnd);
    for (const lit of expression.matchAll(/v\.literal\("([^"]+)"\)/g)) found.add(lit[1]);
    if (/v\.string\(\)/.test(expression)) {
      const comment = trailing.split("//")[1];
      if (comment) for (const q of comment.matchAll(/"([^"]+)"/g)) found.add(q[1]);
    }
  }
  return found;
}

describe("statusLabels", () => {
  const schemaStatuses = extractSchemaStatusLiterals(schemaSource);

  test("the extractor finds the known schema status families", () => {
    for (const code of ["under_review", "partially_captured", "funding_expired", "skipped_budget", "not_sent", "out_of_sequence", "rfqs_dispatched", "PASS"]) {
      expect(schemaStatuses.has(code), code).toBe(true);
    }
    expect(schemaStatuses.size).toBeGreaterThan(50);
  });

  test("every status literal in convex/schema.ts has a human label", () => {
    const missing = [...schemaStatuses].filter((code) => !isKnownStatus(code));
    expect(missing).toEqual([]);
  });

  test("no label is a raw snake_case code", () => {
    for (const [code, meta] of Object.entries(STATUS_LABELS)) {
      expect(meta.label, code).not.toMatch(/_/);
      expect(TONE_CLASSES[meta.tone], code).toBeTruthy();
    }
  });

  test("Phase-2 statuses from the architecture use the agreed labels", () => {
    expect(statusLabel("approved_as_noted")).toBe("Approved as noted");
    expect(statusLabel("revision_requested")).toBe("Revision requested");
    expect(statusLabel("under_review")).toBe("Under review");
    expect(statusLabel("conditional_progress")).toBe("Conditional progress");
    expect(statusLabel("partially_captured")).toBe("Partially captured");
    expect(statusLabel("skipped_budget")).toBe("Email not sent (daily limit)");
    expect(statusLabel("pending_review")).toBe("Pending review");
  });

  test("unknown codes fall back to a readable label, never the raw code", () => {
    expect(humanizeStatus("some_new_state")).toBe("Some new state");
    expect(statusMeta("SOME_PAYPAL_CODE").label).toBe("Some paypal code");
    expect(statusLabel(undefined)).toBe("Unknown");
  });
});
