export type Role = "gc" | "sub" | "owner";

export type AreaId = "procurement" | "payments" | "sub-portal" | "owner-portal" | "agreement" | "ledger";

export type NavItem = { area: Exclude<AreaId, "agreement" | "ledger">; label: string; hash: string };

export type Route = { area: AreaId; agreementId?: string };

const AREA_HASH: Record<NavItem["area"], string> = {
  procurement: "#/procurement",
  payments: "#/payments",
  "sub-portal": "#/portal",
  "owner-portal": "#/projects",
};

/**
 * Role-based navigation. Later areas (payments workspace, approval inbox,
 * billing agents, dashboard) register here with the roles allowed to see them.
 */
export const NAV_BY_ROLE: Record<Role, NavItem[]> = {
  gc: [
    { area: "procurement", label: "Procurement", hash: AREA_HASH.procurement },
    { area: "payments", label: "Payments", hash: AREA_HASH.payments },
    { area: "owner-portal", label: "Projects overview", hash: AREA_HASH["owner-portal"] },
  ],
  sub: [
    { area: "sub-portal", label: "My agreements & pay applications", hash: AREA_HASH["sub-portal"] },
    { area: "payments", label: "Payments", hash: AREA_HASH.payments },
  ],
  owner: [{ area: "owner-portal", label: "Projects & change orders", hash: AREA_HASH["owner-portal"] }],
};

export function agreementHash(agreementId: string): string {
  return `#/agreements/${encodeURIComponent(agreementId)}`;
}

export function ledgerHash(agreementId: string): string {
  return `#/payments/${encodeURIComponent(agreementId)}`;
}

export function parseHash(hash: string): Route | null {
  const path = hash.replace(/^#/, "");
  const agreementMatch = path.match(/^\/agreements\/([^/?#]+)$/);
  if (agreementMatch) return { area: "agreement", agreementId: decodeURIComponent(agreementMatch[1]) };
  const ledgerMatch = path.match(/^\/payments\/([^/?#]+)$/);
  if (ledgerMatch) return { area: "ledger", agreementId: decodeURIComponent(ledgerMatch[1]) };
  for (const [area, h] of Object.entries(AREA_HASH)) {
    if (h === `#${path}`) return { area: area as NavItem["area"] };
  }
  return null;
}

/** The route the role actually gets: unknown or disallowed areas fall back to the role's home. */
export function resolveRoute(role: Role, hash: string): Route {
  const nav = NAV_BY_ROLE[role];
  const parsed = parseHash(hash);
  if (parsed?.area === "agreement" || parsed?.area === "ledger") return parsed;
  if (parsed && nav.some((item) => item.area === parsed.area)) return parsed;
  return { area: nav[0].area };
}

export function signInErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (/TooManyFailedAttempts/i.test(raw)) {
    return "Too many failed attempts for this account. Wait a few minutes and try again.";
  }
  if (/sign-up is disabled/i.test(raw)) {
    return "Self sign-up is disabled. Ask your general contractor for an account.";
  }
  if (/Failed to fetch|NetworkError|network/i.test(raw)) {
    return "Could not reach the server. Check your connection and try again.";
  }
  return "Invalid email or password.";
}
