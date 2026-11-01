import { v } from "convex/values";
import { query } from "../_generated/server";
import { findDocScope } from "../lib/projectScope";

/**
 * Where a compliance record opened from a notification lives (project and vendor), for the GC of
 * the project or the sub company that uploaded it; null for anyone else and for unknown ids.
 */
export const complianceItemLocation = query({
  args: { itemId: v.string() },
  handler: async (ctx, args) => {
    const scope = await findDocScope(ctx, "complianceItems", args.itemId, { roles: ["gc", "sub"] });
    if (scope === null) return null;
    return { itemId: scope.doc._id, projectId: scope.doc.projectId, vendorId: scope.doc.vendorId };
  },
});
