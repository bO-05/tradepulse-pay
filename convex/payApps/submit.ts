import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireRole, type Viewer } from "../lib/roles";
import { formatCents } from "../lib/money";
import { viewerAgentAuditFields, type AgentAuditFields } from "../lib/agentAudit";
import {
  priorBillingByLine,
  validatePayApp,
  WITHDRAWABLE_PAY_APP_STATUSES,
  type SovLineContext,
} from "./validation";
import { billingPayAppHistory } from "./billingHistory";

const NOT_OWN_AGREEMENT = "Forbidden: you can only submit pay applications for your own agreements.";
const NOT_OWN_PAY_APP = "Forbidden: you can only withdraw your own pay applications.";

/** The agreement when the sub (or linked agent) viewer's contractor holds it; otherwise null. */
async function ownAgreement(ctx: QueryCtx, viewer: Viewer, agreementId: string): Promise<Doc<"agreements"> | null> {
  const id = ctx.db.normalizeId("agreements", agreementId);
  if (id === null) return null;
  const agreement = await ctx.db.get(id);
  const contractorId = viewer.profile.contractorId;
  if (agreement === null || contractorId === undefined || agreement.contractorId !== contractorId) return null;
  return agreement;
}

async function sovContext(ctx: QueryCtx, agreementId: Id<"agreements">) {
  const sov = await ctx.db
    .query("scheduleOfValues")
    .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreementId))
    .take(500);
  const prior = priorBillingByLine(await billingPayAppHistory(ctx, agreementId));
  return sov.map((s) => {
    const p = prior.get(s._id) ?? { billedCents: 0, pctToDate: 0 };
    return {
      _id: s._id,
      lineNo: s.lineNo,
      description: s.description,
      csiCode: s.csiCode ?? null,
      excludedScope: s.excludedScope,
      scheduledValueCents: s.scheduledValueCents,
      previouslyBilledCents: p.billedCents,
      remainingCents: Math.max(0, s.scheduledValueCents - p.billedCents),
      previousPctToDate: p.pctToDate,
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
    const viewer = await requireRole(ctx, ["sub"]);
    const agreement = await ownAgreement(ctx, viewer, args.agreementId);
    if (agreement === null) return null;
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
    const viewer = await requireRole(ctx, ["sub"]);
    // Missing and "not yours" give the same error so a sub cannot probe other agreements.
    const agreement = await ownAgreement(ctx, viewer, args.agreementId);
    if (agreement === null) throw new ConvexError({ code: "FORBIDDEN", message: NOT_OWN_AGREEMENT });
    if (agreement.status !== "executed") {
      throw new ConvexError({
        code: "INVALID_STATE",
        message: "Pay applications can only be submitted on an executed agreement.",
      });
    }
    return await recordPayApplication(ctx, agreement, args, {
      submittedBy: submittedByFor(viewer),
      subUserId: viewer.userId,
      actor: viewer.user.email ?? viewer.profile.displayName,
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
    const viewer = await requireRole(ctx, ["sub"]);
    const id = ctx.db.normalizeId("payApplications", args.payAppId);
    const payApp = id === null ? null : await ctx.db.get(id);
    const agreement = payApp === null ? null : await ownAgreement(ctx, viewer, payApp.agreementId);
    if (payApp === null || agreement === null) {
      throw new ConvexError({ code: "FORBIDDEN", message: NOT_OWN_PAY_APP });
    }
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
      actor: viewer.user.email ?? viewer.profile.displayName,
      timestamp: now,
      ...viewerAgentAuditFields(viewer),
    });
    return { status: "withdrawn" as const, cancelledProposals: cancelled };
  },
});
