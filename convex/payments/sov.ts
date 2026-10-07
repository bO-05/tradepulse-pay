import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fromDollars } from "../lib/money";
import {
  DEFAULT_MILESTONES,
  buildSovLines,
  planMilestoneDates,
  splitMilestoneAmounts,
} from "./sovMath";

export function agreementContractSumCents(agreement: { contractSum: number }): number {
  return fromDollars(Math.max(0, agreement.contractSum));
}

async function hasMoneyActivity(ctx: MutationCtx, agreementId: Id<"agreements">): Promise<boolean> {
  const payApp = await ctx.db
    .query("payApplications")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
    .first();
  if (payApp !== null) return true;
  const payment = await ctx.db
    .query("payments")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
    .first();
  return payment !== null;
}

/**
 * Creates the schedule of values and the four default milestones for an
 * executed agreement. Idempotent: an agreement that already has SOV lines or
 * milestones keeps them, so re-executing never duplicates rows.
 */
export async function ensureSovAndMilestones(
  ctx: MutationCtx,
  agreementId: Id<"agreements">,
): Promise<{ sovCreated: number; milestonesCreated: number }> {
  const agreement = await ctx.db.get(agreementId);
  if (agreement === null || agreement.status !== "executed") {
    return { sovCreated: 0, milestonesCreated: 0 };
  }
  const contractSumCents = agreementContractSumCents(agreement);

  let sovRows = await ctx.db
    .query("scheduleOfValues")
    .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
    .take(500);
  let sovCreated = 0;
  const bid = await ctx.db.get(agreement.bidId);

  // A voided agreement can be re-awarded with a different sum and executed
  // again; its stale SOV is replaced only while nothing has been billed or paid.
  const staleTotal = sovRows.length > 0 && sovRows.reduce((a, r) => a + r.scheduledValueCents, 0) !== contractSumCents;
  if (staleTotal && !(await hasMoneyActivity(ctx, agreementId))) {
    for (const row of sovRows) await ctx.db.delete(row._id);
    const oldMilestones = await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId))
      .take(50);
    for (const m of oldMilestones) await ctx.db.delete(m._id);
    sovRows = [];
  }

  if (sovRows.length === 0) {
    const drafts = buildSovLines({
      contractSumCents,
      lineItems: bid?.lineItems ?? [],
      exclusions: bid?.identifiedExclusions ?? [],
      csiDivision: agreement.csiDivision,
      tradeName: agreement.tradeName,
    });
    for (const line of drafts) {
      await ctx.db.insert("scheduleOfValues", { agreementId, ...line });
    }
    sovCreated = drafts.length;
    sovRows = await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
      .take(500);
  }

  const existingMilestone = await ctx.db
    .query("milestones")
    .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId))
    .first();
  let milestonesCreated = 0;
  if (existingMilestone === null) {
    const project = await ctx.db.get(agreement.projectId);
    const dates = planMilestoneDates({
      projectStartMs: project?.createdAt ?? agreement.createdAt,
      executedAtMs: agreement.executedAt ?? Date.now(),
      leadWeeks: bid?.longLeadEquipmentWeeks ?? 0,
      durationWeeks: project?.targetCompletionWeeks ?? 52,
    });
    const amounts = splitMilestoneAmounts(contractSumCents);
    const baseScopeLineIds = sovRows.filter((r) => !r.excludedScope).map((r) => r._id);
    for (const [i, m] of DEFAULT_MILESTONES.entries()) {
      await ctx.db.insert("milestones", {
        agreementId,
        name: m.name,
        order: m.order,
        plannedDate: dates[i],
        amountCents: amounts[i],
        status: "planned",
        sovLineIds: baseScopeLineIds,
      });
    }
    milestonesCreated = DEFAULT_MILESTONES.length;
  }

  if (sovCreated > 0 || milestonesCreated > 0) {
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      tradePackageId: agreement.tradePackageId,
      agreementId,
      eventType: "contract_awarded",
      title: `Schedule of values generated: ${agreement.agreementNumber}`,
      description: `Generated ${sovCreated} schedule-of-values lines and ${milestonesCreated} milestones for ${agreement.subcontractorName} from the leveled bid.`,
      actor: "TradePulse Pay",
      timestamp: Date.now(),
    });
  }
  return { sovCreated, milestonesCreated };
}
