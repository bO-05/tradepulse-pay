import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { agreementContractSumCents, ensureSovAndMilestones, sovIsApproved } from "../payments/sov";
import { SOV_MAX_ROWS, sumSovCents } from "./sovRules";

export const DEMO_SOV_APPROVER = "Demo GC (seeded demo data)";

/**
 * Demo seed: every executed agreement on the Demo GC company's projects gets its prefilled SOV
 * (base scope plus accepted alternates, no plugs) and funding milestones linked to those lines, and
 * the SOV is approved when it sums exactly to the contract sum. Generated (unexecuted) agreements
 * stay in draft so the GC can approve them in the editor. Selects projects by company id only.
 */
export async function approveDemoSovs(
  ctx: MutationCtx,
  demoGcCompanyId: Id<"companies">,
  approverUserId: Id<"users"> | null,
): Promise<number> {
  const company = await ctx.db.get(demoGcCompanyId);
  if (company === null || company.isDemo !== true) return 0;
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", demoGcCompanyId))
    .take(2000);
  let approved = 0;
  for (const project of projects) {
    const agreements = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(200);
    for (const a of agreements) {
      if (a.status !== "executed" || sovIsApproved(a)) continue;
      await ensureSovAndMilestones(ctx, a._id);
      const agreement = await ctx.db.get(a._id);
      if (agreement === null || sovIsApproved(agreement)) continue;
      const lines = await ctx.db
        .query("scheduleOfValues")
        .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", a._id))
        .take(SOV_MAX_ROWS + 1);
      if (lines.length === 0 || sumSovCents(lines) !== agreementContractSumCents(agreement)) continue;
      await ctx.db.patch(a._id, {
        sov: {
          status: "approved",
          ...(agreement.sov?.editedAt !== undefined ? { editedAt: agreement.sov.editedAt } : {}),
          approvedAt: Date.now(),
          ...(approverUserId ? { approvedByUserId: approverUserId } : {}),
          approvedByName: DEMO_SOV_APPROVER,
        },
      });
      approved += 1;
    }
  }
  return approved;
}
