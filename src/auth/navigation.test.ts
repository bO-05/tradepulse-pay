import { describe, expect, test } from "vitest";
import { agreementHash, ledgerHash, NAV_BY_ROLE, parseHash, resolveRoute } from "./navigation";

describe("role navigation", () => {
  test("GC gets procurement, payments and the read-only overview; sub and owner never get procurement", () => {
    expect(NAV_BY_ROLE.gc.map((i) => i.area)).toEqual([
      "procurement",
      "payments",
      "inbox",
      "owner-portal",
      "billing-agents",
      "dashboard",
      "judge-demo",
    ]);
    expect(NAV_BY_ROLE.sub.map((i) => i.area)).toEqual(["sub-portal", "payments"]);
    expect(NAV_BY_ROLE.owner.map((i) => i.area)).toEqual(["owner-portal", "dashboard"]);
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
    expect(resolveRoute("gc", "#/judge-demo")).toEqual({ area: "judge-demo" });
    expect(resolveRoute("sub", "#/judge-demo")).toEqual({ area: "sub-portal" });
    expect(resolveRoute("owner", "#/judge-demo")).toEqual({ area: "owner-portal" });
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
