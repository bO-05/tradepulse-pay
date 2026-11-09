// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useMutation, useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "../../convex/_generated/api";
import { g702Summary, type G703LineInput } from "../../convex/payApps/g703Math";
import { ToastProvider } from "../ui";
import { PayAppPage } from "./PayAppPage";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useAction: vi.fn(),
  useMutation: vi.fn(),
  useConvex: vi.fn(() => ({ query: async () => null })),
}));
vi.mock("@convex-dev/auth/react", () => ({ useAuthToken: () => null }));

const PAY_APP = "pay_app_1";
const AGREEMENT = "agreement_ortiz";

const line: G703LineInput = {
  scheduledValueCents: 400_000,
  previousWorkCents: 0,
  previousStoredCents: 0,
  workThisPeriodCents: 400_000,
  storedCents: 0,
  retainageBps: 500,
  previousRetainageCents: 0,
};
const summary = g702Summary([line], { originalContractSumCents: 900_000, previousCertificatesCents: 0 });

const sheetLine = {
  sovLineId: "sov_line_1",
  lineNo: 1,
  description: "Rough-in",
  csiCode: "22 00 00",
  scheduledValueCents: 400_000,
  retainageBps: 500,
  previousWorkCents: 0,
  previousStoredCents: 0,
  pendingCents: 0,
  workThisPeriodCents: 400_000,
  storedCents: 0,
  note: null,
  requestedWorkCents: null,
  requestedStoredCents: null,
};

type Status = "draft" | "revision_requested" | "submitted" | "paid";

function view(status: Status) {
  const editable = status === "draft";
  return {
    _id: PAY_APP,
    format: "g703" as const,
    viewerRole: "sub" as const,
    projectKind: "residential" as const,
    readOnlyReference: false,
    status,
    applicationNo: 1,
    periodLabel: "Period 1",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-15",
    dueDate: "2026-10-15",
    savedAt: null,
    submittedAt: status === "draft" ? null : 1_794_156_000_000,
    notes: "",
    submittedBy: { actorType: "human" as const, isCaller: true },
    rejectionReason: null,
    withdrawnAt: null,
    agreement: {
      _id: AGREEMENT,
      agreementNumber: "SC-22-ORTIZ-0001",
      projectTitle: "Lopez Kitchen Remodel",
      subcontractorName: "Ortiz Plumbing (demo)",
    },
    basis: "approved" as const,
    unverifiedReason: null,
    retainageBps: 500,
    lines: [sheetLine],
    summary,
    requestedSummary: summary,
    approvalHistory: {
      submittedAt: status === "draft" ? null : 1_794_156_000_000,
      reviewedAt: status === "draft" ? null : 1_794_156_100_000,
      approvedAt: status === "paid" ? 1_794_156_200_000 : null,
      approvedBy: "Demo GC",
      requestedGrossCents: 400_000,
      approvedGrossCents: status === "paid" ? 400_000 : null,
      reason: null,
    },
    lineErrors: [],
    editable,
    canSubmit: editable,
    canWithdraw: status === "submitted",
    canRevise: status === "revision_requested",
    canApprove: false,
    canRequestRevision: false,
    canReject: false,
    canDiscard: false,
    version: 1,
    versions: [],
    decision: null,
    revisionRequest: null,
    reviewSuggestedTotalCents: 400_000,
    review: null,
    excludedScopeNotes: [],
    changeOrders: [],
  } as never;
}

function renderPage(status: Status): string {
  const name = getFunctionName(api.payApps.g703.getPayApp);
  vi.mocked(useQuery).mockImplementation(((fn: unknown) =>
    getFunctionName(fn as never) === name ? view(status) : undefined) as never);
  return renderToStaticMarkup(
    <ToastProvider>
      <PayAppPage payAppId={PAY_APP} backHash="#/portal" backLabel="Sub portal" />
    </ToastProvider>,
  );
}

/** Visible words, not class names or data-status codes. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

/** Every element carrying the shared primary variant, counted from the rendered class list. */
function primaryCount(html: string): number {
  return (html.match(/class="[^"]*"/g) ?? []).filter(
    (attribute) => /\bbg-accent\b/.test(attribute) && /\btext-accent-fg\b/.test(attribute),
  ).length;
}

beforeEach(() => {
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
});

describe("sub pay app primary action by state", () => {
  test("a draft offers Submit pay app as the only primary", () => {
    const html = renderPage("draft");
    expect(html).toContain('data-testid="payapp-submit"');
    expect(text(html)).toContain("Submit pay app");
    expect(primaryCount(html)).toBe(1);
    expect(html).not.toContain('data-testid="payapp-revise"');
    expect(html).not.toContain('data-testid="payapp-withdraw"');
    expect(html).not.toContain('data-testid="payapp-view-payments"');
  });

  test("a revision request offers Revise as the only primary", () => {
    const html = renderPage("revision_requested");
    expect(html).toContain('data-testid="payapp-revise"');
    expect(text(html)).toContain("Revise");
    expect(primaryCount(html)).toBe(1);
    expect(html).not.toContain('data-testid="payapp-submit"');
    expect(html).not.toContain('data-testid="payapp-withdraw"');
    expect(html).not.toContain('data-testid="payapp-view-payments"');
  });

  test("a submitted pay app offers Withdraw as the only primary", () => {
    const html = renderPage("submitted");
    expect(html).toContain('data-testid="payapp-withdraw"');
    expect(text(html)).toContain("Withdraw");
    expect(primaryCount(html)).toBe(1);
    expect(html).not.toContain('data-testid="payapp-submit"');
    expect(html).not.toContain('data-testid="payapp-revise"');
    expect(html).not.toContain('data-testid="payapp-view-payments"');
  });

  test("a paid record offers View payments as the only primary", () => {
    const html = renderPage("paid");
    expect(html).toContain('data-testid="payapp-view-payments"');
    expect(html).toContain(`href="#/payments/${AGREEMENT}"`);
    expect(text(html)).toContain("View payments");
    expect(primaryCount(html)).toBe(1);
    expect(html).not.toContain('data-testid="payapp-submit"');
    expect(html).not.toContain('data-testid="payapp-revise"');
    expect(html).not.toContain('data-testid="payapp-withdraw"');
  });
});
