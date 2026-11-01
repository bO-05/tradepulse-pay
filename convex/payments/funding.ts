import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import {
  FUNDED_FUNDING_STATUSES,
  assertMilestoneTransition,
  assertPaymentTransition,
  type MilestoneStatus,
} from "./stateMachine";

/**
 * Database side of milestone funding (architecture §4 step 1). The PayPal calls live in orders.ts;
 * these internal mutations keep one funding payment per attempt and move it through the state machine.
 */

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const HONOR_PERIOD_MS = 3 * DAY_MS;
export const AUTHORIZATION_VALIDITY_MS = 29 * DAY_MS;
/** A created-but-never-approved order older than this is abandoned and replaced by a new attempt. */
export const STALE_ORDER_MS = HOUR_MS;

const FUNDABLE_MILESTONE_STATUSES: readonly string[] = ["planned", "funding", "funding_expired"];

/** Authorization expiry and honor-period end, from PayPal's timestamps when present. */
export function authorizationWindow(input: { createTime?: string; expirationTime?: string; now: number }): {
  authorizedAt: number;
  authorizationExpiresAt: number;
  honorPeriodEndsAt: number;
} {
  const created = input.createTime ? Date.parse(input.createTime) : NaN;
  const authorizedAt = Number.isFinite(created) ? created : input.now;
  const expires = input.expirationTime ? Date.parse(input.expirationTime) : NaN;
  return {
    authorizedAt,
    authorizationExpiresAt: Number.isFinite(expires) ? expires : authorizedAt + AUTHORIZATION_VALIDITY_MS,
    honorPeriodEndsAt: authorizedAt + HONOR_PERIOD_MS,
  };
}

/** Readable message for a failed authorize; PayPal's issue code stays in the text. */
export function fundingFailureMessage(data: { issues?: string[]; message?: string; name?: string }): string {
  const issues = data.issues ?? [];
  if (issues.includes("INSTRUMENT_DECLINED")) {
    return "Card declined: PayPal returned INSTRUMENT_DECLINED. The milestone was not funded. Try again with a different card.";
  }
  if (issues.includes("ORDER_NOT_APPROVED")) {
    return "Checkout was not completed: PayPal returned ORDER_NOT_APPROVED. The milestone was not funded.";
  }
  return `Funding failed: ${data.message ?? data.name ?? "PayPal rejected the request."} The milestone was not funded.`;
}

const AUTHORIZE_CONFLICT_ISSUES = ["ORDER_ALREADY_AUTHORIZED", "DUPLICATE_REQUEST_ID", "PREVIOUS_REQUEST_IN_PROGRESS"];

/**
 * True when an authorize rejection says the order is already (or is being) authorized rather than declined.
 * PayPal keeps request ids for a limited time and may reject a simultaneous request with the same id.
 */
export function isAuthorizeConflict(data: { status: number; issues?: string[] }): boolean {
  return data.status === 409 || (data.issues ?? []).some((i) => AUTHORIZE_CONFLICT_ISSUES.includes(i));
}

async function fundingPayments(ctx: MutationCtx, milestoneId: Id<"milestones">): Promise<Doc<"payments">[]> {
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_milestoneId", (q) => q.eq("milestoneId", milestoneId))
    .take(100);
  return rows.filter((p) => p.kind === "funding");
}

async function setMilestoneStatus(ctx: MutationCtx, milestone: Doc<"milestones">, to: MilestoneStatus): Promise<void> {
  if (milestone.status === to) return;
  assertMilestoneTransition(milestone.status, to);
  await ctx.db.patch(milestone._id, { status: to });
}

function mergeAudit(current: boolean | undefined, next: boolean): boolean {
  return current === false ? false : next;
}

export const preparedFundingValidator = v.object({
  paymentId: v.id("payments"),
  idempotencyKey: v.string(),
  paypalOrderId: v.optional(v.string()),
  amountCents: v.number(),
  milestoneName: v.string(),
  agreementId: v.id("agreements"),
  agreementNumber: v.string(),
  projectId: v.id("projects"),
  actor: v.string(),
});

/**
 * Returns the funding attempt to use for this milestone, creating one when needed. Reuses an open
 * attempt (same idempotency key, so PayPal returns the same order) so double clicks create one order.
 */
export const prepareFundingOrder = internalMutation({
  args: { milestoneId: v.id("milestones"), userId: v.id("users") },
  returns: preparedFundingValidator,
  handler: async (ctx, { milestoneId, userId }) => {
    const milestone = await ctx.db.get(milestoneId);
    if (milestone === null) throw new ConvexError({ code: "NOT_FOUND", message: "Milestone not found." });
    const agreement = await ctx.db.get(milestone.agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });
    const user = await ctx.db.get(userId);
    const actor = user?.email ?? `user:${userId}`;

    const payments = await fundingPayments(ctx, milestoneId);
    if (payments.some((p) => (FUNDED_FUNDING_STATUSES as readonly string[]).includes(p.status))) {
      throw new ConvexError({ code: "ALREADY_FUNDED", message: "This milestone is already funded." });
    }
    if (payments.some((p) => p.status === "approved")) {
      throw new ConvexError({
        code: "FUNDING_IN_PROGRESS",
        message: "Checkout for this milestone was approved and is being authorized. Wait for it to finish.",
      });
    }
    if (!FUNDABLE_MILESTONE_STATUSES.includes(milestone.status)) {
      throw new ConvexError({ code: "NOT_FUNDABLE", message: `A ${milestone.status} milestone cannot be funded.` });
    }

    const base = {
      amountCents: milestone.amountCents,
      milestoneName: milestone.name,
      agreementId: agreement._id,
      agreementNumber: agreement.agreementNumber,
      projectId: agreement.projectId,
      actor,
    };
    const now = Date.now();
    for (const p of payments.filter((x) => x.status === "created")) {
      if (now - p.createdAt < STALE_ORDER_MS && p.grossCents === milestone.amountCents) {
        await setMilestoneStatus(ctx, milestone, "funding");
        return { ...base, paymentId: p._id, idempotencyKey: p.idempotencyKey, paypalOrderId: p.paypalOrderId };
      }
      assertPaymentTransition("funding", p.status, "expired");
      await ctx.db.patch(p._id, { status: "expired", error: "Checkout was not completed; replaced by a new attempt.", updatedAt: now });
    }

    const idempotencyKey = `fund_${milestoneId}_${payments.length + 1}`;
    const paymentId = await ctx.db.insert("payments", {
      agreementId: agreement._id,
      milestoneId,
      kind: "funding",
      status: "created",
      grossCents: milestone.amountCents,
      retainageCents: 0,
      netCents: milestone.amountCents,
      idempotencyKey,
      createdAt: now,
    });
    await setMilestoneStatus(ctx, milestone, "funding");
    return { ...base, paymentId, idempotencyKey };
  },
});

export const recordFundingOrderCreated = internalMutation({
  args: { paymentId: v.id("payments"), paypalOrderId: v.string(), auditRecorded: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { paymentId, paypalOrderId, auditRecorded }) => {
    const p = await ctx.db.get(paymentId);
    if (p === null) throw new ConvexError({ code: "NOT_FOUND", message: "Payment not found." });
    if (p.paypalOrderId !== undefined && p.paypalOrderId !== paypalOrderId) {
      throw new ConvexError({ code: "CONFLICT", message: "This funding attempt already has a different PayPal order." });
    }
    await ctx.db.patch(paymentId, {
      paypalOrderId,
      auditRecorded: mergeAudit(p.auditRecorded, auditRecorded),
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const beginAuthorizationValidator = v.union(
  v.object({
    state: v.literal("authorize"),
    paymentId: v.id("payments"),
    idempotencyKey: v.string(),
    agreementId: v.id("agreements"),
    projectId: v.id("projects"),
  }),
  v.object({
    state: v.literal("done"),
    paymentId: v.id("payments"),
    paypalAuthorizationId: v.string(),
    authorizationExpiresAt: v.number(),
    honorPeriodEndsAt: v.number(),
  }),
);
export type PreparedFunding = Infer<typeof preparedFundingValidator>;
export type BeginAuthorization = Infer<typeof beginAuthorizationValidator>;

/** The funding payment of a PayPal order, so the action can authorize the caller on its project first. */
export const fundingPaymentIdForOrder = internalQuery({
  args: { paypalOrderId: v.string() },
  returns: v.union(v.id("payments"), v.null()),
  handler: async (ctx, { paypalOrderId }) => {
    const p = await ctx.db
      .query("payments")
      .withIndex("by_paypalOrderId", (q) => q.eq("paypalOrderId", paypalOrderId))
      .unique();
    return p !== null && p.kind === "funding" ? p._id : null;
  },
});

/**
 * Called from onApprove. Moves created → approved and returns what authorize needs, or the stored
 * authorization when this order was already authorized (a repeated onApprove makes no PayPal write).
 */
export const beginAuthorization = internalMutation({
  args: { paypalOrderId: v.string() },
  returns: beginAuthorizationValidator,
  handler: async (ctx, { paypalOrderId }) => {
    const p = await ctx.db
      .query("payments")
      .withIndex("by_paypalOrderId", (q) => q.eq("paypalOrderId", paypalOrderId))
      .unique();
    if (p === null || p.kind !== "funding") {
      throw new ConvexError({ code: "NOT_FOUND", message: "No funding payment exists for this PayPal order." });
    }
    if (p.paypalAuthorizationId !== undefined) {
      return {
        state: "done" as const,
        paymentId: p._id,
        paypalAuthorizationId: p.paypalAuthorizationId,
        authorizationExpiresAt: p.authorizationExpiresAt ?? 0,
        honorPeriodEndsAt: p.honorPeriodEndsAt ?? 0,
      };
    }
    if (p.status !== "created" && p.status !== "approved") {
      throw new ConvexError({
        code: "FUNDING_CLOSED",
        message: p.error ?? `This funding attempt is ${p.status}. Start funding again.`,
      });
    }
    const agreement = await ctx.db.get(p.agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });
    if (p.status === "created") {
      assertPaymentTransition("funding", "created", "approved");
      await ctx.db.patch(p._id, { status: "approved", updatedAt: Date.now() });
    }
    return {
      state: "authorize" as const,
      paymentId: p._id,
      idempotencyKey: p.idempotencyKey,
      agreementId: p.agreementId,
      projectId: agreement.projectId,
    };
  },
});

export const recordAuthorization = internalMutation({
  args: {
    paymentId: v.id("payments"),
    paypalAuthorizationId: v.string(),
    authorizationExpiresAt: v.number(),
    honorPeriodEndsAt: v.number(),
    auditRecorded: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const p = await ctx.db.get(args.paymentId);
    if (p === null) throw new ConvexError({ code: "NOT_FOUND", message: "Payment not found." });
    if (p.paypalAuthorizationId === args.paypalAuthorizationId) {
      // A duplicate result is still a completed PayPal call; its unaudited flag must not be dropped.
      const auditRecorded = mergeAudit(p.auditRecorded, args.auditRecorded);
      if (auditRecorded !== p.auditRecorded) await ctx.db.patch(p._id, { auditRecorded, updatedAt: Date.now() });
      return null;
    }
    assertPaymentTransition("funding", p.status, "authorized");
    await ctx.db.patch(p._id, {
      status: "authorized",
      paypalAuthorizationId: args.paypalAuthorizationId,
      authorizationExpiresAt: args.authorizationExpiresAt,
      honorPeriodEndsAt: args.honorPeriodEndsAt,
      error: undefined,
      auditRecorded: mergeAudit(p.auditRecorded, args.auditRecorded),
      updatedAt: Date.now(),
    });
    if (p.milestoneId) {
      const milestone = await ctx.db.get(p.milestoneId);
      if (milestone !== null && milestone.status !== "funded") {
        if (milestone.status !== "funding") await setMilestoneStatus(ctx, milestone, "funding");
        await setMilestoneStatus(ctx, { ...milestone, status: "funding" }, "funded");
      }
    }
    return null;
  },
});

/** Marks an open funding attempt failed and returns the milestone to planned when nothing else is open. */
export const recordFundingFailure = internalMutation({
  args: { paymentId: v.id("payments"), error: v.string(), auditRecorded: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { paymentId, error, auditRecorded }) => {
    const p = await ctx.db.get(paymentId);
    if (p === null) return null;
    if (p.status !== "created" && p.status !== "approved") return null;
    assertPaymentTransition("funding", p.status, "failed");
    await ctx.db.patch(paymentId, {
      status: "failed",
      error,
      ...(auditRecorded !== undefined ? { auditRecorded: mergeAudit(p.auditRecorded, auditRecorded) } : {}),
      updatedAt: Date.now(),
    });
    if (p.milestoneId) {
      const milestone = await ctx.db.get(p.milestoneId);
      const others = (await fundingPayments(ctx, p.milestoneId)).filter(
        (x) => x._id !== paymentId && ["created", "approved", ...FUNDED_FUNDING_STATUSES].includes(x.status),
      );
      if (milestone !== null && milestone.status === "funding" && others.length === 0) {
        await setMilestoneStatus(ctx, milestone, "planned");
      }
    }
    return null;
  },
});
