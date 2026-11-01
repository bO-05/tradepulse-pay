import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * The caller's user id, but only while the session behind the token still exists. Convex Auth
 * access tokens stay valid for up to an hour after their session row is deleted (password reset,
 * sign-out elsewhere), and getAuthUserId alone never looks at the session. Reading the row also
 * makes subscribed queries rerun when it is deleted, so open tabs see the sign-out at once.
 */
export async function getLiveAuthUserId(ctx: QueryCtx): Promise<Id<"users"> | null> {
  const rawUserId = await getAuthUserId(ctx);
  if (rawUserId === null) return null;
  const userId = ctx.db.normalizeId("users", rawUserId);
  const rawSessionId = await getAuthSessionId(ctx);
  const sessionId = rawSessionId === null ? null : ctx.db.normalizeId("authSessions", rawSessionId);
  if (userId === null || sessionId === null) return null;
  const session = await ctx.db.get(sessionId);
  if (session === null || session.userId !== userId) return null;
  return userId;
}
