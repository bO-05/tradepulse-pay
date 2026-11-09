// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MoneyTrail, type MoneyTrailStep } from "./MoneyTrail";

const steps: MoneyTrailStep[] = [
  { label: "Claimed", valueCents: 540_000, valueTestId: "trail-claimed" },
  { label: "GC approves", valueCents: 400_000, valueTestId: "trail-approved" },
  { label: "Retainage 5%", valueCents: 20_000, note: "Held until closeout" },
  { label: "Net to the sub", valueCents: 380_000, tone: "positive", valueTestId: "trail-net" },
];

describe("the shared money trail", () => {
  test("renders every step in order with the stored cents and the trail test id", () => {
    const html = renderToStaticMarkup(<MoneyTrail testId="gc-money-trail" title="Money trail" description="Every figure is stored cents." steps={steps} />);
    expect(html).toContain('data-testid="gc-money-trail"');
    expect(html).toContain("Money trail");
    expect(html).toContain("Every figure is stored cents.");
    expect(html.indexOf("Claimed")).toBeLessThan(html.indexOf("GC approves"));
    expect(html.indexOf("GC approves")).toBeLessThan(html.indexOf("Retainage 5%"));
    expect(html.indexOf("Retainage 5%")).toBeLessThan(html.indexOf("Net to the sub"));
    expect(html).toContain("$5,400.00");
    expect(html).toContain("$4,000.00");
    expect(html).toContain("$200.00");
    expect(html).toContain("$3,800.00");
    expect(html).toContain("Held until closeout");
  });

  test("the compact variant drops the card and keeps the pinned value hooks on dd elements", () => {
    const html = renderToStaticMarkup(<MoneyTrail variant="compact" testId="proposal-money-trail" steps={steps} />);
    expect(html).toContain('data-testid="proposal-money-trail"');
    expect(html).not.toContain("<section");
    expect(html).toMatch(/data-testid="trail-claimed"[^>]*>\$5,400\.00<\/dd>/);
    expect(html).toMatch(/data-testid="trail-approved"[^>]*>\$4,000\.00<\/dd>/);
    expect(html).toMatch(/data-testid="trail-net"[^>]*>\$3,800\.00<\/dd>/);
  });

  test("a null figure renders an em dash instead of a zero", () => {
    const html = renderToStaticMarkup(<MoneyTrail variant="compact" steps={[{ label: "Not approved yet", valueCents: null }]} />);
    expect(html).toContain("Not approved yet");
    expect(html).toContain("—");
    expect(html).not.toContain("$0.00");
  });

  test("a hero figure renders above the stages at text-3xl, the largest number on the screen", () => {
    const html = renderToStaticMarkup(
      <MoneyTrail
        testId="payapp-money-trail"
        title="Money trail"
        hero={{ label: "Net this draw", valueCents: 380_000, tone: "positive", note: "Paid by PayPal" }}
        steps={steps}
      />,
    );
    expect(html.indexOf("Net this draw")).toBeLessThan(html.indexOf("Claimed"));
    expect(html).toMatch(/<dd[^>]*text-3xl[^>]*>\$3,800\.00/);
    expect(html).toContain("Paid by PayPal");
    // Exactly one figure is the hero; the stages stay at the stage size.
    expect((html.match(/text-3xl/g) ?? []).length).toBe(1);
  });

  test("the footer renders under the steps, inside the card and inside the cardless variant", () => {
    const card = renderToStaticMarkup(
      <MoneyTrail
        testId="payapp-money-trail"
        title="Money trail"
        steps={steps}
        footer={<p data-testid="payapp-retainage-total">Total retainage held to date: $200.00.</p>}
      />,
    );
    expect(card).toContain('data-testid="payapp-retainage-total"');
    expect(card.indexOf("Net to the sub")).toBeLessThan(card.indexOf("payapp-retainage-total"));
    const plain = renderToStaticMarkup(
      <MoneyTrail steps={steps} footer={<p data-testid="paid-note">Paid by PayPal</p>} />,
    );
    expect(plain).toContain('data-testid="paid-note"');
    expect(plain).not.toContain("<section");
  });
});
