import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { callerProjects, isNotFoundError, partyMaySeeContractor, requireProjectScope } from "./lib/projectScope";
import { notFound } from "./lib/tenancy";

/** Project People screen (architecture §13) and the project switcher for subs and owners. */

type MemberView = { membershipId: Id<"companyMembers">; name: string; email: string | null; role: "admin" | "member" };

async function activeMembers(ctx: QueryCtx, companyId: Id<"companies">): Promise<MemberView[]> {
  const rows = await ctx.db
    .query("companyMembers")
    .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
    .take(200);
  const out: MemberView[] = [];
  for (const m of rows) {
    if (m.status !== "active") continue;
    const user = await ctx.db.get(m.userId);
    if (user === null) continue;
    out.push({ membershipId: m._id, name: user.name?.trim() || user.email || "Member", email: user.email ?? null, role: m.role });
  }
  out.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "admin" ? -1 : 1));
  return out;
}

/** GC view of everyone on a project: the GC company, member companies (sub/owner) and the project's invites. */
export const listForProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireProjectScope(ctx, args.projectId, { roles: ["gc"] });
    const gc = project.gcCompanyId ? await ctx.db.get(project.gcCompanyId) : null;
    const companies = [];
    if (gc !== null) {
      companies.push({ companyId: gc._id, name: gc.name, kind: gc.kind, partyRole: "gc" as const, trades: [] as string[], members: await activeMembers(ctx, gc._id) });
    }
    const memberRows = await ctx.db
      .query("projectMembers")
      .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
      .take(200);
    for (const row of memberRows) {
      if (row.status !== "active" || row.companyId === gc?._id) continue;
      const company = await ctx.db.get(row.companyId);
      if (company === null) continue;
      const vendor = row.vendorId ? await ctx.db.get(row.vendorId) : null;
      companies.push({
        companyId: company._id,
        name: company.name,
        kind: company.kind,
        partyRole: row.partyRole,
        trades: vendor?.trades ?? [],
        members: await activeMembers(ctx, company._id),
      });
    }
    const inviteRows = await ctx.db
      .query("invites")
      .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
      .order("desc")
      .take(200);
    const invites = [];
    for (const i of inviteRows) {
      const vendor = i.vendorId ? await ctx.db.get(i.vendorId) : null;
      invites.push({
        _id: i._id,
        email: i.email,
        kind: i.kind,
        status: i.status,
        emailStatus: i.emailStatus,
        emailError: i.emailError ?? null,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
        lastSentAt: i.lastSentAt ?? null,
        companyName: vendor?.name ?? i.companyName ?? null,
      });
    }
    return {
      project: { _id: project._id, title: project.title, ownerName: project.ownerName ?? null, archived: project.archived === true },
      companies,
      invites,
    };
  },
});

/** Ends a sub or owner company's access to the project. The row is kept (status removed), so history stays. */
export const removeProjectMember = mutation({
  args: { projectId: v.string(), companyId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    const companyId = ctx.db.normalizeId("companies", args.companyId);
    if (companyId === null) throw notFound();
    if (companyId === access.project.gcCompanyId) {
      throw new ConvexError({ code: "INVALID", message: "The general contractor can't be removed from its own project." });
    }
    const rows = await ctx.db
      .query("projectMembers")
      .withIndex("by_project_company", (q) => q.eq("projectId", access.project._id).eq("companyId", companyId))
      .take(5);
    const active = rows.filter((r) => r.status === "active");
    if (active.length === 0) throw notFound();
    const now = Date.now();
    for (const row of active) {
      await ctx.db.patch(row._id, { status: "removed", removedAt: now, removedByUserId: access.user._id });
    }
    if (access.project.ownerCompanyId === companyId) await ctx.db.patch(access.project._id, { ownerCompanyId: undefined });
    const company = await ctx.db.get(companyId);
    await ctx.db.insert("auditLogs", {
      projectId: access.project._id,
      eventType: "invite",
      title: "Company removed from project",
      description: `${access.user.name?.trim() || access.user.email || "A GC member"} removed ${company?.name ?? "a company"} from ${access.project.title}.`,
      actor: access.user.name?.trim() || access.user.email || "GC member",
      actorUserId: access.user._id,
      ...(access.company ? { actorCompanyId: access.company._id } : {}),
      timestamp: now,
    });
    return null;
  },
});

async function gcName(ctx: QueryCtx, project: Doc<"projects">): Promise<string | null> {
  if (project.gcCompanyId === undefined) return project.generalContractorName ?? null;
  return (await ctx.db.get(project.gcCompanyId))?.name ?? null;
}

/** The caller's accessible projects, each labeled with its general contractor (project switcher). */
export const myProjects = query({
  args: {},
  handler: async (ctx) => {
    const projects = await callerProjects(ctx);
    const out = [];
    for (const p of projects.slice(0, 100)) {
      out.push({ _id: p._id, title: p.title, location: p.location, gcCompanyName: await gcName(ctx, p) });
    }
    return out;
  },
});

/**
 * One project as a sub or owner sees it: title, GC and the agreements this party may see. Returns
 * null when the caller has no access (never existed, other company, or removed), so the UI can say so.
 */
export const projectOverview = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    let access;
    try {
      access = await requireProjectScope(ctx, args.projectId);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
    const { project } = access;
    const agreements = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(100);
    const visible = agreements.filter((a) => a.status !== "superseded" && partyMaySeeContractor(access, a.contractorId));
    // A sub or owner sees the GC's admins as contacts and its own company, never other parties.
    const gcContacts =
      project.gcCompanyId === undefined ? [] : (await activeMembers(ctx, project.gcCompanyId)).filter((m) => m.role === "admin");
    const yourTeam = access.company === null ? [] : await activeMembers(ctx, access.company._id);
    return {
      gcContacts: gcContacts.map((m) => ({ name: m.name, email: m.email })),
      yourCompanyName: access.company?.name ?? null,
      yourTeam: yourTeam.map((m) => ({ name: m.name, email: m.email, role: m.role })),
      _id: project._id,
      title: project.title,
      location: project.location,
      gcCompanyName: await gcName(ctx, project),
      partyRole: access.partyRole,
      agreements: visible.map((a) => ({
        _id: a._id,
        agreementNumber: a.agreementNumber,
        subcontractorName: a.subcontractorName,
        tradeName: a.tradeName,
        status: a.status,
        contractSum: a.contractSum,
      })),
    };
  },
});
