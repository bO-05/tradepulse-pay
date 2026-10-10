// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { SOV_NOT_APPROVED_MESSAGE } from "../../convex/lib/sovRules";

let rows: unknown[] = [];
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useQuery: () => rows,
  useConvex: () => ({}),
}));

const { PayAppsPage } = await import("./PayAppsPage");

function agreementRow(overrides: Record<string, unknown>) {
  return {
    agreementId: "agr_1",
    agreementNumber: "A401-2026-0001",
    projectTitle: "Harbor Point Dental",
    tradeName: "Electrical",
    contractSumCents: 17_240_000,
    sovApproved: false,
    blockedReason: null,
    openPayApp: null,
    nextApplication: null,
    payApps: [],
    ...overrides,
  };
}

function render(row: Record<string, unknown>): string {
  rows = [agreementRow(row)];
  return renderToStaticMarkup(createElement(PayAppsPage));
}

function newPayAppButton(html: string): string {
  const match = html.match(/<button[^>]*data-testid="new-pay-app"[^>]*>/);
  expect(match, "new-pay-app button").not.toBeNull();
  return match![0];
}

describe("New pay app button", () => {
  test("is shown disabled and described by the reason while the SOV is not approved", () => {
    const html = render({ blockedReason: SOV_NOT_APPROVED_MESSAGE });
    expect(SOV_NOT_APPROVED_MESSAGE).toBe("Waiting for the GC to approve the schedule of values.");
    const button = newPayAppButton(html);
    expect(button).toMatch(/\sdisabled=""/);
    const describedBy = button.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    const reason = html.match(new RegExp(`<p[^>]*id="${describedBy!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^<]*)</p>`));
    expect(reason?.[1]).toBe(SOV_NOT_APPROVED_MESSAGE);
  });

  test("is enabled once the SOV is approved and the next period is open", () => {
    const html = render({
      sovApproved: true,
      nextApplication: { applicationNo: 1, periodStart: "2026-10-01", periodEnd: "2026-10-31", dueDate: "2026-10-25" },
    });
    const button = newPayAppButton(html);
    expect(button).not.toMatch(/\sdisabled=""/);
    expect(button).not.toMatch(/aria-describedby/);
  });
});
