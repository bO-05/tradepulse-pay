// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * Current-facing documentation must match the follow-up audit UI: one Lopez five-cell strip on three
 * mounts, real-GC More vs demo-GC direct Procurement, and the preserved exact-agreement change-order
 * flow that documentation validation never pays.
 */
const docs = {
  "docs/judge-guide.md": readFileSync(new URL("../docs/judge-guide.md", import.meta.url), "utf8"),
  "README.md": readFileSync(new URL("../README.md", import.meta.url), "utf8"),
  "docs/landing-navigation-inbox.md": readFileSync(new URL("../docs/landing-navigation-inbox.md", import.meta.url), "utf8"),
  "docs/recovery-progress.md": readFileSync(new URL("../docs/recovery-progress.md", import.meta.url), "utf8"),
};

const flat = (source: string) => source.replace(/\s+/g, " ");
const JUDGE_GUIDE = flat(docs["docs/judge-guide.md"]);
const README = flat(docs["README.md"]);
const LANDING_NAV = flat(docs["docs/landing-navigation-inbox.md"]);
const RECOVERY = flat(docs["docs/recovery-progress.md"]);

const FIVE_LABELS = [
  "Collected from homeowner",
  "Paid to subs",
  "Retainage you hold",
  "Retainage held from you",
  "Owed this week",
];
const FIVE_VALUES = ["$4,800.00", "$3,800.00", "$200.00", "$400.00", "$0.00"];

describe("the settled Lopez money strip in current docs", () => {
  test.each([
    ["docs/judge-guide.md", JUDGE_GUIDE],
    ["README.md", README],
  ])("%s names the one five-cell strip, its labels, its stored values and its mounts", (_name, text) => {
    expect(text).toContain("Money on this job · Lopez Kitchen Remodel");
    for (const label of FIVE_LABELS) expect(text, label).toContain(label);
    for (const value of FIVE_VALUES) expect(text, value).toContain(value);
    expect(text).toContain("#/inbox");
    expect(text).toContain("#/all-projects/<projectId>");
    expect(text).toContain("owner-billing tab");
    // Commercial reference work is one closed, counted disclosure, not a second strip.
    expect(text).toContain("one closed, counted");
    expect(text).toContain("Commercial reference job (n)");
    expect(text).toContain("every commercial row");
    // The removed all-jobs portfolio strip must not survive as a current claim.
    expect(text).not.toMatch(/collected from owners/i);
    expect(text).not.toMatch(/four-cell|four cell/i);
  });
});

describe("the real-user path", () => {
  test("judge-guide uses Projects → Quick start, People invite verification and real GC More → Procurement", () => {
    expect(JUDGE_GUIDE).toContain("Projects → Quick start");
    expect(JUDGE_GUIDE).toContain("People → Invite subcontractor");
    expect(JUDGE_GUIDE).toContain("resend or copy the invite");
    expect(JUDGE_GUIDE).toContain("More → Procurement");
    expect(JUDGE_GUIDE).toContain("More hides Procurement");
    expect(JUDGE_GUIDE).toContain("#/procurement");
  });

  test("judge-guide step 7 keeps the exact-agreement $1,850 flow and forbids paying it in validation", () => {
    expect(JUDGE_GUIDE).toContain("your exact agreement");
    expect(JUDGE_GUIDE).toContain("$1,850");
    expect(JUDGE_GUIDE).toContain("validation never executes the `$1,850` payment");
  });
});

describe("current navigation docs", () => {
  test("distinguish real-GC More from the demo direct route", () => {
    expect(README).toContain("More for real GCs, direct #/procurement for the demo GC");
    expect(LANDING_NAV).toContain("A real GC sees all seven");
    expect(LANDING_NAV).toContain("The demo GC sees six");
    expect(LANDING_NAV).toContain("Open in Procurement");
    expect(RECOVERY).toContain("A real GC keeps all seven More links");
    expect(RECOVERY).toContain("GC's More has six");
    for (const text of [README, LANDING_NAV, RECOVERY]) {
      expect(text).toContain("#/procurement");
    }
  });

  test("keep the current QA result and do not present the removed strip as current", () => {
    expect(LANDING_NAV).toContain("78/78 checks");
    expect(RECOVERY).toContain("78/78 checks");
    for (const text of [LANDING_NAV, RECOVERY]) {
      expect(text).not.toMatch(/collected from owners/i);
    }
  });
});
