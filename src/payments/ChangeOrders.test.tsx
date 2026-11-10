// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useAction, useMutation, useQuery } from "convex/react";
import { ToastProvider } from "../ui";
import { ChangeOrderRows } from "./ChangeOrders";

vi.mock("convex/react", () => ({
  useAction: vi.fn(),
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}));
vi.mock("../documents/DocumentDownload", () => ({ DocumentDownloadButton: () => null }));

const legacyRow = {
  _id: "co_legacy",
  label: "PCO #9",
  title: "Judge demo: Add two EV charger circuits",
  description: "The stored description stays unchanged.",
  amountCents: 185_000,
  scheduleDays: null,
  status: "paid",
  scope: "prime",
  agreementNumber: null,
  requestedByParty: "gc",
  sovLineNo: null,
  linkedLabel: null,
  approvedAt: null,
  paidAt: null,
  invoicedAt: null,
  judgeDemoApproval: null,
  rejectionReason: null,
  recipientEmail: null,
  paypalInvoiceId: null,
  paypalInvoiceStatus: null,
  error: null,
  editBlockedReason: null,
  canEdit: false,
  canDelete: false,
  canSubmit: false,
  canWithdraw: false,
  canApprove: false,
  canReject: false,
  invoice: { show: false, enabled: false, reason: null },
  payerViewUrl: null,
  canRefresh: false,
} as never;

beforeEach(() => {
  vi.mocked(useQuery).mockReturnValue(undefined as never);
  vi.mocked(useAction).mockReturnValue((async () => undefined) as never);
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
});

describe("change-order display copy", () => {
  test("a row strips the legacy run prefix without changing the description", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ChangeOrderRows rows={[legacyRow]} emptyText="No change orders." />
      </ToastProvider>,
    );
    expect(html).toContain('data-testid="change-order-title-text">Add two EV charger circuits</span>');
    expect(html).not.toContain("Judge demo");
    expect(html).toContain("The stored description stays unchanged.");
    expect(html).toContain("$1,850.00");
  });
});
