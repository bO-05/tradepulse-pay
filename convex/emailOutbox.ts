import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { readDailyBudget, sendLimitFor, utcDayKey } from "./lib/mailer";

const mailKind = v.union(
  v.literal("auth_code"),
  v.literal("invite"),
  v.literal("rfq"),
  v.literal("rfi_answer"),
  v.literal("other")
);

/** A pending attempt older than this is treated as abandoned (the action died mid-call). */
const STALE_PENDING_MS = 2 * 60 * 1000;

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

    if (existing?.status === "sent") {
      return {
        action: "already_sent" as const,
        outboxId: existing._id,
        messageId: existing.agentmailMessageId ?? null,
        threadId: existing.threadId ?? null,
      };
    }
    if (existing?.status === "pending" && now - existing.updatedAt < STALE_PENDING_MS) {
      return { action: "in_flight" as const, outboxId: existing._id };
    }

    const limit = sendLimitFor(args.kind, readDailyBudget(process.env.EMAIL_DAILY_BUDGET));
    const sent = await ctx.db
      .query("emailOutbox")
      .withIndex("by_day_and_status", (q) => q.eq("day", day).eq("status", "sent"))
      .take(limit + 1);
    const pending = await ctx.db
      .query("emailOutbox")
      .withIndex("by_day_and_status", (q) => q.eq("day", day).eq("status", "pending"))
      .take(limit + 1);
    const used = sent.length + pending.filter((row) => row._id !== existing?._id).length;

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
      return { action: "send" as const, outboxId: existing._id };
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
    return { action: "send" as const, outboxId };
  },
});

export const finishSend = internalMutation({
  args: {
    outboxId: v.id("emailOutbox"),
    status: v.union(v.literal("sent"), v.literal("failed")),
    agentmailMessageId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.outboxId, {
      status: args.status,
      agentmailMessageId: args.agentmailMessageId,
      threadId: args.threadId,
      error: args.error,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Delivery webhooks (delivered/bounced/complained/rejected) annotate the matching sent row. */
export const recordDeliveryEvent = internalMutation({
  args: { agentmailMessageId: v.string(), event: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("emailOutbox")
      .withIndex("by_agentmailMessageId", (q) => q.eq("agentmailMessageId", args.agentmailMessageId))
      .first();
    if (!row) return { matched: false };
    await ctx.db.patch(row._id, { deliveryEvent: args.event, updatedAt: Date.now() });
    return { matched: true };
  },
});

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
    const statuses = ["pending", "sent", "failed", "skipped_budget"] as const;
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
    const sent = await ctx.db
      .query("emailOutbox")
      .withIndex("by_day_and_status", (q) => q.eq("day", day).eq("status", "sent"))
      .take(limit + 1);
    const pending = await ctx.db
      .query("emailOutbox")
      .withIndex("by_day_and_status", (q) => q.eq("day", day).eq("status", "pending"))
      .take(limit + 1);
    return sent.length + pending.length >= limit;
  },
});
