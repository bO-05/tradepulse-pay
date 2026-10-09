import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { readDailyBudget, sendLimitFor, utcDayKey } from "./lib/mailer";
import { BLOCKED_RECIPIENT_MESSAGE, recipientAllowed } from "./lib/recipientAllowlist";
import { RFQ_PRE_REPLY_STATUSES } from "./lib/rfqEmail";

const mailKind = v.union(
  v.literal("auth_code"),
  v.literal("invite"),
  v.literal("rfq"),
  v.literal("rfi_answer"),
  v.literal("other")
);

/** A pending attempt older than this is treated as abandoned (the action died mid-call). */
const STALE_PENDING_MS = 2 * 60 * 1000;

/** Rows that used (or may have used) provider quota; only these count against the daily budget. */
const CHARGED_STATUSES = ["sent", "pending", "uncertain", "delivery_failed"] as const;

async function chargedCount(
  ctx: QueryCtx,
  day: string,
  limit: number,
  excludeId?: Id<"emailOutbox">,
): Promise<number> {
  let used = 0;
  for (const status of CHARGED_STATUSES) {
    const rows = await ctx.db
      .query("emailOutbox")
      .withIndex("by_day_and_status", (q) => q.eq("day", day).eq("status", status))
      .take(limit + 1);
    used += rows.filter((row) => row._id !== excludeId).length;
    if (used > limit) break;
  }
  return used;
}

/** Demo-company mail (by sender company or project) never leaves the system. */
async function isDemoSender(
  ctx: QueryCtx,
  companyId: Id<"companies"> | undefined,
  projectId: Id<"projects"> | undefined,
): Promise<boolean> {
  if (companyId !== undefined && (await ctx.db.get(companyId))?.isDemo === true) return true;
  if (projectId === undefined) return false;
  const project = await ctx.db.get(projectId);
  if (project?.gcCompanyId === undefined) return false;
  return (await ctx.db.get(project.gcCompanyId))?.isDemo === true;
}

/**
 * Budget check and slot reservation in one transaction, so concurrent sends can
 * never exceed EMAIL_DAILY_BUDGET. Only convex/lib/mailer.ts calls this.
 */
export const reserveSend = internalMutation({
  args: {
    kind: mailKind,
    to: v.string(),
    fromInbox: v.string(),
    subject: v.string(),
    idempotencyKey: v.string(),
    companyId: v.optional(v.id("companies")),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args) => {
    if (await isDemoSender(ctx, args.companyId, args.projectId)) {
      return { action: "demo_blocked" as const };
    }
    const now = Date.now();
    const day = utcDayKey(now);
    const existing = await ctx.db
      .query("emailOutbox")
      .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();

    if (!recipientAllowed(args.to)) {
      const fields = { status: "blocked_recipient" as const, day, error: BLOCKED_RECIPIENT_MESSAGE, updatedAt: now };
      if (existing && existing.status !== "sent" && existing.status !== "delivery_failed") {
        await ctx.db.patch(existing._id, fields);
        return { action: "blocked_recipient" as const, outboxId: existing._id };
      }
      if (!existing) {
        const outboxId = await ctx.db.insert("emailOutbox", {
          kind: args.kind,
          to: args.to,
          fromInbox: args.fromInbox,
          subject: args.subject,
          companyId: args.companyId,
          projectId: args.projectId,
          idempotencyKey: args.idempotencyKey,
          attempts: 0,
          createdAt: now,
          ...fields,
        });
        return { action: "blocked_recipient" as const, outboxId };
      }
    }

    if (existing?.status === "sent") {
      return {
        action: "already_sent" as const,
        outboxId: existing._id,
        messageId: existing.agentmailMessageId ?? null,
        threadId: existing.threadId ?? null,
      };
    }
    if (existing?.status === "delivery_failed") {
      return { action: "delivery_failed" as const, outboxId: existing._id, error: existing.error ?? null };
    }
    if (existing?.status === "pending" && now - existing.updatedAt < STALE_PENDING_MS) {
      return { action: "in_flight" as const, outboxId: existing._id };
    }

    // An uncertain (or abandoned in-flight) attempt today already holds a budget slot. Retrying it with the
    // same Idempotency-Key reconciles that slot: AgentMail returns the original message if it was accepted.
    if (existing && (existing.status === "uncertain" || existing.status === "pending") && existing.day === day) {
      await ctx.db.patch(existing._id, { status: "pending", attempts: existing.attempts + 1, updatedAt: now });
      return { action: "send" as const, outboxId: existing._id, reconcile: true };
    }

    const limit = sendLimitFor(args.kind, readDailyBudget(process.env.EMAIL_DAILY_BUDGET));
    const used = await chargedCount(ctx, day, limit, existing?._id);

    if (used >= limit) {
      const fields = { status: "skipped_budget" as const, day, updatedAt: now, error: undefined };
      if (existing) {
        await ctx.db.patch(existing._id, fields);
        return { action: "skipped_budget" as const, outboxId: existing._id };
      }
      const outboxId = await ctx.db.insert("emailOutbox", {
        kind: args.kind,
        to: args.to,
        fromInbox: args.fromInbox,
        subject: args.subject,
        companyId: args.companyId,
        projectId: args.projectId,
        idempotencyKey: args.idempotencyKey,
        attempts: 0,
        createdAt: now,
        ...fields,
      });
      return { action: "skipped_budget" as const, outboxId };
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: "pending",
        day,
        attempts: existing.attempts + 1,
        error: undefined,
        updatedAt: now,
      });
      return { action: "send" as const, outboxId: existing._id, reconcile: false };
    }
    const outboxId = await ctx.db.insert("emailOutbox", {
      kind: args.kind,
      to: args.to,
      fromInbox: args.fromInbox,
      subject: args.subject,
      companyId: args.companyId,
      projectId: args.projectId,
      status: "pending",
      idempotencyKey: args.idempotencyKey,
      day,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    return { action: "send" as const, outboxId, reconcile: false };
  },
});

export const finishSend = internalMutation({
  args: {
    outboxId: v.id("emailOutbox"),
    status: v.union(v.literal("sent"), v.literal("failed"), v.literal("uncertain")),
    agentmailMessageId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.union(v.null(), v.object({ status: v.literal("delivery_failed"), error: v.string() })),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.outboxId);
    if (row === null) return null;
    const now = Date.now();
    if (row.status === "delivery_failed") {
      // Terminal: a later finish (e.g. a reconcile) only fills in ids that were missing.
      await ctx.db.patch(row._id, {
        agentmailMessageId: row.agentmailMessageId ?? args.agentmailMessageId,
        threadId: row.threadId ?? args.threadId,
        updatedAt: now,
      });
      return { status: "delivery_failed" as const, error: row.error ?? "The email was not delivered." };
    }
    await ctx.db.patch(row._id, {
      status: args.status,
      agentmailMessageId: args.agentmailMessageId,
      threadId: args.threadId,
      error: args.error,
      updatedAt: now,
    });
    if (args.status !== "sent" || !args.agentmailMessageId) return null;
    const messageId = args.agentmailMessageId;
    const early = await ctx.db
      .query("emailEarlyDeliveryEvents")
      .withIndex("by_agentmailMessageId", (q) => q.eq("agentmailMessageId", messageId))
      .take(10);
    for (const e of early) await ctx.db.delete(e._id);
    if (early.length === 0) return null;
    await markDeliveryFailed(ctx, (await ctx.db.get(row._id))!, early[0].event);
    return { status: "delivery_failed" as const, error: deliveryFailureMessage(early[0].event) };
  },
});

const FAILED_DELIVERY_EVENTS = new Set(["bounced", "rejected"]);

export function deliveryFailureMessage(event: string): string {
  return event === "rejected"
    ? "AgentMail rejected the message; it was not delivered."
    : "The recipient's mail server bounced the message; it was not delivered.";
}

/**
 * Delivery webhooks (delivered/bounced/complained/rejected) annotate the matching sent row. A bounce or
 * rejection is terminal: the row becomes delivery_failed (still charged, since provider quota was used)
 * and the invite or RFQ it belongs to stops reading "Email sent". A bounce or rejection that arrives
 * before the send's message id is stored is kept and applied by finishSend.
 */
export const recordDeliveryEvent = internalMutation({
  args: { agentmailMessageId: v.string(), event: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("emailOutbox")
      .withIndex("by_agentmailMessageId", (q) => q.eq("agentmailMessageId", args.agentmailMessageId))
      .first();
    if (!row) {
      if (FAILED_DELIVERY_EVENTS.has(args.event)) {
        await ctx.db.insert("emailEarlyDeliveryEvents", {
          agentmailMessageId: args.agentmailMessageId,
          event: args.event,
          receivedAt: Date.now(),
        });
      }
      return { matched: false };
    }
    const now = Date.now();
    if (!FAILED_DELIVERY_EVENTS.has(args.event) || row.status === "delivery_failed") {
      // A late "delivered" never overrides a recorded bounce.
      if (row.status !== "delivery_failed") await ctx.db.patch(row._id, { deliveryEvent: args.event, updatedAt: now });
      return { matched: true };
    }
    await markDeliveryFailed(ctx, row, args.event);
    return { matched: true };
  },
});

async function markDeliveryFailed(ctx: MutationCtx, row: Doc<"emailOutbox">, event: string) {
  const error = deliveryFailureMessage(event);
  await ctx.db.patch(row._id, { status: "delivery_failed", deliveryEvent: event, error, updatedAt: Date.now() });
  await markLogicalEventUndelivered(ctx, row, event, error);
}

/** The invite id and link version an invite email's idempotency key names, or null. */
export function parseInviteKey(key: string): { inviteId: string; tokenVersion: number } | null {
  const m = /^invite\.([^.]+)\.(\d+)$/.exec(key);
  return m ? { inviteId: m[1], tokenVersion: Number(m[2]) } : null;
}

async function markLogicalEventUndelivered(ctx: MutationCtx, row: Doc<"emailOutbox">, event: string, error: string) {
  if (row.kind === "invite") {
    const parsed = parseInviteKey(row.idempotencyKey);
    const inviteId = parsed ? ctx.db.normalizeId("invites", parsed.inviteId) : null;
    if (!parsed || !inviteId) return;
    const invite = await ctx.db.get(inviteId);
    // Only the link this email carried; a newer resend owns the status. The send result may not be
    // stored yet; invites:recordEmailResult then reads this row's terminal state.
    if (!invite || (invite.tokenVersion ?? 1) !== parsed.tokenVersion) return;
    await ctx.db.patch(invite._id, { emailStatus: "bounced", emailError: error });
    return;
  }
  if (row.kind === "rfq") {
    const m = /^rfq\.([^.]+)\./.exec(row.idempotencyKey);
    const contractorId = m ? ctx.db.normalizeId("contractors", m[1]) : null;
    const contractor = contractorId ? await ctx.db.get(contractorId) : null;
    const tradePackage = contractor ? await ctx.db.get(contractor.tradePackageId) : null;
    if (!contractor || !tradePackage) return;
    const ownsStatus =
      contractor.rfqOutboxId === row._id ||
      (contractor.rfqOutboxId === undefined && contractor.contactEmail.trim().toLowerCase() === row.to);
    if (ownsStatus && contractor.rfqEmailStatus !== "replied") {
      const status = event === "rejected" ? ("failed" as const) : ("bounced" as const);
      await ctx.db.patch(contractor._id, {
        rfqEmailStatus: status,
        rfqEmailError: error,
        ...(RFQ_PRE_REPLY_STATUSES.has(contractor.rfqStatus) ? { rfqStatus: status } : {}),
      });
    }
    await ctx.db.insert("auditLogs", {
      projectId: tradePackage.projectId,
      tradePackageId: tradePackage._id,
      eventType: "rfq_email_failed",
      title: `AgentMail Delivery failed: ${contractor.companyName}`,
      description: `The invitation to bid sent to ${contractor.contactEmail} was ${event === "rejected" ? "rejected" : "bounced"} and did not arrive. ${error}`,
      actor: "AgentMail Subcontractor Dispatcher",
      timestamp: Date.now(),
    });
  }
}

/** Sending company of a project; Demo companies never send external email. */
export const projectMailContext = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    const company = project?.gcCompanyId ? await ctx.db.get(project.gcCompanyId) : null;
    return {
      companyId: company?._id ?? null,
      companyName: company?.name ?? null,
      // Projects without a company predate tenancy and belong to the demo data set.
      isDemo: company ? company.isDemo : Boolean(project?.isDemoProject) || !project?.gcCompanyId,
    };
  },
});

/** Operator/validator view of one UTC day's outbox (no bodies are stored). */
export const listForDay = internalQuery({
  args: { day: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const day = args.day ?? utcDayKey(Date.now());
    const statuses = ["pending", "sent", "uncertain", "delivery_failed", "failed", "skipped_budget", "blocked_recipient"] as const;
    const rows = [];
    for (const status of statuses) {
      rows.push(
        ...(await ctx.db
          .query("emailOutbox")
          .withIndex("by_day_and_status", (q) => q.eq("day", day).eq("status", status))
          .take(500))
      );
    }
    const budget = readDailyBudget(process.env.EMAIL_DAILY_BUDGET);
    return {
      day,
      budget,
      sentCount: rows.filter((r) => r.status === "sent").length,
      chargedCount: rows.filter((r) => (CHARGED_STATUSES as readonly string[]).includes(r.status)).length,
      rows: rows
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((r) => ({
          id: r._id,
          kind: r.kind,
          to: r.to,
          fromInbox: r.fromInbox,
          subject: r.subject,
          status: r.status,
          attempts: r.attempts,
          agentmailMessageId: r.agentmailMessageId,
          threadId: r.threadId,
          error: r.error,
          deliveryEvent: r.deliveryEvent,
          companyId: r.companyId,
          projectId: r.projectId,
          createdAt: r.createdAt,
        })),
    };
  },
});

/** True when an auth-code send would be skipped for the daily budget right now. */
export const authCodeBudgetExhausted = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const day = utcDayKey(Date.now());
    const limit = sendLimitFor("auth_code", readDailyBudget(process.env.EMAIL_DAILY_BUDGET));
    return (await chargedCount(ctx, day, limit)) >= limit;
  },
});
