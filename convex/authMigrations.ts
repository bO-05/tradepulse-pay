import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { markPasswordAccountVerified } from "./lib/demoTenancy";

/**
 * One-off, idempotent: users already marked verified (`users.emailVerificationTime`, e.g. the demo
 * accounts and dev fixtures) get `authAccounts.emailVerified` too, so turning on email
 * verification does not ask them for a code. Run on each deployment after the deploy:
 *   npx convex run authMigrations:backfillVerifiedPasswordAccounts '{}'
 * Re-run with the returned cursor until `isDone` is true.
 */
export const backfillVerifiedPasswordAccounts = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ patched: v.number(), scanned: v.number(), isDone: v.boolean(), cursor: v.string() }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("users").paginate({ cursor: args.cursor ?? null, numItems: 200 });
    let patched = 0;
    for (const user of page.page) {
      if (user.actorType === "agent" || user.emailVerificationTime === undefined || !user.email) continue;
      if (await markPasswordAccountVerified(ctx, user._id, user.email)) patched++;
    }
    return { patched, scanned: page.page.length, isDone: page.isDone, cursor: page.continueCursor };
  },
});
