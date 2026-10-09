import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("one shared Not found page", () => {
  test("route, project, record and query-error not-found cases all render NotFoundState", () => {
    for (const path of [
      "../auth/RoleShell.tsx",
      "../App.tsx",
      "../payments/AgreementLedgerView.tsx",
      "../payments/AgreementSummaryView.tsx",
      "../people/PeoplePage.tsx",
    ]) {
      expect(src(path), path).toContain("<NotFoundState");
    }
    const shell = src("../auth/RoleShell.tsx");
    expect(shell).not.toContain("Access denied");
    expect(shell).toContain("fallback={(message) => (isNotFoundMessage(message) ? <NotFoundState />");
    expect(src("../payments/AgreementLedgerView.tsx")).not.toContain("Agreement not found");
    expect(src("../payments/AgreementSummaryView.tsx")).not.toContain("Agreement not found");
  });

  test("a foreign or missing ?project= shows Not found instead of silently selecting another project", () => {
    const app = src("../App.tsx");
    expect(app).toContain("resolveRequestedProject(");
    expect(app).toContain("{projectNotFound && (");
    expect(app).not.toContain("is dropped instead of lingering in the address bar");
  });

  test("the GC Projects overview empty state offers Create your first project", () => {
    const portal = src("../payments/OwnerPortal.tsx");
    expect(portal).toContain("Create your first project");
    expect(portal).toContain("requestNewProject()");
    expect(src("../components/Header.tsx")).toContain("consumeNewProjectRequest()");
    expect(src("../auth/RoleShell.tsx")).toContain("<OwnerPortal role={me.role} />");
  });
});
