import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { projectStartMs } from "../billing/trancheRules";
import { fromDollars } from "../lib/money";
import {
  DEFAULT_MILESTONES,
  buildSovLines,
  planMilestoneDates,
  sovSourceFingerprint,
  splitMilestoneAmounts,
} from "./sovMath";
import { assertBaseLineCapacity, loadSovRows } from "../lib/sovLines";

/**
 * Demo and Phase-1 seed projects (flagged demo, owned by the Demo company, or created by seeds before
 * companies existed) keep the generated milestones and the legacy pay-agent approval path. Projects of
 * real companies use GC-defined funding tranches and the pay-app decision.
 */
export async function isDemoBillingProject(ctx: QueryCtx, project: Doc<"projects">): Promise<boolean> {
  if (project.isDemoProject) return true;
  if (project.gcCompanyId === undefined) return true;
  return (await ctx.db.get(project.gcCompanyId))?.isDemo === true;
}

export function agreementContractSumCents(agreement: { contractSum: number; contractSumCents?: number }): number {
  if (typeof agreement.contractSumCents === "number" && Number.isSafeInteger(agreement.contractSumCents)) return Math.max(0, agreement.contractSumCents);
  return fromDollars(Math.max(0, agreement.contractSum));
}

/** True when the agreement has any pay application, payment or retainage entry. */
export async function hasMoneyActivity(ctx: MutationCtx, agreementId: Id<"agreements">): Promise<boolean> {
  const payApp = await ctx.db
    .query("payApplications")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
    .first();
  if (payApp !== null) return true;
  const payment = await ctx.db
    .query("payments")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
    .first();
  if (payment !== null) return true;
  const retainage = await ctx.db
    .query("retainageLedger")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
    .first();
  return retainage !== null;
}

async function loadRows(ctx: MutationCtx, agreementId: Id<"agreements">) {
  const sovRows = await loadSovRows(ctx, agreementId);
  const milestoneRows = await ctx.db
    .query("milestones")
    .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId))
    .take(50);
  return { sovRows, milestoneRows };
}

async function deleteRows(
  ctx: MutationCtx,
  rows: { sovRows: Doc<"scheduleOfValues">[]; milestoneRows: Doc<"milestones">[] },
) {
  for (const m of rows.milestoneRows) await ctx.db.delete(m._id);
  for (const r of rows.sovRows) await ctx.db.delete(r._id);
}

async function auditKeptRows(ctx: MutationCtx, agreement: Doc<"agreements">, why: string) {
  await ctx.db.insert("auditLogs", {
    projectId: agreement.projectId,
    tradePackageId: agreement.tradePackageId,
    agreementId: agreement._id,
    eventType: "compliance_audit",
    title: `Schedule of values kept: ${agreement.agreementNumber}`,
    description: `${why} The existing schedule of values and milestones were kept because pay applications, payments or retainage already reference them. Reconcile with a formal change order.`,
    actor: "TradePulse Pay",
    timestamp: Date.now(),
  });
}

export function sovIsApproved(agreement: Pick<Doc<"agreements">, "sov">): boolean {
  return agreement.sov?.status === "approved";
}

export const LEGACY_SOV_APPROVER = "Approved before SOV approval existed (billing had already started)";

/**
 * SOV state for an agreement that has none yet. Agreements billed before SOV approval existed keep
 * billing (their lines are already referenced by pay apps); everything else starts as a draft.
 */
export async function initialSovState(ctx: MutationCtx, agreementId: Id<"agreements">): Promise<NonNullable<Doc<"agreements">["sov"]>> {
  if (await hasMoneyActivity(ctx, agreementId)) {
    return { status: "approved", approvedAt: Date.now(), approvedByName: LEGACY_SOV_APPROVER };
  }
  return { status: "draft" };
}

/**
 * Creates the draft schedule of values prefilled from the award (generated or executed
 * agreements) and, once a demo agreement is executed, the default milestones. Re-running with the same award inputs
 * keeps the same rows. If the award inputs changed, untouched draft lines are regenerated unless
 * money has already moved against them (then they are kept and an audit warning is written).
 * Lines the GC edited or approved are never regenerated here.
 */
export async function ensureSovAndMilestones(
  ctx: MutationCtx,
  agreementId: Id<"agreements">,
): Promise<{ sovCreated: number; milestonesCreated: number }> {
  const agreement = await ctx.db.get(agreementId);
  if (agreement === null || (agreement.status !== "executed" && agreement.status !== "generated")) {
    return { sovCreated: 0, milestonesCreated: 0 };
  }
  const executed = agreement.status === "executed";
  const gcOwnsLines = sovIsApproved(agreement) || agreement.sov?.editedAt !== undefined;
  const contractSumCents = agreementContractSumCents(agreement);
  const bid = await ctx.db.get(agreement.bidId);
  const lineItems = bid?.lineItems ?? [];
  const acceptedAlternates = agreement.acceptedAlternates ?? [];
  const leadWeeks = bid?.longLeadEquipmentWeeks ?? 0;
  const fingerprint = sovSourceFingerprint({
    bidId: agreement.bidId,
    contractSumCents,
    lineItems,
    acceptedAlternates,
    leadWeeks,
  });

  let rows = await loadRows(ctx, agreementId);
  const sovStale = !gcOwnsLines && rows.sovRows.some((r) => r.sourceFingerprint !== fingerprint);
  const orphanMilestones = !gcOwnsLines && rows.sovRows.length === 0 && rows.milestoneRows.length > 0;
  if (sovStale || orphanMilestones) {
    if (await hasMoneyActivity(ctx, agreementId)) {
      if (sovStale) {
        await auditKeptRows(
          ctx,
          agreement,
          `The award behind ${agreement.agreementNumber} changed (bid, scope, accepted alternates or lead time) after its schedule of values was generated.`,
        );
      }
    } else {
      await deleteRows(ctx, rows);
      rows = { sovRows: [], milestoneRows: [] };
    }
  }

  let sovRows = rows.sovRows;
  let sovCreated = 0;
  if (sovRows.length === 0 && agreement.sov?.editedAt === undefined) {
    const drafts = buildSovLines({
      contractSumCents,
      lineItems,
      acceptedAlternates,
      csiDivision: agreement.csiDivision,
      tradeName: agreement.tradeName,
    });
    assertBaseLineCapacity(drafts.length);
    for (const line of drafts) {
      await ctx.db.insert("scheduleOfValues", { agreementId, ...line, sourceFingerprint: fingerprint });
    }
    sovCreated = drafts.length;
    sovRows = (await loadRows(ctx, agreementId)).sovRows;
  }
  if (agreement.sov === undefined) await ctx.db.patch(agreementId, { sov: await initialSovState(ctx, agreementId) });

  let milestonesCreated = 0;
  const project = await ctx.db.get(agreement.projectId);
  // Real projects get GC-defined funding tranches (billing/tranches.ts); only the Phase-1 demo keeps
  // the four generated milestones its judge flow funds.
  if (executed && rows.milestoneRows.length === 0 && project !== null && (await isDemoBillingProject(ctx, project))) {
    const dates = planMilestoneDates({
      projectStartMs: projectStartMs(project) ?? project.createdAt,
      executedAtMs: agreement.executedAt ?? Date.now(),
      leadWeeks,
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

/**
 * Removes the SOV and milestones of an agreement that is no longer executed
 * (voided or regenerated). Rows that money has moved against are kept and an
 * audit warning is written instead.
 */
export async function removeSovAndMilestonesIfUnbilled(
  ctx: MutationCtx,
  agreementId: Id<"agreements">,
): Promise<{ removed: boolean }> {
  const agreement = await ctx.db.get(agreementId);
  if (agreement === null) return { removed: false };
  const rows = await loadRows(ctx, agreementId);
  if (rows.sovRows.length === 0 && rows.milestoneRows.length === 0) return { removed: false };
  if (await hasMoneyActivity(ctx, agreementId)) {
    await auditKeptRows(ctx, agreement, `${agreement.agreementNumber} is no longer executed.`);
    return { removed: false };
  }
  await deleteRows(ctx, rows);
  return { removed: true };
}
