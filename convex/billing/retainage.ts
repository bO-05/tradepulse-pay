import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { scopedAgreements } from "../lib/agreementScope";
import { callerProjects } from "../lib/projectScope";
import { requireRole } from "../lib/roles";
import { requireProjectAccess } from "../lib/tenancy";
import { retainageOf } from "../payApps/g703Math";
import { primeRetainageHeld, projectOwnerPayApps } from "./ownerRollup";

/**
 * Billing → Retainage for the GC: per project, the retainage the GC holds from each sub (the sum of
 * that agreement's retainage ledger, which pay-app payouts credit with the approved per-line
 * retainage) kept apart from the retainage the owner holds from the GC on the prime contract.
 */

const PRIME_NOT_AVAILABLE =
  "No owner pay app has been approved on this project yet. The retainage the owner holds appears here once the owner approves one (Billing → Owner billing).";

const PRIME_ROUNDING_NOTE =
  "The owner's retainage is rounded once on each prime line; the sub's is rounded on each of its SOV lines, so the two can differ by a cent or so (for example $0.01 on Electrical).";

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
    // A project billed to the owner on GC lines alone has no subcontracts but still has prime retainage.
    for (const project of (await callerProjects(ctx)).slice(0, 100)) {
      if (projects.has(project._id) || (args.projectId !== undefined && args.projectId !== project._id)) continue;
      const access = await requireProjectAccess(ctx, project._id).catch(() => null);
      if (access === null || access.partyRole !== "gc") continue;
      if (primeRetainageHeld(await projectOwnerPayApps(ctx, project._id)) === null) continue;
      projects.set(project._id, { projectId: project._id, projectTitle: project.title, subHeldCents: 0, agreements: [] });
    }
    const out = [];
    for (const p of projects.values()) {
      const apps = await projectOwnerPayApps(ctx, p.projectId);
      const held = primeRetainageHeld(apps);
      const app = held === null ? null : apps.find((a) => a.applicationNo === held.applicationNo)!;
      // Owner-level retainage is rounded on each prime line, the sub's on each SOV line (§22).
      const tradeLines = (app?.lines ?? [])
        .filter((l) => l.kind === "trade")
        .map((l) => ({
          description: l.description,
          ownerRetainageCents: retainageOf(l.previousWorkCents + l.workThisPeriodCents + l.storedCents, l.retainageBps),
          subRetainageCents: l.subRetainageCents ?? null,
        }))
        .filter((l) => l.ownerRetainageCents > 0 || (l.subRetainageCents ?? 0) > 0);
      out.push({
        ...p,
        agreements: p.agreements.sort((a, b) => a.agreementNumber.localeCompare(b.agreementNumber)),
        prime:
          held === null || app === null
            ? { heldCents: null as number | null, applicationNo: null as number | null, note: PRIME_NOT_AVAILABLE, tradeLines: [], roundingNote: null as string | null }
            : {
                heldCents: held.cents,
                applicationNo: held.applicationNo,
                note: `From owner pay app #${held.applicationNo}.`,
                tradeLines,
                roundingNote: tradeLines.some((l) => l.subRetainageCents !== null && l.subRetainageCents !== l.ownerRetainageCents)
                  ? PRIME_ROUNDING_NOTE
                  : null,
              },
      });
    }
    return { truncated, projects: out };
  },
});
