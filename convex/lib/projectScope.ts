import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { changeOrderScopeOf } from "../payments/changeOrderMath";
import { findActiveAgentLink } from "./agentAccess";
import { getViewer, requireRole, type Role } from "./roles";
import {
  accessibleProjectIds,
  findActiveMembership,
  notFound,
  projectIdOfDoc,
  requireProjectAccess,
  requireUser,
  type ProjectAccess,
  type ProjectScopedTable,
} from "./tenancy";

/**
 * Function-level tenancy guards built on convex/lib/tenancy.ts. Unlike requireProjectAccess, a
 * caller whose party on the project lacks one of `roles` also gets "Not found." (never a
 * different error), so no caller outside the allowed parties can tell that a record exists.
 */

export type ScopeOptions = {
  roles?: readonly Role[];
  /** Writes additionally require a verified email (humans) and a non-archived project. */
  write?: boolean;
};

function finish(access: ProjectAccess, opts: ScopeOptions): ProjectAccess {
  if (opts.roles && !opts.roles.includes(access.partyRole)) throw notFound();
  if (opts.write) {
    if (access.user.actorType !== "agent" && access.user.emailVerificationTime === undefined) {
      throw new ConvexError({ code: "EMAIL_UNVERIFIED", message: "Verify your email first." });
    }
    if (access.project.archived === true) {
      throw new ConvexError({ code: "ARCHIVED", message: "This project is archived; restore it before making changes." });
    }
  }
  return access;
}

/** Authorizes the caller on a client-supplied project id. */
export async function requireProjectScope(
  ctx: QueryCtx,
  projectId: Id<"projects"> | string,
  opts: ScopeOptions = {},
): Promise<ProjectAccess> {
  return finish(await requireProjectAccess(ctx, projectId), opts);
}

const CONTRACTOR_FIELD = new Set<ProjectScopedTable>(["bids", "conversations", "agreements", "payApplications"]);
const CONTRACTOR_VIA_AGREEMENT = new Set<ProjectScopedTable>([
  "scheduleOfValues",
  "milestones",
  "agentProposals",
  "payments",
  "retainageLedger",
]);

/**
 * The contractor (bidder/vendor record) a document belongs to: undefined for documents that are
 * not vendor-specific (projects, packages, files, prime change orders), null when the owning
 * contractor is missing.
 */
export async function contractorOfDoc<T extends ProjectScopedTable>(
  ctx: QueryCtx,
  table: T,
  doc: Doc<T>,
): Promise<Id<"contractors"> | null | undefined> {
  if (table === "contractors") return (doc as unknown as Doc<"contractors">)._id;
  if (table === "changeOrders") {
    const co = doc as unknown as Doc<"changeOrders">;
    if (changeOrderScopeOf(co) === "prime") return undefined;
    const agreement = co.agreementId === undefined ? null : await ctx.db.get(co.agreementId);
    return agreement?.contractorId ?? null;
  }
  if (CONTRACTOR_FIELD.has(table)) return (doc as unknown as { contractorId: Id<"contractors"> }).contractorId ?? null;
  if (CONTRACTOR_VIA_AGREEMENT.has(table)) {
    const agreement = await ctx.db.get((doc as unknown as { agreementId: Id<"agreements"> }).agreementId);
    return agreement?.contractorId ?? null;
  }
  return undefined;
}

async function assertVisibleToParty<T extends ProjectScopedTable>(
  ctx: QueryCtx,
  access: ProjectAccess,
  table: T,
  doc: Doc<T>,
): Promise<void> {
  if (access.partyRole === "gc") return;
  if (table === "changeOrders") {
    // Prime change orders are between the GC and the owner; subcontract ones between the GC and that sub.
    const prime = changeOrderScopeOf(doc as unknown as Doc<"changeOrders">) === "prime";
    if (access.partyRole === "owner") {
      if (prime) return;
      throw notFound();
    }
    if (prime) throw notFound();
  }
  if (access.partyRole === "owner") {
    // Owners get the project summary and owner items only; every vendor-specific record (bids,
    // agreements, SOV, pay apps, payments, retainage, subcontract change orders) is subcontract detail.
    if ((await contractorOfDoc(ctx, table, doc)) !== undefined) throw notFound();
    return;
  }
  const contractorId = await contractorOfDoc(ctx, table, doc);
  if (contractorId === undefined) return;
  if (contractorId === null || !access.contractorIds.includes(contractorId)) throw notFound();
}

/**
 * Loads a project-scoped document by a client-supplied id and authorizes the caller on the
 * project it belongs to. Sub callers only reach documents of their own vendor records; owner
 * callers reach no vendor-specific document except change orders. Missing,
 * foreign-company and other-vendor documents all fail with the same "Not found.".
 */
export async function requireDocScope<T extends ProjectScopedTable>(
  ctx: QueryCtx,
  table: T,
  id: Id<T> | string,
  opts: ScopeOptions = {},
): Promise<ProjectAccess & { doc: Doc<T> }> {
  await requireUser(ctx);
  const normalized = ctx.db.normalizeId(table, id);
  const doc = normalized === null ? null : ((await ctx.db.get(normalized)) as Doc<T> | null);
  if (doc === null) throw notFound();
  const projectId = await projectIdOfDoc(ctx, table, doc);
  if (projectId === null) throw notFound();
  const access = await requireProjectAccess(ctx, projectId);
  await assertVisibleToParty(ctx, access, table, doc);
  return { ...finish(access, opts), doc };
}

export function isNotFoundError(err: unknown): boolean {
  return err instanceof ConvexError && (err.data as { code?: unknown } | undefined)?.code === "NOT_FOUND";
}

/**
 * requireDocScope for reads whose UI treats a missing record as null: "Not found." becomes null,
 * any other refusal (signed out, unverified) still throws.
 */
export async function findDocScope<T extends ProjectScopedTable>(
  ctx: QueryCtx,
  table: T,
  id: Id<T> | string,
  opts: ScopeOptions = {},
): Promise<(ProjectAccess & { doc: Doc<T> }) | null> {
  try {
    return await requireDocScope(ctx, table, id, opts);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

/**
 * findDocScope for subcontract detail reads. Owner accounts never see subcontract records, so they
 * get "Not found." (for hidden and missing ids alike) instead of null; everyone else keeps null.
 */
export async function findSubcontractDocScope<T extends ProjectScopedTable>(
  ctx: QueryCtx,
  table: T,
  id: Id<T> | string,
  opts: ScopeOptions = {},
): Promise<(ProjectAccess & { doc: Doc<T> }) | null> {
  const scope = await findDocScope(ctx, table, id, opts);
  if (scope === null && (await getViewer(ctx))?.role === "owner") throw notFound();
  return scope;
}
/** A further client-supplied id that must belong to the already authorized project. */
export async function requireDocOfProject<T extends ProjectScopedTable>(
  ctx: QueryCtx,
  access: ProjectAccess,
  table: T,
  id: Id<T> | string,
): Promise<Doc<T>> {
  const normalized = ctx.db.normalizeId(table, id);
  const doc = normalized === null ? null : ((await ctx.db.get(normalized)) as Doc<T> | null);
  if (doc === null) throw notFound();
  if ((await projectIdOfDoc(ctx, table, doc)) !== access.project._id) throw notFound();
  await assertVisibleToParty(ctx, access, table, doc);
  return doc;
}

/**
 * Whether the caller may see subcontract records of `contractorId`: the GC always, a sub only its
 * own vendor's, an owner never (owners get owner-safe projections instead).
 */
export function partyMaySeeContractor(access: ProjectAccess, contractorId: Id<"contractors"> | undefined): boolean {
  if (access.partyRole === "gc") return true;
  if (access.partyRole === "owner") return false;
  return contractorId !== undefined && access.contractorIds.includes(contractorId);
}

/** The caller's accessible projects (archived hidden unless asked), newest first. */
export async function callerProjects(
  ctx: QueryCtx,
  opts: { includeArchived?: boolean } = {},
): Promise<Doc<"projects">[]> {
  const ids = await accessibleProjectIds(ctx, opts);
  const out: Doc<"projects">[] = [];
  for (const id of ids) {
    const p = await ctx.db.get(id);
    if (p !== null) out.push(p);
  }
  return out;
}

/** Audit attribution: the acting person's real name (never a job title), user id and company. */
export function auditActor(access: Pick<ProjectAccess, "user" | "viewer" | "company">): {
  actor: string;
  actorUserId: Id<"users">;
  actorCompanyId?: Id<"companies">;
} {
  const name = access.user.name?.trim() || access.viewer.profile.displayName?.trim() || access.user.email || "Signed-in user";
  return {
    actor: name,
    actorUserId: access.user._id,
    ...(access.company ? { actorCompanyId: access.company._id } : {}),
  };
}

/**
 * The vendor records a sub caller acts for and the projects it may see them on. Human subs act
 * for the contractor rows linked to their company; billing agents for their link's contractor.
 */
export async function subContractorScope(
  ctx: QueryCtx,
  opts: { includeArchived?: boolean } = {},
): Promise<{
  viewer: Awaited<ReturnType<typeof requireRole>>;
  contractorIds: Id<"contractors">[];
  projectIds: Set<Id<"projects">>;
  /** The caller's sub company; null for billing agents, which act for one contractor only. */
  subCompanyId: Id<"companies"> | null;
}> {
  const viewer = await requireRole(ctx, ["sub"]);
  const projectIds = new Set(await accessibleProjectIds(ctx, opts));
  let contractorIds: Id<"contractors">[] = [];
  let subCompanyId: Id<"companies"> | null = null;
  if (viewer.user.actorType === "agent") {
    const link = await findActiveAgentLink(ctx, viewer.user);
    if (link !== null) contractorIds = [link.contractorId];
  } else {
    const membership = await findActiveMembership(ctx, viewer.userId);
    const company = membership === null ? null : await ctx.db.get(membership.companyId);
    if (company !== null && company.kind === "sub") {
      const companyId = company._id;
      subCompanyId = companyId;
      const linked = await ctx.db
        .query("contractors")
        .withIndex("by_linkedCompanyId", (q) => q.eq("linkedCompanyId", companyId))
        .take(200);
      contractorIds = linked.map((c) => c._id);
    }
  }
  return { viewer, contractorIds, projectIds, subCompanyId };
}

/**
 * Demo-only diagnostics (evals, model traces): the caller's company must be a Demo company.
 * Everyone else gets "Not found.".
 */
export async function requireDemoCompany(ctx: QueryCtx, roles: readonly Role[]): Promise<Doc<"companies">> {
  const viewer = await requireRole(ctx, roles);
  const membership = await findActiveMembership(ctx, viewer.userId);
  const company = membership === null ? null : await ctx.db.get(membership.companyId);
  if (company === null || company.isDemo !== true) throw notFound();
  return company;
}
