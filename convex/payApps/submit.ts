import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { Viewer } from "../lib/roles";
import { auditActor, findDocScope, requireDocScope } from "../lib/projectScope";
import { formatCents } from "../lib/money";
import { viewerAgentAuditFields, type AgentAuditFields } from "../lib/agentAudit";
import {
  sovBaselineByLine,
  validatePayApp,
  WITHDRAWABLE_PAY_APP_STATUSES,
  type SovLineContext,
} from "./validation";
import { billingPayAppHistory } from "./billingHistory";

async function sovContext(ctx: QueryCtx, agreementId: Id<"agreements">) {
  const sov = await ctx.db
    .query("scheduleOfValues")
    .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
    .take(500);
  const baseline = sovBaselineByLine(await billingPayAppHistory(ctx, agreementId), sov);
  return sov.map((s) => {
    const b = baseline.get(s._id)!;
    return {
      _id: s._id,
      lineNo: s.lineNo,
      description: s.description,
      csiCode: s.csiCode ?? null,
      excludedScope: s.excludedScope,
      scheduledValueCents: s.scheduledValueCents,
      previouslyBilledCents: b.previouslyBilledCents,
      pendingRequestedCents: b.pendingRequestedCents,
      remainingCents: b.remainingCents,
      previousPctToDate: b.previousPctToDate,
    };
  });
}

function submittedByFor(viewer: Viewer): Doc<"payApplications">["submittedBy"] {
  if (viewer.user.actorType === "agent") {
    return {
      userId: viewer.userId,
      actorType: "agent",
      agentEmail: viewer.user.email,
      ownerEmail: viewer.user.ownerEmail,
      ownerName: viewer.user.ownerName,
    };
  }
  return { userId: viewer.userId, actorType: "human" };
}

/** SOV lines with prior billing for the pay-app form; null when the agreement is not the caller's. */
export const payAppFormContext = query({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const scope = await findDocScope(ctx, "agreements", args.agreementId, { roles: ["sub"] });
    if (scope === null) return null;
    const agreement = scope.doc;
    return {
      agreementId: agreement._id,
      agreementNumber: agreement.agreementNumber,
      status: agreement.status,
      sovLines: agreement.status === "executed" ? await sovContext(ctx, agreement._id) : [],
    };
  },
});

const lineArg = v.object({
  sovLineId: v.string(),
  pctCompleteThisPeriod: v.number(),
  pctCompleteToDate: v.number(),
  requestedCents: v.number(),
});

/** A sub, or a billing agent with an active link, files a pay application on its own executed agreement. */
export const submitPayApplication = mutation({
  args: {
    agreementId: v.string(),
    periodLabel: v.string(),
    lines: v.array(lineArg),
    notes: v.string(),
    lienWaiver: v.boolean(),
  },
  handler: async (ctx, args) => {
    // Missing, another company's and another sub's agreements all read "Not found.".
    const scope = await requireDocScope(ctx, "agreements", args.agreementId, { roles: ["sub"], write: true });
    const agreement = scope.doc;
    const viewer = scope.viewer;
    if (agreement.status !== "executed") {
      throw new ConvexError({
        code: "INVALID_STATE",
        message: "Pay applications can only be submitted on an executed agreement.",
      });
    }
    return await recordPayApplication(ctx, agreement, args, {
      submittedBy: submittedByFor(viewer),
      subUserId: viewer.userId,
      ...auditActor(scope),
      auditFields: viewerAgentAuditFields(viewer),
    });
  },
});

type PayAppInput = {
  periodLabel: string;
  lines: { sovLineId: string; pctCompleteThisPeriod: number; pctCompleteToDate: number; requestedCents: number }[];
  notes: string;
  lienWaiver: boolean;
};

/**
 * Validates and stores a pay application on an executed agreement, audits it and schedules the
 * AI review. Callers decide who may file it and pass the attribution.
 */
export async function recordPayApplication(
  ctx: MutationCtx,
  agreement: Doc<"agreements">,
  args: PayAppInput,
  who: {
    submittedBy: Doc<"payApplications">["submittedBy"];
    subUserId: Id<"users">;
    actor: string;
    actorUserId?: Id<"users">;
    actorCompanyId?: Id<"companies">;
    auditFields: AgentAuditFields;
    judgeDemo?: Doc<"payApplications">["judgeDemo"];
    auditNote?: string;
  },
): Promise<Id<"payApplications">> {
  const sov = await sovContext(ctx, agreement._id);
  const sovForValidation: SovLineContext[] = sov.map((s) => ({ ...s, _id: s._id as string }));
  const result = validatePayApp(args, sovForValidation);
  if (result.errors.length > 0) {
    throw new ConvexError({
      code: "INVALID_PAY_APP",
      message: result.errors.map((e) => e.message).join(" "),
      errors: result.errors,
    });
  }
  const lines = result.lines.map((l) => ({ ...l, sovLineId: l.sovLineId as Id<"scheduleOfValues"> }));
  const now = Date.now();
  const payAppId = await ctx.db.insert("payApplications", {
    agreementId: agreement._id,
    contractorId: agreement.contractorId,
    subUserId: who.subUserId,
    periodLabel: args.periodLabel.trim(),
    lines,
    requestedTotalCents: result.requestedTotalCents,
    notes: args.notes.trim(),
    lienWaiver: args.lienWaiver,
    status: "submitted",
    submittedBy: who.submittedBy,
    ...(who.judgeDemo ? { judgeDemo: who.judgeDemo } : {}),
    createdAt: now,
  });
  const isAgent = who.submittedBy.actorType === "agent";
  await ctx.db.insert("auditLogs", {
    projectId: agreement.projectId,
    agreementId: agreement._id,
    eventType: "pay_app_submitted",
    title: "Pay application submitted",
    description: `${agreement.agreementNumber} ${args.periodLabel.trim()}: ${formatCents(result.requestedTotalCents)} requested${
      isAgent ? " by billing agent" : ""
    }${who.auditNote ? ` ${who.auditNote}` : ""}.`,
    actor: who.actor,
    ...(who.actorUserId ? { actorUserId: who.actorUserId } : {}),
    ...(who.actorCompanyId ? { actorCompanyId: who.actorCompanyId } : {}),
    timestamp: now,
    ...who.auditFields,
  });
  await ctx.scheduler.runAfter(0, internal.payApps.review.reviewPayApp, { payAppId });
  return payAppId;
}

/** SOV lines of an agreement with what earlier pay apps already billed. */
export async function payAppSovContext(ctx: QueryCtx, agreementId: Id<"agreements">) {
  return await sovContext(ctx, agreementId);
}

/**
 * Withdraws a submitted or under-review pay app of the caller's contractor and
 * cancels its pending proposals. Moves no money.
 */
export const withdrawPayApplication = mutation({
  args: { payAppId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["sub"], write: true });
    const payApp = scope.doc;
    const viewer = scope.viewer;
    const agreement = await ctx.db.get(payApp.agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });
    if (!WITHDRAWABLE_PAY_APP_STATUSES.has(payApp.status)) {
      throw new ConvexError({
        code: "INVALID_STATE",
        message: `Only submitted or under-review pay applications can be withdrawn (this one is ${payApp.status}).`,
      });
    }
    const now = Date.now();
    await ctx.db.patch(payApp._id, { status: "withdrawn", withdrawnAt: now });
    const proposals = await ctx.db
      .query("agentProposals")
      .withIndex("by_payAppId", (q) => q.eq("payAppId", payApp._id))
      .take(200);
    let cancelled = 0;
    for (const p of proposals) {
      if (p.status !== "pending") continue;
      await ctx.db.patch(p._id, { status: "cancelled", decidedBy: viewer.userId, decidedAt: now });
      cancelled++;
    }
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      agreementId: agreement._id,
      eventType: "pay_app_withdrawn",
      title: "Pay application withdrawn",
      description: `${agreement.agreementNumber} ${payApp.periodLabel} withdrawn; ${cancelled} pending proposal(s) cancelled.`,
      ...auditActor(scope),
      timestamp: now,
      ...viewerAgentAuditFields(viewer),
    });
    return { status: "withdrawn" as const, cancelledProposals: cancelled };
  },
});
