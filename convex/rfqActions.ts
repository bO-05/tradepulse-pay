import { action, type ActionCtx } from "./_generated/server";
import { requireProjectScopeInAction } from "./lib/tenancyAction";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { isAgentmailConfigured } from "./agentmailApi";
import { RFQ_INBOX, brandedHtml, sendEmail } from "./lib/mailer";
import { subjectWithRef } from "./inboundEmail";

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

type RfqOutcome =
  | { status: "sent"; messageId: string }
  | { status: "skipped_budget" | "failed" | "not_sent"; reason: string };

function rfqContent(tradePkg: any, project: any, contractor: any, ref: string) {
  const projectTitle = project?.title || "the project";
  const subject = subjectWithRef(
    `Invitation to bid: ${tradePkg.tradeName} (CSI ${tradePkg.csiDivision}) - ${projectTitle}`,
    ref
  );
  const text = `Dear ${contractor.companyName} estimating team,

You are invited to submit a proposal for ${tradePkg.tradeName} on ${projectTitle} in ${project?.location || "the project area"}.

Mandatory inclusions:
${tradePkg.mandatoryInclusions.map((inc: string) => `- ${inc}`).join("\n")}

Bid deadline: ${tradePkg.bidDeadline}

Reply to this email with pre-bid questions and your proposal. Keep the reference [TP-${ref}] in the subject.

TradePulse Pay procurement`;
  return { subject, text, html: brandedHtml(text) };
}

/** One RFQ email to one bidder through the mailer. Demo companies never send external email. */
async function sendRfq(
  ctx: ActionCtx,
  tradePkg: any,
  project: any,
  contractor: any,
  mail: { companyId: any; isDemo: boolean }
): Promise<RfqOutcome> {
  if (mail.isDemo) return { status: "not_sent", reason: "Demo company: no external email is sent" };
  const to = String(contractor.contactEmail || "").trim();
  if (!to.includes("@")) return { status: "not_sent", reason: "no published email on file" };
  if (/\.invalid$/i.test(to)) return { status: "not_sent", reason: `contact email is not published (${to})` };

  const thread = await ctx.runMutation(internal.inboundEmail.ensureRfqThread, {
    projectId: tradePkg.projectId,
    tradePackageId: tradePkg._id,
    contractorId: contractor._id,
  });
  const content = rfqContent(tradePkg, project, contractor, thread.ref);
  const result = await sendEmail(ctx, {
    kind: "rfq",
    from: "rfq",
    to,
    ...content,
    idempotencyKey: `rfq.${contractor._id}.${contractor.dispatchedAt ?? 0}`,
    companyId: mail.companyId ?? undefined,
    projectId: tradePkg.projectId,
  });
  if (result.status === "sent") {
    if (result.threadId) {
      await ctx.runMutation(internal.inboundEmail.attachThreadId, { threadRowId: thread.threadRowId, threadId: result.threadId });
    }
    return { status: "sent", messageId: result.messageId };
  }
  if (result.status === "skipped_budget") return { status: "skipped_budget", reason: result.message };
  return { status: "failed", reason: result.error };
}

export const dispatchRfqsWithNotification = action({
  args: {
    tradePackageId: v.id("tradePackages"),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireProjectScopeInAction(ctx, { docs: [{ table: "tradePackages", id: args.tradePackageId }] }, { roles: ["gc"], write: true });
    // 1. Run mutation to mark contractors invited and package dispatched
    const result: any = await ctx.runMutation(internal.rfq.dispatchRfqsInternal, {
      tradePackageId: args.tradePackageId,
    });

    // 2. Fetch package details
    const tradePkg = await ctx.runQuery(internal.tradePackages.getPackageInternal, {
      tradePackageId: args.tradePackageId,
    });
    if (!tradePkg) throw new Error("Trade package not found");

    // Fetch project details for dynamic email subject & text
    const project = await ctx.runQuery(internal.projects.getProjectInternal, {
      projectId: tradePkg.projectId,
    });

    // 3. Fetch invited contractors
    const contractors = await ctx.runQuery(internal.contractors.listByPackageInternal, {
      tradePackageId: args.tradePackageId,
    });

    const deliveryConfigured = isAgentmailConfigured();
    const mail = await ctx.runQuery(internal.emailOutbox.projectMailContext, { projectId: tradePkg.projectId });
    let emailsSent = 0;
    const deliveryFailures: string[] = [];
    const deliveryResults: Array<{ contractorId: string; status: RfqOutcome["status"]; reason?: string }> = [];

    for (const contractor of contractors) {
      const outcome = await sendRfq(ctx, tradePkg, project, contractor, mail);
      deliveryResults.push({
        contractorId: contractor._id,
        status: outcome.status,
        reason: outcome.status === "sent" ? undefined : outcome.reason,
      });
      if (outcome.status === "sent") emailsSent++;
      else deliveryFailures.push(`${contractor.companyName}: ${outcome.reason.slice(0, 160)}`);
    }

    const eligibleRecipients = contractors.filter(
      (c: any) => c.contactEmail && c.contactEmail.includes("@") && !/\.invalid$/i.test(c.contactEmail)
    ).length;
    await ctx.runMutation(internal.auditLogs.recordLogInternal, {
      projectId: tradePkg.projectId,
      tradePackageId: args.tradePackageId,
      eventType: "rfq_dispatched",
      title: `AgentMail Delivery: ${emailsSent} of ${eligibleRecipients} eligible recipient(s)`,
      description:
        emailsSent > 0
          ? `Delivered ${emailsSent} invitation(s) from ${RFQ_INBOX}.${
              deliveryFailures.length > 0 ? ` Skipped/failed: ${deliveryFailures.slice(0, 3).join("; ")}` : ""
            }`
          : `No invitation email was sent.${
              deliveryFailures.length > 0 ? ` Reasons: ${deliveryFailures.slice(0, 3).join("; ")}` : ""
            }`,
      actor: "AgentMail Subcontractor Dispatcher",
    });

    return {
      ...result,
      emailsSent,
      deliveryConfigured,
      deliveryFailures,
      deliveryResults,
    };
  },
});

export const dispatchSingleRfqWithNotification = action({
  args: {
    contractorId: v.id("contractors"),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireProjectScopeInAction(ctx, { docs: [{ table: "contractors", id: args.contractorId }] }, { roles: ["gc"], write: true });
    // 1. Fetch contractor details
    const contractor = await ctx.runQuery(internal.contractors.getContractorInternal, {
      contractorId: args.contractorId,
    });
    if (!contractor) throw new Error("Contractor not found");

    // 2. Fetch trade package details
    const tradePkg = await ctx.runQuery(internal.tradePackages.getPackageInternal, {
      tradePackageId: contractor.tradePackageId,
    });
    if (!tradePkg) throw new Error("Trade package not found");

    // 3. Fetch project details
    const project = await ctx.runQuery(internal.projects.getProjectInternal, {
      projectId: tradePkg.projectId,
    });

    // 4. Update contractor status and log audit record
    await ctx.runMutation(internal.rfq.markSingleContractorInvitedInternal, {
      contractorId: args.contractorId,
      tradePackageId: tradePkg._id,
    });

    // 5. Dispatch the email through the mailer (re-read so the idempotency key uses the new dispatchedAt)
    const deliveryConfigured = isAgentmailConfigured();
    const invited = await ctx.runQuery(internal.contractors.getContractorInternal, { contractorId: args.contractorId });
    const mail = await ctx.runQuery(internal.emailOutbox.projectMailContext, { projectId: tradePkg.projectId });
    const outcome = await sendRfq(ctx, tradePkg, project, invited ?? contractor, mail);
    const emailSent = outcome.status === "sent";

    await ctx.runMutation(internal.auditLogs.recordLogInternal, {
      projectId: tradePkg.projectId,
      tradePackageId: tradePkg._id,
      eventType: "rfq_dispatched",
      title: `AgentMail Delivery: ${emailSent ? 1 : 0} of 1 eligible recipient(s)`,
      description: emailSent
        ? `Delivered invitation to ${contractor.contactEmail} from ${RFQ_INBOX}.`
        : `No email was sent to ${contractor.contactEmail}: ${outcome.reason}.`,
      actor: "AgentMail Subcontractor Dispatcher",
    });

    return {
      success: true,
      contractorId: args.contractorId,
      emailSent,
      emailStatus: outcome.status,
      emailError: outcome.status === "sent" ? undefined : outcome.reason,
      deliveryConfigured,
    };
  },
});