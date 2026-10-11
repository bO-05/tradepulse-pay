import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, type MutationCtx } from "./_generated/server";
import { MAILER_IN_FLIGHT_MESSAGE, sendEmail } from "./lib/mailer";
import { buildRfiAnswerEmail, cleanRfiAnswer, RFI_ANSWER_MAX, RFI_ANSWER_MIN } from "./lib/rfiAnswerEmail";
import { notFound } from "./lib/tenancy";
import { requireProjectScopeInAction } from "./lib/tenancyAction";

/**
 * RFI answers (architecture §15). The AI only drafts; a GC member reviews or edits the text and
 * clicks Send, and this action is the only code that emails an RFI answer. It replies inside the
 * bidder's AgentMail thread through the mailer. Demo companies record the answer without sending.
 */

/** A send claimed less than this long ago is treated as still in flight. */
const IN_FLIGHT_MS = 60_000;

type Claim =
  | { action: "already"; status: "sent" | "demo_not_sent"; answeredAt: number | null }
  | { action: "in_flight" }
  | { action: "demo"; answeredAt: number }
  | {
      action: "send";
      attempt: number;
      to: string;
      replyToMessageId: string;
      subject: string;
      text: string;
      html: string;
      companyId: Id<"companies"> | null;
      projectId: Id<"projects">;
    };

/** The routed inbound email the RFI came from: its own link first, then the latest message on its thread. */
async function sourceEmailOf(ctx: MutationCtx, convo: Doc<"conversations">): Promise<Doc<"inboundEmails"> | null> {
  if (convo.sourceInboundEmailId) {
    const linked = await ctx.db.get(convo.sourceInboundEmailId);
    if (linked && linked.routing === "routed") return linked;
  }
  if (convo.origin === "portal" || !convo.threadId) return null;
  const onPackage = await ctx.db
    .query("inboundEmails")
    .withIndex("by_tradePackageId", (q) => q.eq("tradePackageId", convo.tradePackageId))
    .order("desc")
    .take(500);
  return onPackage.find((m) => m.routing === "routed" && m.threadId === convo.threadId && m.contractorId === convo.contractorId) ?? null;
}

async function refOf(ctx: MutationCtx, convo: Doc<"conversations">, contractor: Doc<"contractors"> | null): Promise<string | undefined> {
  const thread = await ctx.db
    .query("emailThreads")
    .withIndex("by_threadId", (q) => q.eq("threadId", convo.threadId))
    .first();
  if (thread) return thread.ref;
  const link = await ctx.db
    .query("emailThreadLinks")
    .withIndex("by_threadId", (q) => q.eq("threadId", convo.threadId))
    .first();
  const linked = link ? await ctx.db.get(link.emailThreadId) : null;
  return linked?.ref ?? contractor?.rfqRef ?? undefined;
}

export const claimRfiAnswer = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    answer: v.string(),
    userId: v.id("users"),
    actor: v.string(),
  },
  handler: async (ctx, args): Promise<Claim> => {
    const convo = await ctx.db.get(args.conversationId);
    if (convo === null) throw notFound();
    if (convo.answerEmailStatus === "sent" || convo.answerEmailStatus === "demo_not_sent") {
      return { action: "already", status: convo.answerEmailStatus, answeredAt: convo.answeredAt ?? null };
    }
    const answer = cleanRfiAnswer(args.answer);
    if (answer.length < RFI_ANSWER_MIN || answer.length > RFI_ANSWER_MAX) {
      throw new ConvexError({ code: "INVALID" as const, message: "Enter the answer to send (up to 8,000 characters).", field: "answer" });
    }
    const pkg = await ctx.db.get(convo.tradePackageId);
    const project = pkg ? await ctx.db.get(pkg.projectId) : null;
    if (pkg === null || project === null) throw notFound();
    const gcCompany = project.gcCompanyId ? await ctx.db.get(project.gcCompanyId) : null;
    const isDemo = gcCompany ? gcCompany.isDemo : true;
    const now = Date.now();
    const contractor = await ctx.db.get(convo.contractorId);

    if (isDemo) {
      await ctx.db.patch(convo._id, {
        aiDraft: convo.aiDraft ?? convo.autonomousReply,
        answerText: answer,
        autonomousReply: answer,
        answerEmailStatus: "demo_not_sent",
        answerEmailError: undefined,
        answeredAt: now,
        answeredByUserId: args.userId,
        answeredByName: args.actor,
        status: "clarified",
        pmCertifiedAt: now,
        pmCertifiedBy: args.actor,
      });
      await ctx.db.insert("auditLogs", {
        projectId: project._id,
        tradePackageId: pkg._id,
        eventType: "rfi_clarified",
        title: `RFI answer recorded (Demo — not sent): ${convo.inboundSubject}`,
        description: `${args.actor} recorded the answer to ${contractor?.companyName ?? "the bidder"}'s question. Demo companies send no email.`,
        actor: args.actor,
        actorUserId: args.userId,
        ...(gcCompany ? { actorCompanyId: gcCompany._id } : {}),
        contractorId: convo.contractorId,
        timestamp: now,
      });
      return { action: "demo", answeredAt: now };
    }

    const source = await sourceEmailOf(ctx, convo);
    if (source === null) {
      throw new ConvexError({
        code: "INVALID" as const,
        message: "This question did not arrive by email, so there is no email thread to reply to. Publish the answer to bidders instead.",
      });
    }
    if (convo.answerEmailStatus === "sending" && convo.answerClaimedAt !== undefined && now - convo.answerClaimedAt < IN_FLIGHT_MS) {
      return { action: "in_flight" };
    }
    // An unconfirmed send may still arrive, so a retry must reuse the same text and idempotency key.
    const unconfirmed = convo.answerEmailStatus === "uncertain" || convo.answerEmailStatus === "sending";
    if (unconfirmed && convo.answerText !== undefined && convo.answerText !== answer) {
      throw new ConvexError({
        code: "INVALID" as const,
        message: "The previous send was not confirmed and may still arrive. Retry it with the same text, or wait for it to arrive.",
        field: "answer",
      });
    }
    const attempt = unconfirmed ? (convo.answerAttempt ?? 1) : (convo.answerAttempt ?? 0) + 1;
    await ctx.db.patch(convo._id, {
      aiDraft: convo.aiDraft ?? convo.autonomousReply,
      answerText: answer,
      answerAttempt: attempt,
      answerEmailStatus: "sending",
      answerEmailError: undefined,
      answerClaimedAt: now,
    });
    const content = buildRfiAnswerEmail({
      answer,
      gcName: gcCompany?.name ?? "General contractor",
      answeredByName: args.actor,
      projectTitle: project.title,
      csiDivision: pkg.csiDivision,
      tradeName: pkg.tradeName,
      ref: await refOf(ctx, convo, contractor),
      inboundSubject: source.subject,
    });
    return {
      action: "send",
      attempt,
      to: source.from,
      replyToMessageId: source.messageId,
      ...content,
      companyId: project.gcCompanyId ?? null,
      projectId: project._id,
    };
  },
});

export const recordRfiAnswerOutcome = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    attempt: v.number(),
    status: v.union(v.literal("sent"), v.literal("uncertain"), v.literal("failed"), v.literal("skipped_budget"), v.literal("sending")),
    error: v.optional(v.string()),
    outboxId: v.optional(v.id("emailOutbox")),
    messageId: v.optional(v.string()),
    userId: v.id("users"),
    actor: v.string(),
  },
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.conversationId);
    if (convo === null || convo.answerAttempt !== args.attempt || convo.answerEmailStatus === "sent") return null;
    const now = Date.now();
    if (args.status !== "sent") {
      // A budget or recipient refusal of a retry leaves an earlier possibly-delivered attempt unresolved;
      // the text and idempotency key stay locked until a same-key send settles it.
      const outbox = args.outboxId ? await ctx.db.get(args.outboxId) : null;
      const status = args.status !== "sending" && outbox?.status === "uncertain" ? ("uncertain" as const) : args.status;
      await ctx.db.patch(convo._id, {
        answerEmailStatus: status,
        answerEmailError: args.error?.slice(0, 400),
        ...(args.outboxId ? { answerOutboxId: args.outboxId } : {}),
      });
      return { status };
    }
    const answer = convo.answerText ?? "";
    await ctx.db.patch(convo._id, {
      answerEmailStatus: "sent",
      answerEmailError: undefined,
      answerOutboxId: args.outboxId,
      answerMessageId: args.messageId,
      answeredAt: now,
      answeredByUserId: args.userId,
      answeredByName: args.actor,
      autonomousReply: answer,
      status: "clarified",
      pmCertifiedAt: now,
      pmCertifiedBy: args.actor,
    });
    const pkg = await ctx.db.get(convo.tradePackageId);
    if (pkg) {
      const project = await ctx.db.get(pkg.projectId);
      const contractor = await ctx.db.get(convo.contractorId);
      await ctx.db.insert("auditLogs", {
        projectId: pkg.projectId,
        tradePackageId: pkg._id,
        eventType: "rfi_clarified",
        title: `RFI answer sent: ${convo.inboundSubject}`,
        description: `${args.actor} reviewed and sent the answer to ${contractor?.companyName ?? "the bidder"} by email.`,
        actor: args.actor,
        actorUserId: args.userId,
        ...(project?.gcCompanyId ? { actorCompanyId: project.gcCompanyId } : {}),
        contractorId: convo.contractorId,
        timestamp: now,
      });
    }
    return { status: "sent" as const };
  },
});

export type SendRfiAnswerResult = {
  status: "sent" | "already_sent" | "demo_not_sent" | "in_flight" | "uncertain" | "failed" | "skipped_budget";
  error?: string;
};

/** GC only: sends the reviewed answer text (not the AI draft) as a reply in the bidder's email thread. */
export const sendRfiAnswer = action({
  args: { conversationId: v.string(), answer: v.string() },
  handler: async (ctx, args): Promise<SendRfiAnswerResult> => {
    const scope = await requireProjectScopeInAction(
      ctx,
      { docs: [{ table: "conversations", id: args.conversationId }] },
      { roles: ["gc"], write: true },
    );
    const conversationId = args.conversationId as Id<"conversations">;
    const claim: Claim = await ctx.runMutation(internal.rfiAnswers.claimRfiAnswer, {
      conversationId,
      answer: args.answer,
      userId: scope.userId,
      actor: scope.actor,
    });
    if (claim.action === "already") return { status: claim.status === "sent" ? "already_sent" : "demo_not_sent" };
    if (claim.action === "in_flight") return { status: "in_flight", error: "This answer is already being sent." };
    if (claim.action === "demo") return { status: "demo_not_sent" };

    const result = await sendEmail(ctx, {
      kind: "rfi_answer",
      from: "rfq",
      to: claim.to,
      subject: claim.subject,
      text: claim.text,
      html: claim.html,
      idempotencyKey: `rfi_answer.${conversationId}.${claim.attempt}`,
      replyToMessageId: claim.replyToMessageId,
      companyId: claim.companyId ?? undefined,
      projectId: claim.projectId,
    });
    const status =
      result.status === "sent"
        ? ("sent" as const)
        : result.status === "skipped_budget"
          ? ("skipped_budget" as const)
          : result.uncertain
            ? ("uncertain" as const)
            : result.error === MAILER_IN_FLIGHT_MESSAGE
              ? ("sending" as const)
              : ("failed" as const);
    const error = result.status === "sent" ? undefined : result.status === "skipped_budget" ? result.message : result.error;
    const recorded: { status: typeof status } | null = await ctx.runMutation(internal.rfiAnswers.recordRfiAnswerOutcome, {
      conversationId,
      attempt: claim.attempt,
      status,
      error,
      outboxId: result.outboxId,
      messageId: result.status === "sent" ? result.messageId : undefined,
      userId: scope.userId,
      actor: scope.actor,
    });
    const final = recorded?.status ?? status;
    const reported = final === "sending" ? ("in_flight" as const) : final;
    return error === undefined ? { status: reported } : { status: reported, error };
  },
});
