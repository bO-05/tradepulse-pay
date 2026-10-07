import { ConvexError, v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { moveMilestone } from "./releaseDb";
import { RETAINAGE_REVERSING_STATUSES, isMilestoneFullyPaid } from "./payoutMath";
import { assertPaymentTransition, canTransitionPayment, type PayoutStatus } from "./stateMachine";

/**
 * Database side of sub payouts: payout rows move created → pending → success | failed | unclaimed | returned,
 * the retainage ledger is credited once per payout, and reversed under the policy in payoutMath.ts.
 * applyPayoutStatus is shared by the batch poll and the PayPal webhook.
 */

const payoutStatusValidator = v.union(
  v.literal("success"),
  v.literal("failed"),
  v.literal("unclaimed"),
  v.literal("returned"),
);

const beginPayoutResult = v.union(
  v.object({ state: v.literal("done"), batchId: v.string(), status: v.string() }),
  v.object({ state: v.literal("closed"), status: v.string(), error: v.optional(v.string()) }),
  v.object({
    state: v.literal("send"),
    idempotencyKey: v.string(),
    netCents: v.number(),
    receiverEmail: v.string(),
    note: v.string(),
    emailSubject: v.string(),
    kind: v.union(v.literal("payout"), v.literal("retainage_release")),
    agreementId: v.id("agreements"),
    projectId: v.id("projects"),
  }),
);
export type BeginPayout = Infer<typeof beginPayoutResult>;

/** Returns what the payout POST needs, or the stored batch when this payout was already sent. */
export const beginPayout = internalMutation({
  args: { paymentId: v.id("payments") },
  returns: beginPayoutResult,
  handler: async (ctx, { paymentId }): Promise<BeginPayout> => {
    const p = await ctx.db.get(paymentId);
    if (p === null || (p.kind !== "payout" && p.kind !== "retainage_release")) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Payout payment not found." });
    }
    if (p.paypalPayoutBatchId) return { state: "done", batchId: p.paypalPayoutBatchId, status: p.status };
    if (p.status !== "created") return { state: "closed", status: p.status, error: p.error };
    if (p.fundingPaymentId) {
      const funding = await ctx.db.get(p.fundingPaymentId);
      const captured = (funding?.captures ?? []).some((c) => c.releasePaymentId === p._id);
      if (!captured) {
        throw new ConvexError({ code: "NOT_CAPTURED", message: "The release amount has not been captured yet; the sub was not paid." });
      }
    }
    if (!p.receiverEmail) {
      throw new ConvexError({ code: "NO_PAYOUT_ACCOUNT", message: "This payout has no recipient PayPal email." });
    }
    const agreement = await ctx.db.get(p.agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });
    const milestone = p.milestoneId ? await ctx.db.get(p.milestoneId) : null;
    const isRetainage = p.kind === "retainage_release";
    const note = isRetainage
      ? `${agreement.agreementNumber} · retainage release at closeout`
      : `${agreement.agreementNumber}${milestone ? ` · ${milestone.name}` : ""} · progress payment net of retainage`;
    return {
      state: "send",
      idempotencyKey: p.idempotencyKey,
      netCents: p.netCents,
      receiverEmail: p.receiverEmail,
      note: note.slice(0, 1000),
      emailSubject: isRetainage ? "TradePulse Pay: retainage release" : "TradePulse Pay: progress payment",
      kind: isRetainage ? "retainage_release" : "payout",
      agreementId: agreement._id,
      projectId: agreement.projectId,
    };
  },
});

async function ledgerRowsFor(ctx: MutationCtx, payment: Doc<"payments">) {
  return await ctx.db
    .query("retainageLedger")
    .withIndex("by_paymentId", (q) => q.eq("paymentId", payment._id))
    .take(10);
}

/**
 * Stores the batch id, moves created → pending and writes the payment's ledger row exactly once:
 * a payout credits its withheld retainage, a retainage release debits the amount it pays out.
 */
export const recordPayoutCreated = internalMutation({
  args: {
    paymentId: v.id("payments"),
    batchId: v.string(),
    auditRecorded: v.boolean(),
    duplicate: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.paymentId);
    if (p === null) throw new ConvexError({ code: "NOT_FOUND", message: "Payout payment not found." });
    if (p.paypalPayoutBatchId !== undefined && p.paypalPayoutBatchId !== args.batchId) {
      throw new ConvexError({ code: "CONFLICT", message: "This payout already has a different PayPal batch." });
    }
    const now = Date.now();
    if (p.paypalPayoutBatchId === undefined) {
      assertPaymentTransition(p.kind, p.status, "pending");
      await ctx.db.patch(p._id, {
        status: "pending",
        paypalPayoutBatchId: args.batchId,
        error: undefined,
        auditRecorded: p.auditRecorded === false ? false : args.auditRecorded,
        updatedAt: now,
      });
    }
    if (p.kind === "payout" && p.retainageCents > 0) {
      const rows = await ledgerRowsFor(ctx, p);
      if (!rows.some((r) => r.deltaCents > 0)) {
        await ctx.db.insert("retainageLedger", {
          agreementId: p.agreementId,
          paymentId: p._id,
          deltaCents: p.retainageCents,
          reason: `Retainage withheld from ${(p.grossCents / 100).toFixed(2)} USD gross release (payout batch ${args.batchId})`,
          createdAt: now,
        });
      }
    }
    if (p.kind === "retainage_release" && p.netCents > 0) {
      const rows = await ledgerRowsFor(ctx, p);
      if (!rows.some((r) => r.deltaCents < 0)) {
        await ctx.db.insert("retainageLedger", {
          agreementId: p.agreementId,
          paymentId: p._id,
          deltaCents: -p.netCents,
          reason: `Retainage released at closeout to ${p.receiverEmail ?? "the sub"} (payout batch ${args.batchId})`,
          createdAt: now,
        });
      }
    }
    return null;
  },
});

/** A transient rejection (e.g. INSUFFICIENT_FUNDS right after the capture): the payout stays created for a retry. */
export const recordPayoutDeferred = internalMutation({
  args: { paymentId: v.id("payments"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, { paymentId, note }) => {
    const p = await ctx.db.get(paymentId);
    if (p === null || p.status !== "created" || p.paypalPayoutBatchId) return null;
    await ctx.db.patch(p._id, { error: note, updatedAt: Date.now() });
    return null;
  },
});

/** A definitive PayPal rejection of the payout POST: nothing was sent and the ledger is untouched. */
export const recordPayoutFailure = internalMutation({
  args: { paymentId: v.id("payments"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { paymentId, error }) => {
    const p = await ctx.db.get(paymentId);
    if (p === null || p.status !== "created" || p.paypalPayoutBatchId) return null;
    assertPaymentTransition(p.kind, "created", "failed");
    await ctx.db.patch(p._id, { status: "failed", error, updatedAt: Date.now() });
    return null;
  },
});

function nonSuccessMessage(
  kind: Doc<"payments">["kind"],
  status: PayoutStatus,
  itemStatus: string | undefined,
  errorName: string | undefined,
  receiver?: string,
) {
  const detail = errorName ? ` (${errorName})` : "";
  const ledgerNote =
    kind === "retainage_release"
      ? "The released retainage is held again and can be released again."
      : "Retainage withheld from it was reversed.";
  switch (status) {
    case "unclaimed":
      return `Unclaimed: PayPal could not deliver the payout to ${receiver ?? "the recipient"}${detail}. It stays unclaimed until the recipient claims it or PayPal returns it after 30 days.`;
    case "returned":
      return `Returned: PayPal returned the unclaimed payout${detail}. ${ledgerNote}`;
    case "failed":
      return `Failed: PayPal reported the payout item as ${itemStatus ?? "FAILED"}${detail}. ${ledgerNote}`;
    default:
      return undefined;
  }
}

/**
 * Applies PayPal's item status to a payout row (batch poll or webhook). Illegal or repeated transitions
 * are ignored so out-of-order webhook deliveries cannot corrupt state.
 */
export const applyPayoutStatus = internalMutation({
  args: {
    paymentId: v.id("payments"),
    status: v.optional(payoutStatusValidator),
    itemId: v.optional(v.string()),
    itemStatus: v.optional(v.string()),
    errorName: v.optional(v.string()),
  },
  returns: v.object({ applied: v.boolean(), status: v.string() }),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.paymentId);
    if (p === null) throw new ConvexError({ code: "NOT_FOUND", message: "Payout payment not found." });
    return await applyPayoutStatusTo(ctx, p, args);
  },
});

export type PayoutStatusUpdate = {
  status?: Infer<typeof payoutStatusValidator>;
  itemId?: string;
  itemStatus?: string;
  errorName?: string;
};

export async function applyPayoutStatusTo(
  ctx: MutationCtx,
  p: Doc<"payments">,
  args: PayoutStatusUpdate,
): Promise<{ applied: boolean; status: string }> {
  const now = Date.now();
  const meta = {
    ...(args.itemId && !p.paypalPayoutItemId ? { paypalPayoutItemId: args.itemId } : {}),
    ...(args.itemStatus && args.itemStatus !== p.paypalItemStatus ? { paypalItemStatus: args.itemStatus } : {}),
  };
  if (!args.status || args.status === p.status || !canTransitionPayment(p.kind, p.status, args.status)) {
    if (Object.keys(meta).length > 0) await ctx.db.patch(p._id, { ...meta, updatedAt: now });
    return { applied: false, status: p.status };
  }
  const to = args.status;
  await ctx.db.patch(p._id, {
    ...meta,
    status: to,
    error: nonSuccessMessage(p.kind, to, args.itemStatus, args.errorName, p.receiverEmail),
    updatedAt: now,
  });

  if ((RETAINAGE_REVERSING_STATUSES as readonly string[]).includes(to) && p.kind !== "funding") {
    const rows = await ledgerRowsFor(ctx, p);
    const net = rows.reduce((a, r) => a + r.deltaCents, 0);
    // A failed payout gives back its credit; a failed retainage release puts the released amount back on hold.
    const reversing = p.kind === "payout" ? net > 0 : net < 0;
    if (reversing) {
      await ctx.db.insert("retainageLedger", {
        agreementId: p.agreementId,
        paymentId: p._id,
        deltaCents: -net,
        reason:
          p.kind === "payout"
            ? `Retainage credit reversed: payout ${to} (${args.itemStatus ?? to.toUpperCase()})`
            : `Retainage release ${to} (${args.itemStatus ?? to.toUpperCase()}): the amount is held again`,
        createdAt: now,
      });
    }
  }

  if (to === "success") {
    if (p.payAppId) {
      const app = await ctx.db.get(p.payAppId);
      if (app !== null && app.status === "approved") await ctx.db.patch(app._id, { status: "paid" });
    }
    if (p.milestoneId) {
      const milestone = await ctx.db.get(p.milestoneId);
      const siblings = await ctx.db
        .query("payments")
        .withIndex("by_milestoneId", (q) => q.eq("milestoneId", p.milestoneId))
        .take(200);
      const paidGross = siblings
        .filter((s) => s.kind === "payout" && (s._id === p._id || s.status === "success"))
        .map((s) => s.grossCents);
      if (milestone !== null && isMilestoneFullyPaid(milestone.amountCents, paidGross)) {
        await moveMilestone(ctx, milestone._id, "paid");
      }
    }
  }
  return { applied: true, status: to };
}
