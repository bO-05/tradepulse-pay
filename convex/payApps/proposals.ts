import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { requireRole } from "../lib/roles";
import { latestCompletedCheck } from "../kernel/licenseChecks";
import { milestonePlanRows } from "../agent/proposalDb";
import { checkEditedAmount, chooseCaptureMilestone, effectiveAmount } from "../agent/proposalMath";
import { startRelease } from "../payments/release";
import { computePayoutSplit, isValidRequestKey, remainingAuthorizedCents, retainagePercentFor } from "../payments/payoutMath";
import { finishProposal, syncProposalForPayment } from "./proposalSync";
import { allocateFinalApproval } from "./billingHistory";
import { payAppView, sovMapFor } from "./review";

/**
 * GC approval inbox (architecture §7). The pay agent only creates pending proposals; money moves
 * when the GC approves a capture/payout pair here, which schedules the p2 capture + payout. Every
 * function is GC-only: subs, their billing agents and owners are refused by requireRole.
 */

const MONEY_KINDS = new Set(["capture", "payout"]);
const INBOX_STATUSES = ["submitted", "under_review", "reviewed", "approved", "paid", "rejected"] as const;

function notPending(p: Doc<"agentProposals">): ConvexError<{ code: string; message: string }> {
  const why =
    p.status === "rejected"
      ? "This proposal was rejected; it can no longer be approved or edited."
      : p.status === "cancelled"
        ? "This proposal was superseded by a newer agent run."
        : `This proposal is already ${p.status}.`;
  return new ConvexError({ code: "INVALID_STATE", message: why });
}

async function loadProposal(ctx: MutationCtx, proposalId: string): Promise<Doc<"agentProposals">> {
  const id = ctx.db.normalizeId("agentProposals", proposalId);
  const p = id === null ? null : await ctx.db.get(id);
  if (p === null) throw new ConvexError({ code: "NOT_FOUND", message: "Proposal not found." });
  return p;
}

async function payAppProposals(ctx: MutationCtx, payAppId: Id<"payApplications">) {
  return await ctx.db
    .query("agentProposals")
    .withIndex("by_payAppId", (q) => q.eq("payAppId", payAppId))
    .take(200);
}

/** The pending capture and payout proposals from the same agent run as `p`. */
async function moneyPair(ctx: MutationCtx, p: Doc<"agentProposals">) {
  if (p.payAppId === undefined) return { capture: undefined, payout: p.kind === "payout" ? p : undefined };
  const all = await payAppProposals(ctx, p.payAppId);
  const sameRun = all.filter((x) => x.agentRunId === p.agentRunId && x.status === "pending");
  return { capture: sameRun.find((x) => x.kind === "capture"), payout: sameRun.find((x) => x.kind === "payout") };
}

const MAX_REJECTION_REASON_LENGTH = 500;

function rejectionReason(given: string | undefined, fallback: string): string {
  const trimmed = (given ?? "").trim().slice(0, MAX_REJECTION_REASON_LENGTH);
  return trimmed === "" ? fallback : trimmed;
}

/** The final per-line split of an approved total, or a readable INVALID_AMOUNT error. */
async function finalAllocation(ctx: MutationCtx, payApp: Doc<"payApplications">, amountCents: number) {
  const result = await allocateFinalApproval(ctx, payApp, amountCents);
  if (!result.ok) throw new ConvexError({ code: "INVALID_AMOUNT", message: result.message });
  return result.lines.map((l) => ({ sovLineId: l.sovLineId as Id<"scheduleOfValues">, approvedCents: l.approvedCents }));
}

/**
 * Once a reviewed pay app has no pending proposal left and no approved payment, it is finalized as
 * rejected so it stops reserving scheduled value. Moves no money.
 */
async function finalizeIfNothingActionable(
  ctx: MutationCtx,
  payAppId: Id<"payApplications">,
  reason: string,
  actor: string,
): Promise<boolean> {
  const payApp = await ctx.db.get(payAppId);
  if (payApp === null || payApp.status !== "reviewed") return false;
  const rows = (await payAppProposals(ctx, payAppId)).filter((r) => r.status !== "cancelled");
  if (rows.some((r) => r.status === "pending")) return false;
  if (rows.some((r) => MONEY_KINDS.has(r.kind) && (r.status === "approved" || r.status === "executed"))) return false;
  await ctx.db.patch(payApp._id, { status: "rejected", rejectedAt: Date.now(), rejectionReason: reason });
  await audit(
    ctx,
    payApp.agreementId,
    "pay_app_rejected",
    "Pay application rejected",
    `${payApp.periodLabel}: no actionable proposals remain (${reason}); no money moved.`,
    actor,
  );
  return true;
}

async function audit(
  ctx: MutationCtx,
  agreementId: Id<"agreements">,
  eventType: string,
  title: string,
  description: string,
  actor: string,
) {
  const agreement = await ctx.db.get(agreementId);
  await ctx.db.insert("auditLogs", {
    projectId: agreement?.projectId,
    agreementId,
    eventType,
    title,
    description: `${agreement?.agreementNumber ?? ""} ${description}`.trim().slice(0, 1000),
    actor,
    timestamp: Date.now(),
  });
}

/** Every pay application awaiting or past GC decision, with its review, proposals and attribution. */
export const listInbox = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc"]);
    const payApps: Doc<"payApplications">[] = [];
    for (const status of INBOX_STATUSES) {
      const rows = await ctx.db
        .query("payApplications")
        .withIndex("by_status", (q) => q.eq("status", status))
        .order("desc")
        .take(50);
      payApps.push(...rows);
    }
    payApps.sort((a, b) => b.createdAt - a.createdAt);
    const sovCache = new Map<string, Awaited<ReturnType<typeof sovMapFor>>>();
    const items = [];
    for (const p of payApps.slice(0, 60)) {
      const agreement = await ctx.db.get(p.agreementId);
      if (agreement === null) continue;
      let sov = sovCache.get(agreement._id);
      if (sov === undefined) {
        sov = await sovMapFor(ctx, agreement._id);
        sovCache.set(agreement._id, sov);
      }
      const contractor = await ctx.db.get(agreement.contractorId);
      const proposals = await ctx.db
        .query("agentProposals")
        .withIndex("by_payAppId", (q) => q.eq("payAppId", p._id))
        .take(200);
      const milestoneNames = new Map<string, string>();
      for (const pr of proposals) {
        if (pr.milestoneId && !milestoneNames.has(pr.milestoneId)) {
          milestoneNames.set(pr.milestoneId, (await ctx.db.get(pr.milestoneId))?.name ?? "Milestone");
        }
      }
      const payment = proposals.find((pr) => pr.kind === "payout" && pr.paymentId)?.paymentId;
      const paymentRow = payment ? await ctx.db.get(payment) : null;
      const license = await latestCompletedCheck(ctx, agreement.contractorId);
      items.push({
        payApp: await payAppView(ctx, p, sov),
        agreement: {
          _id: agreement._id,
          agreementNumber: agreement.agreementNumber,
          projectTitle: agreement.projectTitle,
          subcontractorName: agreement.subcontractorName,
          contractorId: agreement.contractorId,
          retainagePercent: retainagePercentFor(agreement),
        },
        contractor: { companyName: contractor?.companyName ?? agreement.subcontractorName, licenseNumber: contractor?.licenseNumber ?? "" },
        license: license ? { status: license.status, checkedAt: license.checkedAt, checkId: license._id } : null,
        proposals: proposals
          .filter((pr) => pr.status !== "cancelled" && pr.source !== "gc_ledger")
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((pr) => {
            const amount = effectiveAmount(pr);
            return {
              _id: pr._id,
              kind: pr.kind,
              status: pr.status,
              source: pr.source ?? "agent",
              amountCents: pr.amountCents ?? null,
              editedAmountCents: pr.editedAmountCents ?? null,
              split:
                amount !== undefined && MONEY_KINDS.has(pr.kind) ? computePayoutSplit(amount, retainagePercentFor(agreement)) : null,
              rationale: pr.rationale,
              flags: pr.flags,
              licenseStatus: pr.licenseStatus ?? null,
              milestoneName: pr.milestoneId ? (milestoneNames.get(pr.milestoneId) ?? null) : null,
              decidedAt: pr.decidedAt ?? null,
              executedAt: pr.executedAt ?? null,
              paypalCaptureId: pr.paypalCaptureId ?? null,
              error: pr.error ?? null,
              overrideLicenseHold: pr.overrideLicenseHold ?? false,
              createdAt: pr.createdAt,
            };
          }),
        payment: paymentRow
          ? {
              status: paymentRow.status,
              grossCents: paymentRow.grossCents,
              retainageCents: paymentRow.retainageCents,
              netCents: paymentRow.netCents,
              batchId: paymentRow.paypalPayoutBatchId ?? null,
              receiverEmail: paymentRow.receiverEmail ?? null,
              error: paymentRow.error ?? null,
            }
          : null,
      });
    }
    return items;
  },
});

/** The latest pay-agent trace for a pay app (secret-free by construction; see agent/tools.ts). */
export const getAgentTrace = query({
  args: { payAppId: v.string() },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const rows = await ctx.db
      .query("agentTraces")
      .withIndex("by_caseId", (q) => q.eq("caseId", args.payAppId))
      .order("desc")
      .take(20);
    const t = rows.find((r) => r.status.startsWith("AGENT_PROPOSED"));
    if (!t) return null;
    return {
      runId: t.runId,
      provider: t.provider,
      model: t.model,
      status: t.status,
      rawPrompt: t.rawPrompt,
      rawResponse: t.rawResponse,
      parsedOutput: t.parsedOutput,
      metrics: t.metrics,
      latencyMs: t.latencyMs,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      timestamp: t.timestamp,
    };
  },
});

/**
 * Approves a proposal. A capture or payout approves its pair from the same run (the capture pays for
 * the payout) and schedules execution; a hold or reschedule is recorded with no money moved.
 * A payout held for the license needs `overrideLicenseHold`.
 */
export const approveProposal = mutation({
  args: { proposalId: v.string(), overrideLicenseHold: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["gc"]);
    const p = await loadProposal(ctx, args.proposalId);
    if (p.status !== "pending") throw notPending(p);
    const payApp = p.payAppId ? await ctx.db.get(p.payAppId) : null;
    if (payApp === null) throw new ConvexError({ code: "NOT_FOUND", message: "Pay application not found." });
    if (payApp.status !== "reviewed") {
      throw new ConvexError({ code: "INVALID_STATE", message: `The pay application is ${payApp.status}; only reviewed pay applications can be approved.` });
    }
    const actor = viewer.user.email ?? `user:${viewer.userId}`;
    const now = Date.now();

    if (!MONEY_KINDS.has(p.kind)) {
      await ctx.db.patch(p._id, { status: "approved", decidedBy: viewer.userId, decidedAt: now });
      await finishProposal(ctx, { ...p, status: "approved" }, "executed", {
        detail: `${p.kind} accepted by the GC; no money moved.`,
      });
      await finalizeIfNothingActionable(ctx, payApp._id, `The GC accepted the ${p.kind}; no payment was approved.`, actor);
      return { scheduled: false };
    }

    const { capture, payout } = await moneyPair(ctx, p);
    if (payout === undefined) {
      throw new ConvexError({ code: "INVALID_STATE", message: "This capture has no matching payout proposal to approve with it." });
    }
    if (payout.flags.includes("license_hold") && args.overrideLicenseHold !== true) {
      throw new ConvexError({
        code: "LICENSE_HOLD",
        message: `The payout is held because the contractor's license is ${payout.licenseStatus ?? "not verified as active"}. Run a new license check, or approve with the license-hold override.`,
      });
    }
    const amountCents = effectiveAmount(payout) ?? 0;
    if (amountCents <= 0) throw new ConvexError({ code: "INVALID_AMOUNT", message: "The proposal has no amount to pay." });
    const finalLines = await finalAllocation(ctx, payApp, amountCents);

    const rows = await milestonePlanRows(ctx, payApp.agreementId);
    const preferred = rows.find(
      (m) =>
        m.milestoneId === (payout.milestoneId ?? capture?.milestoneId) &&
        m.funding !== null &&
        ["authorized", "partially_captured"].includes(m.funding.status) &&
        remainingAuthorizedCents(m.funding) >= amountCents,
    );
    const billed = finalLines.filter((l) => l.approvedCents > 0).map((l) => l.sovLineId as string);
    const milestone = preferred ?? chooseCaptureMilestone(rows, billed, amountCents);
    if (milestone === null) {
      throw new ConvexError({
        code: "NOT_FUNDED",
        message: `No funded milestone has ${formatCents(amountCents)} authorized and uncaptured. Fund a milestone (or edit the amount down) before approving.`,
      });
    }
    const milestoneId = milestone.milestoneId as Id<"milestones">;
    const decision = {
      status: "approved" as const,
      decidedBy: viewer.userId,
      decidedAt: now,
      milestoneId,
      ...(args.overrideLicenseHold ? { overrideLicenseHold: true } : {}),
    };
    await ctx.db.patch(payout._id, decision);
    if (capture) await ctx.db.patch(capture._id, decision);
    await ctx.db.patch(payApp._id, {
      status: "approved",
      finalApproval: { totalCents: amountCents, lines: finalLines, approvedBy: viewer.userId, approvedAt: now },
    });
    await audit(
      ctx,
      payApp.agreementId,
      "proposal_approved",
      "Proposal approved",
      `${payApp.periodLabel}: GC approved capture + payout of ${formatCents(amountCents)} from ${milestone.name}${
        payout.editedAmountCents !== undefined ? ` (edited from ${formatCents(payout.amountCents ?? 0)})` : ""
      }${args.overrideLicenseHold ? "; license hold overridden by the GC" : ""}.`,
      actor,
    );
    await ctx.scheduler.runAfter(0, internal.payApps.proposals.executeApproved, {
      payoutProposalId: payout._id,
      milestoneId,
      amountCents,
      actor,
    });
    return { scheduled: true };
  },
});

/** Changes the amount of a pending capture/payout pair before approval. The original stays for audit. */
export const editProposal = mutation({
  args: { proposalId: v.string(), amountCents: v.number() },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["gc"]);
    const p = await loadProposal(ctx, args.proposalId);
    if (p.status !== "pending") throw notPending(p);
    if (!MONEY_KINDS.has(p.kind)) throw new ConvexError({ code: "INVALID_STATE", message: "Only capture and payout amounts can be edited." });
    const payApp = p.payAppId ? await ctx.db.get(p.payAppId) : null;
    if (payApp === null) throw new ConvexError({ code: "NOT_FOUND", message: "Pay application not found." });
    const check = checkEditedAmount(args.amountCents, payApp.requestedTotalCents);
    if (!check.ok) throw new ConvexError({ code: "INVALID_AMOUNT", message: check.message });
    await finalAllocation(ctx, payApp, check.amountCents);
    const { capture, payout } = await moneyPair(ctx, p);
    for (const row of [capture, payout]) {
      if (row) await ctx.db.patch(row._id, { editedAmountCents: check.amountCents });
    }
    await audit(
      ctx,
      p.agreementId,
      "proposal_edited",
      "Proposal amount edited",
      `${payApp.periodLabel}: GC changed the capture/payout amount from ${formatCents(p.amountCents ?? 0)} to ${formatCents(check.amountCents)}.`,
      viewer.user.email ?? `user:${viewer.userId}`,
    );
    return { editedAmountCents: check.amountCents };
  },
});

async function rejectRows(ctx: MutationCtx, rows: Doc<"agentProposals">[], userId: Id<"users">) {
  const now = Date.now();
  for (const r of rows) await ctx.db.patch(r._id, { status: "rejected", decidedBy: userId, decidedAt: now });
}

/**
 * Rejects a proposal (a capture or payout rejects its pair). Nothing moves. When no actionable
 * proposal is left, the pay app is finalized as rejected with the reason.
 */
export const rejectProposal = mutation({
  args: { proposalId: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["gc"]);
    const p = await loadProposal(ctx, args.proposalId);
    if (p.status !== "pending") throw notPending(p);
    const rows = MONEY_KINDS.has(p.kind) ? Object.values(await moneyPair(ctx, p)).filter((r) => r !== undefined) : [p];
    await rejectRows(ctx, rows, viewer.userId);
    const actor = viewer.user.email ?? `user:${viewer.userId}`;
    const kinds = rows.map((r) => r.kind).join(" + ");
    await audit(ctx, p.agreementId, "proposal_rejected", "Proposal rejected", `GC rejected the ${kinds} proposal; no money moved.`, actor);
    const payAppRejected = p.payAppId
      ? await finalizeIfNothingActionable(ctx, p.payAppId, rejectionReason(args.reason, `The GC rejected the ${kinds} proposal.`), actor)
      : false;
    return { rejected: rows.length, payAppRejected };
  },
});

/** Rejects a reviewed pay application and all its pending proposals. Nothing moves. */
export const rejectPayApp = mutation({
  args: { payAppId: v.string(), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["gc"]);
    const id = ctx.db.normalizeId("payApplications", args.payAppId);
    const payApp = id === null ? null : await ctx.db.get(id);
    if (payApp === null) throw new ConvexError({ code: "NOT_FOUND", message: "Pay application not found." });
    if (!["submitted", "under_review", "reviewed"].includes(payApp.status)) {
      throw new ConvexError({ code: "INVALID_STATE", message: `The pay application is ${payApp.status} and can no longer be rejected.` });
    }
    const pending = (await payAppProposals(ctx, payApp._id)).filter((r) => r.status === "pending");
    await rejectRows(ctx, pending, viewer.userId);
    await ctx.db.patch(payApp._id, {
      status: "rejected",
      rejectedAt: Date.now(),
      rejectionReason: rejectionReason(args.reason, "The GC rejected the pay application."),
    });
    await audit(
      ctx,
      payApp.agreementId,
      "pay_app_rejected",
      "Pay application rejected",
      `${payApp.periodLabel}: GC rejected the pay application and ${pending.length} pending proposal(s); no money moved.`,
      viewer.user.email ?? `user:${viewer.userId}`,
    );
    return { rejected: pending.length };
  },
});

export const proposalRow = internalQuery({
  args: { proposalId: v.id("agentProposals") },
  handler: async (ctx, { proposalId }) => await ctx.db.get(proposalId),
});

/** Runs the p2 capture + payout for an approved payout proposal. */
export const executeApproved = internalAction({
  args: { payoutProposalId: v.id("agentProposals"), milestoneId: v.id("milestones"), amountCents: v.number(), actor: v.string() },
  handler: async (ctx, args) => {
    const proposal: Doc<"agentProposals"> | null = await ctx.runQuery(internal.payApps.proposals.proposalRow, {
      proposalId: args.payoutProposalId,
    });
    if (proposal === null || proposal.status !== "approved") return null;
    const requestKey = `prop_${args.payoutProposalId}`;
    try {
      await startRelease(ctx, {
        milestoneId: args.milestoneId,
        amountCents: args.amountCents,
        requestKey,
        actor: args.actor,
        payAppId: proposal.payAppId,
        proposalId: args.payoutProposalId,
      });
      await ctx.runMutation(internal.payApps.proposals.settleProposalExecution, { proposalId: args.payoutProposalId, requestKey });
    } catch (e) {
      const message = e instanceof ConvexError ? String((e.data as { message?: string }).message ?? "Release failed.") : e instanceof Error ? e.message : "Release failed.";
      await ctx.runMutation(internal.payApps.proposals.settleProposalExecution, {
        proposalId: args.payoutProposalId,
        requestKey,
        error: message.slice(0, 500),
      });
    }
    return null;
  },
});

/**
 * After a release attempt: sync the proposals with the release payment, or fail them when no
 * payment for this proposal was created (refused before capture, or another release was in flight).
 */
export const settleProposalExecution = internalMutation({
  args: { proposalId: v.id("agentProposals"), requestKey: v.string(), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", `pay_${args.requestKey}`))
      .first();
    if (payment !== null && payment.proposalId === args.proposalId) {
      await ctx.db.patch(args.proposalId, { paymentId: payment._id });
      if (args.error && payment.status === "created" && !payment.paypalPayoutBatchId) {
        // The action threw after the payment was created (e.g. a PayPal error); the payment writers
        // have already failed it if PayPal refused, otherwise "Retry release" resumes it.
        await ctx.db.patch(args.proposalId, { error: args.error });
      }
      await syncProposalForPayment(ctx, payment._id);
      return null;
    }
    const proposal = await ctx.db.get(args.proposalId);
    if (proposal === null || proposal.status !== "approved") return null;
    const error = args.error ?? "Another release for this milestone was already in progress, so this one did not start.";
    await finishProposal(ctx, proposal, "failed", { error });
    if (proposal.payAppId) {
      const capture = (await payAppProposals(ctx, proposal.payAppId)).find(
        (r) => r.kind === "capture" && r.status === "approved" && r.agentRunId === proposal.agentRunId,
      );
      if (capture) await finishProposal(ctx, capture, "failed", { error });
    }
    return null;
  },
});

/** The agreement ledger's "Release & pay" recorded as a GC-approved payout proposal. */
export const ledgerReleaseProposal = internalMutation({
  args: { milestoneId: v.id("milestones"), amountCents: v.number(), requestKey: v.string(), userId: v.id("users") },
  returns: v.id("agentProposals"),
  handler: async (ctx, args) => {
    if (!isValidRequestKey(args.requestKey)) throw new ConvexError({ code: "INVALID_REQUEST", message: "Invalid release request key." });
    const existing = await ctx.db
      .query("payments")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", `pay_${args.requestKey}`))
      .first();
    if (existing?.proposalId) return existing.proposalId;
    const milestone = await ctx.db.get(args.milestoneId);
    if (milestone === null) throw new ConvexError({ code: "NOT_FOUND", message: "Milestone not found." });
    const runId = `ledger_${args.requestKey}`;
    const prior = await ctx.db
      .query("agentProposals")
      .withIndex("by_agreementId_and_status", (q) => q.eq("agreementId", milestone.agreementId).eq("status", "approved"))
      .take(200);
    const same = prior.find((p) => p.agentRunId === runId);
    if (same) return same._id;
    const now = Date.now();
    return await ctx.db.insert("agentProposals", {
      agreementId: milestone.agreementId,
      milestoneId: milestone._id,
      kind: "payout",
      amountCents: args.amountCents,
      rationale: `Released by the GC from the agreement ledger (${milestone.name}).`,
      flags: [],
      status: "approved",
      source: "gc_ledger",
      agentRunId: runId,
      decidedBy: args.userId,
      decidedAt: now,
      createdAt: now,
    });
  },
});
