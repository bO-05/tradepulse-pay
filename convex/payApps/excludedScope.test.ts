import { describe, expect, test } from "vitest";
import { excludedScopeClaims, exclusionPhrases, matchExcludedScope, significantTokens } from "./excludedScope";

const NOTES = ["Seismic bracing of conduit and equipment", "Fire alarm system"];

const lines = [
  { sovLineId: "l1", lineNo: 1, description: "Switchgear and distribution", requestedCents: 100_00 },
  { sovLineId: "l2", lineNo: 2, description: "Branch conduit and wire", requestedCents: 200_00 },
  { sovLineId: "l3", lineNo: 3, description: "Grounding grid", requestedCents: 300_00 },
];

describe("excluded-scope keyword match", () => {
  test("tokens are lowercased, stemmed and stop words dropped", () => {
    expect(significantTokens("Installed the SEISMIC Bracing at level 2")).toEqual(["seismic", "brac", "level", "2"]);
    expect(exclusionPhrases("Seismic bracing")).toEqual([["seismic", "brac"]]);
    expect(exclusionPhrases("Excluded: trenching")).toEqual([["trench"]]);
  });

  test("matches a note phrase case-insensitively and across word forms", () => {
    expect(matchExcludedScope(["Grounding grid plus SEISMIC BRACES at level 2"], NOTES)).toBe(NOTES[0]);
    expect(matchExcludedScope(["fire alarm devices roughed in"], NOTES)).toBe(NOTES[1]);
  });

  test("shared single words do not match a multi-word note", () => {
    expect(matchExcludedScope(["Conduit runs progressing", "Grounding materials stored on site"], NOTES)).toBeNull();
    expect(matchExcludedScope(["Fire stopping at penetrations"], NOTES)).toBeNull();
    expect(matchExcludedScope([null, undefined, ""], NOTES)).toBeNull();
  });

  test("a line note claiming excluded scope flags that line only", () => {
    const res = excludedScopeClaims({
      lines: [...lines.slice(0, 2), { ...lines[2], note: "Grounding grid plus seismic bracing installed at level 2" }],
      payAppNotes: "Switchgear set.",
      excludedScopeNotes: NOTES,
    });
    expect([...res.byLine.entries()]).toEqual([["l3", NOTES[0]]]);
    expect(res.unattributed).toEqual([]);
  });

  test("pay-app notes are attributed by line number, then by shared description words", () => {
    const byNumber = excludedScopeClaims({ lines, payAppNotes: "Line 2: seismic bracing complete.", excludedScopeNotes: NOTES });
    expect([...byNumber.byLine.keys()]).toEqual(["l2"]);
    const byWord = excludedScopeClaims({ lines, payAppNotes: "Added seismic bracing on the switchgear.", excludedScopeNotes: NOTES });
    expect([...byWord.byLine.keys()]).toEqual(["l1"]);
  });

  test("an unattributable pay-app note is reported without zeroing a line", () => {
    const res = excludedScopeClaims({ lines, payAppNotes: "Seismic bracing started. Feeders pulled.", excludedScopeNotes: NOTES });
    expect(res.byLine.size).toBe(0);
    expect(res.unattributed).toEqual([{ clause: "Seismic bracing started", note: NOTES[0] }]);
  });

  test("with one billed line, any matching pay-app clause applies to it", () => {
    const res = excludedScopeClaims({
      lines: lines.map((l) => (l.lineNo === 3 ? l : { ...l, requestedCents: 0 })),
      payAppNotes: "Seismic bracing started.",
      excludedScopeNotes: NOTES,
    });
    expect([...res.byLine.keys()]).toEqual(["l3"]);
  });

  describe("approved SOV line descriptions are contract scope", () => {
    const LV_NOTES = ["Low-voltage cabling (27 00 00)"];
    const lvLines = [
      { sovLineId: "l4", lineNo: 4, description: "Lighting fixtures 26 51 00", requestedCents: 400_00 },
      { sovLineId: "l5", lineNo: 5, description: "Low-voltage & data 27 10 00", requestedCents: 500_00 },
    ];

    test("a line whose description resembles an exclusion note is not flagged", () => {
      const res = excludedScopeClaims({ lines: lvLines, payAppNotes: "", excludedScopeNotes: LV_NOTES });
      expect(res.byLine.size).toBe(0);
      expect(res.unattributed).toEqual([]);
    });

    test("notes that only restate the line's own description are not claims", () => {
      const res = excludedScopeClaims({
        lines: [lvLines[0], { ...lvLines[1], note: "Low-voltage & data rough-in on level 2" }],
        payAppNotes: "Low-voltage pulled on level 2. Fixtures hung.",
        excludedScopeNotes: LV_NOTES,
      });
      expect(res.byLine.size).toBe(0);
      expect(res.unattributed).toEqual([]);
    });

    test("a note claiming the excluded part beyond the description is still flagged", () => {
      const res = excludedScopeClaims({
        lines: [{ ...lvLines[0], note: "Fixtures plus low-voltage cabling pulled" }, lvLines[1]],
        payAppNotes: "",
        excludedScopeNotes: LV_NOTES,
      });
      expect([...res.byLine.entries()]).toEqual([["l4", LV_NOTES[0]]]);
    });

    test("a description matching an exclusion is ignored while the line note still flags", () => {
      const res = excludedScopeClaims({
        lines: [{ sovLineId: "l9", lineNo: 9, description: "Seismic bracing of conduit", note: "Fire alarm devices roughed in", requestedCents: 1 }],
        payAppNotes: "",
        excludedScopeNotes: NOTES,
      });
      expect([...res.byLine.entries()]).toEqual([["l9", NOTES[1]]]);
    });
  });

  test("no exclusion notes means no claims", () => {
    const res = excludedScopeClaims({ lines, payAppNotes: "Seismic bracing", excludedScopeNotes: [" "] });
    expect(res.byLine.size).toBe(0);
    expect(res.unattributed).toEqual([]);
  });
});
