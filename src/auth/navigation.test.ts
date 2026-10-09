import { describe, expect, test } from "vitest";
import { agreementHash, ledgerHash, NAV_BY_ROLE, navFor, parseHash, resolveRoute } from "./navigation";

describe("role navigation", () => {
  test("GC gets procurement, payments and the read-only overview; sub and owner never get procurement", () => {
    expect(NAV_BY_ROLE.gc.map((i) => i.area)).toEqual([
      "procurement",
      "gc-projects",
      "payments",
      "inbox",
      "owner-portal",
      "people",
      "vendors",
      "billing-agents",
      "dashboard",
      "judge-demo",
    ]);
    expect(NAV_BY_ROLE.sub.map((i) => i.area)).toEqual(["sub-portal", "my-projects", "payments"]);
    expect(NAV_BY_ROLE.owner.map((i) => i.area)).toEqual(["owner-portal", "my-projects", "dashboard"]);
  });

  test("People is GC-only; project switcher for subs and owners; Company settings for every role", () => {
    expect(resolveRoute("gc", "#/people/k97p")).toEqual({ area: "people", projectId: "k97p" });
    expect(resolveRoute("sub", "#/people/k97p")).toEqual({ area: "not-found" });
    expect(resolveRoute("gc", "#/vendors")).toEqual({ area: "vendors" });
    expect(resolveRoute("sub", "#/vendors")).toEqual({ area: "not-found" });
    expect(resolveRoute("owner", "#/vendors")).toEqual({ area: "not-found" });
    expect(resolveRoute("sub", "#/my-projects/k97p")).toEqual({ area: "my-projects", projectId: "k97p" });
    expect(resolveRoute("owner", "#/my-projects")).toEqual({ area: "my-projects" });
    expect(resolveRoute("gc", "#/my-projects")).toEqual({ area: "not-found" });
    for (const role of ["gc", "sub", "owner"] as const) expect(resolveRoute(role, "#/company")).toEqual({ area: "company" });
  });

  test("GC project setup routes: list, wizard, project page and settings; GC only", () => {
    expect(resolveRoute("gc", "#/all-projects")).toEqual({ area: "gc-projects" });
    expect(resolveRoute("gc", "#/all-projects/new")).toEqual({ area: "gc-projects", view: "new" });
    expect(resolveRoute("gc", "#/all-projects/k97p")).toEqual({ area: "gc-projects", projectId: "k97p" });
    expect(resolveRoute("gc", "#/all-projects/k97p/settings")).toEqual({ area: "gc-projects", projectId: "k97p", view: "settings" });
    expect(resolveRoute("gc", "#/all-projects/k97p/other")).toEqual({ area: "not-found" });
    for (const role of ["sub", "owner"] as const) {
      for (const hash of ["#/all-projects", "#/all-projects/new", "#/all-projects/k97p", "#/all-projects/k97p/settings"]) {
        expect(resolveRoute(role, hash)).toEqual({ area: "not-found" });
      }
    }
  });

  test("an empty hash is the role's home", () => {
    for (const hash of ["", "#", "#/"]) {
      expect(resolveRoute("gc", hash)).toEqual({ area: "procurement" });
      expect(resolveRoute("sub", hash)).toEqual({ area: "sub-portal" });
      expect(resolveRoute("owner", hash)).toEqual({ area: "owner-portal" });
    }
  });

  test("wrong-role areas are Not found, never a silent fallback to the role's home", () => {
    expect(resolveRoute("sub", "#/procurement")).toEqual({ area: "not-found" });
    expect(resolveRoute("owner", "#/procurement")).toEqual({ area: "not-found" });
    expect(resolveRoute("owner", "#/portal")).toEqual({ area: "not-found" });
    expect(resolveRoute("gc", "#/projects")).toEqual({ area: "owner-portal" });
    expect(resolveRoute("gc", "#/billing-agents")).toEqual({ area: "billing-agents" });
    expect(resolveRoute("sub", "#/billing-agents")).toEqual({ area: "not-found" });
    expect(resolveRoute("owner", "#/billing-agents")).toEqual({ area: "not-found" });
    expect(resolveRoute("gc", "#/inbox")).toEqual({ area: "inbox" });
    expect(resolveRoute("sub", "#/inbox")).toEqual({ area: "not-found" });
    expect(resolveRoute("owner", "#/inbox")).toEqual({ area: "not-found" });
    expect(resolveRoute("owner", "#/people/k97p")).toEqual({ area: "not-found" });
  });

  test("unknown routes are Not found", () => {
    for (const role of ["gc", "sub", "owner"] as const) {
      expect(resolveRoute(role, "#/nonsense")).toEqual({ area: "not-found" });
      expect(resolveRoute(role, "#/agreements/")).toEqual({ area: "not-found" });
      expect(resolveRoute(role, "#/procurement/extra")).toEqual({ area: "not-found" });
    }
  });

  test("GC procurement URLs opened by a sub or owner are Not found, with or without the hash", () => {
    const leveling = "?project=k978yam8&tab=leveling";
    const diagnostics = "?tab=diagnostics";
    for (const role of ["sub", "owner"] as const) {
      expect(resolveRoute(role, "#/procurement", false, leveling)).toEqual({ area: "not-found" });
      expect(resolveRoute(role, "#/procurement", false, diagnostics)).toEqual({ area: "not-found" });
      expect(resolveRoute(role, "", false, leveling)).toEqual({ area: "not-found" });
      expect(resolveRoute(role, "#/", false, diagnostics)).toEqual({ area: "not-found" });
    }
    // The GC's own workspace owns that query state.
    expect(resolveRoute("gc", "", false, leveling)).toEqual({ area: "procurement" });
    expect(resolveRoute("gc", "#/procurement", false, diagnostics)).toEqual({ area: "procurement" });
  });

  test("a removed project's legacy procurement URL is Not found for the removed sub", () => {
    expect(resolveRoute("sub", "#/procurement", false, "?project=k978yam8&tab=packages")).toEqual({ area: "not-found" });
  });

  test("the guided demo is a Demo-company area; every other company gets Not found", () => {
    expect(resolveRoute("gc", "#/judge-demo", true)).toEqual({ area: "judge-demo" });
    expect(resolveRoute("sub", "#/judge-demo", true)).toEqual({ area: "not-found" });
    for (const role of ["gc", "sub", "owner"] as const) {
      expect(resolveRoute(role, "#/judge-demo")).toEqual({ area: "not-found" });
      expect(navFor(role).some((i) => i.area === "judge-demo")).toBe(false);
    }
    expect(navFor("gc", true).some((i) => i.area === "judge-demo")).toBe(true);
    expect(NAV_BY_ROLE.gc.find((i) => i.area === "judge-demo")?.label).toBe("Guided demo");
  });

  test("dashboard: GC and owner reach it, a sub's direct route is Not found", () => {
    expect(parseHash("#/dashboard")).toEqual({ area: "dashboard" });
    expect(resolveRoute("gc", "#/dashboard")).toEqual({ area: "dashboard" });
    expect(resolveRoute("owner", "#/dashboard")).toEqual({ area: "dashboard" });
    expect(resolveRoute("sub", "#/dashboard")).toEqual({ area: "not-found" });
    expect(NAV_BY_ROLE.sub.some((i) => i.area === "dashboard")).toBe(false);
  });

  test("agreement deep links round-trip for every role (access is enforced by the backend)", () => {
    const hash = agreementHash("k97abc");
    expect(parseHash(hash)).toEqual({ area: "agreement", agreementId: "k97abc" });
    expect(resolveRoute("sub", hash)).toEqual({ area: "agreement", agreementId: "k97abc" });
  });

  test("payments workspace and ledger deep links", () => {
    expect(resolveRoute("gc", "#/payments")).toEqual({ area: "payments" });
    expect(resolveRoute("owner", "#/payments")).toEqual({ area: "not-found" });
    const hash = ledgerHash("k97abc");
    expect(hash).toBe("#/payments/k97abc");
    expect(resolveRoute("sub", hash)).toEqual({ area: "ledger", agreementId: "k97abc" });
  });
});

describe("notifications and vendor detail routes", () => {
  test("every role can open the notifications page", () => {
    for (const role of ["gc", "sub", "owner"] as const) {
      expect(resolveRoute(role, "#/notifications")).toEqual({ area: "notifications" });
    }
  });

  test("vendor detail is a GC-only route", () => {
    expect(resolveRoute("gc", "#/vendors/abc123")).toEqual({ area: "vendors", vendorId: "abc123" });
    expect(resolveRoute("sub", "#/vendors/abc123")).toEqual({ area: "not-found" });
    expect(resolveRoute("owner", "#/vendors/abc123")).toEqual({ area: "not-found" });
  });
});
