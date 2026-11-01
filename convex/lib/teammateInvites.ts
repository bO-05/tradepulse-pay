import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

const HISTORY_PER_STATUS = 50;

/**
 * A GC company's teammate invites, newest first: every pending one (up to 200), then recent
 * accepted/revoked/expired ones. Read by kind and status so sub/owner invite volume never hides them.
 */
export async function listTeammateInvites(ctx: QueryCtx, companyId: Id<"companies">): Promise<Doc<"invites">[]> {
  const rows: Doc<"invites">[] = [];
  for (const [status, limit] of [
    ["pending", 200],
    ["accepted", HISTORY_PER_STATUS],
    ["revoked", HISTORY_PER_STATUS],
    ["expired", HISTORY_PER_STATUS],
  ] as const) {
    rows.push(
      ...(await ctx.db
        .query("invites")
        .withIndex("by_inviterCompanyId_and_kind_and_status", (q) =>
          q.eq("inviterCompanyId", companyId).eq("kind", "teammate").eq("status", status),
        )
        .order("desc")
        .take(limit)),
    );
  }
  return rows.sort((a, b) => b._creationTime - a._creationTime);
}
