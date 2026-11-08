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
});
