import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { loadTranches } from "../lib/trancheRows";

export type MilestoneFundingState = "not_funded" | "funded" | "captured" | "paid";

export const MILESTONE_FUNDING_LABELS: Record<MilestoneFundingState, string> = {
  not_funded: "Not funded",
  funded: "Funded (authorized)",
  captured: "Captured",
  paid: "Paid",
};

type FundingLike = { status: string; paypalAuthorizationId?: string | null; capturedCents?: number | null } | null | undefined;

/**
 * Plain funding state of one milestone from its status and its latest funding payment, using the
 * same rows the GC ledger renders. Lapsed, failed or unfinished checkouts hold no money, so they
 * read as not funded.
 */
export function milestoneFundingState(milestoneStatus: string, funding: FundingLike): MilestoneFundingState {
  if (milestoneStatus === "paid") return "paid";
  if (!funding || !funding.paypalAuthorizationId) return "not_funded";
  const captured = (funding.capturedCents ?? 0) > 0;
  if (funding.status === "partially_captured" || funding.status === "captured") return "captured";
  if (funding.status === "voided" && captured) return "captured";
  if (funding.status === "authorized") return "funded";
  return "not_funded";
}

export function milestoneFundingLabel(state: MilestoneFundingState): string {
  return MILESTONE_FUNDING_LABELS[state];
}

/** Read-only milestone funding rows for one agreement; callers must check agreement access first. */
export async function loadMilestoneFunding(ctx: QueryCtx, agreementId: Id<"agreements">) {
  const milestones = await loadTranches(ctx, agreementId);
  const rows = [];
  for (const m of milestones) {
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_milestoneId", (q) => q.eq("milestoneId", m._id))
      .take(200);
    // Index order within one milestoneId is creation order, matching the ledger's "latest attempt".
    let latest: Doc<"payments"> | undefined;
    for (const p of payments) if (p.kind === "funding") latest = p;
    const state = milestoneFundingState(m.status, latest);
    rows.push({
      _id: m._id,
      name: m.name,
      order: m.order,
      amountCents: m.amountCents,
      state,
      authorizedCents: state === "not_funded" || latest === undefined ? 0 : latest.grossCents,
      capturedCents: state === "not_funded" ? 0 : (latest?.capturedCents ?? 0),
    });
  }
  return rows;
}
