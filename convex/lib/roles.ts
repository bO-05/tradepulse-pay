import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";

export type Role = "gc" | "sub" | "owner";

export type Viewer = {
  userId: Id<"users">;
  user: Doc<"users">;
  profile: Doc<"userProfiles">;
  role: Role;
};

export const UNAUTHENTICATED_MESSAGE = "Not authenticated: sign in required.";

export function forbiddenMessage(roles: readonly Role[]): string {
  return `Forbidden: role ${roles.join(" or ")} required.`;
}

/** Resolves the signed-in user and their role profile, or null when either is missing. */
export async function getViewer(ctx: QueryCtx): Promise<Viewer | null> {
  const rawUserId = await getAuthUserId(ctx);
  if (rawUserId === null) return null;
  const userId = ctx.db.normalizeId("users", rawUserId);
  if (userId === null) return null;
  const user = await ctx.db.get(userId);
  if (user === null) return null;
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (profile === null) return null;
  return { userId, user, profile, role: profile.role };
}

/**
 * Throws a ConvexError unless the caller is signed in with one of `roles`.
 * When `projectId` is given the project must exist. All GC and owner accounts
 * currently share every project (single-GC demo tenancy); per-project
 * membership would be enforced here.
 */
export async function requireRole(
  ctx: QueryCtx,
  roles: readonly Role[],
  projectId?: Id<"projects">,
): Promise<Viewer> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: UNAUTHENTICATED_MESSAGE });
  }
  const viewer = await getViewer(ctx);
  if (viewer === null) {
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "Forbidden: this account has no TradePulse role assigned.",
    });
  }
  if (!roles.includes(viewer.role)) {
    throw new ConvexError({ code: "FORBIDDEN", message: forbiddenMessage(roles) });
  }
  if (projectId !== undefined) {
    const project = await ctx.db.get(projectId);
    if (project === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Project not found." });
    }
  }
  return viewer;
}

export type ActionViewer = {
  userId: Id<"users">;
  role: Role;
  profileId: Id<"userProfiles">;
  contractorId?: Id<"contractors">;
};

/** Action variant of requireRole: actions have no db, so the check runs in an internal query. */
export async function requireRoleInAction(ctx: ActionCtx, roles: readonly Role[]): Promise<ActionViewer> {
  return await ctx.runQuery(internal.profiles.requireRoleForAction, { roles: [...roles] });
}

/** A sub (human or linked billing agent) may only see agreements of its own contractor. */
export function canViewAgreement(viewer: Viewer, agreement: Doc<"agreements">): boolean {
  if (viewer.role === "gc" || viewer.role === "owner") return true;
  return viewer.profile.contractorId !== undefined && agreement.contractorId === viewer.profile.contractorId;
}

export async function requireAgreementAccess(
  ctx: QueryCtx,
  agreementId: Id<"agreements">,
  roles: readonly Role[] = ["gc", "sub", "owner"],
): Promise<{ viewer: Viewer; agreement: Doc<"agreements"> }> {
  const viewer = await requireRole(ctx, roles);
  const agreement = await ctx.db.get(agreementId);
  // Same error for "missing" and "not yours" so a sub cannot probe other agreements.
  if (agreement === null || !canViewAgreement(viewer, agreement)) {
    throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });
  }
  return { viewer, agreement };
}
