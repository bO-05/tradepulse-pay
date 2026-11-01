import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalMutation, type MutationCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { requireProjectScopeInAction } from "../lib/tenancyAction";
import { startRelease } from "../payments/release";
import type { FundingSource, PayFigures, PayGate } from "./payGate";
import { cannotPay, payGateForMutation } from "./payGateDb";

/**
 * Paying an approved pay app (architecture §16): the GC's "Pay <sub>" on the pay app's Payment panel.
 * canPay is evaluated inside the mutation that approves the payment and again where the payout row is
 * created, so no path moves money while any condition is unmet. Capture gross from a funded tranche,
 * pay the sub the approved current payment due; retainage is the approved per-line retainage.
 */

/** The tranche to capture from: the GC's choice when it covers the gross, else the first tranche that does. */
export function chooseFundingSource(gate: PayGate, preferred: Id<"milestones"> | undefined): FundingSource | null {
  if (gate.figures === null) return null;
  const gross = gate.figures.grossCents;
  if (preferred !== undefined) {
    const chosen = gate.sources.find((s) => s.milestoneId === preferred);
    if (chosen !== undefined && chosen.availableCents >= gross) return chosen;
  }
  return gate.tranche;
}

/** Payout rows that ended without paying; a failure after capture is still blocked by canPay (retry instead). */
const SETTLED_UNPAID: ReadonlySet<string> = new Set(["failed", "returned"]);

async function payoutProposals(ctx: MutationCtx, payAppId: Id<"payApplications">) {
  const rows = await ctx.db
    .query("agentProposals")
    .withIndex("by_payAppId", (q) => q.eq("payAppId", payAppId))
    .take(200);
  return rows;
}

const preparedValidator = v.object({
  proposalId: v.id("agentProposals"),
  milestoneId: v.id("milestones"),
  amountCents: v.number(),
  actor: v.string(),
});

/**
 * Approves the payment of one pay app: re-uses a payment approved a moment ago (double click), else
 * checks canPay, supersedes any pending agent proposal and records the GC's approved payout proposal.
 */
export const preparePayAppPayment = internalMutation({
  args: {
    payAppId: v.id("payApplications"),
    userId: v.id("users"),
    actor: v.string(),
    trancheId: v.optional(v.id("milestones")),
  },
  returns: preparedValidator,
  handler: async (ctx, args) => {
    const payApp = await ctx.db.get(args.payAppId);
    if (payApp === null) throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });
    const agreement = await ctx.db.get(payApp.agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });

    const proposals = await payoutProposals(ctx, payApp._id);
    for (const p of proposals) {
      if (p.kind !== "payout" || (p.status !== "approved" && p.status !== "executed") || p.milestoneId === undefined) continue;
      const payment = p.paymentId ? await ctx.db.get(p.paymentId) : null;
      if (payment !== null && SETTLED_UNPAID.has(payment.status)) continue;
      // Already approved or paid: resume that payment (same request key) instead of starting another.
      return {
        proposalId: p._id,
        milestoneId: p.milestoneId,
        amountCents: payment?.grossCents ?? payApp.finalApproval?.totalCents ?? p.editedAmountCents ?? p.amountCents ?? 0,
        actor: args.actor,
      };
    }

    const gate = await payGateForMutation(ctx, payApp, agreement);
    if (!gate.ok) throw cannotPay(gate.reasons);
    const figures = gate.figures as PayFigures;
    const source = chooseFundingSource(gate, args.trancheId);
    if (source === null) throw cannotPay(gate.reasons);

    const now = Date.now();
    for (const p of proposals) {
      if (p.status === "pending" && (p.kind === "capture" || p.kind === "payout")) {
        await ctx.db.patch(p._id, { status: "cancelled", decidedBy: args.userId, decidedAt: now, error: "Superseded: the GC paid the approved pay app." });
      }
    }
    const proposalId = await ctx.db.insert("agentProposals", {
      payAppId: payApp._id,
      agreementId: agreement._id,
      milestoneId: source.milestoneId,
      kind: "payout",
      amountCents: figures.grossCents,
      rationale: `Paid by the GC from the approved pay app (${source.name}).`,
      flags: [],
      status: "approved",
      source: "gc_payapp",
      decidedBy: args.userId,
      decidedAt: now,
      createdAt: now,
    });
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      agreementId: agreement._id,
      eventType: "pay_app_payment_approved",
      title: "Pay app payment approved",
      description: `${agreement.agreementNumber} ${payApp.applicationNo !== undefined ? `Pay app #${payApp.applicationNo}` : payApp.periodLabel}: GC approved paying ${
        agreement.subcontractorName
      } ${formatCents(figures.netCents)} (gross ${formatCents(figures.grossCents)}, retainage ${formatCents(figures.retainageCents)}) from ${source.name} to ${gate.payeeEmail}.`.slice(0, 1000),
      actor: args.actor,
      actorUserId: args.userId,
      timestamp: now,
    });
    return { proposalId, milestoneId: source.milestoneId, amountCents: figures.grossCents, actor: args.actor };
  },
});

const payResult = v.object({
  state: v.union(v.literal("paid"), v.literal("pending"), v.literal("already_processed"), v.literal("busy")),
  paymentId: v.id("payments"),
  status: v.string(),
  message: v.optional(v.string()),
  captureId: v.optional(v.string()),
  batchId: v.optional(v.string()),
});

/** GC only: captures the approved gross from a funded tranche and pays the sub's confirmed payee the net. */
export const payPayApp = action({
  args: { payAppId: v.id("payApplications"), trancheId: v.optional(v.id("milestones")) },
  returns: payResult,
  handler: async (ctx, args) => {
    const scope = await requireProjectScopeInAction(ctx, { docs: [{ table: "payApplications", id: args.payAppId }] }, { roles: ["gc"], write: true });
    const prepared: { proposalId: Id<"agentProposals">; milestoneId: Id<"milestones">; amountCents: number; actor: string } = await ctx.runMutation(
      internal.billing.pay.preparePayAppPayment,
      { payAppId: args.payAppId, userId: scope.userId, actor: scope.actor, trancheId: args.trancheId },
    );
    const requestKey = `prop_${prepared.proposalId}`;
    try {
      const result = await startRelease(ctx, {
        milestoneId: prepared.milestoneId,
        amountCents: prepared.amountCents,
        requestKey,
        actor: prepared.actor,
        payAppId: args.payAppId,
        proposalId: prepared.proposalId,
      });
      await ctx.runMutation(internal.payApps.proposals.settleProposalExecution, { proposalId: prepared.proposalId, requestKey });
      return result;
    } catch (e) {
      const message = e instanceof ConvexError ? String((e.data as { message?: string }).message ?? "") : "";
      await ctx.runMutation(internal.payApps.proposals.settleProposalExecution, {
        proposalId: prepared.proposalId,
        requestKey,
        error: (message || "The payment failed.").slice(0, 500),
      });
      throw e;
    }
  },
});
