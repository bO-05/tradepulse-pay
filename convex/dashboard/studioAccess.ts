import { ConvexError } from "convex/values";
import { internalQuery } from "../_generated/server";
import { requireRole } from "../lib/roles";
import { requireCompanyMember } from "../lib/tenancy";

/**
 * Gate for the /ai/studio proxy: a GC or owner who is an active member of a GC or owner company.
 * The proxy itself reads no app data; Studio's tools fetch it through the company-scoped
 * dashboard queries, so the model only ever sees the caller's own projects.
 */
export const authorizeStudioCaller = internalQuery({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireRole(ctx, ["gc", "owner"]);
    const { company } = await requireCompanyMember(ctx);
    if (company.kind !== "gc" && company.kind !== "owner") {
      throw new ConvexError({ code: "FORBIDDEN", message: "Forbidden: role gc or owner required." });
    }
    return { userId: viewer.userId, companyId: company._id };
  },
});
