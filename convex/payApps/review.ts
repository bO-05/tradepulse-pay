import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { action, internalAction, internalMutation, internalQuery, query, type ActionCtx, type QueryCtx } from "../_generated/server";
import { findSubcontractDocScope } from "../lib/projectScope";
import { requireProjectScopeInAction } from "../lib/tenancyAction";
import { formatCents } from "../lib/money";
import { payAppReviewValidator } from "../schema";
import { latestCompletedCheck } from "../kernel/licenseChecks";
import { billingPayAppHistory } from "./billingHistory";
import { projectGcCompanyName } from "../lib/gcCompanyName";
import { buildReviewContext } from "./reviewContext";
import type { ReviewContext } from "./reviewMath";
import { runPayAppReview, type ReviewRun } from "./reviewModel";
import { loadSovRows } from "../lib/sovLines";

type ReviewInputs = {
  context: ReviewContext;
  meta: {
    payAppId: Id<"payApplications">;
    agreementId: Id<"agreements">;
    projectId: Id<"projects">;
    agreementNumber: string;
    periodLabel: string;
    csiDivision: string;
    contractorName: string;
  };
};

/** Everything the reviewer needs for one pay app, or null when it is missing. */
export const loadReviewInputs = internalQuery({
  args: { payAppId: v.id("payApplications") },
  handler: async (ctx, args): Promise<ReviewInputs | null> => {
    const payApp = await ctx.db.get(args.payAppId);
    if (payApp === null) return null;
    const agreement = await ctx.db.get(payApp.agreementId);
    if (agreement === null) return null;
    const sov = await loadSovRows(ctx, agreement._id);
    const milestones = await ctx.db
      .query("milestones")
      .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
      .take(50);
    const agreementPayApps = await billingPayAppHistory(ctx, agreement._id);
    const license = await latestCompletedCheck(ctx, agreement.contractorId);
    const project = await ctx.db.get(agreement.projectId);
    const gcCompanyName = project ? await projectGcCompanyName(ctx, project) : null;
    return {
      context: buildReviewContext({ payApp, agreement, sov, milestones, agreementPayApps, license, gcCompanyName }),
      meta: {
        payAppId: payApp._id,
        agreementId: agreement._id,
        projectId: agreement.projectId,
        agreementNumber: agreement.agreementNumber,
        periodLabel: payApp.periodLabel,
        csiDivision: agreement.csiDivision,
        contractorName: agreement.subcontractorName,
      },
    };
  },
});

const REVIEWABLE = new Set(["submitted", "under_review", "reviewed"]);

/** Moves a pay app to under_review. A plain run only starts from "submitted"; a GC re-run may also restart a reviewed one. */
export const beginReview = internalMutation({
  args: { payAppId: v.id("payApplications"), rerun: v.boolean() },
  handler: async (ctx, args): Promise<boolean> => {
    const payApp = await ctx.db.get(args.payAppId);
    if (payApp === null) return false;
    const allowed = args.rerun ? REVIEWABLE.has(payApp.status) : payApp.status === "submitted";
    if (!allowed) return false;
    if (payApp.status !== "under_review") await ctx.db.patch(payApp._id, { status: "under_review" });
    return true;
  },
});

/** Returns a stuck pay app to "submitted" so it can be reviewed again. */
export const abandonReview = internalMutation({
  args: { payAppId: v.id("payApplications") },
  handler: async (ctx, args) => {
    const payApp = await ctx.db.get(args.payAppId);
    if (payApp?.status === "under_review") await ctx.db.patch(payApp._id, { status: "submitted" });
    return null;
  },
});

export const storeReview = internalMutation({
  args: {
    payAppId: v.id("payApplications"),
    review: payAppReviewValidator,
    trace: v.object({
      runId: v.string(),
      csiDivision: v.string(),
      contractorName: v.string(),
      provider: v.string(),
      model: v.string(),
      rawPrompt: v.string(),
      systemPrompt: v.string(),
      rawResponse: v.string(),
      parsedOutput: v.any(),
      metrics: v.any(),
      latencyMs: v.number(),
      inputTokens: v.number(),
      outputTokens: v.number(),
    }),
  },
  handler: async (ctx, args): Promise<{ stored: boolean }> => {
    const now = Date.now();
    await ctx.db.insert("agentTraces", {
      ...args.trace,
      caseId: args.payAppId,
      groundTruth: null,
      status: args.review.provider === "Anthropic" ? "REVIEWED" : "REVIEWED_OFFLINE",
      costUsd: 0,
      timestamp: now,
    });
    const payApp = await ctx.db.get(args.payAppId);
    // A pay app withdrawn while the model was running keeps its withdrawn status and gets no review.
    if (payApp === null || payApp.status !== "under_review") return { stored: false };
    await ctx.db.patch(payApp._id, { review: args.review, status: "reviewed" });
    const agreement = await ctx.db.get(payApp.agreementId);
    await ctx.db.insert("auditLogs", {
      projectId: agreement?.projectId,
      agreementId: payApp.agreementId,
      eventType: "pay_app_reviewed",
      title: "Pay application reviewed",
      description: `${agreement?.agreementNumber ?? ""} ${payApp.periodLabel}: ${formatCents(args.review.approvedTotalCents)} recommended of ${formatCents(payApp.requestedTotalCents)} requested (${args.review.engine}).`,
      actor: args.review.engine,
      timestamp: now,
    });
    await ctx.scheduler.runAfter(0, internal.agent.payAgent.runPayAgent, { payAppId: payApp._id });
    return { stored: true };
  },
});

type ReviewOutcome =
  | { reviewed: false; reason: string }
  | { reviewed: boolean; engine: string; approvedTotalCents: number; traceRunId: string; reason?: undefined };

function reviewRecord(run: ReviewRun, traceRunId: string): NonNullable<Doc<"payApplications">["review"]> {
  return {
    engine: run.engine,
    provider: run.provider,
    model: run.model,
    ...(run.fallbackReason ? { fallbackReason: run.fallbackReason } : {}),
    lines: run.review.lines.map((l) => ({ ...l, sovLineId: l.sovLineId as Id<"scheduleOfValues"> })),
    flags: run.review.flags,
    approvedTotalCents: run.review.approvedTotalCents,
    traceRunId,
    reviewedAt: Date.now(),
  };
}

async function performReview(
  ctx: ActionCtx,
  payAppId: Id<"payApplications">,
  rerun: boolean,
): Promise<ReviewOutcome> {
  const started: boolean = await ctx.runMutation(internal.payApps.review.beginReview, { payAppId, rerun });
  if (!started) return { reviewed: false, reason: "Pay application is not awaiting review." };
  try {
    const inputs: ReviewInputs | null = await ctx.runQuery(internal.payApps.review.loadReviewInputs, { payAppId });
    if (inputs === null) {
      await ctx.runMutation(internal.payApps.review.abandonReview, { payAppId });
      return { reviewed: false, reason: "Pay application not found." };
    }
    const run = await runPayAppReview(inputs.context, {
      apiKey: process.env.ANTHROPIC_API_KEY,
      modelId: process.env.ANTHROPIC_MODEL,
    });
    const traceRunId = `payapp_review_${payAppId}_${Date.now()}`;
    const review = reviewRecord(run, traceRunId);
    const { stored }: { stored: boolean } = await ctx.runMutation(internal.payApps.review.storeReview, {
      payAppId,
      review,
      trace: {
        runId: traceRunId,
        csiDivision: inputs.meta.csiDivision,
        contractorName: inputs.meta.contractorName,
        provider: run.provider,
        model: run.model,
        rawPrompt: run.prompt,
        systemPrompt: run.systemPrompt,
        rawResponse: run.rawResponse,
        parsedOutput: review,
        metrics: {
          requestedTotalCents: inputs.context.payApp.requestedTotalCents,
          approvedTotalCents: run.review.approvedTotalCents,
          ...(run.fallbackReason ? { fallbackReason: run.fallbackReason } : {}),
        },
        latencyMs: run.latencyMs,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
      },
    });
    return { reviewed: stored, engine: run.engine, approvedTotalCents: run.review.approvedTotalCents, traceRunId };
  } catch (err) {
    await ctx.runMutation(internal.payApps.review.abandonReview, { payAppId });
    throw err;
  }
}

/** Scheduled on submit: reviews a submitted pay app and stores the result. */
export const reviewPayApp = internalAction({
  args: { payAppId: v.id("payApplications"), rerun: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ReviewOutcome> => await performReview(ctx, args.payAppId, args.rerun ?? false),
});

/** GC re-runs the review of a submitted, under-review or reviewed pay app. */
export const rerunPayAppReview = action({
  args: { payAppId: v.string() },
  handler: async (ctx, args): Promise<ReviewOutcome> => {
    await requireProjectScopeInAction(ctx, { docs: [{ table: "payApplications", id: args.payAppId }] }, { roles: ["gc"], write: true });
    const id: Id<"payApplications"> | null = await ctx.runQuery(internal.payApps.review.normalizePayAppId, { payAppId: args.payAppId });
    if (id === null) throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });
    const result = await performReview(ctx, id, true);
    if (!result.reviewed) throw new ConvexError({ code: "INVALID_STATE", message: result.reason ?? "Review not stored." });
    return result;
  },
});

export const normalizePayAppId = internalQuery({
  args: { payAppId: v.string() },
  handler: async (ctx, args) => ctx.db.normalizeId("payApplications", args.payAppId),
});

/** A pay application with line details and its stored review, as the GC sees it. */
export async function payAppView(ctx: QueryCtx, p: Doc<"payApplications">, sovById: Map<string, Doc<"scheduleOfValues">>) {
  const reviewLines = new Map((p.review?.lines ?? []).map((l) => [l.sovLineId as string, l]));
  const finalLines = new Map((p.finalApproval?.lines ?? []).map((l) => [l.sovLineId as string, l.approvedCents]));
  const submitter = p.submittedBy.actorType === "human" ? await ctx.db.get(p.submittedBy.userId) : null;
  return {
    _id: p._id,
    agreementId: p.agreementId,
    periodLabel: p.periodLabel,
    status: p.status,
    requestedTotalCents: p.requestedTotalCents,
    lienWaiver: p.lienWaiver,
    notes: p.notes,
    createdAt: p.createdAt,
    finalApproval: p.finalApproval ? { totalCents: p.finalApproval.totalCents, approvedAt: p.finalApproval.approvedAt } : null,
    rejectedAt: p.rejectedAt ?? null,
    rejectionReason: p.rejectionReason ?? null,
    submittedBy: {
      actorType: p.submittedBy.actorType,
      agentEmail: p.submittedBy.agentEmail ?? null,
      onBehalfOf: p.submittedBy.ownerName ?? p.submittedBy.ownerEmail ?? null,
      userEmail: submitter?.email ?? null,
    },
    judgeDemoFiledBy: p.judgeDemo?.filedBy ?? null,
    lines: p.lines.map((l) => {
      const s = sovById.get(l.sovLineId);
      const r = reviewLines.get(l.sovLineId);
      return {
        sovLineId: l.sovLineId,
        lineNo: s?.lineNo ?? 0,
        description: s?.description ?? "Unknown line",
        excludedScope: s?.excludedScope ?? false,
        scheduledValueCents: s?.scheduledValueCents ?? 0,
        pctCompleteThisPeriod: l.pctCompleteThisPeriod,
        pctCompleteToDate: l.pctCompleteToDate,
        requestedCents: l.requestedCents,
        finalApprovedCents: finalLines.get(l.sovLineId) ?? null,
        review: r
          ? { verdict: r.verdict, recommendedPctToDate: r.recommendedPctToDate, approvedCents: r.approvedCents, reason: r.reason }
          : null,
      };
    }),
    review: p.review
      ? {
          engine: p.review.engine,
          provider: p.review.provider,
          model: p.review.model,
          fallbackReason: p.review.fallbackReason ?? null,
          flags: p.review.flags,
          approvedTotalCents: p.review.approvedTotalCents,
          traceRunId: p.review.traceRunId ?? null,
          reviewedAt: p.review.reviewedAt,
        }
      : null,
  };
}

export async function sovMapFor(ctx: QueryCtx, agreementId: Id<"agreements">) {
  const sov = await loadSovRows(ctx, agreementId);
  return new Map(sov.map((s) => [s._id as string, s]));
}

/**
 * GC view of an agreement's pay applications with line details and the stored review. Only the GC
 * of the agreement's project; everyone else gets an empty list, and owner accounts get "Not found.".
 */
export const listAgreementPayApps = query({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const scope = await findSubcontractDocScope(ctx, "agreements", args.agreementId, { roles: ["gc"] });
    if (scope === null) return [];
    const agreementId = scope.doc._id;
    const sovById = await sovMapFor(ctx, agreementId);
    const payApps = await ctx.db
      .query("payApplications")
      .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
      .order("desc")
      .take(100);
    return await Promise.all(payApps.filter((p) => p.status !== "draft").map((p) => payAppView(ctx, p, sovById)));
  },
});
