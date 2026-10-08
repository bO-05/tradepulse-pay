import { action } from "./_generated/server";
import { requireProjectScopeInAction } from "./lib/tenancyAction";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { createAgentmailInbox, isAgentmailConfigured, listAgentmailInboxes, sendAgentmailMessage } from "./agentmailApi";

export const provisionPackageInbox = action({
  args: {
    tradePackageId: v.id("tradePackages"),
    usernamePrefix: v.string(),
  },
  handler: async (ctx, args): Promise<{ email: string; id: string; live: boolean; shared: boolean }> => {
    await requireProjectScopeInAction(ctx, { docs: [{ table: "tradePackages", id: args.tradePackageId }] }, { roles: ["gc"], write: true });
    let mailboxEmail = `${args.usernamePrefix}-${Date.now().toString().slice(-4)}@agentmail.to`;
    let mailboxId = `local_inbox_${Date.now().toString().slice(-6)}`;
    let live = false;
    let shared = false;

    if (isAgentmailConfigured()) {
      try {
        const inbox = await createAgentmailInbox({
          username: `${args.usernamePrefix}-${Date.now().toString().slice(-4)}`,
          displayName: "TradePulse RFQ Portal",
        });
        mailboxEmail = inbox.email;
        mailboxId = inbox.id;
        live = true;
      } catch (err) {
        // Typical cause: the AgentMail plan's inbox limit is reached. Reuse an
        // existing inbox from the account so the workflow keeps working, and mark
        // it as shared so the UI can say so instead of pretending it is dedicated.
        console.warn("AgentMail inbox creation failed; attempting to reuse an existing inbox:", err);
        try {
          const existing = await listAgentmailInboxes(20);
          if (existing.length > 0) {
            const chosen = existing[Math.floor(Math.random() * existing.length)];
            mailboxEmail = chosen.email;
            mailboxId = chosen.id;
            live = true;
            shared = true;
          }
        } catch (listErr) {
          console.warn("AgentMail inbox reuse failed too; keeping a local placeholder:", listErr);
        }
      }
    }

    await ctx.runMutation(internal.tradePackages.updateMailbox, {
      tradePackageId: args.tradePackageId,
      agentMailbox: mailboxEmail,
      agentMailboxId: mailboxId,
      agentMailboxShared: shared,
    });

    return { email: mailboxEmail, id: mailboxId, live, shared };
  },
});

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
    let emailsSent = 0;
    const deliveryFailures: string[] = [];

    if (deliveryConfigured && tradePkg.agentMailboxId && !String(tradePkg.agentMailboxId).startsWith("local_")) {
      for (const contractor of contractors) {
        if (!contractor.contactEmail || !contractor.contactEmail.includes("@")) {
          deliveryFailures.push(`${contractor.companyName}: no published email on file`);
          continue;
        }
        if (/\.invalid$/i.test(contractor.contactEmail)) {
          deliveryFailures.push(`${contractor.companyName}: contact email is not published (${contractor.contactEmail})`);
          continue;
        }
        try {
          await sendAgentmailMessage({
            inboxId: tradePkg.agentMailboxId,
            to: contractor.contactEmail,
            subject: `INVITATION TO BID: ${tradePkg.tradeName} (CSI ${tradePkg.csiDivision}) - ${project?.title || "Commercial Development"}`,
            text: `Dear ${contractor.companyName} Estimating Team,\n\nYou are invited to submit a proposal for ${tradePkg.tradeName} for ${project?.title || "our commercial development"} located in ${project?.location || "the area"}.\n\nMandatory Inclusions:\n${tradePkg.mandatoryInclusions.map((inc: string) => `- ${inc}`).join("\n")}\n\nBid Deadline: ${tradePkg.bidDeadline}\n\nPlease submit all pre-bid RFIs and final proposals directly to this project email address: ${tradePkg.agentMailbox}.\n\nTradePulse Pro Procurement Team`,
          });
          emailsSent++;
        } catch (err: any) {
          deliveryFailures.push(`${contractor.companyName}: ${String(err?.message || err).slice(0, 160)}`);
          console.warn(`Failed to dispatch email to ${contractor.contactEmail}:`, err);
        }
      }
    } else if (!deliveryConfigured) {
      deliveryFailures.push("AGENTMAIL_API_KEY is not configured on this deployment");
    } else if (String(tradePkg.agentMailboxId).startsWith("local_")) {
      deliveryFailures.push("The trade package has no live AgentMail inbox (provisioning failed)");
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
          ? `Delivered ${emailsSent} invitation(s) from ${tradePkg.agentMailbox}.${
              deliveryFailures.length > 0 ? ` Skipped/failed: ${deliveryFailures.slice(0, 3).join("; ")}` : ""
            }`
          : `${deliveryConfigured ? "No AgentMail invitation was delivered." : "AgentMail is not configured on this deployment; no email was sent."}${
              deliveryFailures.length > 0 ? ` Reasons: ${deliveryFailures.slice(0, 3).join("; ")}` : ""
            }`,
      actor: "AgentMail Subcontractor Dispatcher",
    });

    return {
      ...result,
      emailsSent,
      deliveryConfigured,
      deliveryFailures,
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

    // 5. Dispatch email via AgentMail if available
    const deliveryConfigured = isAgentmailConfigured();
    let emailSent = false;
    const localMailbox = String(tradePkg.agentMailboxId).startsWith("local_");
    if (
      deliveryConfigured &&
      !localMailbox &&
      contractor.contactEmail &&
      contractor.contactEmail.includes("@") &&
      !/\.invalid$/i.test(contractor.contactEmail)
    ) {
      try {
        await sendAgentmailMessage({
          inboxId: tradePkg.agentMailboxId,
          to: contractor.contactEmail,
          subject: `INVITATION TO BID: ${tradePkg.tradeName} (CSI ${tradePkg.csiDivision}) - ${project?.title || "Commercial Development"}`,
          text: `Dear ${contractor.companyName} Estimating Team,\n\nYou are invited to submit a proposal for ${tradePkg.tradeName} on ${project?.title || "our commercial development"} located in ${project?.location || "the area"}.\n\nMandatory Inclusions:\n${tradePkg.mandatoryInclusions.map((inc: string) => `- ${inc}`).join("\n")}\n\nBid Deadline: ${tradePkg.bidDeadline}\n\nPlease submit all pre-bid RFIs and final proposals directly to this project email address: ${tradePkg.agentMailbox}.\n\nTradePulse Pro Procurement Team`,
        });
        emailSent = true;
      } catch (err) {
        console.warn(`Failed to dispatch single RFQ email to ${contractor.contactEmail}:`, err);
      }
    }

    await ctx.runMutation(internal.auditLogs.recordLogInternal, {
      projectId: tradePkg.projectId,
      tradePackageId: tradePkg._id,
      eventType: "rfq_dispatched",
      title: `AgentMail Delivery: ${emailSent ? 1 : 0} of 1 eligible recipient(s)`,
      description: emailSent
        ? `Delivered invitation to ${contractor.contactEmail} from ${tradePkg.agentMailbox}.`
        : `No email was delivered to ${contractor.contactEmail}.${
            !deliveryConfigured ? " AgentMail is not configured on this deployment." : localMailbox ? " The package has no live AgentMail inbox." : ""
          }`,
      actor: "AgentMail Subcontractor Dispatcher",
    });

    return {
      success: true,
      contractorId: args.contractorId,
      emailSent,
      deliveryConfigured,
    };
  },
});