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
