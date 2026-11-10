// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const docs = {
  "README.md": readFileSync(new URL("../README.md", import.meta.url), "utf8"),
  "docs/judge-guide.md": readFileSync(new URL("../docs/judge-guide.md", import.meta.url), "utf8"),
};

function words(source: string): string {
  return source.replace(/\s+/g, " ");
}

describe("the judge-facing settled-record story", () => {
  test.each(Object.entries(docs))("%s explains the conservative review and recorded GC decision", (_name, source) => {
    const rendered = words(source);
    expect(rendered).toContain("conservative");
    expect(rendered).toMatch(/funded or in-progress milestones are credited at 50%/i);
    expect(rendered).toContain("Work in place is reported by the subcontractor, not independently inspected");
    expect(rendered).toContain("Rough-in");
    expect(rendered).toContain("Fixtures set");
    expect(rendered).toContain("both billed lines");
    expect(rendered).toContain("recorded per-line reasons");
    expect(rendered).toContain("kept the Fixtures set cut");
    expect(rendered).toContain("overrode Rough-in");
  });

  test.each(Object.entries(docs))("%s matches every settled figure without a re-settlement claim", (_name, source) => {
    const rendered = words(source);
    for (const figure of ["$5,400.00", "$2,000.00", "$1,400.00", "$0.00", "$4,000.00", "$200.00", "$3,800.00"]) {
      expect(rendered, figure).toContain(figure);
    }
    expect(rendered).not.toMatch(/\b(re-settlement|resettlement|re-settled|resettled|re-settle|resettle)\b/i);
    for (const jargon of ["(140,000 cents)", "tranche ceiling", "funding progress"]) {
      expect(rendered).not.toContain(jargon);
    }
  });
});
