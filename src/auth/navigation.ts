export type Role = "gc" | "sub" | "owner";

export type AreaId =
  | "procurement"
  | "payments"
  | "inbox"
  | "sub-portal"
  | "owner-portal"
  | "billing-agents"
  | "dashboard"
  | "judge-demo"
  | "people"
  | "my-projects"
  | "company"
  | "agreement"
  | "ledger"
  | "access-denied"
  | "not-found";

export type NavItem = {
  area: Exclude<AreaId, "agreement" | "ledger" | "access-denied" | "not-found" | "company">;
  label: string;
  hash: string;
};

export type Route = { area: AreaId; agreementId?: string; projectId?: string };

/** Areas whose direct route shows an access-denied page (instead of the role home) to roles without them. */
const DENY_WHEN_DISALLOWED = new Set<AreaId>(["dashboard"]);

/** Areas that exist only for Demo companies; everyone else gets "Not found" on the direct route. */
export const DEMO_ONLY_AREAS = new Set<AreaId>(["judge-demo"]);

const AREA_HASH: Record<NavItem["area"], string> = {
  procurement: "#/procurement",
  payments: "#/payments",
  inbox: "#/inbox",
  "sub-portal": "#/portal",
  "owner-portal": "#/projects",
  "billing-agents": "#/billing-agents",
  dashboard: "#/dashboard",
  "judge-demo": "#/judge-demo",
  people: "#/people",
  "my-projects": "#/my-projects",
};

/** Company settings: opened from the user menu, available to every role. */
export const COMPANY_HASH = "#/company";

/**
 * Role-based navigation: each area is registered with the roles allowed to see it.
 * Subs (and their billing agents) have no dashboard; the owner's dashboard is read-only.
 */
export const NAV_BY_ROLE: Record<Role, NavItem[]> = {
  gc: [
    { area: "procurement", label: "Procurement", hash: AREA_HASH.procurement },
    { area: "payments", label: "Payments", hash: AREA_HASH.payments },
    { area: "inbox", label: "Approval inbox", hash: AREA_HASH.inbox },
    { area: "owner-portal", label: "Projects overview", hash: AREA_HASH["owner-portal"] },
    { area: "people", label: "People", hash: AREA_HASH.people },
    { area: "billing-agents", label: "Billing agents", hash: AREA_HASH["billing-agents"] },
    { area: "dashboard", label: "Dashboard", hash: AREA_HASH.dashboard },
    { area: "judge-demo", label: "Guided demo", hash: AREA_HASH["judge-demo"] },
  ],
  sub: [
    { area: "sub-portal", label: "My agreements & pay applications", hash: AREA_HASH["sub-portal"] },
    { area: "my-projects", label: "Projects", hash: AREA_HASH["my-projects"] },
    { area: "payments", label: "Payments", hash: AREA_HASH.payments },
  ],
  owner: [
    { area: "owner-portal", label: "Projects & change orders", hash: AREA_HASH["owner-portal"] },
    { area: "my-projects", label: "My projects", hash: AREA_HASH["my-projects"] },
    { area: "dashboard", label: "Dashboard", hash: AREA_HASH.dashboard },
  ],
};

export function agreementHash(agreementId: string): string {
  return `#/agreements/${encodeURIComponent(agreementId)}`;
}

export function ledgerHash(agreementId: string): string {
  return `#/payments/${encodeURIComponent(agreementId)}`;
}

export function peopleHash(projectId: string): string {
  return `#/people/${encodeURIComponent(projectId)}`;
}

export function myProjectHash(projectId: string): string {
  return `#/my-projects/${encodeURIComponent(projectId)}`;
}

export function parseHash(hash: string): Route | null {
  const path = hash.replace(/^#/, "");
  if (`#${path}` === COMPANY_HASH) return { area: "company" };
  const projectMatch = path.match(/^\/(people|my-projects)\/([^/?#]+)$/);
  if (projectMatch) return { area: projectMatch[1] as "people" | "my-projects", projectId: decodeURIComponent(projectMatch[2]) };
  const agreementMatch = path.match(/^\/agreements\/([^/?#]+)$/);
  if (agreementMatch) return { area: "agreement", agreementId: decodeURIComponent(agreementMatch[1]) };
  const ledgerMatch = path.match(/^\/payments\/([^/?#]+)$/);
  if (ledgerMatch) return { area: "ledger", agreementId: decodeURIComponent(ledgerMatch[1]) };
  for (const [area, h] of Object.entries(AREA_HASH)) {
    if (h === `#${path}`) return { area: area as NavItem["area"] };
  }
  return null;
}

/** The role's nav items; Demo-only items appear only for Demo companies. */
export function navFor(role: Role, isDemo = false): NavItem[] {
  return NAV_BY_ROLE[role].filter((item) => isDemo || !DEMO_ONLY_AREAS.has(item.area));
}

/** The route the role actually gets: unknown or disallowed areas fall back to the role's home. */
export function resolveRoute(role: Role, hash: string, isDemo = false): Route {
  const nav = navFor(role, isDemo);
  const parsed = parseHash(hash);
  if (parsed && DEMO_ONLY_AREAS.has(parsed.area) && !isDemo) return { area: "not-found" };
  if (parsed?.area === "agreement" || parsed?.area === "ledger" || parsed?.area === "company") return parsed;
  if (parsed && nav.some((item) => item.area === parsed.area)) return parsed;
  if (parsed && DENY_WHEN_DISALLOWED.has(parsed.area)) return { area: "access-denied" };
  return { area: nav[0].area };
}
