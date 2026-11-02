import { ConvexError, v } from "convex/values";
import { env, internalMutation } from "../_generated/server";
import { REFERENCE_AGREEMENT_ID, REFERENCE_RUN_ID } from "../lib/demoReference";

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
