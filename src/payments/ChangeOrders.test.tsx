// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useAction, useMutation, useQuery } from "convex/react";
import { ToastProvider } from "../ui";
import { ChangeOrderRows, ChangeOrdersPage, isGuidedRunProject, orderChangeOrderProjects, pickerProjects, resolveChangeOrderProjectId } from "./ChangeOrders";

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

type PickerProject = {
  _id: string;
  title: string;
  projectKind?: "residential" | "commercial";
  hasPrimeChangeOrders: boolean;
};

const lopez: PickerProject = {
  _id: "project_lopez",
  title: "Lopez Kitchen Remodel",
  projectKind: "residential",
  hasPrimeChangeOrders: true,
};
const commercialWithChangeOrders: PickerProject = {
  _id: "project_run20",
  title: "Sandbox run 20261110-20",
  projectKind: "commercial",
  hasPrimeChangeOrders: true,
};
const commercialWithoutChangeOrders: PickerProject = {
  _id: "project_run19",
  title: "Sandbox run 20261110-19",
  projectKind: "commercial",
  hasPrimeChangeOrders: false,
};
const secondResidential: PickerProject = {
  _id: "project_cabin",
  title: "Hilltop Cabin Rewire",
  projectKind: "residential",
  hasPrimeChangeOrders: false,
};

function mockPickerProjects(projects: PickerProject[] | undefined) {
  // `api` is Convex's anyApi proxy, so each property access returns a new reference. Identify the
  // page-level query by its empty args and let the per-project query stay in its loading state.
  vi.mocked(useQuery).mockImplementation(((_query: unknown, args: { projectId?: string } | "skip") => {
    if (typeof args === "object" && !("projectId" in args)) return projects;
    return undefined;
  }) as never);
}

function optionIndex(html: string, projectId: string): number {
  return html.indexOf(`value="${projectId}"`);
}

function selectedProjectId(html: string): string | null {
  const tag = html.match(/<option[^>]*\bselected(?:="[^"]*")?[^>]*>/)?.[0] ?? "";
  return tag.match(/value="([^"]+)"/)?.[1] ?? null;
}

describe("change-orders project picker", () => {
  test("mixed projects: Lopez leads and is selected, every commercial project sits under one optgroup", () => {
    // Server order is newest-first and puts the commercial run with change orders ahead of Lopez.
    mockPickerProjects([commercialWithChangeOrders, commercialWithoutChangeOrders, lopez]);
    const html = renderToStaticMarkup(<ChangeOrdersPage />);
    expect(selectedProjectId(html)).toBe("project_lopez");
    expect(optionIndex(html, "project_lopez")).toBeGreaterThanOrEqual(0);
    expect(optionIndex(html, "project_lopez")).toBeLessThan(optionIndex(html, "project_run20"));
    expect(html.match(/<optgroup label="Commercial reference job"/g) ?? []).toHaveLength(1);
    const group = html.slice(html.indexOf("<optgroup"));
    expect(group).toContain('value="project_run20"');
    // A guided-demo run without change orders is no longer listed; the page says how many are hidden.
    expect(html).not.toContain('value="project_run19"');
    expect(html).toContain('data-testid="change-orders-hidden-runs"');
    expect(html).toContain("1 guided-demo run without change orders is not listed.");
    // No commercial option sits outside the group.
    expect(html.slice(0, html.indexOf("<optgroup"))).not.toContain('value="project_run20"');
  });

  test("empty guided-demo runs are dropped; real projects and runs with change orders stay in server order", () => {
    const realEmpty: PickerProject = { _id: "project_office", title: "Office Buildout", projectKind: "commercial", hasPrimeChangeOrders: false };
    const storedRun: PickerProject = { _id: "project_run17", title: "Demo · TradePulse Pay judge demo 20261109-17", projectKind: "commercial", hasPrimeChangeOrders: false };
    const storedRunWithCo: PickerProject = { _id: "project_run12", title: "Demo · TradePulse Pay judge demo 20261107-12", projectKind: "commercial", hasPrimeChangeOrders: true };
    expect(isGuidedRunProject(storedRun.title)).toBe(true);
    expect(isGuidedRunProject("Lopez Kitchen Remodel")).toBe(false);
    const all = [commercialWithoutChangeOrders, storedRun, storedRunWithCo, realEmpty, lopez];
    const { shown, hiddenRuns } = pickerProjects(all, null);
    expect(shown.map((p) => p._id)).toEqual(["project_run12", "project_office", "project_lopez"]);
    expect(hiddenRuns).toBe(2);
    // The explicit selection is never hidden, even when it is an empty run.
    expect(pickerProjects(all, "project_run17").shown.map((p) => p._id)).toContain("project_run17");
    mockPickerProjects(all);
    const html = renderToStaticMarkup(<ChangeOrdersPage />);
    expect(html).not.toContain('value="project_run17"');
    expect(html).toContain('value="project_office"');
    expect(html).toContain("2 guided-demo runs without change orders are not listed.");
  });

  test("the default comes from the filtered list, and an all-filtered picker restores the authorized list", () => {
    // The newest server row is an empty guided run; the only other project is real and empty too.
    const storedRun: PickerProject = { _id: "project_run17", title: "Sandbox run 20261109-17", projectKind: "commercial", hasPrimeChangeOrders: false };
    const realEmpty: PickerProject = { _id: "project_office", title: "Office Buildout", projectKind: "commercial", hasPrimeChangeOrders: false };
    const mixed = pickerProjects([storedRun, realEmpty], null).shown;
    expect(resolveChangeOrderProjectId(mixed, null)).toBe("project_office");
    mockPickerProjects([storedRun, realEmpty]);
    const html = renderToStaticMarkup(<ChangeOrdersPage />);
    // One filtered project opens directly; the hidden run cannot be the fallback default.
    expect(html).toContain("Office Buildout");
    expect(html).not.toContain("Sandbox run 20261109-17");
    expect(html).not.toContain('data-testid="change-orders-project"');
    expect(html).toContain("1 guided-demo run without change orders is not listed.");

    // Every project is an empty guided run: the original authorized set comes back, with no count.
    const onlyRuns = [storedRun, commercialWithoutChangeOrders];
    expect(pickerProjects(onlyRuns, null)).toEqual({ shown: onlyRuns, hiddenRuns: 0 });
    mockPickerProjects(onlyRuns);
    const restored = renderToStaticMarkup(<ChangeOrdersPage />);
    expect(restored).toContain('value="project_run17"');
    expect(restored).toContain('value="project_run19"');
    expect(restored).not.toContain('data-testid="change-orders-hidden-runs"');
    expect(selectedProjectId(restored)).toBe("project_run17");
  });

  test("a commercial project no longer wins the default just because it has change orders", () => {
    mockPickerProjects([commercialWithChangeOrders, { ...lopez, hasPrimeChangeOrders: false }]);
    const html = renderToStaticMarkup(<ChangeOrdersPage />);
    expect(selectedProjectId(html)).toBe("project_lopez");
  });

  test("multiple residential projects keep server order and the first one is the fallback", () => {
    mockPickerProjects([commercialWithChangeOrders, secondResidential, lopez]);
    const html = renderToStaticMarkup(<ChangeOrdersPage />);
    expect(selectedProjectId(html)).toBe("project_cabin");
    expect(optionIndex(html, "project_cabin")).toBeLessThan(optionIndex(html, "project_lopez"));
    expect(optionIndex(html, "project_lopez")).toBeLessThan(optionIndex(html, "project_run20"));
  });

  test("commercial-only owners fall back to a project with change orders, then to the first project", () => {
    mockPickerProjects([commercialWithoutChangeOrders, commercialWithChangeOrders]);
    // The empty guided run is hidden, so the one remaining project opens directly without a picker.
    const single = renderToStaticMarkup(<ChangeOrdersPage />);
    expect(single).not.toContain('data-testid="change-orders-project"');
    expect(single).toContain("Sandbox run 20261110-20");
    expect(resolveChangeOrderProjectId([commercialWithoutChangeOrders, commercialWithChangeOrders], null)).toBe("project_run20");

    const olderCommercial: PickerProject = { ...commercialWithoutChangeOrders, _id: "project_run18", title: "Sandbox run 20261110-18" };
    mockPickerProjects([olderCommercial, commercialWithoutChangeOrders]);
    const html = renderToStaticMarkup(<ChangeOrdersPage />);
    expect(selectedProjectId(html)).toBe("project_run18");
    expect(html).not.toContain('value="project_lopez"');
    expect(html.match(/<optgroup label="Commercial reference job"/g) ?? []).toHaveLength(1);
  });

  test("all-residential pickers render no empty commercial group", () => {
    mockPickerProjects([secondResidential, lopez]);
    const html = renderToStaticMarkup(<ChangeOrdersPage />);
    expect(selectedProjectId(html)).toBe("project_cabin");
    expect(html).not.toContain("<optgroup");
  });

  test("a missing project kind is commercial by default", () => {
    const legacy: PickerProject = { _id: "project_legacy", title: "Legacy Office Buildout", hasPrimeChangeOrders: true };
    const groups = orderChangeOrderProjects([legacy]);
    expect(groups.residential).toHaveLength(0);
    expect(groups.commercial).toHaveLength(1);
    expect(resolveChangeOrderProjectId([legacy], null)).toBe("project_legacy");
    mockPickerProjects([legacy, lopez]);
    const html = renderToStaticMarkup(<ChangeOrdersPage />);
    expect(selectedProjectId(html)).toBe("project_lopez");
    expect(html.slice(html.indexOf("<optgroup"))).toContain('value="project_legacy"');
  });

  test("an explicit commercial selection is never overridden by a reactive update", () => {
    const next = [lopez, secondResidential, commercialWithChangeOrders];
    expect(resolveChangeOrderProjectId(next, "project_run20")).toBe("project_run20");
    // Even a stale explicit id stays selected rather than jumping to the residential default.
    expect(resolveChangeOrderProjectId(next, "project_run19")).toBe("project_run19");
    expect(resolveChangeOrderProjectId(next, null)).toBe("project_lopez");
  });

  test("loading and empty states keep their existing behavior", () => {
    mockPickerProjects(undefined);
    expect(renderToStaticMarkup(<ChangeOrdersPage />)).toContain("Loading projects…");
    mockPickerProjects([]);
    const empty = renderToStaticMarkup(<ChangeOrdersPage />);
    expect(empty).toContain("No projects yet");
    expect(empty).not.toContain('data-testid="change-orders-project"');
  });
});
