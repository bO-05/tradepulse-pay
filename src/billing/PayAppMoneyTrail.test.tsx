// @vitest-environment node
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { termsForKind } from "../lib/terms";
import { PayAppMoneyTrail, type PayAppView } from "./PayAppMoneyTrail";

/**
 * The settled Ortiz draw on the frozen Lopez reference: claimed $5,400.00, the rules suggested
 * $2,000.00, the GC approved $4,000.00, $200.00 retainage, $3,800.00 net, paid.
 */
function view(overrides: Record<string, unknown> = {}): PayAppView {
  return {
    _id: "payapp_1",
    status: "paid",
    projectKind: "residential",
    approvalHistory: {
      submittedAt: 1_763_000_000_000,
      reviewedAt: 1_763_000_060_000,
      approvedAt: 1_763_000_120_000,
      approvedBy: "Demo GC",
      requestedGrossCents: 540_000,
      approvedGrossCents: 400_000,
      reason: null,
    },
    reviewSuggestedTotalCents: 200_000,
    summary: { retainageCents: 20_000, currentPaymentDueCents: 380_000 },
    ...overrides,
  } as unknown as PayAppView;
}

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

function render(overrides: Record<string, unknown> = {}, kind: "residential" | "commercial" = "residential") {
  return renderToStaticMarkup(<PayAppMoneyTrail view={view(overrides)} terms={termsForKind(kind)} />);
}

describe("the sub pay app money trail", () => {
  test("renders the stored trail on the shared primitive with the pinned hooks", () => {
    const html = render();
    expect(html).toContain('data-testid="payapp-money-trail"');
    expect(html).toContain('data-testid="payapp-retainage-total"');
    expect(html).toContain('data-testid="payapp-money-trail-edit"');
    expect(html).toContain("Total retainage held to date: $200.00.");
    const rendered = text(html);
    for (const figure of ["$5,400.00", "$2,000.00", "$4,000.00", "$200.00", "$3,800.00"]) {
      expect(rendered, figure).toContain(figure);
    }
  });

  test("makes the net payment the hero: text-3xl, above the stages, paid by PayPal", () => {
    const html = render();
    expect(html.indexOf("Net this draw")).toBeLessThan(html.indexOf("Claimed"));
    expect(html).toMatch(/<dd[^>]*text-3xl[^>]*>\$3,800\.00/);
    expect(text(html)).toContain("Paid by PayPal");
    // One hero only; every stage figure is smaller than the hero.
    expect((html.match(/text-3xl/g) ?? []).length).toBe(1);
  });

  test("residential keeps draw words and names the withheld retainage in words, not colour alone", () => {
    const rendered = text(render());
    expect(rendered).toContain("Retainage this draw");
    expect(rendered).toContain("Withheld");
    expect(rendered).toContain("This draw withheld $200.00.");
    expect(rendered).not.toContain("Retainage this app");
  });

  test("commercial keeps application words and the G702 line reference", () => {
    const rendered = text(render({}, "commercial"));
    expect(rendered).toContain("Net this app");
    expect(rendered).toContain("Retainage this app");
    expect(rendered).toContain("Total retainage held to date: $200.00 (G702 line 5).");
    expect(rendered).toContain("This application withheld $200.00.");
    expect(rendered).not.toContain("Net this draw");
  });

  test("drops the edit note when the GC approved the review suggestion unchanged", () => {
    const html = render({
      reviewSuggestedTotalCents: 400_000,
      approvalHistory: {
        submittedAt: 1_763_000_000_000,
        reviewedAt: null,
        approvedAt: null,
        approvedBy: null,
        requestedGrossCents: 540_000,
        approvedGrossCents: 400_000,
        reason: null,
      },
    });
    expect(html).not.toContain('data-testid="payapp-money-trail-edit"');
  });

  test("a pay app that is not paid yet says so instead of claiming PayPal settled", () => {
    const rendered = text(render({ status: "approved" }));
    expect(rendered).not.toContain("Paid by PayPal");
    expect(rendered).toContain("Paid after the GC approves");
  });

  test("the sub page reuses the shared primitive instead of keeping its own MoneyTrail", () => {
    const page = readFileSync(new URL("./PayAppPage.tsx", import.meta.url), "utf8");
    expect(page).not.toMatch(/function MoneyTrail\s*\(/);
    expect(page).toContain('from "./PayAppMoneyTrail"');
    expect(page).toContain("<PayAppMoneyTrail");
    const shared = readFileSync(new URL("../ui/MoneyTrail.tsx", import.meta.url), "utf8");
    expect(shared).toContain("export function MoneyTrail");
  });
});

/**
 * A reviewed application whose requested net ($5,130.00) is larger than the review suggestion
 * ($2,000.00) and whose stored requested retainage is $270.00. Deriving the period retainage as
 * `suggested - requested net` rendered this state as -$3,130.00 before the fix.
 */
function reviewedView(status: "reviewed" | "revision_requested" | "rejected" | "approved") {
  const approved = status === "approved" ? 400_000 : null;
  return {
    status,
    approvalHistory: {
      submittedAt: 1_763_000_000_000,
      reviewedAt: 1_763_000_060_000,
      approvedAt: null,
      approvedBy: null,
      requestedGrossCents: 540_000,
      approvedGrossCents: approved,
      reason: null,
    },
    reviewSuggestedTotalCents: 200_000,
    summary:
      approved === null
        ? { retainageCents: 27_000, currentPaymentDueCents: 513_000 }
        : { retainageCents: 20_000, currentPaymentDueCents: 380_000 },
  };
}

describe("the sub pay app money trail in every status", () => {
  test.each(["reviewed", "revision_requested", "rejected"] as const)(
    "a %s app shows the stored requested retainage and says it is not withheld yet",
    (status) => {
      const rendered = text(render(reviewedView(status)));
      // No figure on the trail may be negative, and the old fabricated figure is gone.
      expect(rendered).not.toMatch(/-\$[0-9]/);
      expect(rendered).not.toContain("-$3,130.00");
      expect(rendered).toContain("$5,400.00"); // claimed, stored
      expect(rendered).toContain("$2,000.00"); // the rules suggestion, stored
      expect(rendered).toContain("$270.00"); // stored requested retainage (5,400.00 - 5,130.00)
      expect(rendered).toContain("$5,130.00"); // requested net, stored
      expect(rendered).toContain("GC approved —"); // not decided yet, stored null
      expect(rendered).toContain("Not withheld yet");
      expect(rendered).toContain("Retainage on this draw: $270.00. Not withheld yet");
      expect(rendered).not.toContain("This draw withheld");
      expect(rendered).not.toContain("Withheld");
    },
  );

  test("an approved app shows the stored approved retainage as actually withheld", () => {
    const rendered = text(render(reviewedView("approved")));
    expect(rendered).toContain("$4,000.00");
    expect(rendered).toContain("$200.00");
    expect(rendered).toContain("$3,800.00");
    expect(rendered).toContain("This draw withheld $200.00.");
    expect(rendered).not.toMatch(/-\$[0-9]/);
  });

  test("the paid reference keeps its stored retainage and its wording", () => {
    const rendered = text(render());
    expect(rendered).toContain("Total retainage held to date: $200.00.");
    expect(rendered).toContain("This draw withheld $200.00.");
    expect(rendered).toContain("Withheld");
  });
});
