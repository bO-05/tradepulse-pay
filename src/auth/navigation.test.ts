import { describe, expect, test } from "vitest";
import { agreementHash, ledgerHash, NAV_BY_ROLE, navFor, parseHash, resolveRoute } from "./navigation";

describe("role navigation", () => {
  test("GC gets procurement, payments and the read-only overview; sub and owner never get procurement", () => {
    expect(NAV_BY_ROLE.gc.map((i) => i.area)).toEqual([
      "procurement",
      "payments",
      "inbox",
      "owner-portal",
      "people",
      "billing-agents",
      "dashboard",
      "judge-demo",
    ]);
    expect(NAV_BY_ROLE.sub.map((i) => i.area)).toEqual(["sub-portal", "my-projects", "payments"]);
    expect(NAV_BY_ROLE.owner.map((i) => i.area)).toEqual(["owner-portal", "my-projects", "dashboard"]);
  });

  test("People is GC-only; project switcher for subs and owners; Company settings for every role", () => {
    expect(resolveRoute("gc", "#/people/k97p")).toEqual({ area: "people", projectId: "k97p" });
    expect(resolveRoute("sub", "#/people/k97p")).toEqual({ area: "sub-portal" });
    expect(resolveRoute("sub", "#/my-projects/k97p")).toEqual({ area: "my-projects", projectId: "k97p" });
    expect(resolveRoute("owner", "#/my-projects")).toEqual({ area: "my-projects" });
    expect(resolveRoute("gc", "#/my-projects")).toEqual({ area: "procurement" });
    for (const role of ["gc", "sub", "owner"] as const) expect(resolveRoute(role, "#/company")).toEqual({ area: "company" });
  });

  test("disallowed or unknown areas fall back to the role's home", () => {
    expect(resolveRoute("sub", "#/procurement")).toEqual({ area: "sub-portal" });
    expect(resolveRoute("owner", "#/procurement")).toEqual({ area: "owner-portal" });
    expect(resolveRoute("owner", "#/portal")).toEqual({ area: "owner-portal" });
    expect(resolveRoute("gc", "")).toEqual({ area: "procurement" });
    expect(resolveRoute("gc", "#/nonsense")).toEqual({ area: "procurement" });
    expect(resolveRoute("gc", "#/projects")).toEqual({ area: "owner-portal" });
    expect(resolveRoute("gc", "#/billing-agents")).toEqual({ area: "billing-agents" });
    expect(resolveRoute("sub", "#/billing-agents")).toEqual({ area: "sub-portal" });
    expect(resolveRoute("owner", "#/billing-agents")).toEqual({ area: "owner-portal" });
    expect(resolveRoute("gc", "#/inbox")).toEqual({ area: "inbox" });
    expect(resolveRoute("sub", "#/inbox")).toEqual({ area: "sub-portal" });
    expect(resolveRoute("owner", "#/inbox")).toEqual({ area: "owner-portal" });
  });

  test("the guided demo is a Demo-company area; every other company gets Not found", () => {
    expect(resolveRoute("gc", "#/judge-demo", true)).toEqual({ area: "judge-demo" });
    expect(resolveRoute("sub", "#/judge-demo", true)).toEqual({ area: "sub-portal" });
    for (const role of ["gc", "sub", "owner"] as const) {
      expect(resolveRoute(role, "#/judge-demo")).toEqual({ area: "not-found" });
      expect(navFor(role).some((i) => i.area === "judge-demo")).toBe(false);
    }
    expect(navFor("gc", true).some((i) => i.area === "judge-demo")).toBe(true);
    expect(NAV_BY_ROLE.gc.find((i) => i.area === "judge-demo")?.label).toBe("Guided demo");
  });

  test("dashboard: GC and owner reach it, a sub's direct route is access denied", () => {
    expect(parseHash("#/dashboard")).toEqual({ area: "dashboard" });
    expect(resolveRoute("gc", "#/dashboard")).toEqual({ area: "dashboard" });
    expect(resolveRoute("owner", "#/dashboard")).toEqual({ area: "dashboard" });
    expect(resolveRoute("sub", "#/dashboard")).toEqual({ area: "access-denied" });
    expect(NAV_BY_ROLE.sub.some((i) => i.area === "dashboard")).toBe(false);
  });

  test("agreement deep links round-trip for every role (access is enforced by the backend)", () => {
    const hash = agreementHash("k97abc");
    expect(parseHash(hash)).toEqual({ area: "agreement", agreementId: "k97abc" });
    expect(resolveRoute("sub", hash)).toEqual({ area: "agreement", agreementId: "k97abc" });
  });

  test("payments workspace and ledger deep links", () => {
    expect(resolveRoute("gc", "#/payments")).toEqual({ area: "payments" });
    expect(resolveRoute("owner", "#/payments")).toEqual({ area: "owner-portal" });
    const hash = ledgerHash("k97abc");
    expect(hash).toBe("#/payments/k97abc");
    expect(resolveRoute("sub", hash)).toEqual({ area: "ledger", agreementId: "k97abc" });
  });
});
