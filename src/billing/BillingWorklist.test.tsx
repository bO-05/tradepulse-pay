// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import { BillingWorklist } from "./BillingWorklist";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));

type Kind = "residential" | "commercial";

function row(id: string, kind: Kind | undefined, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    applicationNo: 1,
    periodLabel: "Pay app #1 – period ending Oct 15, 2026",
    periodEnd: 1_791_000_000_000,
    dueDate: null,
    status: "submitted",
    currentPaymentDueCents: 400_000,
    requestedTotalCents: 540_000,
    submittedAt: 1_791_000_000_000,
    agreementId: "agreement_ortiz",
    agreementNumber: "SC-22-ORTIZ-0001",
    projectTitle: "Lopez Kitchen Remodel",
    projectKind: kind,
    subName: "Ortiz Plumbing",
    awaitingReview: true,
    isG703: true,
    ...overrides,
  };
}

function mockWorklist(value: { rows: ReturnType<typeof row>[]; truncated?: boolean } | undefined) {
  vi.mocked(useQuery).mockReturnValue(
    (value === undefined ? undefined : { rows: value.rows, truncated: value.truncated === true }) as never,
  );
}

function between(html: string, startNeedle: string, endNeedle: string): string {
  const start = html.indexOf(startNeedle);
  if (start < 0) throw new Error(`missing ${startNeedle}`);
  const end = html.indexOf(endNeedle, start);
  return end < 0 ? html.slice(start) : html.slice(start, end);
}

function detailsTag(html: string, at: number): string {
  const start = html.lastIndexOf("<details", at);
  return html.slice(start, html.indexOf(">", start) + 1);
}

beforeEach(() => {
  mockWorklist(undefined);
});

describe("GC Billing worklist partition", () => {
  test("mixed state keeps the residential rows first and every commercial row in one closed counted disclosure", () => {
    mockWorklist({
      rows: [
        row("payapp_commercial_waiting", "commercial", { agreementNumber: "A401-DEMO-PAY-20261109-19", projectTitle: "Sandbox run 20261109-19" }),
        row("payapp_commercial_decided", "commercial", {
          agreementNumber: "A401-DEMO-PAY-20261110-20",
          projectTitle: "Sandbox run 20261110-20",
          status: "paid",
          awaitingReview: false,
        }),
        row("payapp_ortiz", "residential", {
          status: "paid",
          awaitingReview: false,
          applicationNo: null,
          periodLabel: "Judge demo · Period 2 (billing agent)",
        }),
      ],
    });
    const html = renderToStaticMarkup(<BillingWorklist />);

    const commercial = html.indexOf('data-testid="billing-commercial"');
    expect(html.match(/data-testid="billing-commercial"/g) ?? []).toHaveLength(1);
    expect(html).toContain("Commercial reference job (2)");
    expect(html).toContain('data-record-count="2"');
    expect(detailsTag(html, commercial)).not.toContain(" open");

    // The residential paid row renders outside, before the commercial disclosure.
    const ortiz = html.indexOf('href="#/pay-apps/payapp_ortiz"');
    expect(ortiz).toBeGreaterThan(-1);
    expect(ortiz).toBeLessThan(commercial);

    const inside = between(html, 'data-testid="billing-commercial"', "</details>");
    expect(inside).toContain('href="#/pay-apps/payapp_commercial_waiting"');
    expect(inside).toContain('href="#/pay-apps/payapp_commercial_decided"');
    expect(inside).not.toContain('href="#/pay-apps/payapp_ortiz"');

    // Every original row survives exactly once.
    expect(html.match(/data-testid="billing-worklist-row"/g) ?? []).toHaveLength(3);
  });

  test("commercial status groups keep their existing words inside the disclosure", () => {
    mockWorklist({
      rows: [
        row("payapp_commercial_waiting", "commercial", { applicationNo: 3 }),
        row("payapp_commercial_decided", "commercial", { applicationNo: 2, status: "paid", awaitingReview: false }),
      ],
    });
    const html = renderToStaticMarkup(<BillingWorklist />);

    const inside = between(html, 'data-testid="billing-commercial"', "</details>");
    expect(inside).toContain("Awaiting review");
    expect(inside).toContain("Decided and withdrawn");
    expect(inside.indexOf("Awaiting review")).toBeLessThan(inside.indexOf("Decided and withdrawn"));
    expect(inside).toContain('href="#/pay-apps/payapp_commercial_waiting"');
    expect(inside).toContain('href="#/pay-apps/payapp_commercial_decided"');
  });

  test("server order is preserved inside the commercial partition", () => {
    mockWorklist({
      rows: [
        row("payapp_c1", "commercial", { applicationNo: 1 }),
        row("payapp_r1", "residential", { applicationNo: 2 }),
        row("payapp_c2", "commercial", { applicationNo: 3 }),
        row("payapp_r2", "residential", { applicationNo: 4 }),
      ],
    });
    const html = renderToStaticMarkup(<BillingWorklist />);

    const r1 = html.indexOf('href="#/pay-apps/payapp_r1"');
    const r2 = html.indexOf('href="#/pay-apps/payapp_r2"');
    expect(r1).toBeGreaterThan(-1);
    expect(r1).toBeLessThan(r2);
    const inside = between(html, 'data-testid="billing-commercial"', "</details>");
    expect(inside.indexOf('href="#/pay-apps/payapp_c1"')).toBeLessThan(inside.indexOf('href="#/pay-apps/payapp_c2"'));
  });

  test("a residential-only result set keeps the awaiting and decided cards without a disclosure", () => {
    mockWorklist({
      rows: [
        row("payapp_ortiz_waiting", "residential"),
        row("payapp_ortiz_paid", "residential", { applicationNo: 2, status: "paid", awaitingReview: false }),
      ],
    });
    const html = renderToStaticMarkup(<BillingWorklist />);

    expect(html).not.toContain('data-testid="billing-commercial"');
    expect(html).not.toContain("Commercial reference job");
    expect(html).toContain("Awaiting review");
    expect(html).toContain("Decided and withdrawn");
    expect(html).toContain('href="#/pay-apps/payapp_ortiz_waiting"');
    expect(html).toContain('href="#/pay-apps/payapp_ortiz_paid"');
  });

  test("a missing project kind reads commercial and never lands in the residential cards", () => {
    mockWorklist({
      rows: [
        row("payapp_ortiz", "residential"),
        row("payapp_legacy", undefined, { agreementNumber: "SC-LEGACY-0001", projectTitle: "Legacy Office Buildout" }),
      ],
    });
    const html = renderToStaticMarkup(<BillingWorklist />);

    const inside = between(html, 'data-testid="billing-commercial"', "</details>");
    expect(inside).toContain('href="#/pay-apps/payapp_legacy"');
    expect(inside).not.toContain('href="#/pay-apps/payapp_ortiz"');
    expect(html).toContain("Commercial reference job (1)");
  });

  test("the partition uses projectKind only, never an agreement-number suffix", () => {
    mockWorklist({
      rows: [
        row("payapp_suffix_residential", "residential", {
          agreementNumber: "A401-DEMO-PAY-20261105-07",
          status: "paid",
          awaitingReview: false,
        }),
        row("payapp_suffix_commercial", "commercial", { agreementNumber: "SC-22-ORTIZ-0001" }),
      ],
    });
    const html = renderToStaticMarkup(<BillingWorklist />);

    const inside = between(html, 'data-testid="billing-commercial"', "</details>");
    expect(inside).toContain("SC-22-ORTIZ-0001");
    expect(inside).not.toContain("A401-DEMO-PAY-20261105-07");
    expect(html.indexOf("A401-DEMO-PAY-20261105-07")).toBeLessThan(html.indexOf('data-testid="billing-commercial"'));
  });

  test("a legacy pay app without an application number keeps its quoted period wording", () => {
    mockWorklist({
      rows: [row("payapp_legacy", "residential", { applicationNo: null, periodLabel: "Judge demo · Period 2 (billing agent)" })],
    });
    const html = renderToStaticMarkup(<BillingWorklist />);

    expect(html).toContain('&quot;Period 2 · billing agent&quot;');
    expect(html).not.toContain("Judge demo");
  });

  test("the truncated note and the zero-row state keep their existing wording", () => {
    mockWorklist({ rows: [row("payapp_ortiz", "residential")], truncated: true });
    const truncated = renderToStaticMarkup(<BillingWorklist />);
    expect(truncated).toContain("Showing the newest pay apps only.");

    mockWorklist({ rows: [] });
    const empty = renderToStaticMarkup(<BillingWorklist />);
    expect(empty).toContain("Awaiting review");
    expect(empty).toContain("Nothing to review");
    expect(empty).not.toContain('data-testid="billing-commercial"');
    expect(empty).not.toContain('data-testid="billing-worklist-row"');

    mockWorklist(undefined);
    const loading = renderToStaticMarkup(<BillingWorklist />);
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading pay apps…");
  });
});
