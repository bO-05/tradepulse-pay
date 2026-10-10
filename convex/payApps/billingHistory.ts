import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { effectiveAmount } from "../agent/proposalMath";
import { allocateApprovedTotal, type AllocationResult } from "./approvalAllocation";
import { APPROVED_PAY_APP_STATUSES, BILLING_PAY_APP_STATUSES, committedCents, priorBillingByLine } from "./validation";
import { loadSovRows } from "../lib/sovLines";

/**
 * Upper bound on billing pay apps read for one agreement. Past it the history is refused rather
 * than truncated, because a partial sum would understate billed-to-date and allow overbilling.
 */
export const MAX_BILLING_HISTORY = 2000;

export const BILLING_HISTORY_TOO_LARGE =
  "This agreement's billing history is too large to verify completely, so the remaining scheduled value cannot be checked. Contact the GC.";

export type UnresolvedApproval = { payAppId: Id<"payApplications">; periodLabel: string; reason: string };

export type BillingHistory = {
  /** Billing pay apps; every approved or paid row carries a final approval (stored or rebuilt). */
  rows: Doc<"payApplications">[];
  /** Approved or paid rows whose final approved amount could not be established; left out of `rows`. */
  unresolved: UnresolvedApproval[];
};

export function unresolvedApprovalMessage(u: UnresolvedApproval): string {
  return `Pay application "${u.periodLabel}" was approved without a recorded final per-line approval, and it cannot be rebuilt from the GC's decision (${u.reason}). Billed-to-date cannot be verified until this is resolved. Contact the GC.`;
}

const DECIDED_PROPOSAL_STATUSES = new Set(["approved", "executed", "failed"]);

function createdBefore(a: Doc<"payApplications">, b: Doc<"payApplications">): boolean {
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a._creationTime < b._creationTime);
}

/** The GC's approved capture/payout amount for a pay app, from its decided proposals. */
async function recordedGcDecision(ctx: QueryCtx, payAppId: Id<"payApplications">) {
  const proposals = await ctx.db
    .query("agentProposals")
    .withIndex("by_payAppId", (q) => q.eq("payAppId", payAppId))
    .take(200);
  const decided = proposals
    .filter((p) => (p.kind === "payout" || p.kind === "capture") && p.decidedBy !== undefined && DECIDED_PROPOSAL_STATUSES.has(p.status))
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0) || (a.kind === "payout" ? -1 : 1));
  const p = decided[0];
  const amountCents = p ? effectiveAmount(p) : undefined;
  if (p === undefined || amountCents === undefined) return null;
  return { amountCents, approvedBy: p.decidedBy!, approvedAt: p.decidedAt ?? p.createdAt };
}

/**
 * Rebuilds the final per-line approval of a pay app approved before final approvals were stored:
 * the GC's recorded capture/payout amount, split with allocateApprovedTotal against the review's
 * recommendations, capped by each line's request and what pay apps created before it left.
 */
async function rebuildFinalApproval(
  ctx: QueryCtx,
  payApp: Doc<"payApplications">,
  earlier: readonly Doc<"payApplications">[],
  sov: Map<string, Doc<"scheduleOfValues">>,
): Promise<{ ok: true; finalApproval: NonNullable<Doc<"payApplications">["finalApproval"]> } | { ok: false; reason: string }> {
  const decision = await recordedGcDecision(ctx, payApp._id);
  if (decision === null) return { ok: false, reason: "no approved capture or payout proposal is recorded" };
  if (!payApp.review) return { ok: false, reason: "the pay application has no stored review to allocate from" };
  const prior = priorBillingByLine(earlier, { unresolvedApprovedAs: "requested" });
  const recommended = new Map(payApp.review.lines.map((l) => [l.sovLineId as string, l.approvedCents]));
  const result = allocateApprovedTotal(
    payApp.lines.map((l) => {
      const s = sov.get(l.sovLineId);
      const remaining = s ? Math.max(0, s.scheduledValueCents - committedCents(prior.get(l.sovLineId))) : 0;
      return {
        sovLineId: l.sovLineId,
        lineNo: s?.lineNo ?? 0,
        excludedScope: s?.excludedScope ?? true,
        recommendedCents: recommended.get(l.sovLineId) ?? 0,
        capCents: Math.min(l.requestedCents, remaining),
      };
    }),
    decision.amountCents,
  );
  if (!result.ok) return { ok: false, reason: `the approved ${decision.amountCents} cents cannot be split across its lines` };
  return {
    ok: true,
    finalApproval: {
      totalCents: result.totalCents,
      lines: result.lines.map((l) => ({ sovLineId: l.sovLineId as Id<"scheduleOfValues">, approvedCents: l.approvedCents })),
      approvedBy: decision.approvedBy,
      approvedAt: decision.approvedAt,
    },
  };
}

/**
 * Every pay app on the agreement that counts against scheduled value, with each approved row's
 * final approval stored or rebuilt from the GC's decision. Withdrawn and rejected applications are
 * skipped by the status index, so they can never crowd out billing rows. Rebuilt approvals are not
 * written back; reads stay side-effect free.
 */
export async function loadBillingHistory(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<BillingHistory> {
  const out: Doc<"payApplications">[] = [];
  for (const status of BILLING_PAY_APP_STATUSES) {
    const budget = MAX_BILLING_HISTORY - out.length;
    const rows = await ctx.db
      .query("payApplications")
      .withIndex("by_agreementId_and_status", (q) =>
        q.eq("agreementId", agreementId).eq("status", status as Doc<"payApplications">["status"]),
      )
      .take(budget + 1);
    if (rows.length > budget) throw new ConvexError({ code: "BILLING_HISTORY_TOO_LARGE", message: BILLING_HISTORY_TOO_LARGE });
    out.push(...rows);
  }
  const needsRebuild = (p: Doc<"payApplications">) => APPROVED_PAY_APP_STATUSES.has(p.status) && !p.finalApproval;
  if (!out.some(needsRebuild)) return { rows: out, unresolved: [] };

  const sov = new Map((await agreementSov(ctx, agreementId)).map((s) => [s._id as string, s]));
  const ordered = [...out].sort((a, b) => (createdBefore(a, b) ? -1 : createdBefore(b, a) ? 1 : 0));
  // Unresolved rows stay in `earlier` at their requested cents, a conservative upper bound.
  const current = new Map(ordered.map((p) => [p._id as string, p]));
  const unresolved: UnresolvedApproval[] = [];
  for (const p of ordered) {
    if (!needsRebuild(p)) continue;
    const earlier = ordered.filter((x) => createdBefore(x, p)).map((x) => current.get(x._id)!);
    const rebuilt = await rebuildFinalApproval(ctx, p, earlier, sov);
    if (rebuilt.ok) current.set(p._id, { ...p, finalApproval: rebuilt.finalApproval });
    else unresolved.push({ payAppId: p._id, periodLabel: p.periodLabel, reason: rebuilt.reason });
  }
  const unresolvedIds = new Set(unresolved.map((u) => u.payAppId as string));
  return { rows: out.filter((p) => !unresolvedIds.has(p._id)).map((p) => current.get(p._id)!), unresolved };
}

/**
 * Billing history for checks that must not proceed on an unverifiable total (submission, review,
 * approval): throws when any approved row's final approval cannot be established.
 */
export async function billingPayAppHistory(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<Doc<"payApplications">[]> {
  const history = await loadBillingHistory(ctx, agreementId);
  if (history.unresolved.length > 0) {
    throw new ConvexError({ code: "APPROVAL_UNRESOLVED", message: unresolvedApprovalMessage(history.unresolved[0]) });
  }
  return history.rows;
}

async function agreementSov(ctx: QueryCtx, agreementId: Id<"agreements">) {
  return await loadSovRows(ctx, agreementId);
}

/**
 * Per billed line of a pay app, the most the GC may approve: the line's request, capped by the
 * scheduled value left after every other billing pay app on the agreement.
 */
export async function finalApprovalCaps(ctx: QueryCtx, payApp: Doc<"payApplications">) {
  const sov = new Map((await agreementSov(ctx, payApp.agreementId)).map((s) => [s._id as string, s]));
  const others = (await billingPayAppHistory(ctx, payApp.agreementId)).filter((p) => p._id !== payApp._id);
  const prior = priorBillingByLine(others);
  return payApp.lines.map((l) => {
    const s = sov.get(l.sovLineId);
    const remaining = s ? Math.max(0, s.scheduledValueCents - committedCents(prior.get(l.sovLineId))) : 0;
    return {
      sovLineId: l.sovLineId,
      lineNo: s?.lineNo ?? 0,
      description: s?.description ?? "Unknown line",
      excludedScope: s?.excludedScope ?? true,
      requestedCents: l.requestedCents,
      capCents: Math.min(l.requestedCents, remaining),
    };
  });
}

/**
 * The final per-line split of `totalCents` for a pay app, capped by each line's request and by
 * the scheduled value left after every other billing pay app on the agreement.
 */
export async function allocateFinalApproval(ctx: QueryCtx, payApp: Doc<"payApplications">, totalCents: number): Promise<AllocationResult> {
  const recommended = new Map((payApp.review?.lines ?? []).map((l) => [l.sovLineId as string, l.approvedCents]));
  const caps = await finalApprovalCaps(ctx, payApp);
  return allocateApprovedTotal(
    caps.map((c) => ({
      sovLineId: c.sovLineId,
      lineNo: c.lineNo,
      excludedScope: c.excludedScope,
      recommendedCents: recommended.get(c.sovLineId) ?? 0,
      capCents: c.capCents,
    })),
    totalCents,
  );
}
