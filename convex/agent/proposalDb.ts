import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { submitterAuditFields } from "../lib/agentAudit";
import { retainagePercentFor } from "../payments/payoutMath";
import { latestCompletedCheck } from "../kernel/licenseChecks";
import { planProposals, requiredKinds, type PlanLicenseStatus, type PlanMilestone, type ProposalPlan } from "./proposalMath";

/**
 * Database side of the pay agent. The agent's propose* tools end here, and this file only ever inserts
 * agentProposals rows (plus their audit entries): it never creates payments, captures or ledger rows.
 * Amounts are recomputed from the stored review inside the mutation, so a tool call cannot pick them.
 */

export const AGENT_ACTOR = "TradePulse pay agent";

const PROPOSABLE_KINDS = v.union(v.literal("capture"), v.literal("payout"), v.literal("reschedule"), v.literal("hold"));
type ProposableKind = "capture" | "payout" | "reschedule" | "hold";

export async function milestonePlanRows(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<PlanMilestone[]> {
  const milestones = await ctx.db
    .query("milestones")
    .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreementId))
    .take(50);
  const rows: PlanMilestone[] = [];
  for (const m of milestones) {
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_milestoneId", (q) => q.eq("milestoneId", m._id))
      .take(200);
    const funded = payments.filter((p) => p.kind === "funding" && p.paypalAuthorizationId !== undefined);
    const funding = funded.length > 0 ? funded[funded.length - 1] : null;
    rows.push({
      milestoneId: m._id,
      name: m.name,
      order: m.order,
      status: m.status,
      sovLineIds: m.sovLineIds,
      funding: funding ? { status: funding.status, grossCents: funding.grossCents, capturedCents: funding.capturedCents ?? 0 } : null,
    });
  }
  return rows;
}

function toPlanLicense(status: string | undefined): PlanLicenseStatus {
  const known = ["active", "expired", "suspended", "inactive", "not_found", "unverified"];
  return status && known.includes(status) ? (status as PlanLicenseStatus) : status === undefined ? "none" : "unverified";
}

async function planFor(
  ctx: QueryCtx,
  payApp: Doc<"payApplications">,
  agreement: Doc<"agreements">,
  licenseStatus: PlanLicenseStatus,
): Promise<ProposalPlan | null> {
  const review = payApp.review;
  if (!review) return null;
  const requested = new Map(payApp.lines.map((l) => [l.sovLineId as string, l.requestedCents]));
  return planProposals({
    requestedTotalCents: payApp.requestedTotalCents,
    lienWaiver: payApp.lienWaiver,
    approvedTotalCents: review.approvedTotalCents,
    lines: review.lines.map((l) => ({
      sovLineId: l.sovLineId,
      verdict: l.verdict,
      approvedCents: l.approvedCents,
      requestedCents: requested.get(l.sovLineId) ?? 0,
    })),
    milestones: await milestonePlanRows(ctx, agreement._id),
    retainagePercent: retainagePercentFor(agreement),
    licenseStatus,
  });
}

/** What the agent prompt and tools need for one reviewed pay app. */
export const loadAgentInputs = internalQuery({
  args: { payAppId: v.id("payApplications") },
  handler: async (ctx, { payAppId }) => {
    const payApp = await ctx.db.get(payAppId);
    if (payApp === null || payApp.review === undefined) return null;
    const agreement = await ctx.db.get(payApp.agreementId);
    if (agreement === null) return null;
    const contractor = await ctx.db.get(agreement.contractorId);
    const sov = await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id))
      .take(500);
    const sovById = new Map(sov.map((s) => [s._id as string, s]));
    const reviewLines = new Map(payApp.review.lines.map((l) => [l.sovLineId as string, l]));
    const latest = await latestCompletedCheck(ctx, agreement.contractorId);
    const milestones = await milestonePlanRows(ctx, agreement._id);
    return {
      payApp: {
        _id: payApp._id,
        status: payApp.status,
        periodLabel: payApp.periodLabel,
        requestedTotalCents: payApp.requestedTotalCents,
        lienWaiver: payApp.lienWaiver,
        notes: payApp.notes,
        submittedByActorType: payApp.submittedBy.actorType,
      },
      review: {
        provider: payApp.review.provider,
        model: payApp.review.model,
        approvedTotalCents: payApp.review.approvedTotalCents,
        flags: payApp.review.flags,
      },
      lines: payApp.lines.map((l) => {
        const s = sovById.get(l.sovLineId);
        const r = reviewLines.get(l.sovLineId);
        return {
          sovLineId: l.sovLineId as string,
          lineNo: s?.lineNo ?? 0,
          description: s?.description ?? "Unknown line",
          excludedScope: s?.excludedScope ?? false,
          pctCompleteToDate: l.pctCompleteToDate,
          requestedCents: l.requestedCents,
          verdict: r?.verdict ?? "ok",
          recommendedPctToDate: r?.recommendedPctToDate ?? 0,
          approvedCents: r?.approvedCents ?? 0,
          reason: r?.reason ?? "",
        };
      }),
      agreement: {
        _id: agreement._id,
        agreementNumber: agreement.agreementNumber,
        projectId: agreement.projectId,
        contractorId: agreement.contractorId,
        subcontractorName: agreement.subcontractorName,
        csiDivision: agreement.csiDivision,
        retainagePercent: retainagePercentFor(agreement),
      },
      contractor: {
        companyName: contractor?.companyName ?? agreement.subcontractorName,
        licenseNumber: contractor?.licenseNumber ?? "",
      },
      milestones: milestones.map((m) => ({
        milestoneId: m.milestoneId,
        name: m.name,
        order: m.order,
        status: m.status,
        funding: m.funding,
      })),
      latestLicense: latest ? { status: latest.status, checkedAt: latest.checkedAt } : null,
    };
  },
});

/** Starts an agent run: pending proposals from earlier runs on this pay app are superseded. */
export const beginAgentRun = internalMutation({
  args: { payAppId: v.id("payApplications"), runId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { payAppId, runId }) => {
    const payApp = await ctx.db.get(payAppId);
    if (payApp === null || payApp.status !== "reviewed") return false;
    const existing = await ctx.db
      .query("agentProposals")
      .withIndex("by_payAppId", (q) => q.eq("payAppId", payAppId))
      .take(200);
    const now = Date.now();
    for (const p of existing) {
      if (p.status !== "pending" || p.source === "gc_ledger") continue;
      await ctx.db.patch(p._id, { status: "cancelled", decidedAt: now, error: `Superseded by agent run ${runId}.` });
    }
    return true;
  },
});

const insertResult = v.union(
  v.object({ ok: v.literal(true), proposalId: v.id("agentProposals"), kind: v.string(), amountCents: v.optional(v.number()), flags: v.array(v.string()), duplicate: v.boolean() }),
  v.object({ ok: v.literal(false), reason: v.string() }),
);

async function auditProposal(ctx: MutationCtx, agreement: Doc<"agreements">, payApp: Doc<"payApplications">, p: { kind: string; amountCents?: number; source: string }) {
  await ctx.db.insert("auditLogs", {
    projectId: agreement.projectId,
    agreementId: agreement._id,
    eventType: "agent_proposal_created",
    title: `Pay agent proposed ${p.kind}`,
    description: `${agreement.agreementNumber} ${payApp.periodLabel}: ${p.kind}${p.amountCents !== undefined ? ` ${formatCents(p.amountCents)}` : ""} (pending GC approval; no money moved).`,
    actor: p.source === "code_policy" ? `${AGENT_ACTOR} (code policy)` : AGENT_ACTOR,
    timestamp: Date.now(),
    ...(await submitterAuditFields(ctx, payApp)),
  });
}

/**
 * The only write the propose* tools can make: one pending agentProposals row per kind per run.
 * Capture and payout amounts are the review's code-computed approved total; payouts require a
 * finished license check from this run and carry its status.
 */
export const insertAgentProposal = internalMutation({
  args: {
    payAppId: v.id("payApplications"),
    runId: v.string(),
    kind: PROPOSABLE_KINDS,
    rationale: v.string(),
    source: v.union(v.literal("agent"), v.literal("code_policy")),
    licenseCheckId: v.optional(v.id("licenseChecks")),
  },
  returns: insertResult,
  handler: async (ctx, args) => {
    const payApp = await ctx.db.get(args.payAppId);
    if (payApp === null) return { ok: false as const, reason: "Pay application not found." };
    if (payApp.status !== "reviewed") {
      return { ok: false as const, reason: `The pay application is ${payApp.status}; proposals are only made for reviewed pay applications.` };
    }
    const agreement = await ctx.db.get(payApp.agreementId);
    if (agreement === null) return { ok: false as const, reason: "Agreement not found." };

    const prior = await ctx.db
      .query("agentProposals")
      .withIndex("by_payAppId", (q) => q.eq("payAppId", args.payAppId))
      .take(200);
    const dup = prior.find((p) => p.agentRunId === args.runId && p.kind === args.kind);
    if (dup) {
      return { ok: true as const, proposalId: dup._id, kind: dup.kind, amountCents: dup.amountCents, flags: dup.flags, duplicate: true };
    }

    const check = args.licenseCheckId ? await ctx.db.get(args.licenseCheckId) : null;
    if (check !== null && check.contractorId !== agreement.contractorId) {
      return { ok: false as const, reason: "That license check belongs to another contractor." };
    }
    if (args.kind === "payout" && (check === null || check.phase === "running")) {
      return { ok: false as const, reason: "Run checkLicense first: a payout is only proposed after the CSLB license check finishes." };
    }
    const licenseStatus = toPlanLicense(check?.status ?? (await latestCompletedCheck(ctx, agreement.contractorId))?.status);
    const plan = await planFor(ctx, payApp, agreement, licenseStatus);
    if (plan === null) return { ok: false as const, reason: "The pay application has no stored review." };

    let amountCents: number | undefined;
    let flags: string[];
    let milestoneId: Id<"milestones"> | undefined;
    let rationale = args.rationale.trim().slice(0, 2000);
    if (args.kind === "capture") {
      if (plan.approvedTotalCents === 0) return { ok: false as const, reason: "The review approved nothing, so there is nothing to capture." };
      // Without a funded milestone the capture is still proposed (flagged); the GC funds one and the
      // milestone is resolved again when the proposal is approved.
      amountCents = plan.approvedTotalCents;
      milestoneId = (plan.captureMilestoneId ?? undefined) as Id<"milestones"> | undefined;
      flags = plan.captureFlags;
    } else if (args.kind === "payout") {
      if (plan.approvedTotalCents === 0) return { ok: false as const, reason: "The review approved nothing, so there is nothing to pay." };
      amountCents = plan.approvedTotalCents;
      milestoneId = (plan.captureMilestoneId ?? undefined) as Id<"milestones"> | undefined;
      flags = plan.payoutFlags;
      if (plan.licenseHold) rationale = `Held: the license is ${licenseStatus}. ${rationale}`.trim();
    } else if (args.kind === "hold") {
      flags = [...plan.reviewFlags, ...(plan.licenseHold ? ["license_hold"] : []), ...(plan.approvedTotalCents === 0 ? ["nothing_approved"] : [])];
      if (plan.holdReasons.length > 0) rationale = `${plan.holdReasons.join(" ")} ${rationale}`.trim();
    } else {
      flags = [...plan.reviewFlags];
    }
    if (rationale === "") rationale = `${args.kind} proposed by the pay agent.`;

    const proposalId = await ctx.db.insert("agentProposals", {
      payAppId: payApp._id,
      agreementId: agreement._id,
      milestoneId,
      kind: args.kind,
      amountCents,
      rationale,
      flags,
      status: "pending",
      source: args.source,
      agentRunId: args.runId,
      licenseStatus: licenseStatus,
      licenseCheckId: check?._id,
      createdAt: Date.now(),
    });
    await auditProposal(ctx, agreement, payApp, { kind: args.kind, amountCents, source: args.source });
    return { ok: true as const, proposalId, kind: args.kind as ProposableKind, amountCents, flags, duplicate: false };
  },
});

/** Proposal kinds the code policy requires for this pay app, and which of them this run already made. */
export const requiredProposalKinds = internalQuery({
  args: { payAppId: v.id("payApplications"), runId: v.string(), licenseCheckId: v.optional(v.id("licenseChecks")) },
  returns: v.object({ required: v.array(v.string()), made: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const payApp = await ctx.db.get(args.payAppId);
    if (payApp === null) return { required: [], made: [] };
    const agreement = await ctx.db.get(payApp.agreementId);
    if (agreement === null) return { required: [], made: [] };
    const check = args.licenseCheckId ? await ctx.db.get(args.licenseCheckId) : null;
    const plan = await planFor(ctx, payApp, agreement, toPlanLicense(check?.status));
    const made = (
      await ctx.db
        .query("agentProposals")
        .withIndex("by_payAppId", (q) => q.eq("payAppId", args.payAppId))
        .take(200)
    )
      .filter((p) => p.agentRunId === args.runId)
      .map((p) => p.kind);
    return { required: plan ? requiredKinds(plan) : [], made };
  },
});

/** Makes the review's license flag match the check the agent used (VAL-KERNEL-007). */
export const syncReviewLicense = internalMutation({
  args: { payAppId: v.id("payApplications"), checkId: v.id("licenseChecks") },
  returns: v.null(),
  handler: async (ctx, { payAppId, checkId }) => {
    const payApp = await ctx.db.get(payAppId);
    const check = await ctx.db.get(checkId);
    if (payApp === null || payApp.review === undefined || check === null || check.phase === "running") return null;
    const status = toPlanLicense(check.status) as Exclude<PlanLicenseStatus, "none">;
    const flags = payApp.review.flags;
    if (flags.licenseStatus === status && flags.licenseIssue === (status !== "active")) return null;
    await ctx.db.patch(payApp._id, {
      review: { ...payApp.review, flags: { ...flags, licenseStatus: status, licenseIssue: status !== "active" } },
    });
    return null;
  },
});

export const storeAgentTrace = internalMutation({
  args: {
    payAppId: v.id("payApplications"),
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
  returns: v.null(),
  handler: async (ctx, { payAppId, trace }) => {
    const now = Date.now();
    await ctx.db.insert("agentTraces", {
      ...trace,
      caseId: payAppId,
      groundTruth: null,
      status: trace.provider === "Anthropic" ? "AGENT_PROPOSED" : "AGENT_PROPOSED_OFFLINE",
      costUsd: 0,
      timestamp: now,
    });
    const payApp = await ctx.db.get(payAppId);
    const agreement = payApp ? await ctx.db.get(payApp.agreementId) : null;
    await ctx.db.insert("auditLogs", {
      projectId: agreement?.projectId,
      agreementId: payApp?.agreementId,
      eventType: "pay_agent_run",
      title: "Pay agent run",
      description: `${agreement?.agreementNumber ?? ""} ${payApp?.periodLabel ?? ""}: agent run ${trace.runId} (${trace.provider}${trace.model !== "none" ? ` ${trace.model}` : ""}) proposed actions for GC approval.`,
      actor: AGENT_ACTOR,
      timestamp: now,
      ...(await submitterAuditFields(ctx, payApp)),
    });
    return null;
  },
});
