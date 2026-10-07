import { describe, expect, test } from "vitest";
import { agreementHash, NAV_BY_ROLE, parseHash, resolveRoute, signInErrorMessage } from "./navigation";

describe("role navigation", () => {
  test("GC gets procurement plus the read-only overview; sub and owner never get procurement", () => {
    expect(NAV_BY_ROLE.gc.map((i) => i.area)).toEqual(["procurement", "owner-portal"]);
    expect(NAV_BY_ROLE.sub.map((i) => i.area)).toEqual(["sub-portal"]);
    expect(NAV_BY_ROLE.owner.map((i) => i.area)).toEqual(["owner-portal"]);
  });

  test("disallowed or unknown areas fall back to the role's home", () => {
    expect(resolveRoute("sub", "#/procurement")).toEqual({ area: "sub-portal" });
    expect(resolveRoute("owner", "#/procurement")).toEqual({ area: "owner-portal" });
    expect(resolveRoute("owner", "#/portal")).toEqual({ area: "owner-portal" });
    expect(resolveRoute("gc", "")).toEqual({ area: "procurement" });
    expect(resolveRoute("gc", "#/nonsense")).toEqual({ area: "procurement" });
    expect(resolveRoute("gc", "#/projects")).toEqual({ area: "owner-portal" });
  });

  test("agreement deep links round-trip for every role (access is enforced by the backend)", () => {
    const hash = agreementHash("k97abc");
    expect(parseHash(hash)).toEqual({ area: "agreement", agreementId: "k97abc" });
    expect(resolveRoute("sub", hash)).toEqual({ area: "agreement", agreementId: "k97abc" });
  });
});

describe("sign-in errors", () => {
  test("wrong password and unknown email both read as invalid credentials", () => {
    expect(signInErrorMessage(new Error("[CONVEX A(auth:signIn)] Uncaught Error: InvalidSecret"))).toBe(
      "Invalid email or password.",
    );
    expect(signInErrorMessage(new Error("Uncaught Error: InvalidAccountId"))).toBe("Invalid email or password.");
  });

  test("rate limiting and disabled sign-up get their own messages", () => {
    expect(signInErrorMessage(new Error("TooManyFailedAttempts"))).toMatch(/Too many failed attempts/);
    expect(signInErrorMessage(new Error("Self sign-up is disabled."))).toMatch(/sign-up is disabled/);
  });
});
