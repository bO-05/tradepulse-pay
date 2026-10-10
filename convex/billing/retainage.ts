import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { scopedAgreements } from "../lib/agreementScope";
import { requireRole } from "../lib/roles";

/**
 * Billing → Retainage for the GC: per project, the retainage the GC holds from each sub (the sum of
 * that agreement's retainage ledger, which pay-app payouts credit with the approved per-line
 * retainage) kept apart from the retainage the owner holds from the GC on the prime contract.
 */

const PRIME_NOT_AVAILABLE =
  "Owner billing is not set up on this project yet. The retainage the owner holds appears here once an owner pay app is approved.";

export const projectRetainage = query({
  args: { projectId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const { rows, truncated } = await scopedAgreements(ctx, { parties: ["gc"], projectId: args.projectId, limit: 200 });
    const projects = new Map<
      Id<"projects">,
      {
        projectId: Id<"projects">;
        projectTitle: string;
        subHeldCents: number;
        agreements: {
          agreementId: Id<"agreements">;
          agreementNumber: string;
          subcontractorName: string;
          trade: string;
          retainagePercent: number;
          heldCents: number;
          entries: { payAppId: Id<"payApplications"> | null; applicationNo: number | null; deltaCents: number; createdAt: number }[];
        }[];
      }
    >();
    for (const { agreement, access } of rows) {
      if (agreement.status === "superseded" || agreement.status === "draft") continue;
      const ledger = await ctx.db
        .query("retainageLedger")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreement._id))
        .take(500);
      const entries = [];
      for (const r of ledger) {
        const payment: Doc<"payments"> | null = r.paymentId ? await ctx.db.get(r.paymentId) : null;
        const payApp = payment?.payAppId ? await ctx.db.get(payment.payAppId) : null;
        entries.push({ payAppId: payApp?._id ?? null, applicationNo: payApp?.applicationNo ?? null, deltaCents: r.deltaCents, createdAt: r.createdAt });
      }
      const heldCents = ledger.reduce((acc, r) => acc + r.deltaCents, 0);
      const project = access.project;
      const entry = projects.get(project._id) ?? { projectId: project._id, projectTitle: project.title, subHeldCents: 0, agreements: [] };
      entry.agreements.push({
        agreementId: agreement._id,
        agreementNumber: agreement.agreementNumber,
        subcontractorName: agreement.subcontractorName,
        trade: `${agreement.csiDivision} ${agreement.tradeName}`.trim(),
        retainagePercent: agreement.retainagePercent,
        heldCents,
        entries,
      });
      entry.subHeldCents += heldCents;
      projects.set(project._id, entry);
    }
    return {
      truncated,
      projects: [...projects.values()].map((p) => ({
        ...p,
        agreements: p.agreements.sort((a, b) => a.agreementNumber.localeCompare(b.agreementNumber)),
        prime: { heldCents: null as number | null, note: PRIME_NOT_AVAILABLE },
      })),
    };
  },
});
