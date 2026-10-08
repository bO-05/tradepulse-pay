import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { ProjectScopedTable } from "./lib/tenancy";
import {
  auditActor,
  requireDemoCompany,
  requireDocOfProject,
  requireDocScope,
  requireProjectScope,
} from "./lib/projectScope";
import { roleValidator } from "./schema";
import { notFound } from "./lib/tenancy";

export const scopedTableValidator = v.union(
  v.literal("projects"),
  v.literal("tradePackages"),
  v.literal("contractors"),
  v.literal("bids"),
  v.literal("conversations"),
  v.literal("agreements"),
  v.literal("projectFiles"),
  v.literal("clashResolutions"),
  v.literal("judgeDemoRuns"),
  v.literal("scheduleOfValues"),
  v.literal("milestones"),
  v.literal("payApplications"),
  v.literal("agentProposals"),
  v.literal("payments"),
  v.literal("retainageLedger"),
  v.literal("changeOrders"),
);

/**
 * Action-side tenancy check (actions have no db). Authorizes the caller on `projectId`, or on the
 * project of the first doc when no projectId is given; every listed doc must belong to that
 * project. Fails with "Not found." exactly like the query/mutation guards.
 */
export const resolveForAction = internalQuery({
  args: {
    projectId: v.optional(v.string()),
    docs: v.array(v.object({ table: scopedTableValidator, id: v.string() })),
    roles: v.optional(v.array(roleValidator)),
    write: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const opts = { roles: args.roles, write: args.write };
    let access;
    let rest = args.docs;
    if (args.projectId !== undefined) {
      access = await requireProjectScope(ctx, args.projectId, opts);
    } else {
      const [first, ...others] = args.docs;
      if (first === undefined) throw notFound();
      access = await requireDocScope(ctx, first.table as ProjectScopedTable, first.id, opts);
      rest = others;
    }
    for (const d of rest) await requireDocOfProject(ctx, access, d.table as ProjectScopedTable, d.id);
    const actor = auditActor(access);
    return {
      userId: access.user._id,
      role: access.partyRole,
      projectId: access.project._id,
      companyId: access.company?._id ?? null,
      contractorIds: access.contractorIds,
      actor: actor.actor,
    };
  },
});

/** Action-side variant of requireDemoCompany. */
export const resolveDemoCompanyForAction = internalQuery({
  args: { roles: v.array(roleValidator) },
  handler: async (ctx, args) => {
    const company = await requireDemoCompany(ctx, args.roles);
    return { companyId: company._id };
  },
});
