import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { notify } from "../lib/notify";
import { auditActor, requireDocScope } from "../lib/projectScope";
import { notFound, type ProjectAccess } from "../lib/tenancy";
import { viewerAgentAuditFields } from "../lib/agentAudit";
import type { payAppDecisionValidator } from "../schema";
import { finalApprovalCaps } from "./billingHistory";
import { approvedG702Figures, payAppHash } from "./g703";

/**
 * The GC's decision on a submitted pay app (architecture §16, §22). Per line the GC accepts the review's
 * code-computed amount or overrides it with an amount and a required reason; any override makes the
 * result "approved as noted". The GC may instead ask the sub to revise lines, or reject the pay app with
 * a reason. Every outcome stores the G702 approved figures (nothing approved for a revision request or
 * a rejection), so the next application's previous values stay right. No money moves here: the approved
 * total flows to the pending capture/payout proposals, which the GC approves separately.
 */

export const OVERRIDE_REASON_REQUIRED = "A reason is required for an override";
export const REVISION_REASON_REQUIRED = "A reason is required for each line you ask the sub to revise";
export const REVISION_NEEDS_LINE = "Choose at least one line to revise, or give a reason for the revision";
export const REJECTION_REASON_REQUIRED = "A reason is required to reject a pay app";
export const MAX_DECISION_REASON_LENGTH = 500;

const DECIDABLE_BEFORE_REVIEW = new Set(["submitted", "under_review", "reviewed"]);

type Decision = Infer<typeof payAppDecisionValidator>;
type DecisionLine = Decision["lines"][number];

const lineDecisionArg = v.object({
  sovLineId: v.string(),
  action: v.union(v.literal("accept"), v.literal("override"), v.literal("revise")),
  amountCents: v.optional(v.number()),
  reason: v.optional(v.string()),
});

function invalid(message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "INVALID_DECISION", message });
}

function cleanReason(reason: string | undefined): string {
  const r = (reason ?? "").trim();
  if (r.length > MAX_DECISION_REASON_LENGTH) throw invalid(`A reason must be at most ${MAX_DECISION_REASON_LENGTH} characters.`);
  return r;
}

export function payAppName(p: Pick<Doc<"payApplications">, "applicationNo" | "periodLabel">): string {
  return p.applicationNo !== undefined ? `Pay app #${p.applicationNo}` : `Pay app "${p.periodLabel}"`;
}

async function pendingProposals(ctx: MutationCtx, payAppId: Id<"payApplications">) {
  const rows = await ctx.db
    .query("agentProposals")
    .withIndex("by_payAppId", (q) => q.eq("payAppId", payAppId))
    .take(200);
  return rows.filter((r) => r.status === "pending" && r.source !== "gc_ledger");
}

async function rejectPending(ctx: MutationCtx, payAppId: Id<"payApplications">, userId: Id<"users">): Promise<number> {
  const now = Date.now();
  const rows = await pendingProposals(ctx, payAppId);
  for (const r of rows) await ctx.db.patch(r._id, { status: "rejected", decidedBy: userId, decidedAt: now });
  return rows.length;
}

async function audit(
  ctx: MutationCtx,
  scope: ProjectAccess,
  payApp: Doc<"payApplications">,
  eventType: string,
  title: string,
  description: string,
) {
  const agreement = await ctx.db.get(payApp.agreementId);
  await ctx.db.insert("auditLogs", {
    projectId: agreement?.projectId,
    agreementId: payApp.agreementId,
    eventType,
    title,
    description: `${agreement?.agreementNumber ?? ""} ${description}`.trim().slice(0, 1000),
    ...auditActor(scope),
    timestamp: Date.now(),
    ...viewerAgentAuditFields(scope.viewer),
  });
}

async function notifySub(
  ctx: MutationCtx,
  payApp: Doc<"payApplications">,
  kind: "pay_app_approved" | "pay_app_revision_requested" | "pay_app_rejected",
  title: string,
  body: string,
) {
  const agreement = await ctx.db.get(payApp.agreementId);
  const target = payApp.subCompanyId ? { companyId: payApp.subCompanyId } : { userId: payApp.subUserId };
  await notify(ctx, target, { kind, title, body, link: payAppHash(payApp._id), projectId: agreement?.projectId });
}

/** Per billed line: the GC's action, the review's computed amount and what is approved. */
async function approvalLines(
  ctx: MutationCtx,
  payApp: Doc<"payApplications">,
  given: readonly Infer<typeof lineDecisionArg>[],
): Promise<DecisionLine[]> {
  const caps = await finalApprovalCaps(ctx, payApp);
  const known = new Set(caps.map((c) => c.sovLineId as string));
  const byId = new Map<string, Infer<typeof lineDecisionArg>>();
  for (const d of given) {
    if (!known.has(d.sovLineId)) throw invalid("A decision names a line that is not billed on this pay app.");
    if (byId.has(d.sovLineId)) throw invalid("A line appears more than once.");
    byId.set(d.sovLineId, d);
  }
  const recommended = new Map((payApp.review?.lines ?? []).map((l) => [l.sovLineId as string, l.approvedCents]));
  return caps.map((c) => {
    const d = byId.get(c.sovLineId);
    if (c.capCents < 0) {
      // A deductive change-order credit is applied in full; lowering it would overstate the payment.
      if (d !== undefined && d.action !== "accept") {
        throw invalid(`Line ${c.lineNo} is a deductive change-order credit of ${formatCents(c.capCents)}; it is applied in full and cannot be changed.`);
      }
      return { sovLineId: c.sovLineId, action: "accept" as const, recommendedCents: c.capCents, approvedCents: c.capCents };
    }
    const rec = Math.min(recommended.get(c.sovLineId) ?? 0, c.capCents);
    if (d === undefined || d.action === "accept") {
      return { sovLineId: c.sovLineId, action: "accept" as const, recommendedCents: rec, approvedCents: rec };
    }
    if (d.action === "revise") throw invalid(`Line ${c.lineNo}: use "Request revision" to send a line back to the sub.`);
    const reason = cleanReason(d.reason);
    if (reason === "") throw invalid(OVERRIDE_REASON_REQUIRED);
    const amount = d.amountCents;
    if (amount === undefined || !Number.isSafeInteger(amount)) throw invalid(`Line ${c.lineNo}: the approved amount must be whole cents.`);
    if (amount < 0) throw invalid(`Line ${c.lineNo}: the approved amount cannot be negative.`);
    if (c.excludedScope && amount > 0) throw invalid(`Line ${c.lineNo} is excluded scope and cannot be approved.`);
    if (amount > c.capCents) {
      throw invalid(
        `Line ${c.lineNo}: the approved amount cannot exceed ${formatCents(c.capCents)} (the amount requested, less what other pay apps hold on the line).`,
      );
    }
    return { sovLineId: c.sovLineId, action: "override" as const, recommendedCents: rec, approvedCents: amount, reason };
  });
}

async function approve(
  ctx: MutationCtx,
  scope: ProjectAccess & { doc: Doc<"payApplications"> },
  given: readonly Infer<typeof lineDecisionArg>[],
) {
  const payApp = scope.doc;
  if (payApp.status !== "reviewed" || payApp.review === undefined) {
    throw new ConvexError({
      code: "INVALID_STATE",
      message: `The pay application is ${payApp.status.replace(/_/g, " ")}; only reviewed pay applications can be approved.`,
    });
  }
  const lines = await approvalLines(ctx, payApp, given);
  const outcome = lines.some((l) => l.action === "override") ? ("approved_as_noted" as const) : ("approved" as const);
  const totalCents = lines.reduce((acc, l) => acc + l.approvedCents, 0);
  if (totalCents < 0) {
    throw invalid(
      `The deductive change-order credits exceed the work approved: the net approved would be ${formatCents(totalCents)}. Request a revision or reject the pay app.`,
    );
  }
  const now = Date.now();
  const finalLines = lines.map((l) => ({ sovLineId: l.sovLineId, approvedCents: l.approvedCents }));
  const figures = await approvedG702Figures(ctx, payApp, finalLines);
  await ctx.db.patch(payApp._id, {
    status: outcome,
    finalApproval: { totalCents, lines: finalLines, approvedBy: scope.viewer.userId, approvedAt: now },
    gcDecision: { outcome, lines, decidedBy: scope.viewer.userId, decidedAt: now },
    ...(payApp.g703 && figures ? { g703: { ...payApp.g703, approved: figures } } : {}),
  });

  // The approved total is what the pay agent's capture/payout pair pays; with nothing approved there is nothing to pay.
  const pending = await pendingProposals(ctx, payApp._id);
  let proposalsRejected = 0;
  for (const p of pending) {
    if (p.kind !== "capture" && p.kind !== "payout") continue;
    if (totalCents <= 0) {
      await ctx.db.patch(p._id, { status: "rejected", decidedBy: scope.viewer.userId, decidedAt: now });
      proposalsRejected += 1;
    } else {
      await ctx.db.patch(p._id, { editedAmountCents: totalCents === p.amountCents ? undefined : totalCents });
    }
  }

  const overrides = lines.filter((l) => l.action === "override");
  const name = payAppName(payApp);
  const label = outcome === "approved_as_noted" ? "approved as noted" : "approved";
  const due = figures?.currentPaymentDueCents ?? totalCents;
  await audit(
    ctx,
    scope,
    payApp,
    outcome === "approved_as_noted" ? "pay_app_approved_as_noted" : "pay_app_approved",
    outcome === "approved_as_noted" ? "Pay application approved as noted" : "Pay application approved",
    `${payApp.periodLabel}: GC ${label} ${formatCents(totalCents)} of ${formatCents(payApp.requestedTotalCents)} requested${
      overrides.length > 0 ? ` with ${overrides.length} line override(s)` : ""
    }; current payment due ${formatCents(due)}. No money moved.`,
  );
  await notifySub(
    ctx,
    payApp,
    "pay_app_approved",
    `${name} ${label}`,
    `${formatCents(due)} current payment due${overrides.length > 0 ? `; the GC changed ${overrides.length} line(s), see the reasons on the pay app` : ""}.`,
  );
  return { status: outcome, approvedTotalCents: totalCents, currentPaymentDueCents: due, proposalsRejected };
}

async function requestRevision(
  ctx: MutationCtx,
  scope: ProjectAccess & { doc: Doc<"payApplications"> },
  given: readonly Infer<typeof lineDecisionArg>[],
  overall: string,
) {
  const payApp = scope.doc;
  if (payApp.g703 === undefined) throw invalid("Only G702/G703 pay applications can be sent back for revision; reject this one instead.");
  if (!DECIDABLE_BEFORE_REVIEW.has(payApp.status)) {
    throw new ConvexError({ code: "INVALID_STATE", message: `The pay application is ${payApp.status.replace(/_/g, " ")} and can no longer be sent back.` });
  }
  const billed = new Set(payApp.lines.map((l) => l.sovLineId as string));
  const sheetLines = new Set(payApp.g703.lines.map((l) => l.sovLineId as string));
  const revise = new Map<string, string>();
  for (const d of given) {
    if (d.action !== "revise") continue;
    if (!sheetLines.has(d.sovLineId)) throw invalid("A decision names a line that is not on this pay app.");
    if (revise.has(d.sovLineId)) throw invalid("A line appears more than once.");
    const reason = cleanReason(d.reason);
    if (reason === "") throw invalid(REVISION_REASON_REQUIRED);
    revise.set(d.sovLineId, reason);
  }
  if (revise.size === 0 && overall === "") throw invalid(REVISION_NEEDS_LINE);
  const recommended = new Map((payApp.review?.lines ?? []).map((l) => [l.sovLineId as string, l.approvedCents]));
  const lines: DecisionLine[] = payApp.g703.lines
    .filter((l) => billed.has(l.sovLineId) || revise.has(l.sovLineId))
    .map((l) => {
      const reason = revise.get(l.sovLineId);
      return {
        sovLineId: l.sovLineId,
        action: reason !== undefined ? ("revise" as const) : ("accept" as const),
        recommendedCents: recommended.get(l.sovLineId) ?? 0,
        approvedCents: 0,
        ...(reason !== undefined ? { reason } : {}),
      };
    });
  const now = Date.now();
  const figures = await approvedG702Figures(ctx, payApp, []);
  await ctx.db.patch(payApp._id, {
    status: "revision_requested",
    finalApproval: undefined,
    gcDecision: {
      outcome: "revision_requested",
      ...(overall !== "" ? { reason: overall } : {}),
      lines,
      decidedBy: scope.viewer.userId,
      decidedAt: now,
    },
    ...(figures ? { g703: { ...payApp.g703, approved: figures } } : {}),
  });
  const cancelled = await rejectPending(ctx, payApp._id, scope.viewer.userId);
  const name = payAppName(payApp);
  const firstReason = [...revise.values()][0] ?? overall;
  await audit(
    ctx,
    scope,
    payApp,
    "pay_app_revision_requested",
    "Pay application revision requested",
    `${payApp.periodLabel} (version ${payApp.version ?? 1}): GC asked for a revision on ${revise.size} line(s): ${firstReason}. ${cancelled} pending proposal(s) rejected; no money moved.`,
  );
  await notifySub(ctx, payApp, "pay_app_revision_requested", `Revision requested on ${name}`, `${firstReason}. Open the pay app to revise and resubmit it.`);
  return { status: "revision_requested" as const, proposalsRejected: cancelled };
}

async function reject(ctx: MutationCtx, scope: ProjectAccess & { doc: Doc<"payApplications"> }, reason: string) {
  const payApp = scope.doc;
  if (reason === "") throw invalid(REJECTION_REASON_REQUIRED);
  if (!DECIDABLE_BEFORE_REVIEW.has(payApp.status)) {
    throw new ConvexError({ code: "INVALID_STATE", message: `The pay application is ${payApp.status.replace(/_/g, " ")} and can no longer be rejected.` });
  }
  const now = Date.now();
  const figures = await approvedG702Figures(ctx, payApp, []);
  await ctx.db.patch(payApp._id, {
    status: "rejected",
    rejectedAt: now,
    rejectionReason: reason,
    finalApproval: undefined,
    gcDecision: { outcome: "rejected", reason, lines: [], decidedBy: scope.viewer.userId, decidedAt: now },
    ...(payApp.g703 && figures ? { g703: { ...payApp.g703, approved: figures } } : {}),
  });
  const cancelled = await rejectPending(ctx, payApp._id, scope.viewer.userId);
  await audit(
    ctx,
    scope,
    payApp,
    "pay_app_rejected",
    "Pay application rejected",
    `${payApp.periodLabel}: GC rejected the pay application (${reason}) and ${cancelled} pending proposal(s); no money moved.`,
  );
  await notifySub(ctx, payApp, "pay_app_rejected", `${payAppName(payApp)} rejected`, `Reason: ${reason}`);
  return { status: "rejected" as const, proposalsRejected: cancelled };
}

/**
 * The GC decides a submitted pay app: approve (accepting or overriding each line), request a revision
 * of named lines, or reject. GC of the project only; subs, owners and other companies get "Not found.".
 */
export const decidePayApp = mutation({
  args: {
    payAppId: v.string(),
    decision: v.union(v.literal("approve"), v.literal("request_revision"), v.literal("reject")),
    lines: v.optional(v.array(lineDecisionArg)),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["gc"], write: true });
    if (scope.doc.status === "draft") throw notFound();
    const lines = args.lines ?? [];
    if (lines.length > 500) throw invalid("Too many line decisions.");
    if (args.decision === "approve") return await approve(ctx, scope, lines);
    if (args.decision === "request_revision") return await requestRevision(ctx, scope, lines, cleanReason(args.reason));
    return await reject(ctx, scope, cleanReason(args.reason));
  },
});

/**
 * The filing sub reopens a pay app the GC sent back as a draft for its next version. The submitted
 * version, with the GC's decision, is kept unchanged in `versions`.
 */
export const revisePayApp = mutation({
  args: { payAppId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["sub"], write: true });
    const payApp = scope.doc;
    if (payApp.g703 === undefined) throw notFound();
    if (payApp.status !== "revision_requested") {
      throw new ConvexError({ code: "INVALID_STATE", message: "Only a pay app the GC sent back for revision can be revised." });
    }
    const version = payApp.version ?? 1;
    const { approved: _approved, ...g703 } = payApp.g703;
    const now = Date.now();
    await ctx.db.patch(payApp._id, {
      status: "draft",
      version: version + 1,
      versions: [
        ...(payApp.versions ?? []),
        {
          version,
          submittedAt: payApp.submittedAt ?? payApp.createdAt,
          requestedTotalCents: payApp.requestedTotalCents,
          notes: payApp.notes,
          lines: payApp.g703.lines,
          ...(payApp.g703.requested ? { requested: payApp.g703.requested } : {}),
          ...(payApp.gcDecision ? { decision: payApp.gcDecision } : {}),
        },
      ],
      gcDecision: undefined,
      finalApproval: undefined,
      review: undefined,
      reviewRunId: undefined,
      g703: { ...g703, savedAt: now },
    });
    await audit(ctx, scope, payApp, "pay_app_revision_started", "Pay application revision started", `${payApp.periodLabel}: version ${version + 1} opened as a draft; version ${version} kept.`);
    return { payAppId: payApp._id, version: version + 1 };
  },
});
