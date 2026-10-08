/**
 * Deterministic inbound routing for verified AgentMail `message.received` events.
 * Order: stored thread_id, then the `[TP-<ref>]` subject token. No keyword or
 * fuzzy matching. Dev and prod share inboxes, so replies on threads this
 * deployment did not start are ignored, and anything else unmatched is stored
 * as `unrouted` with no tenant ids.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

const TOKEN_PATTERN = /\[TP-([A-Z0-9]{4,12})\]/gi;
const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newThreadRef(random: () => number = Math.random): string {
  let ref = "";
  for (let i = 0; i < 8; i++) ref += REF_ALPHABET[Math.floor(random() * REF_ALPHABET.length)];
  return ref;
}

export function subjectTokens(subject: string): string[] {
  return [...subject.matchAll(TOKEN_PATTERN)].map((m) => m[1].toUpperCase());
}

export function subjectWithRef(subject: string, ref: string): string {
  return `${subject} [TP-${ref}]`;
}

export function parseAddress(raw: unknown): { email: string; name?: string } {
  const value = typeof raw === "string" ? raw : (raw as any)?.email ?? "";
  const angle = /<([^>]+)>/.exec(value);
  const email = (angle ? angle[1] : value).trim().toLowerCase();
  const name = angle ? value.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || undefined : (raw as any)?.name;
  return { email, name };
}

type Route =
  | { routing: "routed"; matchMethod: "thread" | "token"; thread: Doc<"emailThreads">; contractorId: Id<"contractors"> }
  | { routing: "triage"; matchMethod: "token"; thread: Doc<"emailThreads"> }
  | { routing: "unrouted" }
  | { routing: "ignored"; reason: string };

async function contractorForSender(
  ctx: MutationCtx,
  thread: Doc<"emailThreads">,
  sender: string
): Promise<Id<"contractors"> | null> {
  const own = await ctx.db.get(thread.contractorId);
  if (own && own.contactEmail.trim().toLowerCase() === sender) return own._id;
  const inPackage = await ctx.db
    .query("contractors")
    .withIndex("by_package", (q) => q.eq("tradePackageId", thread.tradePackageId))
    .take(500);
  const match = inPackage.find((c) => c.contactEmail.trim().toLowerCase() === sender);
  return match?._id ?? null;
}

async function routeMessage(
  ctx: MutationCtx,
  msg: { threadId: string; subject: string; from: string; inReplyTo?: string }
): Promise<Route> {
  if (msg.threadId) {
    const byThread = await ctx.db
      .query("emailThreads")
      .withIndex("by_threadId", (q) => q.eq("threadId", msg.threadId))
      .first();
    if (byThread) {
      return { routing: "routed", matchMethod: "thread", thread: byThread, contractorId: byThread.contractorId };
    }
    const link = await ctx.db
      .query("emailThreadLinks")
      .withIndex("by_threadId", (q) => q.eq("threadId", msg.threadId))
      .first();
    const linked = link ? await ctx.db.get(link.emailThreadId) : null;
    if (link && linked) {
      return { routing: "routed", matchMethod: "thread", thread: linked, contractorId: link.contractorId };
    }
  }

  for (const token of subjectTokens(msg.subject)) {
    const byRef = await ctx.db
      .query("emailThreads")
      .withIndex("by_ref", (q) => q.eq("ref", token))
      .first();
    if (!byRef) continue;
    const contractorId = await contractorForSender(ctx, byRef, msg.from);
    return contractorId
      ? { routing: "routed", matchMethod: "token", thread: byRef, contractorId }
      : { routing: "triage", matchMethod: "token", thread: byRef };
  }

  if (msg.threadId) {
    const startedHere = await ctx.db
      .query("emailOutbox")
      .withIndex("by_threadId", (q) => q.eq("threadId", msg.threadId))
      .first();
    if (startedHere) return { routing: "unrouted" };
  }
  if (msg.inReplyTo) {
    return { routing: "ignored", reason: "reply on a thread this deployment did not start" };
  }
  return { routing: "unrouted" };
}

/** Remembers that an AgentMail thread belongs to this RFQ conversation; idempotent per thread id. */
async function linkThread(
  ctx: MutationCtx,
  p: { threadId: string; thread: Doc<"emailThreads">; contractorId: Id<"contractors">; source: "outbound" | "inbound_token" }
): Promise<void> {
  if (p.thread.threadId === p.threadId) return;
  const existing = await ctx.db
    .query("emailThreadLinks")
    .withIndex("by_threadId", (q) => q.eq("threadId", p.threadId))
    .first();
  if (existing) return;
  await ctx.db.insert("emailThreadLinks", {
    threadId: p.threadId,
    emailThreadId: p.thread._id,
    contractorId: p.contractorId,
    source: p.source,
    createdAt: Date.now(),
  });
}

export const ingestReceived = internalMutation({
  args: {
    eventId: v.string(),
    message: v.object({
      inboxId: v.string(),
      threadId: v.string(),
      messageId: v.string(),
      from: v.string(),
      subject: v.string(),
      text: v.string(),
      inReplyTo: v.optional(v.string()),
      attachments: v.optional(v.array(v.any())),
    }),
  },
  handler: async (ctx, args) => {
    const msg = args.message;
    const dupByEvent = await ctx.db
      .query("inboundEmails")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .first();
    const dupByMessage =
      dupByEvent ??
      (msg.messageId
        ? await ctx.db
            .query("inboundEmails")
            .withIndex("by_messageId", (q) => q.eq("messageId", msg.messageId))
            .first()
        : null);
    if (dupByMessage) return { outcome: "duplicate" as const, inboundId: dupByMessage._id };

    const sender = parseAddress(msg.from);
    const route = await routeMessage(ctx, {
      threadId: msg.threadId,
      subject: msg.subject,
      from: sender.email,
      inReplyTo: msg.inReplyTo,
    });
    if (route.routing === "ignored") return { outcome: "ignored" as const, reason: route.reason };

    const base = {
      eventId: args.eventId,
      messageId: msg.messageId,
      inboxId: msg.inboxId,
      threadId: msg.threadId,
      from: sender.email,
      fromName: sender.name,
      subject: msg.subject.slice(0, 500),
      text: msg.text.slice(0, 50_000),
      inReplyTo: msg.inReplyTo,
      attachments: msg.attachments,
      receivedAt: Date.now(),
    };

    if (route.routing === "unrouted") {
      const inboundId = await ctx.db.insert("inboundEmails", { ...base, routing: "unrouted" });
      return { outcome: "unrouted" as const, inboundId };
    }

    const tenant = {
      projectId: route.thread.projectId,
      companyId: route.thread.companyId,
      tradePackageId: route.thread.tradePackageId,
    };
    if (route.routing === "triage") {
      const inboundId = await ctx.db.insert("inboundEmails", {
        ...base,
        ...tenant,
        routing: "triage",
        matchMethod: "token",
      });
      return { outcome: "triage" as const, inboundId };
    }

    if (route.matchMethod === "token" && msg.threadId) {
      await linkThread(ctx, { threadId: msg.threadId, thread: route.thread, contractorId: route.contractorId, source: "inbound_token" });
    }
    const inboundId = await ctx.db.insert("inboundEmails", {
      ...base,
      ...tenant,
      routing: "routed",
      matchMethod: route.matchMethod,
      contractorId: route.contractorId,
    });
    await ctx.scheduler.runAfter(0, internal.emailActions.processInboundEmail, {
      inboxId: msg.inboxId,
      messageId: msg.messageId,
      threadId: msg.threadId,
      text: msg.text,
      subject: msg.subject,
      from: sender.email,
      tradePackageId: route.thread.tradePackageId,
      contractorId: route.contractorId,
      attachments: msg.attachments,
    });
    return { outcome: "routed" as const, inboundId, matchMethod: route.matchMethod };
  },
});

/** RFQ thread for one bidder on one package; reused so every RFQ to that bidder carries the same ref. */
export const ensureRfqThread = internalMutation({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.id("tradePackages"),
    contractorId: v.id("contractors"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("emailThreads")
      .withIndex("by_contractorId", (q) => q.eq("contractorId", args.contractorId))
      .take(20);
    const same = existing.find((t) => t.tradePackageId === args.tradePackageId);
    if (same) return { threadRowId: same._id, ref: same.ref };
    const project = await ctx.db.get(args.projectId);
    let ref = newThreadRef();
    while (await ctx.db.query("emailThreads").withIndex("by_ref", (q) => q.eq("ref", ref)).first()) {
      ref = newThreadRef();
    }
    const threadRowId = await ctx.db.insert("emailThreads", {
      ref,
      kind: "rfq",
      projectId: args.projectId,
      companyId: project?.gcCompanyId,
      tradePackageId: args.tradePackageId,
      contractorId: args.contractorId,
      createdAt: Date.now(),
    });
    return { threadRowId, ref };
  },
});

export const attachThreadId = internalMutation({
  args: { threadRowId: v.id("emailThreads"), threadId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.threadRowId);
    if (!row) return null;
    if (!row.threadId) {
      await ctx.db.patch(args.threadRowId, { threadId: args.threadId });
      return null;
    }
    // A later dispatch can start a new provider thread; replies on it must route too.
    await linkThread(ctx, { threadId: args.threadId, thread: row, contractorId: row.contractorId, source: "outbound" });
    return null;
  },
});

/** Operator view of unrouted mail (never exposed to tenants). */
export const listUnrouted = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("inboundEmails")
      .withIndex("by_routing", (q) => q.eq("routing", "unrouted"))
      .order("desc")
      .take(Math.min(args.limit ?? 50, 200));
    return rows.map((r) => ({ id: r._id, from: r.from, subject: r.subject, threadId: r.threadId, receivedAt: r.receivedAt }));
  },
});
