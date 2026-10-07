import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireRole } from "./lib/roles";
import { normalizeAgentEmail, syncAgentProfilesForEmail } from "./lib/agentAccess";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** GC view of every billing-agent link, newest first. */
export const listAgentLinks = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc"]);
    const links = await ctx.db.query("agentLinks").order("desc").take(200);
    return await Promise.all(
      links.map(async (link) => {
        const contractor = await ctx.db.get(link.contractorId);
        return {
          _id: link._id,
          agentEmail: link.agentEmail,
          contractorId: link.contractorId,
          contractorName: contractor?.companyName ?? "Unknown contractor",
          status: link.status,
          createdAt: link.createdAt,
          revokedAt: link.revokedAt ?? null,
        };
      }),
    );
  },
});

/** Contractors a GC can link an agent to, alphabetically. */
export const listLinkableContractors = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc"]);
    const contractors = await ctx.db.query("contractors").take(500);
    return contractors
      .map((c) => ({ _id: c._id, companyName: c.companyName }))
      .sort((a, b) => a.companyName.localeCompare(b.companyName));
  },
});

export const addAgentLink = mutation({
  args: { agentEmail: v.string(), contractorId: v.id("contractors") },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["gc"]);
    const agentEmail = normalizeAgentEmail(args.agentEmail);
    if (!EMAIL_PATTERN.test(agentEmail)) {
      throw new ConvexError({ code: "INVALID", message: "Enter a valid agent email address." });
    }
    const contractor = await ctx.db.get(args.contractorId);
    if (contractor === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Contractor not found." });
    }
    const active = await ctx.db
      .query("agentLinks")
      .withIndex("by_agentEmail_and_status", (q) => q.eq("agentEmail", agentEmail).eq("status", "active"))
      .first();
    if (active !== null) {
      if (active.contractorId === args.contractorId) return active._id;
      throw new ConvexError({
        code: "CONFLICT",
        message: `${agentEmail} is already authorized for another contractor. Revoke that link first.`,
      });
    }
    const linkId = await ctx.db.insert("agentLinks", {
      agentEmail,
      contractorId: args.contractorId,
      status: "active",
      createdBy: viewer.userId,
      createdAt: Date.now(),
    });
    await syncAgentProfilesForEmail(ctx, agentEmail);
    await ctx.db.insert("auditLogs", {
      eventType: "agent_link_added",
      title: "Billing agent authorized",
      description: `${agentEmail} may act as billing agent for ${contractor.companyName}.`,
      actor: viewer.user.email ?? viewer.profile.displayName,
      timestamp: Date.now(),
    });
    return linkId;
  },
});

export const revokeAgentLink = mutation({
  args: { linkId: v.id("agentLinks") },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["gc"]);
    const link = await ctx.db.get(args.linkId);
    if (link === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Billing-agent link not found." });
    }
    if (link.status === "revoked") return null;
    await ctx.db.patch(link._id, { status: "revoked", revokedBy: viewer.userId, revokedAt: Date.now() });
    await syncAgentProfilesForEmail(ctx, link.agentEmail);
    const contractor = await ctx.db.get(link.contractorId);
    await ctx.db.insert("auditLogs", {
      eventType: "agent_link_revoked",
      title: "Billing agent revoked",
      description: `${link.agentEmail} may no longer act for ${contractor?.companyName ?? "the contractor"}.`,
      actor: viewer.user.email ?? viewer.profile.displayName,
      timestamp: Date.now(),
    });
    return null;
  },
});
