import { internalMutation, internalQuery } from "./_generated/server";
import { DEMO_EMAIL_DOMAIN, ensureDemoTenancy } from "./lib/demoTenancy";
import { findActiveMembership } from "./lib/tenancy";

/**
 * Phase-2 tenancy migration (architecture §12). Idempotent and non-destructive:
 *   npx convex run tenancyMigration:migrate '{}'
 * A second run returns all-zero counts.
 */
export const migrate = internalMutation({
  args: {},
  handler: async (ctx) => {
    const { counts, archivedTitles } = await ensureDemoTenancy(ctx);
    return { counts, archivedTitles };
  },
});

/** Read-only summary for checking the migration: npx convex run tenancyMigration:report '{}' */
export const report = internalQuery({
  args: {},
  handler: async (ctx) => {
    const companies = await ctx.db.query("companies").take(1000);
    const companyMembers = await ctx.db.query("companyMembers").take(5000);
    const projectMembers = await ctx.db.query("projectMembers").take(5000);
    const projects = await ctx.db.query("projects").take(5000);
    const demoUsers = (await ctx.db.query("users").take(5000)).filter((u) => u.email?.endsWith(DEMO_EMAIL_DOMAIN));
    const maxCreation = (rows: { _creationTime: number }[]) => rows.reduce((m, r) => Math.max(m, r._creationTime), 0);
    const nameOf = new Map(companies.map((c) => [c._id, c.name]));
    const demoAccounts = [];
    for (const u of demoUsers) {
      const membership = await findActiveMembership(ctx, u._id);
      demoAccounts.push({
        email: u.email,
        emailVerified: u.emailVerificationTime !== undefined,
        company: membership ? nameOf.get(membership.companyId) ?? null : null,
        memberRole: membership?.role ?? null,
      });
    }
    return {
      counts: {
        companies: companies.length,
        companyMembers: companyMembers.length,
        projectMembers: projectMembers.length,
        projects: projects.length,
      },
      maxCreationTime: {
        companies: maxCreation(companies),
        companyMembers: maxCreation(companyMembers),
        projectMembers: maxCreation(projectMembers),
        projects: maxCreation(projects),
      },
      companies: companies.map((c) => ({ id: c._id, name: c.name, kind: c.kind, isDemo: c.isDemo, demoKey: c.demoKey ?? null })),
      projectsWithoutCompany: projects.filter((p) => p.gcCompanyId === undefined).map((p) => p.title),
      archivedProjects: projects.filter((p) => p.archived === true).map((p) => ({ id: p._id, title: p.title })),
      activeProjects: projects
        .filter((p) => p.archived !== true)
        .map((p) => ({ id: p._id, title: p.title, company: p.gcCompanyId ? nameOf.get(p.gcCompanyId) ?? null : null })),
      demoAccounts,
    };
  },
});
