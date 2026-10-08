import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Role } from "./roles";
import type { ProjectScopedTable } from "./tenancy";

export type ActionScope = {
  userId: Id<"users">;
  role: Role;
  projectId: Id<"projects">;
  companyId: Id<"companies"> | null;
  contractorIds: Id<"contractors">[];
  /** The acting person's real name for audit entries. */
  actor: string;
};

/**
 * Action variant of requireProjectScope/requireDocScope. Pass `projectId`, or only `docs` to
 * authorize on the first doc's project; every doc must belong to that project.
 */
export async function requireProjectScopeInAction(
  ctx: ActionCtx,
  target: { projectId?: Id<"projects"> | string; docs?: { table: ProjectScopedTable; id: string | undefined }[] },
  opts: { roles?: readonly Role[]; write?: boolean } = {},
): Promise<ActionScope> {
  const docs = (target.docs ?? []).filter((d): d is { table: ProjectScopedTable; id: string } => d.id !== undefined);
  return await ctx.runQuery(internal.tenancyAccess.resolveForAction, {
    projectId: target.projectId,
    docs,
    roles: opts.roles ? [...opts.roles] : undefined,
    write: opts.write,
  });
}

/** Action variant of requireCompanyMember: the caller's own active company, derived from the session. */
export async function requireCompanyMemberInAction(
  ctx: ActionCtx,
  opts: { admin?: boolean } = {},
): Promise<{ userId: Id<"users">; companyId: Id<"companies">; companyKind: Role; memberRole: "admin" | "member" }> {
  return await ctx.runQuery(internal.tenancyAccess.resolveCompanyForAction, { admin: opts.admin });
}

/** Action variant of requireDemoCompany: the caller's company must be a Demo company. */
export async function requireDemoCompanyInAction(
  ctx: ActionCtx,
  roles: readonly Role[],
): Promise<{ companyId: Id<"companies"> }> {
  return await ctx.runQuery(internal.tenancyAccess.resolveDemoCompanyForAction, { roles: [...roles] });
}
