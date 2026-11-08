// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useMutation, useQuery } from "convex/react";
import { ToastProvider } from "../../ui";
import { ProjectPage } from "./ProjectPage";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

function project(readOnlyReference: boolean, projectKind: "residential" | "commercial" = "residential") {
  return {
    _id: "project_lopez",
    title: "Lopez Kitchen Remodel",
    ownerName: "Dana Lopez",
    projectType: "Residential kitchen remodel",
    projectKind,
    location: "El Cerrito, CA",
    address: { line1: "1420 Elm Street", city: "El Cerrito", state: "CA", zip: "94530" },
    state: "CA",
    contractValueCents: 8_650_000,
    retainageBps: 1_000,
    billingDay: 15,
    startDate: "2026-09-21",
    substantialCompletionDate: "2026-11-20",
    status: "active" as const,
    isDemoProject: false,
    readOnlyReference,
  };
}

function render(readOnlyReference: boolean, projectKind?: "residential" | "commercial") {
  vi.mocked(useQuery)
    .mockReturnValueOnce(project(readOnlyReference, projectKind) as never)
    .mockReturnValueOnce({ company: null, invoicing: { enabled: true } } as never)
    .mockReturnValue([] as never);
  return renderToStaticMarkup(
    <ToastProvider>
      <ProjectPage projectId="project_lopez" />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
});

describe("a preserved reference job on the project page", () => {
  test("offers neither the settings nor the People link and shows the reference notice", () => {
    const html = render(true);
    expect(html).toContain('data-testid="read-only-reference"');
    expect(html).toContain("Preserved reference job · read-only.");
    expect(html).not.toContain("#/all-projects/project_lopez/settings");
    expect(html).not.toContain("#/people/project_lopez");
    expect(html).not.toContain(">Project settings<");
    expect(html).not.toContain(">People<");
    expect(html).not.toContain("Open in Procurement");
  });

  test("an ordinary project keeps the settings and People links without the notice", () => {
    const html = render(false);
    expect(html).toContain("#/all-projects/project_lopez/settings");
    expect(html).toContain("#/people/project_lopez");
    expect(html).toContain(">Project settings<");
    expect(html).toContain(">People<");
    expect(html).not.toContain('data-testid="read-only-reference"');
  });

  test("a residential job calls the section Trades and never shows CSI wording", () => {
    const html = render(false, "residential");
    expect(html).toContain(">Trades<");
    expect(html).toContain("No trades yet");
    expect(html).toContain("Add trade<");
    expect(html).not.toContain("Trade packages");
    expect(html).not.toContain("CSI");
    expect(html).not.toContain("Commercial reference job");
  });

  test("a commercial job keeps Trade packages, CSI and the reference badge", () => {
    const html = render(false, "commercial");
    expect(html).toContain(">Trade packages<");
    expect(html).toContain("No trade packages yet");
    expect(html).toContain("CSI MasterFormat");
    expect(html).toContain("Commercial reference job");
  });
});
