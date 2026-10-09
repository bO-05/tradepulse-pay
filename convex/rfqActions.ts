import { action, type ActionCtx } from "./_generated/server";
import { requireProjectScopeInAction } from "./lib/tenancyAction";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isAgentmailConfigured } from "./agentmailApi";
import { BUDGET_SKIP_MESSAGE, RFQ_INBOX, sendEmail } from "./lib/mailer";
import { buildRfqEmail } from "./lib/rfqEmail";
import { assertRecipientList } from "./rfqRecipients";

/**
 * Every package uses the shared RFQ inbox; the app never creates or deletes
 * AgentMail inboxes. Replies are routed by thread and `[TP-<ref>]` token.
 */
export const provisionPackageInbox = action({
  args: {
    tradePackageId: v.id("tradePackages"),
    usernamePrefix: v.string(),
  },
  handler: async (ctx, args): Promise<{ email: string; id: string; live: boolean; shared: boolean }> => {
    await requireProjectScopeInAction(ctx, { docs: [{ table: "tradePackages", id: args.tradePackageId }] }, { roles: ["gc"], write: true });
    await ctx.runMutation(internal.tradePackages.updateMailbox, {
      tradePackageId: args.tradePackageId,
      agentMailbox: RFQ_INBOX,
      agentMailboxId: RFQ_INBOX,
      agentMailboxShared: true,
    });
    return { email: RFQ_INBOX, id: RFQ_INBOX, live: isAgentmailConfigured(), shared: true };
  },
});

export const RFQ_BUDGET_MESSAGE = "Email limit reached for today — copy the RFQ link instead.";

type DeliveryStatus =
  | "sent"
  | "failed"
  | "skipped_budget"
  | "blocked_recipient"
  | "bounced"
  | "not_sent"
  | "no_email"
  | "email_unconfirmed"
  | "already_sent"
  | "email_changed"
  | "not_in_package";

type DeliveryResult = { contractorId: Id<"contractors">; email: string; status: DeliveryStatus; reason?: string };

const recipientValidator = v.object({ contractorId: v.id("contractors"), email: v.string() });

/** One confirmed bidder: prepare, send through the mailer, then record the real outcome. */
async function sendOneRfq(
  ctx: ActionCtx,
  tradePackageId: Id<"tradePackages">,
  recipient: { contractorId: Id<"contractors">; email: string },
  mail: { companyId: Id<"companies"> | null; isDemo: boolean },
  projectId: Id<"projects">,
): Promise<DeliveryResult> {
  const base = { contractorId: recipient.contractorId, email: recipient.email.trim().toLowerCase() };
  const prepared = await ctx.runMutation(internal.rfqRecipients.prepareRfqSend, {
    tradePackageId,
    contractorId: recipient.contractorId,
    email: recipient.email,
  });
  if (prepared.action === "skip") return { ...base, status: prepared.status, reason: prepared.reason };
  if (mail.isDemo) {
    await ctx.runMutation(internal.rfqRecipients.recordRfqOutcome, {
      contractorId: recipient.contractorId,
      to: prepared.to,
      status: "not_sent",
      error: "Demo company: no external email is sent.",
      ref: prepared.ref,
    });
    return { ...base, status: "not_sent", reason: "Demo company: no external email is sent" };
  }

  const content = buildRfqEmail({ ...prepared.content, ref: prepared.ref, siteUrl: process.env.SITE_URL });
  const result = await sendEmail(ctx, {
    kind: "rfq",
    from: "rfq",
    to: prepared.to,
    subject: content.subject,
    text: content.text,
    html: content.html,
    idempotencyKey: prepared.idempotencyKey,
    companyId: mail.companyId ?? undefined,
    projectId,
  });

  if (result.status === "sent" && result.threadId) {
    await ctx.runMutation(internal.inboundEmail.attachThreadId, { threadRowId: prepared.threadRowId, threadId: result.threadId });
  }
  const status =
    result.status === "sent"
      ? ("sent" as const)
      : result.status === "skipped_budget"
        ? ("skipped_budget" as const)
        : result.blockedRecipient
          ? ("blocked_recipient" as const)
          : ("failed" as const);
  const error =
    result.status === "sent" ? undefined : result.status === "skipped_budget" ? RFQ_BUDGET_MESSAGE : result.error;
  const recorded = await ctx.runMutation(internal.rfqRecipients.recordRfqOutcome, {
    contractorId: recipient.contractorId,
    to: prepared.to,
    status,
    error,
    outboxId: result.outboxId,
    ref: prepared.ref,
    threadId: result.status === "sent" ? result.threadId || undefined : undefined,
  });
  const finalStatus = (recorded?.status ?? status) as DeliveryStatus;
  return finalStatus === "sent" ? { ...base, status: "sent" } : { ...base, status: finalStatus, reason: error ?? BUDGET_SKIP_MESSAGE };
}

async function sendConfirmedRfqs(
  ctx: ActionCtx,
  tradePackageId: Id<"tradePackages">,
  recipients: { contractorId: Id<"contractors">; email: string }[],
) {
  assertRecipientList(recipients);
  const tradePkg = await ctx.runQuery(internal.tradePackages.getPackageInternal, { tradePackageId });
  if (!tradePkg) throw new Error("Trade package not found");
  const mail = await ctx.runQuery(internal.emailOutbox.projectMailContext, { projectId: tradePkg.projectId });

  const seen = new Set<string>();
  const deliveryResults: DeliveryResult[] = [];
  for (const recipient of recipients) {
    if (seen.has(recipient.contractorId)) continue;
    seen.add(recipient.contractorId);
    deliveryResults.push(await sendOneRfq(ctx, tradePackageId, recipient, mail, tradePkg.projectId));
  }

  const emailsSent = deliveryResults.filter((r) => r.status === "sent").length;
  const attempted = deliveryResults.filter((r) => r.status !== "already_sent").length;
  const problems = deliveryResults
    .filter((r) => r.status !== "sent" && r.status !== "already_sent")
    .map((r) => `${r.email}: ${(r.reason ?? r.status).slice(0, 160)}`);
  await ctx.runMutation(internal.auditLogs.recordLogInternal, {
    projectId: tradePkg.projectId,
    tradePackageId,
    eventType: "rfq_dispatched",
    title: `AgentMail Delivery: ${emailsSent} of ${attempted} eligible recipient(s)`,
    description:
      emailsSent > 0
        ? `Sent ${emailsSent} RFQ email(s) from ${RFQ_INBOX} after GC review of the recipient list.${
            problems.length > 0 ? ` Not sent: ${problems.slice(0, 3).join("; ")}` : ""
          }`
        : `No RFQ email was sent.${problems.length > 0 ? ` Reasons: ${problems.slice(0, 3).join("; ")}` : ""}`,
    actor: "AgentMail Subcontractor Dispatcher",
  });

  return {
    success: true,
    tradePackageId,
    emailsSent,
    deliveryConfigured: isAgentmailConfigured(),
    deliveryResults,
    deliveryFailures: problems,
  };
}

/** Sends RFQs to the recipient list the GC reviewed and confirmed (contractor id + the exact address shown). */
export const dispatchRfqsWithNotification = action({
  args: {
    tradePackageId: v.id("tradePackages"),
    recipients: v.array(recipientValidator),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireProjectScopeInAction(
      ctx,
      {
        docs: [
          { table: "tradePackages", id: args.tradePackageId },
          ...args.recipients.slice(0, 50).map((r) => ({ table: "contractors" as const, id: r.contractorId })),
        ],
      },
      { roles: ["gc"], write: true },
    );
    return await sendConfirmedRfqs(ctx, args.tradePackageId, args.recipients);
  },
});

/** One bidder, after the GC confirmed the address shown in the review dialog. */
export const dispatchSingleRfqWithNotification = action({
  args: {
    contractorId: v.id("contractors"),
    email: v.string(),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireProjectScopeInAction(ctx, { docs: [{ table: "contractors", id: args.contractorId }] }, { roles: ["gc"], write: true });
    const contractor = await ctx.runQuery(internal.contractors.getContractorInternal, { contractorId: args.contractorId });
    if (!contractor) throw new Error("Contractor not found");
    const res = await sendConfirmedRfqs(ctx, contractor.tradePackageId, [{ contractorId: args.contractorId, email: args.email }]);
    const [only] = res.deliveryResults;
    return {
      success: true,
      contractorId: args.contractorId,
      emailSent: only?.status === "sent",
      emailStatus: only?.status ?? "failed",
      emailError: only?.status === "sent" ? undefined : only?.reason,
      deliveryConfigured: res.deliveryConfigured,
    };
  },
});
