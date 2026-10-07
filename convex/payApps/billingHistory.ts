import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { allocateApprovedTotal, type AllocationResult } from "./approvalAllocation";
import { BILLING_PAY_APP_STATUSES, priorBillingByLine } from "./validation";

/**
 * Upper bound on billing pay apps read for one agreement. Past it the history is refused rather
 * than truncated, because a partial sum would understate billed-to-date and allow overbilling.
 */
export const MAX_BILLING_HISTORY = 2000;

export const BILLING_HISTORY_TOO_LARGE =
  "This agreement's billing history is too large to verify completely, so the remaining scheduled value cannot be checked. Contact the GC.";

/**
 * Every pay app on the agreement that counts against scheduled value. Withdrawn and rejected
 * applications are skipped by the status index, so they can never crowd out billing rows.
 */
export async function billingPayAppHistory(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<Doc<"payApplications">[]> {
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
  return out;
}

async function agreementSov(ctx: QueryCtx, agreementId: Id<"agreements">) {
  return await ctx.db
    .query("scheduleOfValues")
    .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
    .take(500);
}

/**
 * The final per-line split of `totalCents` for a pay app, capped by each line's request and by
 * the scheduled value left after every other billing pay app on the agreement.
 */
export async function allocateFinalApproval(ctx: QueryCtx, payApp: Doc<"payApplications">, totalCents: number): Promise<AllocationResult> {
  const sov = new Map((await agreementSov(ctx, payApp.agreementId)).map((s) => [s._id as string, s]));
  const others = (await billingPayAppHistory(ctx, payApp.agreementId)).filter((p) => p._id !== payApp._id);
  const prior = priorBillingByLine(others);
  const recommended = new Map((payApp.review?.lines ?? []).map((l) => [l.sovLineId as string, l.approvedCents]));
  return allocateApprovedTotal(
    payApp.lines.map((l) => {
      const s = sov.get(l.sovLineId);
      const remaining = s ? Math.max(0, s.scheduledValueCents - (prior.get(l.sovLineId)?.billedCents ?? 0)) : 0;
      return {
        sovLineId: l.sovLineId,
        lineNo: s?.lineNo ?? 0,
        excludedScope: s?.excludedScope ?? true,
        recommendedCents: recommended.get(l.sovLineId) ?? 0,
        capCents: Math.min(l.requestedCents, remaining),
      };
    }),
    totalCents,
  );
}
