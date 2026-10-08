import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Role } from "./roles";
import { partyMaySeeContractor, requireProjectScope } from "./projectScope";
import { accessibleProjectIds, requireProjectAccess, type ProjectAccess } from "./tenancy";

export type ScopedAgreement = { agreement: Doc<"agreements">; access: ProjectAccess };

/**
 * Agreements the caller may see across its accessible projects (or one project when `projectId`
 * is given, which must be accessible with one of `parties` or the call fails with "Not found.").
 * Only projects where the caller's party is in `parties` count, and sub parties only get their
 * own vendor's agreements. Newest first; `truncated` is set when more than `limit` exist.
 */
export async function scopedAgreements(
  ctx: QueryCtx,
  opts: { parties: readonly Role[]; projectId?: Id<"projects"> | string; limit: number },
): Promise<{ rows: ScopedAgreement[]; truncated: boolean }> {
  const accesses: ProjectAccess[] = [];
  if (opts.projectId !== undefined) {
    accesses.push(await requireProjectScope(ctx, opts.projectId, { roles: opts.parties }));
  } else {
    for (const projectId of await accessibleProjectIds(ctx)) {
      const access = await requireProjectAccess(ctx, projectId);
      if (opts.parties.includes(access.partyRole)) accesses.push(access);
    }
  }
  const rows: ScopedAgreement[] = [];
  for (const access of accesses) {
    const agreements = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .order("desc")
      .take(opts.limit + 1);
    for (const agreement of agreements) {
      if (partyMaySeeContractor(access, agreement.contractorId)) rows.push({ agreement, access });
    }
  }
  rows.sort((a, b) => b.agreement._creationTime - a.agreement._creationTime);
  return { rows: rows.slice(0, opts.limit), truncated: rows.length > opts.limit };
}
