import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireCompanyMember } from "./lib/tenancy";

/** The caller's GC company vendor directory (active vendors), for pickers such as the sub invite dialog. */
export const listVendors = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { company } = await requireCompanyMember(ctx);
    if (company.kind !== "gc") return [];
    const rows = await ctx.db
      .query("vendors")
      .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
      .take(1000);
    return rows
      .filter((r) => args.includeInactive === true || r.status === "active")
      .map((r) => ({
        _id: r._id,
        name: r.name,
        trades: r.trades,
        contactName: r.contactName,
        email: r.email,
        linked: r.linkedCompanyId !== undefined,
        status: r.status,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
