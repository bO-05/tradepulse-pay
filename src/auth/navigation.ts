export type Role = "gc" | "sub" | "owner";

export type AreaId =
  | "procurement"
  | "payments"
  | "inbox"
  | "sub-portal"
  | "bid-invitations"
  | "owner-portal"
  | "billing-agents"
  | "dashboard"
  | "judge-demo"
  | "people"
  | "vendors"
  | "my-projects"
  | "gc-projects"
  | "company"
  | "notifications"
  | "billing"
  | "pay-apps"
  | "change-orders"
  | "pay-app"
  | "agreement"
  | "ledger"
  | "not-found";

export type NavItem = {
  area: Exclude<AreaId, "agreement" | "ledger" | "not-found" | "company" | "notifications" | "pay-app">;
  label: string;
  hash: string;
};

export type Route = {
  area: AreaId;
  agreementId?: string;
  projectId?: string;
  vendorId?: string;
  tradePackageId?: string;
  payAppId?: string;
  view?: "new" | "settings" | "sov";
};

/** Areas that exist only for Demo companies; everyone else gets "Not found" on the direct route. */
export const DEMO_ONLY_AREAS = new Set<AreaId>(["judge-demo"]);

/** Areas for company members only; billing agents act on executed agreements and never bid. */
export const HUMAN_ONLY_AREAS = new Set<AreaId>(["bid-invitations"]);

const AREA_HASH: Record<NavItem["area"], string> = {
  procurement: "#/procurement",
  payments: "#/payments",
  inbox: "#/inbox",
  "sub-portal": "#/portal",
  "bid-invitations": "#/bids",
  "owner-portal": "#/projects",
  "billing-agents": "#/billing-agents",
  dashboard: "#/dashboard",
  "judge-demo": "#/judge-demo",
  people: "#/people",
  vendors: "#/vendors",
  "my-projects": "#/my-projects",
  "gc-projects": "#/all-projects",
  billing: "#/billing",
  "pay-apps": "#/pay-apps",
  "change-orders": "#/change-orders",
};

/** One pay app (G703 sheet and G702 summary): the GC and the filing sub; owners get Not found. */
export function payAppHash(payAppId: string): string {
  return `#/pay-apps/${encodeURIComponent(payAppId)}`;
}

/** Company settings: opened from the user menu, available to every role. */
export const COMPANY_HASH = "#/company";

/** All notifications ("See all" from the bell), available to every role. */
export const NOTIFICATIONS_HASH = "#/notifications";

export const BID_INVITATIONS_HASH = "#/bids";

export function bidPackageHash(tradePackageId: string): string {
  return `${BID_INVITATIONS_HASH}/${encodeURIComponent(tradePackageId)}`;
}

export function vendorHash(vendorId: string): string {
  return `#/vendors/${encodeURIComponent(vendorId)}`;
}

/**
 * Role-based navigation: each area is registered with the roles allowed to see it.
 * Subs (and their billing agents) have no dashboard; the owner's dashboard is read-only.
 */
export const NAV_BY_ROLE: Record<Role, NavItem[]> = {
  gc: [
    { area: "procurement", label: "Procurement", hash: AREA_HASH.procurement },
    { area: "gc-projects", label: "Projects", hash: AREA_HASH["gc-projects"] },
    { area: "billing", label: "Billing", hash: AREA_HASH.billing },
    { area: "change-orders", label: "Change orders", hash: AREA_HASH["change-orders"] },
    { area: "payments", label: "Payments", hash: AREA_HASH.payments },
    { area: "inbox", label: "Approval inbox", hash: AREA_HASH.inbox },
    { area: "owner-portal", label: "Projects overview", hash: AREA_HASH["owner-portal"] },
    { area: "people", label: "People", hash: AREA_HASH.people },
    { area: "vendors", label: "Vendors", hash: AREA_HASH.vendors },
    { area: "billing-agents", label: "Billing agents", hash: AREA_HASH["billing-agents"] },
    { area: "dashboard", label: "Dashboard", hash: AREA_HASH.dashboard },
    { area: "judge-demo", label: "Guided demo", hash: AREA_HASH["judge-demo"] },
  ],
  sub: [
    { area: "sub-portal", label: "My agreements & pay applications", hash: AREA_HASH["sub-portal"] },
    { area: "pay-apps", label: "Pay apps", hash: AREA_HASH["pay-apps"] },
    { area: "change-orders", label: "Change orders", hash: AREA_HASH["change-orders"] },
    { area: "bid-invitations", label: "Bid invitations", hash: AREA_HASH["bid-invitations"] },
    { area: "my-projects", label: "Projects", hash: AREA_HASH["my-projects"] },
    { area: "payments", label: "Payments", hash: AREA_HASH.payments },
  ],
  owner: [
    { area: "owner-portal", label: "Projects & change orders", hash: AREA_HASH["owner-portal"] },
    { area: "my-projects", label: "My projects", hash: AREA_HASH["my-projects"] },
    { area: "change-orders", label: "Change orders", hash: AREA_HASH["change-orders"] },
    { area: "dashboard", label: "Dashboard", hash: AREA_HASH.dashboard },
  ],
};

export function agreementHash(agreementId: string): string {
  return `#/agreements/${encodeURIComponent(agreementId)}`;
}

export function sovHash(agreementId: string): string {
  return `${agreementHash(agreementId)}/sov`;
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

/** GC project setup: list, New project wizard, project page and Project settings. */
export const GC_PROJECTS_HASH = "#/all-projects";
export const NEW_PROJECT_HASH = "#/all-projects/new";

export function gcProjectHash(projectId: string): string {
  return `${GC_PROJECTS_HASH}/${encodeURIComponent(projectId)}`;
}

export function gcProjectSettingsHash(projectId: string): string {
  return `${gcProjectHash(projectId)}/settings`;
}

export function parseHash(hash: string): Route | null {
  const path = hash.replace(/^#/, "");
  if (`#${path}` === COMPANY_HASH) return { area: "company" };
  if (`#${path}` === NOTIFICATIONS_HASH) return { area: "notifications" };
  const bidMatch = path.match(/^\/bids\/([^/?#]+)$/);
  if (bidMatch) return { area: "bid-invitations", tradePackageId: decodeURIComponent(bidMatch[1]) };
  const vendorMatch = path.match(/^\/vendors\/([^/?#]+)$/);
  if (vendorMatch) return { area: "vendors", vendorId: decodeURIComponent(vendorMatch[1]) };
  if (`#${path}` === NEW_PROJECT_HASH) return { area: "gc-projects", view: "new" };
  const gcProject = path.match(/^\/all-projects\/([^/?#]+)(\/settings)?$/);
  if (gcProject) {
    const projectId = decodeURIComponent(gcProject[1]);
    return gcProject[2] ? { area: "gc-projects", projectId, view: "settings" } : { area: "gc-projects", projectId };
  }
  const projectMatch = path.match(/^\/(people|my-projects)\/([^/?#]+)$/);
  if (projectMatch) return { area: projectMatch[1] as "people" | "my-projects", projectId: decodeURIComponent(projectMatch[2]) };
  const agreementMatch = path.match(/^\/agreements\/([^/?#]+)(\/sov)?$/);
  if (agreementMatch) {
    const agreementId = decodeURIComponent(agreementMatch[1]);
    return agreementMatch[2] ? { area: "agreement", agreementId, view: "sov" } : { area: "agreement", agreementId };
  }
  const payAppMatch = path.match(/^\/pay-apps\/([^/?#]+)$/);
  if (payAppMatch) return { area: "pay-app", payAppId: decodeURIComponent(payAppMatch[1]) };
  const ledgerMatch = path.match(/^\/payments\/([^/?#]+)$/);
  if (ledgerMatch) return { area: "ledger", agreementId: decodeURIComponent(ledgerMatch[1]) };
  for (const [area, h] of Object.entries(AREA_HASH)) {
    if (h === `#${path}`) return { area: area as NavItem["area"] };
  }
  return null;
}

export type ActorType = "human" | "agent";

/** The role's nav items; Demo-only items appear only for Demo companies, human-only items never for agents. */
export function navFor(role: Role, isDemo = false, actorType: ActorType = "human"): NavItem[] {
  return NAV_BY_ROLE[role].filter(
    (item) => (isDemo || !DEMO_ONLY_AREAS.has(item.area)) && (actorType === "human" || !HUMAN_ONLY_AREAS.has(item.area)),
  );
}

/** `?project=` / `?tab=` only mean something to the GC procurement workspace. */
function hasProcurementQuery(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("project") || params.has("tab");
}

/**
 * The route the role actually gets. An empty hash is the role's home; every route the role or
 * company cannot open, and every unknown route, is the single "Not found" page (never a silent
 * fallback to another screen).
 */
export function resolveRoute(role: Role, hash: string, isDemo = false, search = "", actorType: ActorType = "human"): Route {
  const nav = navFor(role, isDemo, actorType);
  const isHome = hash === "" || hash === "#" || hash === "#/";
  if (isHome) {
    const ownsProcurementQuery = nav.some((item) => item.area === "procurement");
    if (!ownsProcurementQuery && hasProcurementQuery(search)) return { area: "not-found" };
    return { area: nav[0].area };
  }
  const parsed = parseHash(hash);
  if (!parsed) return { area: "not-found" };
  if (DEMO_ONLY_AREAS.has(parsed.area) && !isDemo) return { area: "not-found" };
  if (parsed.area === "agreement" || parsed.area === "ledger" || parsed.area === "company" || parsed.area === "notifications") return parsed;
  if (parsed.area === "pay-app") return role === "owner" ? { area: "not-found" } : parsed;
  if (nav.some((item) => item.area === parsed.area)) return parsed;
  return { area: "not-found" };
}
