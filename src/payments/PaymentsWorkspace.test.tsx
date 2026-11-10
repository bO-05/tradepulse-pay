// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import { PaymentsWorkspace } from "./PaymentsWorkspace";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));

type Kind = "residential" | "commercial";

function agreement(id: string, kind: Kind | undefined, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    agreementNumber: "SC-22-ORTIZ-0001",
    projectId: "project_lopez",
    projectTitle: "Lopez Kitchen Remodel",
    subcontractorName: "Ortiz Plumbing (demo)",
    contractorId: "contractor_ortiz",
    csiDivision: "22 00 00",
    tradeName: "Plumbing",
    status: "executed",
    retainagePercent: 5,
    retainagePercentApplied: 5,
    retainageReductionBpsAt50: null,
    contractSumCents: 900_000,
    originalContractSumCents: 900_000,
    netChangeOrdersCents: 0,
    excludedScopeNotes: [],
    executedAt: 1_790_000_000_000,
    projectKind: kind,
    ...overrides,
  };
}

function mockAgreements(rows: ReturnType<typeof agreement>[] | undefined) {
  vi.mocked(useQuery).mockReturnValue(rows as never);
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
  mockAgreements(undefined);
});

describe("GC Payments worklist partition", () => {
  test("mixed state puts SC-22-ORTIZ-0001 before the commercial Rosendin Div 26 00 00 row", () => {
    mockAgreements([
      agreement("agreement_rosendin", "commercial", {
        agreementNumber: "SC-24-ROSENDIN-0001",
        subcontractorName: "Rosendin Electric",
        projectTitle: "Harbor Point Dental Office TI",
        csiDivision: "26 00 00",
        tradeName: "Electrical",
        contractSumCents: 4_200_000,
      }),
      agreement("agreement_ortiz", "residential"),
      agreement("agreement_run20", "commercial", {
        agreementNumber: "A401-DEMO-PAY-20261110-20",
        subcontractorName: "Demo GC",
        projectTitle: "Sandbox run 20261110-20",
        csiDivision: "01 00 00",
        tradeName: "General conditions",
        contractSumCents: 500_000,
      }),
    ]);
    const html = renderToStaticMarkup(<PaymentsWorkspace />);

    const ortiz = html.indexOf("SC-22-ORTIZ-0001");
    const rosendin = html.indexOf("Div 26 00 00");
    expect(ortiz).toBeGreaterThan(-1);
    expect(rosendin).toBeGreaterThan(-1);
    expect(ortiz).toBeLessThan(rosendin);

    const commercial = html.indexOf('data-testid="payments-commercial"');
    expect(html.match(/data-testid="payments-commercial"/g) ?? []).toHaveLength(1);
    expect(html).toContain("Commercial reference job (2)");
    expect(html).toContain('data-record-count="2"');
    expect(detailsTag(html, commercial)).not.toContain(" open");

    const inside = between(html, 'data-testid="payments-commercial"', "</details>");
    expect(inside).toContain('href="#/payments/agreement_rosendin"');
    expect(inside).toContain('href="#/payments/agreement_run20"');
    expect(inside).toContain("A401-DEMO-PAY-20261110-20");
    expect(inside).not.toContain('href="#/payments/agreement_ortiz"');

    // The residential table keeps the pinned hook and the commercial rows keep a stable one.
    const residentialTable = between(html, 'data-testid="payments-agreements"', "</table>");
    expect(residentialTable).toContain('href="#/payments/agreement_ortiz"');
    expect(inside).toContain('data-testid="payments-commercial-agreements"');

    // Every original agreement link survives exactly once.
    const hrefs = html.match(/href="#\/payments\/agreement_[a-z0-9]+"/g) ?? [];
    expect(hrefs).toHaveLength(3);
    expect(new Set(hrefs).size).toBe(3);
  });

  test("server order is preserved inside each partition", () => {
    mockAgreements([
      agreement("agreement_c1", "commercial", { agreementNumber: "Commercial One" }),
      agreement("agreement_r1", "residential", { agreementNumber: "Residential One" }),
      agreement("agreement_c2", "commercial", { agreementNumber: "Commercial Two" }),
      agreement("agreement_r2", "residential", { agreementNumber: "Residential Two" }),
    ]);
    const html = renderToStaticMarkup(<PaymentsWorkspace />);

    expect(html.indexOf("Residential One")).toBeLessThan(html.indexOf("Residential Two"));
    const inside = between(html, 'data-testid="payments-commercial"', "</details>");
    expect(inside.indexOf("Commercial One")).toBeLessThan(inside.indexOf("Commercial Two"));
  });

  test("a commercial-only result set keeps every agreement in one closed counted disclosure", () => {
    mockAgreements([
      agreement("agreement_rosendin", "commercial", {
        agreementNumber: "SC-24-ROSENDIN-0001",
        subcontractorName: "Rosendin Electric",
        csiDivision: "26 00 00",
        tradeName: "Electrical",
      }),
      agreement("agreement_run20", "commercial", { agreementNumber: "A401-DEMO-PAY-20261110-20", subcontractorName: "Demo GC" }),
    ]);
    const html = renderToStaticMarkup(<PaymentsWorkspace />);

    expect(html).toContain("Commercial reference job (2)");
    expect(html).not.toContain('data-testid="payments-agreements"');
    expect(html.match(/href="#\/payments\/agreement_(rosendin|run20)"/g) ?? []).toHaveLength(2);
  });

  test("a residential-only result set, as a sub sees its own agreement, has no commercial disclosure", () => {
    mockAgreements([agreement("agreement_ortiz", "residential")]);
    const html = renderToStaticMarkup(<PaymentsWorkspace />);

    expect(html).not.toContain('data-testid="payments-commercial"');
    expect(html).not.toContain("Commercial reference job");
    expect(html).toContain('data-testid="payments-agreements"');
    // Residential trade wording drops the division prefix; commercial keeps "Div ...".
    expect(html).not.toContain("Div 22 00 00");
    expect(html).toContain(">Plumbing<");
  });

  test("a missing project kind reads commercial and never lands in the residential table", () => {
    mockAgreements([
      agreement("agreement_ortiz", "residential"),
      agreement("agreement_legacy", undefined, { agreementNumber: "SC-LEGACY-0001" }),
    ]);
    const html = renderToStaticMarkup(<PaymentsWorkspace />);

    const inside = between(html, 'data-testid="payments-commercial"', "</details>");
    expect(inside).toContain('href="#/payments/agreement_legacy"');
    expect(inside).not.toContain('href="#/payments/agreement_ortiz"');
    expect(html).toContain("Commercial reference job (1)");
  });

  test("the partition uses projectKind only, never an agreement-number suffix", () => {
    mockAgreements([
      agreement("agreement_suffix_residential", "residential", {
        agreementNumber: "A401-DEMO-PAY-20261105-07",
        subcontractorName: "Residential Trade",
      }),
      agreement("agreement_suffix_commercial", "commercial", {
        agreementNumber: "SC-22-ORTIZ-0001",
        subcontractorName: "Commercial Trade",
        csiDivision: "26 00 00",
        tradeName: "Electrical",
      }),
    ]);
    const html = renderToStaticMarkup(<PaymentsWorkspace />);

    const inside = between(html, 'data-testid="payments-commercial"', "</details>");
    expect(inside).toContain("SC-22-ORTIZ-0001");
    expect(inside).not.toContain("A401-DEMO-PAY-20261105-07");
    expect(html.indexOf("A401-DEMO-PAY-20261105-07")).toBeLessThan(html.indexOf('data-testid="payments-commercial"'));
    expect(html).toContain("Commercial reference job (1)");
  });

  test("the empty and loading states keep their existing wording and no disclosure", () => {
    mockAgreements([]);
    const empty = renderToStaticMarkup(<PaymentsWorkspace />);
    expect(empty).toContain("No agreements yet.");
    expect(empty).not.toContain('data-testid="payments-commercial"');

    mockAgreements(undefined);
    const loading = renderToStaticMarkup(<PaymentsWorkspace />);
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading agreements…");
    expect(loading).not.toContain('data-testid="payments-commercial"');
  });
});
