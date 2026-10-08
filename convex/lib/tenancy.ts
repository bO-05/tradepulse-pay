import { ConvexError } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { findActiveAgentLink } from "./agentAccess";
import { forbiddenMessage, getViewer, UNAUTHENTICATED_MESSAGE, type Role, type Viewer } from "./roles";
import { getLiveAuthUserId } from "./session";

/**
 * Tenancy helpers (architecture §12). The caller's company is always derived from the session;
 * a projectId or document id from the client is only a selector and must pass these checks.
 * A project or document that is missing and one that belongs to another company produce the
 * same "Not found." error, so ids cannot be probed across companies.
 */

export const NOT_FOUND_MESSAGE = "Not found.";

export function notFound(): ConvexError<{ code: "NOT_FOUND"; message: string }> {
  return new ConvexError({ code: "NOT_FOUND" as const, message: NOT_FOUND_MESSAGE });
}

function unauthenticated() {
  return new ConvexError({ code: "UNAUTHENTICATED" as const, message: UNAUTHENTICATED_MESSAGE });
}

export async function requireUser(ctx: QueryCtx): Promise<Doc<"users">> {
  const userId = await getLiveAuthUserId(ctx);
  const user = userId === null ? null : await ctx.db.get(userId);
  if (user === null) throw unauthenticated();
  return user;
}

/** Humans must have verified their email. AgentID agents are verified by their provider. */
export async function requireVerifiedUser(ctx: QueryCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (user.actorType !== "agent" && user.emailVerificationTime === undefined) {
    throw new ConvexError({ code: "EMAIL_UNVERIFIED", message: "Verify your email first." });
  }
  return user;
}

/** The caller's single active membership, or null. */
export async function findActiveMembership(ctx: QueryCtx, userId: Id<"users">): Promise<Doc<"companyMembers"> | null> {
  return await ctx.db
    .query("companyMembers")
    .withIndex("by_userId_and_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .first();
}

export type CompanyMember = {
  user: Doc<"users">;
  membership: Doc<"companyMembers">;
  company: Doc<"companies">;
};

export async function requireCompanyMember(ctx: QueryCtx, opts: { admin?: boolean } = {}): Promise<CompanyMember> {
  const user = await requireUser(ctx);
  const membership = await findActiveMembership(ctx, user._id);
  const company = membership === null ? null : await ctx.db.get(membership.companyId);
  if (membership === null || company === null) {
    throw new ConvexError({ code: "NO_COMPANY", message: "Create or join a company first." });
  }
  if (opts.admin && membership.role !== "admin") {
    throw new ConvexError({ code: "FORBIDDEN", message: "Forbidden: company admin required." });
  }
  return { user, membership, company };
}

export type ProjectAccess = {
  viewer: Viewer;
  user: Doc<"users">;
  project: Doc<"projects">;
  /** The caller's company; null for AgentID billing agents (they act through an agent link). */
  company: Doc<"companies"> | null;
  /** The caller's party on this project, which is what role checks use. */
  partyRole: Role;
  /** Sub party only: the contractor (bidder) records the caller may act for on this project. */
  contractorIds: Id<"contractors">[];
};

export type ProjectAccessOptions = {
  roles?: readonly Role[];
  /** Writes additionally require a verified email (humans) and a non-archived project. */
  write?: boolean;
};

async function contractorIdsForCompany(ctx: QueryCtx, companyId: Id<"companies">): Promise<Id<"contractors">[]> {
  const rows = await ctx.db
    .query("contractors")
    .withIndex("by_linkedCompanyId", (q) => q.eq("linkedCompanyId", companyId))
    .take(200);
  return rows.map((c) => c._id);
}

async function agentHasProject(
  ctx: QueryCtx,
  link: Doc<"agentLinks">,
  project: Doc<"projects">,
): Promise<boolean> {
  if (link.gcCompanyId !== undefined && project.gcCompanyId !== undefined && link.gcCompanyId !== project.gcCompanyId) {
    return false;
  }
  if (link.agreementId !== undefined) {
    const agreement = await ctx.db.get(link.agreementId);
    return agreement !== null && agreement.projectId === project._id;
  }
  const agreements = await ctx.db
    .query("agreements")
    .withIndex("by_project", (q) => q.eq("projectId", project._id))
    .take(500);
  return agreements.some((a) => a.contractorId === link.contractorId);
}

/**
 * Resolves the caller's access to a project:
 * - GC company members: projects whose gcCompanyId is their company.
 * - Sub and owner company members: projects where their company has an active projectMembers row.
 * - AgentID billing agents: projects holding an agreement of their linked contractor.
 */
export async function requireProjectAccess(
  ctx: QueryCtx,
  projectId: Id<"projects"> | string,
  opts: ProjectAccessOptions = {},
): Promise<ProjectAccess> {
  const user = opts.write ? await requireVerifiedUser(ctx) : await requireUser(ctx);
  const viewer = await getViewer(ctx);
  const normalized = ctx.db.normalizeId("projects", projectId);
  const project = normalized === null ? null : await ctx.db.get(normalized);
  if (viewer === null || project === null) throw notFound();

  let company: Doc<"companies"> | null = null;
  let partyRole: Role | null = null;
  let contractorIds: Id<"contractors">[] = [];

  if (user.actorType === "agent") {
    const link = await findActiveAgentLink(ctx, user);
    if (link !== null && (await agentHasProject(ctx, link, project))) {
      partyRole = "sub";
      contractorIds = [link.contractorId];
    }
  } else {
    const membership = await findActiveMembership(ctx, user._id);
    company = membership === null ? null : await ctx.db.get(membership.companyId);
    if (company !== null) {
      if (company.kind === "gc" && project.gcCompanyId === company._id) {
        partyRole = "gc";
      } else {
        const companyId = company._id;
        const pm = await ctx.db
          .query("projectMembers")
          .withIndex("by_project_company", (q) => q.eq("projectId", project._id).eq("companyId", companyId))
          .take(5);
        const active = pm.find((m) => m.status === "active");
        if (active !== undefined) partyRole = active.partyRole;
      }
      if (partyRole === "sub") contractorIds = await contractorIdsForCompany(ctx, company._id);
    }
  }

  if (partyRole === null) throw notFound();
  if (opts.roles && !opts.roles.includes(partyRole)) {
    throw new ConvexError({ code: "FORBIDDEN", message: forbiddenMessage(opts.roles) });
  }
  if (opts.write && project.archived === true) {
    throw new ConvexError({ code: "ARCHIVED", message: "This project is archived; restore it before making changes." });
  }
  return { viewer: { ...viewer, role: partyRole }, user, project, company, partyRole, contractorIds };
}

/** Tables whose rows can be resolved to a single owning project. */
export type ProjectScopedTable =
  | "projects"
  | "tradePackages"
  | "contractors"
  | "bids"
  | "conversations"
  | "agreements"
  | "projectFiles"
  | "clashResolutions"
  | "judgeDemoRuns"
  | "scheduleOfValues"
  | "milestones"
  | "payApplications"
  | "agentProposals"
  | "payments"
  | "retainageLedger"
  | "changeOrders";

const VIA_AGREEMENT = new Set<TableNames>([
  "scheduleOfValues",
  "milestones",
  "payApplications",
  "agentProposals",
  "payments",
  "retainageLedger",
  "changeOrders",
]);
const VIA_PACKAGE = new Set<TableNames>(["contractors", "bids", "conversations"]);

/** The project a document belongs to, or null when the document or a parent is missing. */
export async function projectIdOfDoc<T extends ProjectScopedTable>(
  ctx: QueryCtx,
  table: T,
  doc: Doc<T>,
): Promise<Id<"projects"> | null> {
  if (table === "projects") return (doc as unknown as Doc<"projects">)._id;
  if (VIA_AGREEMENT.has(table)) {
    const agreement = await ctx.db.get((doc as unknown as { agreementId: Id<"agreements"> }).agreementId);
    return agreement?.projectId ?? null;
  }
  if (VIA_PACKAGE.has(table)) {
    const pkg = await ctx.db.get((doc as unknown as { tradePackageId: Id<"tradePackages"> }).tradePackageId);
    return pkg?.projectId ?? null;
  }
  return (doc as unknown as { projectId: Id<"projects"> }).projectId;
}

/**
 * Loads a document by a client-supplied id and authorizes it against `projectId`. A document that
 * is missing, belongs to another project, or sits in a project the caller cannot access all fail
 * with the same "Not found.".
 */
export async function requireDocInProject<T extends ProjectScopedTable>(
  ctx: QueryCtx,
  table: T,
  id: Id<T> | string,
  projectId: Id<"projects"> | string,
  opts: ProjectAccessOptions = {},
): Promise<ProjectAccess & { doc: Doc<T> }> {
  const access = await requireProjectAccess(ctx, projectId, opts);
  const normalized = ctx.db.normalizeId(table, id);
  const doc = normalized === null ? null : ((await ctx.db.get(normalized)) as Doc<T> | null);
  if (doc === null) throw notFound();
  const owner = await projectIdOfDoc(ctx, table, doc);
  if (owner !== access.project._id) throw notFound();
  return { ...access, doc };
}

/**
 * Every project the caller can access, newest first. Archived projects are left out unless
 * `includeArchived` is set. Unauthenticated callers and users without a company get [].
 */
export async function accessibleProjectIds(
  ctx: QueryCtx,
  opts: { includeArchived?: boolean } = {},
): Promise<Id<"projects">[]> {
  const userId = await getLiveAuthUserId(ctx);
  const user = userId === null ? null : await ctx.db.get(userId);
  if (user === null) return [];

  const ids = new Set<Id<"projects">>();
  let agentGcCompanyId: Id<"companies"> | undefined;
  if (user.actorType === "agent") {
    const link = await findActiveAgentLink(ctx, user);
    if (link === null) return [];
    agentGcCompanyId = link.gcCompanyId;
    const agreements = await ctx.db
      .query("agreements")
      .withIndex("by_contractorId", (q) => q.eq("contractorId", link.contractorId))
      .take(500);
    for (const a of agreements) {
      if (link.agreementId === undefined || link.agreementId === a._id) ids.add(a.projectId);
    }
  } else {
    const membership = await findActiveMembership(ctx, user._id);
    const company = membership === null ? null : await ctx.db.get(membership.companyId);
    if (company === null) return [];
    const companyId = company._id;
    if (company.kind === "gc") {
      const own = await ctx.db
        .query("projects")
        .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", companyId))
        .take(1000);
      for (const p of own) ids.add(p._id);
    }
    const memberRows = await ctx.db
      .query("projectMembers")
      .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
      .take(1000);
    for (const m of memberRows) if (m.status === "active") ids.add(m.projectId);
  }

  const projects: Doc<"projects">[] = [];
  for (const id of ids) {
    const p = await ctx.db.get(id);
    if (p === null) continue;
    if (agentGcCompanyId !== undefined && p.gcCompanyId !== undefined && agentGcCompanyId !== p.gcCompanyId) continue;
    if (!opts.includeArchived && p.archived === true) continue;
    projects.push(p);
  }
  projects.sort((a, b) => b._creationTime - a._creationTime);
  return projects.map((p) => p._id);
}
