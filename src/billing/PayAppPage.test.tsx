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
  return renderView(view(status));
}

function renderView(record: unknown): string {
  const name = getFunctionName(api.payApps.g703.getPayApp);
  vi.mocked(useQuery).mockImplementation(((fn: unknown) =>
    getFunctionName(fn as never) === name ? record : undefined) as never);
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

  test("a reviewed record renders the stored requested retainage, never the negative derivation", () => {
    const base = view("submitted") as unknown as Record<string, unknown>;
    const reviewed = {
      ...base,
      status: "reviewed",
      basis: "requested",
      // The reviewed state's summary is the requested G702: 5,400.00 claimed - 270.00 retainage.
      summary: { ...(base.summary as object), retainageCents: 27_000, currentPaymentDueCents: 513_000 },
      reviewSuggestedTotalCents: 200_000,
      approvalHistory: {
        ...(base.approvalHistory as object),
        requestedGrossCents: 540_000,
        approvedGrossCents: null,
      },
    };
    const rendered = text(renderView(reviewed));
    // Judge the money trail itself: the page's other panels keep their own stored figures.
    const trail = rendered.slice(rendered.indexOf("Money trail"), rendered.indexOf("Application No. 1"));
    expect(trail).not.toContain("-$3,130.00");
    expect(trail).not.toMatch(/-\$[0-9]/);
    expect(trail).toContain("$5,400.00"); // claimed, stored
    expect(trail).toContain("$2,000.00"); // review suggestion, stored
    expect(trail).toContain("$270.00"); // stored requested retainage
    expect(trail).toContain("$5,130.00"); // requested net, stored
    expect(trail).toContain("Not withheld yet");
  });

  test("the settled residential record explains the review and keeps both flagged lines visible", () => {
    const settled = {
      ...(view("paid") as unknown as Record<string, unknown>),
      readOnlyReference: true,
      reviewSuggestedTotalCents: 200_000,
      approvalHistory: {
        submittedAt: 1_794_156_000_000,
        reviewedAt: 1_794_156_100_000,
        approvedAt: 1_794_156_200_000,
        approvedBy: "Bayview Remodeling",
        requestedGrossCents: 540_000,
        approvedGrossCents: 400_000,
        reason: null,
      },
      lines: [
        sheetLine,
        {
          ...sheetLine,
          sovLineId: "sov_line_2",
          lineNo: 2,
          description: "Fixtures set",
          scheduledValueCents: 350_000,
          workThisPeriodCents: 0,
          requestedWorkCents: 140_000,
        },
      ],
      decision: {
        outcome: "approved_as_noted",
        reason: null,
        decidedAt: 1_794_156_200_000,
        decidedByName: "Bayview Remodeling",
        lines: [
          {
            sovLineId: "sov_line_1",
            lineNo: 1,
            description: "Rough-in",
            action: "override",
            recommendedCents: null,
            approvedCents: 400_000,
            reason: "Rough-in is complete and its milestone is funded.",
          },
          {
            sovLineId: "sov_line_2",
            lineNo: 2,
            description: "Fixtures set",
            action: "override",
            recommendedCents: null,
            approvedCents: 0,
            reason: "Fixtures set is not complete.",
          },
        ],
      },
    };
    const rendered = text(renderView(settled));
    expect(rendered).toContain("Conservative review: funded or in-progress milestones are credited at 50% of their share");
    expect(rendered).toContain("Fixtures set was cut by $1,400.00 to $0.00, and the GC kept that cut");
    expect(rendered).toContain("Line 1. Rough-in");
    expect(rendered).toContain("Line 2. Fixtures set");
    expect(rendered).toContain("Rough-in is complete and its milestone is funded.");
    expect(rendered).toContain("Fixtures set is not complete.");
    expect(rendered).toContain("Conservative review suggested gross $2,000.00 · GC approved $4,000.00 with recorded per-line reasons.");
    expect(rendered).not.toContain("above the recommendation");
  });

  test("residential approval history does not invent reasons for an unchanged review", () => {
    const rendered = text(renderPage("paid"));
    expect(rendered).toContain("Conservative review suggested gross $4,000.00 · GC approved $4,000.00 with no change to the recommendation.");
    expect(rendered).not.toContain("with recorded per-line reasons");
  });

  test("commercial approval history keeps its original recommendation comparison", () => {
    const commercial = {
      ...(view("paid") as unknown as Record<string, unknown>),
      projectKind: "commercial",
      reviewSuggestedTotalCents: 200_000,
    };
    const rendered = text(renderView(commercial));
    expect(rendered).toContain("Rules recommended gross $2,000.00 · GC approved $4,000.00 · $2,000.00 above the recommendation.");
    expect(rendered).not.toContain("Conservative review suggested gross");
  });
});
