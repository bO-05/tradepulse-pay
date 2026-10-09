import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolveRoute } from "./navigation";
import { resetRouteState, SELECTION_STORAGE_KEYS } from "./signOutAndReset";

function fakeWindow(url: string) {
  const parsed = new URL(url);
  const location = { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
  const store = new Map<string, string>([
    ["tradepulse.selectedProjectId", "k978yam8bayview"],
    ["tradepulse.selectedPackageId", "jx7pkg"],
    ["tradepulse.tourDismissed", "1"],
  ]);
  const win = {
    location,
    history: {
      replaceState: (_state: unknown, _unused: string, next: string) => {
        const u = new URL(next, parsed.origin);
        location.pathname = u.pathname;
        location.search = u.search;
        location.hash = u.hash;
      },
    },
    localStorage: { removeItem: (key: string) => store.delete(key) },
  } as unknown as Window;
  return { win, location, store };
}

describe("sign-out route reset", () => {
  test("clears the hash, ?project and ?tab so the next user lands on their own home", () => {
    const { win, location } = fakeWindow("http://127.0.0.1:3150/?project=k978yam8bayview&tab=leveling#/procurement");
    resetRouteState(win);
    expect(location).toEqual({ pathname: "/", search: "", hash: "" });
    expect(resolveRoute("sub", location.hash, false, location.search)).toEqual({ area: "sub-portal" });
    expect(resolveRoute("owner", location.hash, false, location.search)).toEqual({ area: "owner-portal" });
    expect(resolveRoute("gc", location.hash, false, location.search)).toEqual({ area: "procurement" });
  });

  test("forgets the previous user's project and package selection but nothing else", () => {
    const { win, store } = fakeWindow("http://127.0.0.1:3150/#/payments");
    resetRouteState(win);
    for (const key of SELECTION_STORAGE_KEYS) expect(store.has(key)).toBe(false);
    expect(store.get("tradepulse.tourDismissed")).toBe("1");
  });

  test("every app sign-out button resets the route, except the invite page which must keep #/invite/<token>", () => {
    const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    for (const path of ["./RoleShell.tsx", "./AuthGate.tsx", "../onboarding/SetUpCompanyPage.tsx"]) {
      const code = src(path);
      expect(code, path).toContain("useSignOutAndReset");
      expect(code, path).not.toContain("useAuthActions");
    }
    expect(src("../invites/InvitePage.tsx")).not.toContain("useSignOutAndReset");
  });
});
