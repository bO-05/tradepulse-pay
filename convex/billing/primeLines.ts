import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { auditActor, requireDocScope, requireProjectScope } from "../lib/projectScope";
import type { ProjectAccess } from "../lib/tenancy";
import { agreementContractSumCents } from "../payments/sov";
import { CO_MAX_ABS_CENTS } from "../payments/changeOrderMath";
import { gcKey } from "./ownerBillingMath";
import { MAX_PRIME_LINES, projectOwnerPayApps, projectPrimeLines } from "./ownerRollup";

/**
 * GC lines of the prime contract (architecture §16), set up per project: general conditions, GC fee,
 * insurance and the like. Together with the awarded trade packages they make the prime schedule of
 * values that owner pay apps bill. GC of the project only.
 */

export const PRIME_LINE_MAX_DESCRIPTION = 200;
export const SUGGESTED_PRIME_LINES = ["General conditions", "GC fee", "Insurance"] as const;

function invalid(message: string, field?: "description" | "scheduledValueCents") {
  return new ConvexError({ code: "INVALID_ARGUMENT", message, ...(field ? { fieldErrors: { [field]: message } } : {}) });
}

function clean(input: { description: string; scheduledValueCents: number }) {
  const description = input.description.trim();
  if (description.length === 0) throw invalid("Enter a description for the line.", "description");
  if (description.length > PRIME_LINE_MAX_DESCRIPTION) throw invalid(`The description is limited to ${PRIME_LINE_MAX_DESCRIPTION} characters.`, "description");
  const cents = input.scheduledValueCents;
  if (!Number.isSafeInteger(cents) || cents <= 0) throw invalid("Enter a scheduled value more than $0.00 in whole cents.", "scheduledValueCents");
  if (cents > CO_MAX_ABS_CENTS) throw invalid("The scheduled value can't be more than $100,000,000.00.", "scheduledValueCents");
  return { description, scheduledValueCents: cents };
}

/** What owner pay apps outside drafts have billed on a GC line to date, and whether any includes it. */
async function billedOnLine(ctx: MutationCtx, line: Doc<"primeLines">) {
  const key = gcKey(line._id);
  let billedCents = 0;
  let used = false;
  for (const app of await projectOwnerPayApps(ctx, line.projectId)) {
    if (app.status === "draft") continue;
    const l = app.lines.find((x) => x.key === key);
    if (!l) continue;
    used = true;
    billedCents = Math.max(billedCents, l.previousWorkCents + l.workThisPeriodCents + l.storedCents);
  }
  return { billedCents, used };
}

async function audit(ctx: MutationCtx, access: ProjectAccess, title: string, description: string) {
  await ctx.db.insert("auditLogs", {
    projectId: access.project._id,
    eventType: "compliance_audit",
    title,
    description,
    ...auditActor(access),
    timestamp: Date.now(),
  });
}

/** GC: the project's GC lines plus the awarded trade packages, for the Project settings editor. */
export const listPrimeLines = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"] });
    const project = access.project;
    const lines = await projectPrimeLines(ctx, project._id);
    const agreements = (
      await ctx.db
        .query("agreements")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .take(200)
    ).filter((a) => a.status === "executed" || a.status === "generated");
    const tradeCents = agreements.reduce((acc, a) => acc + agreementContractSumCents(a), 0);
    const gcCents = lines.reduce((acc, l) => acc + l.scheduledValueCents, 0);
    return {
      projectId: project._id,
      contractValueCents: project.contractValueCents ?? null,
      tradePackagesCents: tradeCents,
      gcLinesCents: gcCents,
      unallocatedCents: project.contractValueCents === undefined ? null : project.contractValueCents - tradeCents - gcCents,
      suggestions: SUGGESTED_PRIME_LINES.filter((s) => !lines.some((l) => l.description.toLowerCase() === s.toLowerCase())),
      lines: lines.map((l) => ({ _id: l._id, lineNo: l.lineNo, description: l.description, scheduledValueCents: l.scheduledValueCents })),
    };
  },
});

export const addPrimeLine = mutation({
  args: { projectId: v.string(), description: v.string(), scheduledValueCents: v.number() },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    const fields = clean(args);
    const lines = await projectPrimeLines(ctx, access.project._id);
    if (lines.length >= MAX_PRIME_LINES) throw invalid(`A project can have at most ${MAX_PRIME_LINES} GC lines.`);
    const lineNo = (lines[lines.length - 1]?.lineNo ?? 0) + 1;
    const primeLineId = await ctx.db.insert("primeLines", { projectId: access.project._id, lineNo, ...fields, createdAt: Date.now() });
    await audit(ctx, access, "Prime contract GC line added", `${fields.description}: ${formatCents(fields.scheduledValueCents)}.`);
    return { primeLineId };
  },
});

export const updatePrimeLine = mutation({
  args: { primeLineId: v.string(), description: v.string(), scheduledValueCents: v.number() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "primeLines", args.primeLineId, { roles: ["gc"], write: true });
    const fields = clean(args);
    const { billedCents } = await billedOnLine(ctx, scope.doc);
    if (fields.scheduledValueCents < billedCents) {
      throw invalid(`Owner pay apps already billed ${formatCents(billedCents)} on this line; the scheduled value can't be lower.`, "scheduledValueCents");
    }
    await ctx.db.patch(scope.doc._id, { ...fields, updatedAt: Date.now() });
    await audit(ctx, scope, "Prime contract GC line updated", `${fields.description}: ${formatCents(fields.scheduledValueCents)}.`);
    return null;
  },
});

export const deletePrimeLine = mutation({
  args: { primeLineId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "primeLines", args.primeLineId, { roles: ["gc"], write: true });
    if ((await billedOnLine(ctx, scope.doc)).used) {
      throw invalid("This line is on an owner pay app submitted to the owner, so it can't be removed. Change its description instead.");
    }
    await ctx.db.delete(scope.doc._id);
    await audit(ctx, scope, "Prime contract GC line removed", scope.doc.description);
    return null;
  },
});
