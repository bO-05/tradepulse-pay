import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireRole } from "./lib/roles";
import { normalizeAgentEmail, syncAgentProfilesForEmail } from "./lib/agentAccess";
import { scopedAgreements } from "./lib/agreementScope";
import { auditActor, findDocScope, requireDocScope } from "./lib/projectScope";
import { notFound, requireCompanyMember, requireVerifiedUser } from "./lib/tenancy";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Billing-agent links (architecture §12): each link belongs to the GC company that created it and
 * points at one vendor (contractor) record on one of that company's projects. Other companies
 * never see or change it; the agent reaches only that contractor's agreements.
 */

/** The caller's GC company's billing-agent links, newest first. */
export const listAgentLinks = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc"]);
    const { company } = await requireCompanyMember(ctx);
    if (company.kind !== "gc") return [];
    const links = await ctx.db
      .query("agentLinks")
      .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", company._id))
      .order("desc")
      .take(200);
    const rows = await Promise.all(
      links.map(async (link) => {
        const contractor = await ctx.db.get(link.contractorId);
        // A revoked link whose contractor was removed grants nothing and has nothing left to show.
        if (contractor === null && link.status === "revoked") return null;
        return {
          _id: link._id,
          agentEmail: link.agentEmail,
          contractorId: link.contractorId,
          contractorName: contractor?.companyName ?? link.contractorName ?? "Removed contractor",
          status: link.status,
          createdAt: link.createdAt,
          revokedAt: link.revokedAt ?? null,
        };
      }),
    );
    return rows.filter((row) => row !== null);
  },
});

/** Subcontractors holding an agreement on the caller's GC projects, alphabetically. */
export const listLinkableContractors = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc"]);
    const { rows } = await scopedAgreements(ctx, { parties: ["gc"], limit: 500 });
    const byId = new Map<Id<"contractors">, { _id: Id<"contractors">; companyName: string; projectTitle: string }>();
    for (const { agreement, access } of rows) {
      if (agreement.status === "superseded" || byId.has(agreement.contractorId)) continue;
      const contractor = await ctx.db.get(agreement.contractorId);
      if (contractor === null) continue;
      byId.set(contractor._id, { _id: contractor._id, companyName: contractor.companyName, projectTitle: access.project.title });
    }
    return [...byId.values()].sort(
      (a, b) => a.companyName.localeCompare(b.companyName) || a.projectTitle.localeCompare(b.projectTitle),
    );
  },
});

export const addAgentLink = mutation({
  args: { agentEmail: v.string(), contractorId: v.id("contractors") },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "contractors", args.contractorId, { roles: ["gc"], write: true });
    const contractor = scope.doc;
    const gcCompanyId = scope.company?._id;
    if (gcCompanyId === undefined) throw notFound();
    const agentEmail = normalizeAgentEmail(args.agentEmail);
    if (!EMAIL_PATTERN.test(agentEmail)) {
      throw new ConvexError({ code: "INVALID", message: "Enter a valid agent email address." });
    }
    const active = await ctx.db
      .query("agentLinks")
      .withIndex("by_agentEmail_and_status", (q) => q.eq("agentEmail", agentEmail).eq("status", "active"))
      .first();
    if (active !== null) {
      if (active.contractorId === args.contractorId) return active._id;
      throw new ConvexError({
        code: "CONFLICT",
        message: `${agentEmail} is already authorized as a billing agent elsewhere. It must be revoked there first.`,
      });
    }
    const linkId = await ctx.db.insert("agentLinks", {
      agentEmail,
      contractorId: args.contractorId,
      contractorName: contractor.companyName,
      gcCompanyId,
      subCompanyId: contractor.linkedCompanyId,
      status: "active",
      createdBy: scope.user._id,
      createdAt: Date.now(),
    });
    await syncAgentProfilesForEmail(ctx, agentEmail);
    await ctx.db.insert("auditLogs", {
      projectId: scope.project._id,
      eventType: "agent_link_added",
      title: "Billing agent authorized",
      description: `${agentEmail} may act as billing agent for ${contractor.companyName}.`,
      ...auditActor(scope),
      contractorId: contractor._id,
      timestamp: Date.now(),
    });
    return linkId;
  },
});

export const revokeAgentLink = mutation({
  args: { linkId: v.id("agentLinks") },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const user = await requireVerifiedUser(ctx);
    const { company } = await requireCompanyMember(ctx);
    const link = await ctx.db.get(args.linkId);
    if (company.kind !== "gc" || link === null) throw notFound();
    // Links from before the tenancy migration carry no company; fall back to the contractor's project.
    const scope = await findDocScope(ctx, "contractors", link.contractorId, { roles: ["gc"] });
    if ((link.gcCompanyId ?? scope?.project.gcCompanyId) !== company._id) throw notFound();
    if (link.status === "revoked") return null;
    await ctx.db.patch(link._id, { status: "revoked", revokedBy: user._id, revokedAt: Date.now() });
    await syncAgentProfilesForEmail(ctx, link.agentEmail);
    await ctx.db.insert("auditLogs", {
      projectId: scope?.project._id,
      eventType: "agent_link_revoked",
      title: "Billing agent revoked",
      description: `${link.agentEmail} may no longer act for ${scope?.doc.companyName ?? "the contractor"}.`,
      actor: user.name?.trim() || user.email || "Signed-in user",
      actorUserId: user._id,
      actorCompanyId: company._id,
      contractorId: link.contractorId,
      timestamp: Date.now(),
    });
    return null;
  },
});

/** Idempotent backfill of `contractorName` on links whose contractor still exists. */
export const backfillContractorNames = internalMutation({
  args: {},
  handler: async (ctx) => {
    let updated = 0;
    let missingContractor = 0;
    for await (const link of ctx.db.query("agentLinks")) {
      if (link.contractorName !== undefined) continue;
      const contractor = await ctx.db.get(link.contractorId);
      if (contractor === null) {
        missingContractor++;
        continue;
      }
      await ctx.db.patch(link._id, { contractorName: contractor.companyName });
      updated++;
    }
    return { updated, missingContractor };
  },
});
