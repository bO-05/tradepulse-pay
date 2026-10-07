import { query, mutation, internalMutation, internalQuery, action } from "./_generated/server";
import { requireRole, requireRoleInAction } from "./lib/roles";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";

export const listConversations = query({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conversations")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .order("desc")
      .collect();
  },
});

/**
 * A6-29: the real outcome of the last RFQ email dispatch per package, so the UI
 * can state "delivery unavailable" instead of implying email was sent.
 */
export const getProjectDeliveryStatus = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("auditLogs")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const byPackage: Record<string, { sent: number; eligible: number; at: number }> = {};
    for (const log of logs) {
      if (!log.tradePackageId) continue;
      const match = /^AgentMail Delivery:\s*(\d+)\s+of\s+(\d+)/i.exec(log.title);
      if (!match) continue;
      const previous = byPackage[log.tradePackageId];
      if (!previous || log.timestamp > previous.at) {
        byPackage[log.tradePackageId] = { sent: Number(match[1]), eligible: Number(match[2]), at: log.timestamp };
      }
    }
    return byPackage;
  },
});

export const listClarifiedConversationsForProject = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const packages = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const clarified: any[] = [];
    const pending: any[] = [];
    for (const pkg of packages) {
      const convos = await ctx.db
        .query("conversations")
        .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
        .collect();
      for (const c of convos) {
        if (c.status === "clarified" && c.pmCertifiedAt) {
          clarified.push({
            ...c,
            csiDivision: pkg.csiDivision,
            tradeName: pkg.tradeName,
          });
        } else if (c.status !== "rejected") {
          pending.push({
            ...c,
            csiDivision: pkg.csiDivision,
            tradeName: pkg.tradeName,
          });
        }
      }
    }
    return { clarified, pending };
  },
});

export const dispatchRfqs = mutation({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");

    const contractors = await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();

    if (contractors.length === 0) {
      throw new ConvexError(
        "No contractors have been discovered for this trade package yet. Run Discovery before dispatching RFQs."
      );
    }

    let dispatchedCount = 0;
    const now = Date.now();

    for (const c of contractors) {
      if (c.rfqStatus === "discovered") {
        await ctx.db.patch(c._id, {
          rfqStatus: "invited",
          dispatchedAt: now,
        });
        dispatchedCount++;
      }
    }

    const totalNotified = dispatchedCount > 0 ? dispatchedCount : contractors.length;

    await ctx.db.patch(args.tradePackageId, {
      status: "rfqs_dispatched",
    });

    // Record in reactive audit stream
    await ctx.db.insert("auditLogs", {
      projectId: tradePkg.projectId,
      tradePackageId: tradePkg._id,
      eventType: "rfq_dispatched",
      title: `RFQ Invitations Recorded: Division ${tradePkg.csiDivision} (${tradePkg.tradeName})`,
      description: `RFQ invitations recorded for ${totalNotified} contractor(s); AgentMail delivery results are logged by the dispatch action (${tradePkg.agentMailbox}).`,
      actor: "Lead Project Manager",
      timestamp: now,
    });

    return {
      success: true,
      tradePackageId: args.tradePackageId,
      dispatchedCount: totalNotified,
      agentMailbox: tradePkg.agentMailbox,
    };
  },
});

export const dispatchRfqsInternal = internalMutation({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");

    const contractors = await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();

    if (contractors.length === 0) {
      throw new ConvexError(
        "No contractors have been discovered for this trade package yet. Run Discovery before dispatching RFQs."
      );
    }

    let dispatchedCount = 0;
    const now = Date.now();

    for (const c of contractors) {
      if (c.rfqStatus === "discovered") {
        await ctx.db.patch(c._id, {
          rfqStatus: "invited",
          dispatchedAt: now,
        });
        dispatchedCount++;
      }
    }

    const totalNotified = dispatchedCount > 0 ? dispatchedCount : contractors.length;

    await ctx.db.patch(args.tradePackageId, {
      status: "rfqs_dispatched",
    });

    // Record in reactive audit stream
    await ctx.db.insert("auditLogs", {
      projectId: tradePkg.projectId,
      tradePackageId: tradePkg._id,
      eventType: "rfq_dispatched",
      title: `RFQ Invitations Recorded: Division ${tradePkg.csiDivision} (${tradePkg.tradeName})`,
      description:
        dispatchedCount > 0
          ? `Recorded ${dispatchedCount} commercial contractor(s) as invited for ${tradePkg.agentMailbox}; email delivery is attempted and logged separately.`
          : `No new invitations were required: ${totalNotified} contractor(s) are already invited. Package marked as RFQs dispatched (${tradePkg.agentMailbox}).`,
      actor: "Lead Project Manager",
      timestamp: now,
    });

    return {
      success: true,
      tradePackageId: args.tradePackageId,
      dispatchedCount: totalNotified,
      agentMailbox: tradePkg.agentMailbox,
    };
  },
});

export const markSingleContractorInvitedInternal = internalMutation({
  args: {
    contractorId: v.id("contractors"),
    tradePackageId: v.id("tradePackages"),
  },
  handler: async (ctx, args) => {
    const contractor = await ctx.db.get(args.contractorId);
    if (!contractor) throw new Error("Contractor not found");

    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");

    const now = Date.now();
    await ctx.db.patch(args.contractorId, {
      rfqStatus: "invited",
      dispatchedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      projectId: tradePkg.projectId,
      tradePackageId: tradePkg._id,
      eventType: "rfq_dispatched",
      title: `RFQ Invitation Prepared: ${contractor.companyName}`,
      description: `Marked ${contractor.companyName} as invited for ${tradePkg.tradeName} (${tradePkg.csiDivision}); the invitation targets ${contractor.contactEmail}. Email delivery is attempted and logged separately.`,
      actor: "AgentMail Subcontractor Dispatcher",
      timestamp: now,
    });

    return { success: true };
  },
});

/**
 * F1 durability: persist the submitted RFI text BEFORE any LLM work so a
 * failed/slow analysis can never drop a subcontractor's formal question.
 * Returns the new conversation id.
 */
export async function persistPendingRfi(
  ctx: any,
  args: {
    tradePackageId: any;
    contractorId: any;
    threadId: string;
    inboundSubject: string;
    inboundQuestion: string;
  }
) {
  const contractor = await ctx.db.get(args.contractorId);
  if (!contractor || contractor.tradePackageId !== args.tradePackageId) {
    throw new Error("The RFI contractor does not belong to the selected trade package.");
  }
  if (contractor.rfqStatus !== "bid_received") {
    await ctx.db.patch(args.contractorId, { rfqStatus: "rfi_submitted" });
  }
  return await ctx.db.insert("conversations", {
    tradePackageId: args.tradePackageId,
    contractorId: args.contractorId,
    threadId: args.threadId,
    inboundSubject: args.inboundSubject,
    inboundQuestion: args.inboundQuestion,
    autonomousReply: "",
    confidenceScore: 0,
    status: "pending_analysis",
    timestamp: Date.now(),
  });
}

export const createPendingInboundRfi = internalMutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    contractorId: v.id("contractors"),
    threadId: v.string(),
    inboundSubject: v.string(),
    inboundQuestion: v.string(),
  },
  handler: async (ctx, args) => {
    return await persistPendingRfi(ctx, args);
  },
});

export const getConversationInternal = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.conversationId);
  },
});

/**
 * Marks an RFI as answered (or escalated) after the analysis step succeeds.
 * Keeps the contractor validation so a stale/mismatched retry cannot complete.
 */
export const completeInboundRfi = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    autonomousReply: v.string(),
    confidenceScore: v.number(),
    status: v.union(v.literal("clarified"), v.literal("escalated_to_pm")),
  },
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.conversationId);
    if (!convo) throw new Error("The RFI record no longer exists.");
    const contractor = await ctx.db.get(convo.contractorId);
    if (!contractor || contractor.tradePackageId !== convo.tradePackageId) {
      throw new Error("The RFI contractor no longer belongs to the selected trade package.");
    }

    await ctx.db.patch(args.conversationId, {
      autonomousReply: args.autonomousReply,
      confidenceScore: args.confidenceScore,
      status: args.status,
      analysisError: undefined,
    });

    const tradePkg = await ctx.db.get(convo.tradePackageId);
    if (tradePkg) {
      const isEscalated = args.status === "escalated_to_pm";
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        eventType: isEscalated ? "compliance_audit" : "rfi_clarified",
        title: isEscalated
          ? `Pre-Bid RFI Escalated to PM: ${convo.inboundSubject}`
          : `Pre-Bid RFI Clarified: ${convo.inboundSubject}`,
        description: isEscalated
          ? `Subcontractor inquiry from ${contractor?.companyName || "Contractor"} flagged for human PM review (scope waiver, schedule extension, or low confidence threshold).`
          : `TradePulse AI autonomously answered pre-bid question for ${contractor?.companyName || "Contractor"} with ${Math.round(args.confidenceScore * 100)}% model confidence.`,
        actor: isEscalated ? "Autonomous Pre-Bid Governance" : "TradePulse AI Spec Agent",
        timestamp: Date.now(),
      });
    }

    return args.conversationId;
  },
});

/**
 * F1 durability: record an analysis failure on the persisted RFI row so the
 * submitted text, the error, and a retry affordance survive a refresh.
 */
export const failInboundRfiAnalysis = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.conversationId);
    if (!convo) throw new Error("The RFI record no longer exists.");
    const shortError = args.error.slice(0, 400);
    await ctx.db.patch(args.conversationId, {
      status: "failed_analysis",
      analysisError: shortError,
    });
    const tradePkg = await ctx.db.get(convo.tradePackageId);
    if (tradePkg) {
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        eventType: "compliance_audit",
        title: `RFI Analysis Failed — Retry Available: ${convo.inboundSubject}`,
        description: `Automated clarification could not complete (${shortError}). The submitted question is preserved and can be retried from the Pre-Bid Q&A queue.`,
        actor: "TradePulse AI Spec Agent",
        timestamp: Date.now(),
      });
    }
    return args.conversationId;
  },
});

/**
 * Pre-Bid Escalated RFI Review Queue:
 * Allows Project Managers to review, approve, edit, or reject escalated subcontractor RFIs
 * before they are certified into official binding legal addenda.
 */
export const reviewEscalatedRfi = mutation({
  args: {
    conversationId: v.id("conversations"),
    status: v.union(v.literal("clarified"), v.literal("escalated_to_pm"), v.literal("rejected")),
    autonomousReply: v.optional(v.string()),
    reviewNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const convo = await ctx.db.get(args.conversationId);
    if (!convo) throw new Error("Conversation not found");
    const convoContractor = await ctx.db.get(convo.contractorId);
    if (!convoContractor || convoContractor.tradePackageId !== convo.tradePackageId) {
      throw new Error("The RFI is linked to an invalid contractor/package relationship.");
    }

    const patchData: any = {
      status: args.status,
    };
    if (args.autonomousReply !== undefined) {
      patchData.autonomousReply = args.autonomousReply;
    }
    if (args.status === "clarified") {
      patchData.pmCertifiedAt = Date.now();
      patchData.pmCertifiedBy = "Project Manager";
      patchData.reviewNote = args.reviewNote || "Approved by Project Manager for Addendum NO. 01";
    } else {
      patchData.pmCertifiedAt = undefined;
      patchData.pmCertifiedBy = undefined;
      if (args.reviewNote !== undefined) patchData.reviewNote = args.reviewNote;
    }
    await ctx.db.patch(args.conversationId, patchData);

    const tradePkg = await ctx.db.get(convo.tradePackageId);
    if (tradePkg) {
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        eventType: args.status === "clarified" ? "rfi_clarified" : "compliance_audit",
        title: `PM RFI Review: ${args.status === "clarified" ? "Approved for Addendum" : args.status.toUpperCase()}`,
        description: `Project Manager reviewed RFI '${convo.inboundSubject}'. Status updated to ${args.status}.${args.reviewNote ? ` Note: ${args.reviewNote}` : ""}`,
        actor: "Project Manager (PM Review Queue)",
        timestamp: Date.now(),
      });
    }

    return { success: true, conversationId: args.conversationId, status: args.status };
  },
});

/**
 * Pre-Bid Legal Addendum Generator:
 * Compiles all clarified pre-bid RFIs across project trade packages
 * into binding CSI MasterFormat ADDENDUM NO. 01 stored in Convex File Storage.
 */
export const generatePreBidAddendum = action({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.optional(v.id("tradePackages")),
    addendumNumber: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireRoleInAction(ctx, ["gc"]);
    // Delegate to the storage-backed generator in files.ts to ensure single source of truth
    return await ctx.runAction(internal.files.generatePreBidAddendumInternal, {
      projectId: args.projectId,
      tradePackageId: args.tradePackageId,
      addendumNumber: args.addendumNumber,
    });
  },
});
