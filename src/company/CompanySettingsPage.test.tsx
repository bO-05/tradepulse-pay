// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useMutation, useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "../../convex/_generated/api";
import { ToastProvider } from "../ui";
import { CompanySettingsPage } from "./CompanySettingsPage";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
}));

const OWNER_EMAIL = "owner-sandbox@business.example.com";
const PAYOUT_EMAIL = "sb-ortiz123@personal.example.com";

function companyData(kind: "owner" | "sub", isAdmin = true) {
  return {
    company: {
      _id: `company_${kind}`,
      name: kind === "owner" ? "Dana Lopez" : "Ortiz Plumbing",
      kind,
      isDemo: true,
      legalName: "",
      phone: "",
      website: "",
      address: null,
      billingEmail: kind === "owner" ? OWNER_EMAIL : null,
      payoutPaypalEmail: kind === "sub" ? PAYOUT_EMAIL : null,
      defaultRetainageBps: null,
    },
    isAdmin,
    members: [],
    teammateInvites: [],
  };
}

function renderSettings(kind: "owner" | "sub", isAdmin = true) {
  const data = companyData(kind, isAdmin);
  vi.mocked(useQuery).mockImplementation(((fn: unknown) => {
    if (getFunctionName(fn as never) === getFunctionName(api.companies.myCompany)) return data;
    return undefined;
  }) as never);
  return renderToStaticMarkup(
    <ToastProvider>
      <CompanySettingsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
});

describe("company settings sandbox email privacy", () => {
  test("the owner billing address is masked by default for an admin", () => {
    const html = renderSettings("owner");
    expect(html).toContain("[demo inbox]@business.example.com");
    expect(html).not.toContain(OWNER_EMAIL);
    expect(html).toContain('data-testid="company-settings-billing-email-display"');
    expect(html).toContain('data-testid="company-settings-billing-email-edit"');
    expect(html).not.toContain('id="company-settings-billing-email"');
  });

  test("the sub payout address uses the same masked display by default", () => {
    const html = renderSettings("sub");
    expect(html).toContain("sb-****@personal.example.com");
    expect(html).not.toContain(PAYOUT_EMAIL);
    expect(html).toContain('data-testid="company-settings-payout-email-display"');
    expect(html).toContain('data-testid="company-settings-payout-email-edit"');
    expect(html).not.toContain('id="company-settings-payout-email"');
  });

  test("a non-admin owner sees the identical masked value and no edit control", () => {
    const html = renderSettings("owner", false);
    expect(html).toContain("[demo inbox]@business.example.com");
    expect(html).not.toContain(OWNER_EMAIL);
    expect(html).toContain("Only company admins can change this.");
    expect(html).not.toContain('data-testid="company-settings-billing-email-edit"');
  });
});
