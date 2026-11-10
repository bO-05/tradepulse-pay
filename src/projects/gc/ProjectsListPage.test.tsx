// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useQuery } from "convex/react";
import { ProjectsListPage } from "./ProjectsListPage";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));

type Kind = "residential" | "commercial";

function project(id: string, kind: Kind | undefined, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    title: "Lopez Kitchen Remodel",
    ownerName: "Dana Lopez",
    location: "San Jose, CA",
    status: "active",
    contractValueCents: 8_650_000,
    archived: false,
    projectKind: kind,
    ...overrides,
  };
}

function mockProjects(projects: ReturnType<typeof project>[] | undefined) {
  vi.mocked(useQuery).mockReturnValue(projects as never);
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
  mockProjects(undefined);
});

describe("GC Projects worklist partition", () => {
  test("mixed state leads with the residential project and hides every commercial row in one closed counted disclosure", () => {
    mockProjects([
      project("project_harbor", "commercial", { title: "Harbor Point Dental Office TI", contractValueCents: 5_235_000 }),
      project("project_lopez", "residential"),
      project("project_run20", "commercial", { title: "Sandbox run 20261110-20", contractValueCents: 4_500_000 }),
    ]);
    const html = renderToStaticMarkup(<ProjectsListPage />);

    const lopez = html.indexOf('href="#/all-projects/project_lopez"');
    const commercial = html.indexOf('data-testid="projects-commercial"');
    expect(lopez).toBeGreaterThan(-1);
    expect(commercial).toBeGreaterThan(-1);
    expect(lopez).toBeLessThan(commercial);

    expect(html.match(/data-testid="projects-commercial"/g) ?? []).toHaveLength(1);
    expect(html).toContain("Commercial reference job (2)");
    expect(detailsTag(html, commercial)).not.toContain(" open");
    expect(html).toContain('data-record-count="2"');

    // Expansion is not needed for the links to exist: the native disclosure keeps all of them.
    const inside = between(html, 'data-testid="projects-commercial"', "</details>");
    expect(inside).toContain('href="#/all-projects/project_harbor"');
    expect(inside).toContain('href="#/all-projects/project_run20"');
    expect(inside).not.toContain('href="#/all-projects/project_lopez"');

    // Every original record survives the split, exactly once.
    const hrefs = html.match(/href="#\/all-projects\/project_[a-z0-9]+"/g) ?? [];
    expect(hrefs).toHaveLength(3);
    expect(new Set(hrefs).size).toBe(3);
  });

  test("server order is preserved inside each partition", () => {
    mockProjects([
      project("project_c1", "commercial", { title: "Commercial One" }),
      project("project_r1", "residential", { title: "Residential One" }),
      project("project_c2", "commercial", { title: "Commercial Two" }),
      project("project_r2", "residential", { title: "Residential Two" }),
    ]);
    const html = renderToStaticMarkup(<ProjectsListPage />);

    const r1 = html.indexOf('href="#/all-projects/project_r1"');
    const r2 = html.indexOf('href="#/all-projects/project_r2"');
    expect(r1).toBeGreaterThan(-1);
    expect(r1).toBeLessThan(r2);

    const inside = between(html, 'data-testid="projects-commercial"', "</details>");
    expect(inside.indexOf('href="#/all-projects/project_c1"')).toBeLessThan(inside.indexOf('href="#/all-projects/project_c2"'));
  });

  test("a commercial-only result set keeps every project in one closed disclosure and its primary action", () => {
    mockProjects([
      project("project_harbor", "commercial", { title: "Harbor Point Dental Office TI" }),
      project("project_dental", "commercial", { title: "Second Commercial Job" }),
    ]);
    const html = renderToStaticMarkup(<ProjectsListPage />);

    expect(html).toContain('data-testid="projects-commercial"');
    expect(html).toContain("Commercial reference job (2)");
    // No residential list is rendered; the only list sits inside the commercial disclosure.
    expect(html).not.toContain('aria-label="Projects"');
    expect(html).toContain('aria-label="Commercial reference jobs"');
    expect(html.match(/href="#\/all-projects\/project_(harbor|dental)"/g) ?? []).toHaveLength(2);
    // The page keeps Quick start, its filled primary action, even with the records collapsed.
    expect(html).toContain('href="#/all-projects/quick-start"');
    expect(html).toContain("bg-accent");
  });

  test("a residential-only result set has no commercial disclosure", () => {
    mockProjects([project("project_lopez", "residential"), project("project_cabin", "residential", { title: "Hilltop Cabin Rewire" })]);
    const html = renderToStaticMarkup(<ProjectsListPage />);

    expect(html).not.toContain('data-testid="projects-commercial"');
    expect(html).not.toContain("Commercial reference job");
    expect(html.match(/href="#\/all-projects\/project_(lopez|cabin)"/g) ?? []).toHaveLength(2);
  });

  test("an archived commercial project stays reachable inside the disclosure with its archived status", () => {
    mockProjects([
      project("project_lopez", "residential"),
      project("project_old", "commercial", { title: "Old Commercial Job", archived: true, status: "archived" }),
    ]);
    const html = renderToStaticMarkup(<ProjectsListPage />);

    const inside = between(html, 'data-testid="projects-commercial"', "</details>");
    expect(inside).toContain('href="#/all-projects/project_old"');
    expect(inside).toContain('data-status="archived"');
    expect(html).toContain("Commercial reference job (1)");
  });

  test("a missing project kind reads commercial and never lands in the residential list", () => {
    mockProjects([
      project("project_lopez", "residential"),
      project("project_legacy", undefined, { title: "Legacy Office Buildout" }),
    ]);
    const html = renderToStaticMarkup(<ProjectsListPage />);

    const inside = between(html, 'data-testid="projects-commercial"', "</details>");
    expect(inside).toContain('href="#/all-projects/project_legacy"');
    expect(html).toContain("Commercial reference job (1)");
    const residentialList = between(html, 'aria-label="Projects"', "</ul>");
    expect(residentialList).toContain('href="#/all-projects/project_lopez"');
    expect(residentialList).not.toContain("project_legacy");
  });

  test("the partition uses projectKind only, never a title or run suffix", () => {
    mockProjects([
      project("project_suffix_residential", "residential", { title: "Sandbox run 20261110-20" }),
      project("project_suffix_commercial", "commercial", { title: "Lopez Kitchen Remodel 20261110-20" }),
    ]);
    const html = renderToStaticMarkup(<ProjectsListPage />);

    const inside = between(html, 'data-testid="projects-commercial"', "</details>");
    // A commercial row keeps its "-20" title suffix and stays inside; a residential row outside.
    expect(inside).toContain("Lopez Kitchen Remodel 20261110-20");
    expect(inside).not.toContain("Sandbox run 20261110-20");
    expect(html.indexOf("Sandbox run 20261110-20")).toBeLessThan(html.indexOf('data-testid="projects-commercial"'));
  });

  test("the empty and loading states keep their existing wording and no disclosure", () => {
    mockProjects([]);
    const empty = renderToStaticMarkup(<ProjectsListPage />);
    expect(empty).toContain("No projects yet");
    expect(empty).not.toContain('data-testid="projects-commercial"');

    mockProjects(undefined);
    const loading = renderToStaticMarkup(<ProjectsListPage />);
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Loading projects…");
    expect(loading).not.toContain('data-testid="projects-commercial"');
  });
});
