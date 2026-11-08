import { ConvexError, v } from "convex/values";
import { env, internalMutation } from "../_generated/server";
import { RESIDENTIAL_REFERENCE_TITLE } from "../demoResidential";
import { REFERENCE_AGREEMENT_ID, REFERENCE_RUN_ID } from "../lib/demoReference";
import { findDemoGcCompanyId } from "../lib/demoTenancy";
import { projectKindOf } from "../lib/projectKind";

/** Recovery-dev only. Locks existing business records without resetting or changing any settlement. */
export const protectReference = internalMutation({
  args: {},
  returns: v.object({ projectId: v.id("projects"), alreadyProtected: v.boolean() }),
  handler: async (ctx) => {
    if (env.CONVEX_SITE_URL !== "https://cheery-axolotl-689.convex.site") {
      throw new ConvexError({ code: "WRONG_DEPLOYMENT", message: "Reference protection is restricted to recovery dev." });
    }
    const runId = ctx.db.normalizeId("judgeDemoRuns", REFERENCE_RUN_ID);
    const run = runId ? await ctx.db.get(runId) : null;
    if (!run || run.agreementId !== REFERENCE_AGREEMENT_ID) {
      throw new ConvexError({ code: "NOT_FOUND", message: "The verified reference run is missing." });
    }
    const agreement = await ctx.db.get(run.agreementId);
    const project = await ctx.db.get(run.projectId);
    const company = project?.gcCompanyId ? await ctx.db.get(project.gcCompanyId) : null;
    if (!agreement || agreement.projectId !== run.projectId || !project || !company?.isDemo) {
      throw new ConvexError({ code: "INVALID_REFERENCE", message: "Reference ownership does not match the demo." });
    }
    const alreadyProtected = project.readOnlyReference === true;
    if (!alreadyProtected) await ctx.db.patch(project._id, { readOnlyReference: true });
    return { projectId: project._id, alreadyProtected };
  },
});

/**
 * Freezes the settled Lopez residential job. Internal-only and deployment-locked like
 * `protectReference`: the job is found by its seed title inside the Demo GC, its ownership and
 * residential kind are verified, and only then is `readOnlyReference` set. Idempotent, and it
 * never touches the commercial reference run or any settled money row.
 */
export const protectResidentialReference = internalMutation({
  args: {},
  returns: v.object({ projectId: v.id("projects"), alreadyProtected: v.boolean() }),
  handler: async (ctx) => {
    if (env.CONVEX_SITE_URL !== "https://cheery-axolotl-689.convex.site") {
      throw new ConvexError({ code: "WRONG_DEPLOYMENT", message: "Reference protection is restricted to recovery dev." });
    }
    const demoGcId = await findDemoGcCompanyId(ctx);
    if (demoGcId === null) {
      throw new ConvexError({ code: "NOT_FOUND", message: "The demo GC company is missing." });
    }
    const owned = await ctx.db
      .query("projects")
      .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", demoGcId))
      .take(2000);
    const project = owned.find((p) => p.title === RESIDENTIAL_REFERENCE_TITLE);
    if (project === undefined) {
      throw new ConvexError({ code: "NOT_FOUND", message: "The Lopez residential reference job is missing." });
    }
    const company = await ctx.db.get(demoGcId);
    if (
      !company?.isDemo ||
      company.kind !== "gc" ||
      project.gcCompanyId !== demoGcId ||
      projectKindOf(project) !== "residential"
    ) {
      throw new ConvexError({ code: "INVALID_REFERENCE", message: "Reference ownership does not match the residential demo." });
    }
    const alreadyProtected = project.readOnlyReference === true;
    if (!alreadyProtected) await ctx.db.patch(project._id, { readOnlyReference: true });
    return { projectId: project._id, alreadyProtected };
  },
});

/** Protect existing shared fixtures/settings, never new explicitly created sandbox workspaces. */
export const protectSharedFixtures = internalMutation({
  args: {},
  returns: v.object({ companies: v.number(), projects: v.number() }),
  handler: async (ctx) => {
    if (env.CONVEX_SITE_URL !== "https://cheery-axolotl-689.convex.site") {
      throw new ConvexError({ code: "WRONG_DEPLOYMENT", message: "Recovery dev only." });
    }
    const companies = await ctx.db.query("companies").withIndex("by_isDemo", (q) => q.eq("isDemo", true)).take(100);
    let projects = 0;
    for (const company of companies) {
      await ctx.db.patch(company._id, { demoReadOnly: true });
      if (company.kind !== "gc") continue;
      const rows = await ctx.db.query("projects").withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", company._id)).take(1000);
      for (const row of rows) {
        if (row.demoSandbox) continue;
        await ctx.db.patch(row._id, { readOnlyDemoFixture: true });
        projects++;
      }
    }
    return { companies: companies.length, projects };
  },
});
