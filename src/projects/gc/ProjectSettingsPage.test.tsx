// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useMutation, useQuery } from "convex/react";
import { ToastProvider } from "../../ui";
import { ProjectSettingsPage } from "./ProjectSettingsPage";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));

/** The project fields the settings screen reads; a frozen reference and an ordinary job differ by one flag. */
function project(readOnlyReference: boolean) {
  return {
    _id: "project_lopez",
    title: "Lopez Kitchen Remodel",
    ownerName: "Dana Lopez",
    projectType: "Residential kitchen remodel",
    projectKind: "residential",
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

const company = { company: { defaultRetainageBps: 500 } };

const primeLines = {
  projectId: "project_lopez",
  contractValueCents: 8_650_000,
  tradePackagesCents: 900_000,
  gcLinesCents: 7_750_000,
  unallocatedCents: 0,
  suggestions: [],
  lines: [
    { _id: "line_1", lineNo: 1, description: "Demolition, rough-in and permits", scheduledValueCents: 2_160_000 },
    { _id: "line_2", lineNo: 2, description: "Cabinetry, countertops and backsplash", scheduledValueCents: 3_460_000 },
  ],
};

function render(readOnlyReference: boolean) {
  vi.mocked(useQuery)
    .mockReturnValueOnce(project(readOnlyReference) as never)
    .mockReturnValueOnce(company as never)
    .mockReturnValue(primeLines as never);
  return renderToStaticMarkup(
    <ToastProvider>
      <ProjectSettingsPage projectId="project_lopez" />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.mocked(useMutation).mockReturnValue((async () => undefined) as never);
});

describe("project settings write controls", () => {
  test("a settled residential reference renders its fields and prime lines read-only with the notice", () => {
    const html = render(true);
    expect(html).toContain('data-testid="read-only-reference"');
    expect(html).toContain("Settled sandbox record · read-only.");
    expect(html).toContain("This settled sandbox record is read-only.");
    expect(html).not.toContain("Preserved reference job · read-only.");
    expect(html).not.toContain("This preserved reference job is read-only.");
    // The fields and the lines are still readable.
    expect(html).toContain("Lopez Kitchen Remodel");
    expect(html).toContain("Demolition, rough-in and permits");
    expect(html).toContain("$21,600.00");
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    // No write control: no save, no archive, no prime-line add, edit or remove.
    expect(html).not.toContain("Save settings");
    expect(html).not.toContain("Discard changes");
    expect(html).not.toContain("Archive project");
    expect(html).not.toContain("Add GC line");
    expect(html).not.toContain('data-testid="prime-line-add"');
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain(">Remove<");
  });

  test("an unfrozen commercial project keeps its editable settings", () => {
    const html = render(false);
    expect(html).not.toContain('data-testid="read-only-reference"');
    expect(html).not.toContain("This preserved reference job is read-only.");
    expect(html).toContain("Save settings");
    expect(html).toContain("Archive project");
    expect(html).toContain("Add GC line");
    expect(html).toContain('data-testid="prime-line-add"');
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Remove<");
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
  });
});
