import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { OFFLINE_RULES_ENGINE } from "./lib/aiLabels";
import { cleanNumber, sanitizeBidLevelingOutput, augmentExclusionsWithDeterministicGaps, applyExplicitExclusionAmounts, applyUnpricedExclusionBenchmarks, normalizeExclusionSeverity, normalizeLeadWeeksFromText, detectCoiDeficiency, detectCoiAffirmativeCompliance } from "./llmRouter";
import { sendAgentmailMessage } from "./agentmailApi";
import { COI_DEFICIENCY_PENALTY, leadTimePenaltyFor, targetWeeksForDivision } from "./terms";

export const processInboundEmail = internalAction({
  args: {
    inboxId: v.string(),
    messageId: v.string(),
    threadId: v.string(),
    text: v.string(),
    subject: v.string(),
    from: v.string(),
    tradePackageId: v.optional(v.id("tradePackages")),
    contractorId: v.optional(v.id("contractors")),
    attachments: v.optional(v.array(v.any())),
  },
  handler: async (ctx, args) => {
    if (!args.tradePackageId) {
      console.warn("Could not determine tradePackageId for inbound message:", args.subject);
      return;
    }

    let contractorId = args.contractorId;
    if (!contractorId) {
      let contractor: any = await ctx.runQuery(internal.simulation.findContractorByEmail, {
        tradePackageId: args.tradePackageId,
        email: args.from,
      });
      if (!contractor) {
        const newId: any = await ctx.runMutation(internal.simulation.createSimulatedContractor, {
          tradePackageId: args.tradePackageId,
          fromEmail: args.from,
        });
        contractor = { _id: newId };
      }
      contractorId = contractor._id;
    }

    const textLower = args.text.toLowerCase();
    const subjectLower = args.subject.toLowerCase();

    // Distinguish proposals/bids from pure pre-bid RFIs/inquiries
    const hasAttachment = Boolean(args.attachments && args.attachments.length > 0);
    const hasExplicitBidKeyword =
      subjectLower.includes("proposal") ||
      subjectLower.includes("quote") ||
      subjectLower.includes("bid submittal") ||
      subjectLower.includes("bid submission") ||
      subjectLower.includes("formal bid") ||
      subjectLower.includes("quotation") ||
      textLower.includes("base bid") ||
      textLower.includes("we propose to furnish") ||
      textLower.includes("lump sum quotation") ||
      textLower.includes("lump sum base bid") ||
      textLower.includes("lump sum price") ||
      textLower.includes("total lump sum") ||
      /\$[0-9,]{4,}/.test(args.text);

    const isPureRfi =
      (subjectLower.startsWith("rfi") || subjectLower.includes("rfi #") || textLower.startsWith("rfi")) &&
      !hasAttachment &&
      !hasExplicitBidKeyword;

    // Save attachments to project files if present
    let attachedQuoteText = "";
    if (hasAttachment && args.attachments) {
      for (const att of args.attachments) {
        const attName = att.filename || att.name || "Subcontractor_Quote.pdf";
        const attSize = att.size || att.file_size || 50000;
        const attUrl = att.url || att.download_url || `email_attachment_${Date.now()}`;
        try {
          const tradePkg: any = await ctx.runQuery(internal.tradePackages.getPackageInternal, {
            tradePackageId: args.tradePackageId,
          });
          if (tradePkg) {
            await ctx.runMutation(internal.files.saveFileRecordInternal, {
              projectId: tradePkg.projectId,
              tradePackageId: args.tradePackageId,
              storageId: attUrl,
              fileName: attName,
              fileType: "quote_pdf",
              fileSize: attSize,
              uploadedBy: args.from,
            });
          }
        } catch (fileErr) {
          console.warn("Failed to store email attachment record:", fileErr);
        }

        if (att.text) {
          attachedQuoteText += `\n[Attachment: ${attName}]\n${att.text}`;
        }
      }
    }

    const isBid = !isPureRfi && (hasExplicitBidKeyword || hasAttachment);
    const fullContent = attachedQuoteText ? `${args.text}\n\n${attachedQuoteText}` : args.text;

    if (!contractorId) {
      console.warn("Could not resolve a contractor for inbound message:", args.subject);
      return;
    }

    if (isBid) {
      await ctx.runAction(internal.emailActions.handleBidProcessing, {
        tradePackageId: args.tradePackageId,
        contractorId,
        fromEmail: args.from,
        subject: args.subject,
        text: fullContent,
      });
    } else {
      // F1 durability: persist the inbound question before the LLM step so a
      // failed analysis can never drop a subcontractor's RFI.
      const conversationId: any = await ctx.runMutation(internal.rfq.createPendingInboundRfi, {
        tradePackageId: args.tradePackageId,
        contractorId,
        threadId: args.threadId,
        inboundSubject: args.subject,
        inboundQuestion: args.text,
      });
      await ctx.runAction(internal.emailActions.handleRfiProcessing, {
        tradePackageId: args.tradePackageId,
        contractorId,
        fromEmail: args.from,
        subject: args.subject,
        text: args.text,
        threadId: args.threadId,
        conversationId,
      });
    }
  },
});

export const processSimulatedInbound = internalAction({
  args: {
    tradePackageId: v.id("tradePackages"),
    fromEmail: v.string(),
    subject: v.string(),
    bodyText: v.string(),
    isBid: v.boolean(),
  },
  handler: async (ctx, args) => {
    // 1. Find contractor by fromEmail in this trade package or create one
    let contractor: any = await ctx.runQuery(internal.simulation.findContractorByEmail, {
      tradePackageId: args.tradePackageId,
      email: args.fromEmail,
    });

    if (!contractor) {
      const contractorId: any = await ctx.runMutation(internal.simulation.createSimulatedContractor, {
        tradePackageId: args.tradePackageId,
        fromEmail: args.fromEmail,
      });
      contractor = { _id: contractorId };
    }

    if (args.isBid) {
      await ctx.runAction(internal.emailActions.handleBidProcessing, {
        tradePackageId: args.tradePackageId,
        contractorId: contractor._id,
        fromEmail: args.fromEmail,
        subject: args.subject,
        text: args.bodyText,
      });
    } else {
      // F1 durability: persist the question before analysis.
      const conversationId: any = await ctx.runMutation(internal.rfq.createPendingInboundRfi, {
        tradePackageId: args.tradePackageId,
        contractorId: contractor._id,
        threadId: `sim_th_${Date.now().toString().slice(-6)}`,
        inboundSubject: args.subject,
        inboundQuestion: args.bodyText,
      });
      await ctx.runAction(internal.emailActions.handleRfiProcessing, {
        tradePackageId: args.tradePackageId,
        contractorId: contractor._id,
        fromEmail: args.fromEmail,
        subject: args.subject,
        text: args.bodyText,
        threadId: `sim_th_${Date.now().toString().slice(-6)}`,
        conversationId,
      });
    }
  },
});

export const handleRfiProcessing = internalAction({
  args: {
    tradePackageId: v.id("tradePackages"),
    contractorId: v.optional(v.id("contractors")),
    fromEmail: v.string(),
    subject: v.string(),
    text: v.string(),
    threadId: v.string(),
    // Present when the RFI row was persisted before analysis (F1 durability).
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    let contractorId = args.contractorId;
    if (!contractorId) {
      let contractor: any = await ctx.runQuery(internal.simulation.findContractorByEmail, {
        tradePackageId: args.tradePackageId,
        email: args.fromEmail,
      });
      if (!contractor) {
        const newId: any = await ctx.runMutation(internal.simulation.createSimulatedContractor, {
          tradePackageId: args.tradePackageId,
          fromEmail: args.fromEmail,
        });
        contractor = { _id: newId };
      }
      contractorId = contractor._id;
    }

    // F1: persistence-first. If the caller did not already create the row, create
    // it now — before the LLM call — so the submitted text survives any failure.
    let conversationId = args.conversationId;
    if (!conversationId && contractorId) {
      try {
        conversationId = await ctx.runMutation(internal.rfq.createPendingInboundRfi, {
          tradePackageId: args.tradePackageId,
          contractorId,
          threadId: args.threadId,
          inboundSubject: args.subject,
          inboundQuestion: args.text,
        });
      } catch (persistErr) {
        console.error("Could not persist inbound RFI before analysis:", persistErr);
      }
    }

    try {
      if (conversationId) {
        const existing: any = await ctx.runQuery(internal.rfq.getConversationInternal, { conversationId });
        if (existing && (existing.status === "clarified" || existing.status === "escalated_to_pm")) {
          return; // idempotent guard: this RFI was already answered
        }
      }

      const tradePkg = await ctx.runQuery(internal.tradePackages.getPackageInternal, {
        tradePackageId: args.tradePackageId,
      });

      // Call LLM Router for RFI reply
      const llmResult = await ctx.runAction(internal.llmRouter.executeReasoning, {
        taskType: "rfi_reply",
        prompt: `Inbound Contractor Subject: ${args.subject}\nInbound Question: ${args.text}\nContext: CSI MasterFormat Commercial Subcontractor Procurement for CSI ${tradePkg?.csiDivision || "trade"} (${tradePkg?.tradeName || "Trade Package"}). Mandatory inclusions: ${(tradePkg?.mandatoryInclusions || []).join("; ")}. Answer authoritatively referencing Division 01 General Requirements and Section ${tradePkg?.csiDivision || "specifications"}. Format the answer as concise markdown: a one-line determination, the specific reasons with spec/section references, and any action required of the bidder.`,
        systemPrompt: "You are the TradePulse Pro Autonomous RFI Clarification Agent. Respond factually and clearly to subcontractor pre-bid questions based on contract specifications.",
      });

      const subjectLower = args.subject.toLowerCase();
      const textLower = args.text.toLowerCase();
      const isEscalationRequest =
        subjectLower.includes("extension") ||
        subjectLower.includes("waiver") ||
        subjectLower.includes("exception") ||
        subjectLower.includes("liquidated damages") ||
        subjectLower.includes("retainage") ||
        subjectLower.includes("subcontract terms") ||
        textLower.includes("extension") ||
        textLower.includes("waiver") ||
        textLower.includes("exception rider") ||
        textLower.includes("liquidated damages") ||
        textLower.includes("waive") ||
        (llmResult.confidenceScore !== undefined && llmResult.confidenceScore < 0.92);

      const rfiStatus: "clarified" | "escalated_to_pm" = isEscalationRequest ? "escalated_to_pm" : "clarified";

      if (conversationId) {
        await ctx.runMutation(internal.rfq.completeInboundRfi, {
          conversationId,
          autonomousReply: llmResult.content,
          confidenceScore: llmResult.confidenceScore ?? 0.96,
          status: rfiStatus,
        });
      }

      // Attempt outbound email via AgentMail if configured (never for escalated RFIs requiring PM approval)
      const agentMailKey = process.env.AGENTMAIL_API_KEY;
      if (agentMailKey && args.fromEmail.includes("@") && rfiStatus !== "escalated_to_pm") {
        try {
          if (tradePkg?.agentMailboxId && !String(tradePkg.agentMailboxId).startsWith("local_")) {
            await sendAgentmailMessage({
              inboxId: tradePkg.agentMailboxId,
              to: args.fromEmail,
              subject: `RE: ${args.subject}`,
              text: llmResult.content,
            });
          }
        } catch (err) {
          console.warn("Outbound AgentMail dispatch failed (offline or test env):", err);
        }
      }
    } catch (analysisErr: any) {
      const message = analysisErr?.message || String(analysisErr);
      console.error("RFI analysis failed; the submitted question is preserved for retry:", message);
      if (conversationId) {
        try {
          await ctx.runMutation(internal.rfq.failInboundRfiAnalysis, {
            conversationId,
            error: message,
          });
        } catch (markErr) {
          console.error("Could not mark the RFI as failed:", markErr);
        }
      }
    }
  },
});

export const handleBidProcessing = internalAction({
  args: {
    tradePackageId: v.id("tradePackages"),
    contractorId: v.optional(v.id("contractors")),
    fromEmail: v.string(),
    subject: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    try {
    let contractorId = args.contractorId;
    if (!contractorId) {
      let contractor: any = await ctx.runQuery(internal.simulation.findContractorByEmail, {
        tradePackageId: args.tradePackageId,
        email: args.fromEmail,
      });
      if (!contractor) {
        const newId: any = await ctx.runMutation(internal.simulation.createSimulatedContractor, {
          tradePackageId: args.tradePackageId,
          fromEmail: args.fromEmail,
        });
        contractor = { _id: newId };
      }
      contractorId = contractor._id;
    }
    if (!contractorId) return;

    const tradePkg = await ctx.runQuery(internal.tradePackages.getPackageInternal, {
      tradePackageId: args.tradePackageId,
    });
    const contractorRecord = await ctx.runQuery(internal.contractors.getContractorInternal, {
      contractorId,
    });
    const subName = contractorRecord?.companyName || "Commercial Subcontractor";

    // Call LLM Router for forensic Bid Leveling extraction
    const llmResult = await ctx.runAction(internal.llmRouter.executeReasoning, {
      taskType: "bid_leveling",
      prompt: `Analyze this commercial subcontractor bid proposal for ${tradePkg?.tradeName || "Trade"} (CSI ${tradePkg?.csiDivision || ""}):\nMandatory package requirements: ${(tradePkg?.mandatoryInclusions || []).join("; ")}\nContractor: ${subName}\nSubject: ${args.subject}\nBody:\n${args.text}\nIdentify base bid amount, line items, subtle scope exclusions, crane hoisting exclusions, long lead times, and insurance compliance. Return structured bid leveling data.`,
      division: tradePkg?.csiDivision,
    });

    let bidData: any = llmResult.parsedJson;

    if (!bidData) {
      try {
        bidData = JSON.parse(llmResult.content);
      } catch {
        // Deterministic forensic fallback parser
        const text = args.text;
        const lower = text.toLowerCase();
        const baseMatch =
          text.match(/(?:Base\s*Bid(?:\s*Price)?|lump\s*sum(?:\s*quotation|\s*base\s*bid|\s*price|\s*amount|\s*proposal)?|total\s*(?:lump\s*sum|amount|price|quote)|amount|price)[:\s]*(?:of\s*)?([$€£CAD\s]*[0-9][0-9.,\s]*(?:[kKmMbB])?)/i) ||
          text.match(/lump\s*sum(?:\s*quotation|\s*base\s*bid|\s*price)?:\s*([$€£CAD\s]*[0-9][0-9.,\s]*(?:[kKmMbB])?)/i) ||
          text.match(/[$€£]\s*([0-9][0-9.,\s]{3,})/);
        const parsedBase = baseMatch ? cleanNumber(baseMatch[1], 1100000) : 1100000;

        const exclusions = [];
        let exclusionsCost = 0;
        const isCraneExcluded =
          (lower.includes("crane") || lower.includes("hoisting")) &&
          (lower.includes("excluded") || lower.includes("gc to furnish") || lower.includes("by others") || lower.includes("not included"));
        if (isCraneExcluded) {
          exclusions.push({
            description: "Crane hoisting & rigging to penthouse mechanical floor excluded (GC to furnish)",
            costImpact: 45000,
            severity: "critical",
          });
          exclusionsCost += 45000;
        }
        const isFirestopExcluded =
          (lower.includes("firestopping") || lower.includes("firestop")) &&
          (lower.includes("excluded") || lower.includes("by others") || lower.includes("not included"));
        if (isFirestopExcluded) {
          exclusions.push({
            description: "UL 1479 firestop floor penetrations excluded (By drywall trade)",
            costImpact: 22000,
            severity: "critical",
          });
          exclusionsCost += 22000;
        }
        const isOvertimeExcluded =
          lower.includes("overtime") &&
          (lower.includes("excluded") || lower.includes("straight time only") || lower.includes("not included"));
        if (isOvertimeExcluded) {
          exclusions.push({
            description: "Overtime/weekend acceleration excluded from base rate",
            costImpact: 25000,
            severity: "moderate",
          });
          exclusionsCost += 25000;
        }

        const leadWeeksMatch = text.match(/(\d+)\s*weeks/i);
        const leadWeeks = leadWeeksMatch ? parseInt(leadWeeksMatch[1]) : 12;
        const targetWeeks = targetWeeksForDivision(tradePkg?.csiDivision);
        const leadPenalty = leadTimePenaltyFor(leadWeeks, targetWeeks);
        const coiDeficient =
          text.toLowerCase().includes("coi deficient") ||
          text.toLowerCase().includes("waiver of subrogation excluded") ||
          text.toLowerCase().includes("additional insured excluded") ||
          text.toLowerCase().includes("missing acord 25");
        const coiPenalty = coiDeficient ? 15000 : 0;

        const divCode = (tradePkg?.csiDivision || "26").slice(0, 2);
        let fallbackLineItems = [
          { item: "Main Switchgear & Primary Distribution (Base Scope)", unit: "LS", quantity: 1, unitCost: parsedBase * 0.4, totalCost: parsedBase * 0.4 },
          { item: "Emergency Lighting & Feeders", unit: "LS", quantity: 1, unitCost: parsedBase * 0.35, totalCost: parsedBase * 0.35 },
          { item: "Branch Power & Distribution Hookups", unit: "LS", quantity: 1, unitCost: parsedBase * 0.25, totalCost: parsedBase * 0.25 },
        ];

        if (divCode === "22") {
          fallbackLineItems = [
            { item: "Sanitary Waste & Cast-Iron Hubless DWV Rough-In", unit: "LS", quantity: 1, unitCost: parsedBase * 0.45, totalCost: parsedBase * 0.45 },
            { item: "Domestic Water Heaters & Hot/Cold Distribution", unit: "LS", quantity: 1, unitCost: parsedBase * 0.35, totalCost: parsedBase * 0.35 },
            { item: "Commercial Plumbing Fixtures & Backflow Assemblies", unit: "LS", quantity: 1, unitCost: parsedBase * 0.2, totalCost: parsedBase * 0.2 },
          ];
        } else if (divCode === "23") {
          fallbackLineItems = [
            { item: "Rooftop Air Handling Units & Hydronic Chilled Water Piping", unit: "LS", quantity: 1, unitCost: parsedBase * 0.5, totalCost: parsedBase * 0.5 },
            { item: "Supply & Return Galvanized SMACNA Ductwork", unit: "LS", quantity: 1, unitCost: parsedBase * 0.3, totalCost: parsedBase * 0.3 },
            { item: "VAV Terminal Reheat Units & Air Balancing", unit: "LS", quantity: 1, unitCost: parsedBase * 0.2, totalCost: parsedBase * 0.2 },
          ];
        }

        bidData = {
          subcontractorName: subName,
          baseBidAmount: parsedBase,
          lineItems: fallbackLineItems,
          identifiedExclusions: exclusions,
          valueEngineeringAlternates: [],
          longLeadEquipmentWeeks: leadWeeks,
          leadTimePenalty: leadPenalty,
          coiComplianceStatus: coiDeficient ? "deficiency_detected" : "compliant",
          coiPenalty: coiPenalty,
          leveledTotalCost: Math.max(0, parsedBase + exclusionsCost + leadPenalty + coiPenalty),
        };
      }
    }

    bidData = sanitizeBidLevelingOutput(bidData, { division: tradePkg?.csiDivision });
    if (Array.isArray(bidData?.identifiedExclusions)) {
      // A7CONV-R9B/R15A: scope-gap safety net, unpriced benchmarks, stated
      // amounts (which always win), then severity.
      bidData.identifiedExclusions = normalizeExclusionSeverity(
        applyExplicitExclusionAmounts(
          applyUnpricedExclusionBenchmarks(
            augmentExclusionsWithDeterministicGaps(
              bidData.identifiedExclusions,
              args.text,
              tradePkg?.csiDivision
            ),
            args.text,
            tradePkg?.csiDivision
          ),
          args.text
        )
      );
    }
    // A7CONV-R6C-2/R14A-F1: the proposal text is the source of truth for a stated
    // COI position, in both directions.
    if (detectCoiDeficiency(args.text)) {
      bidData.coiComplianceStatus = "deficiency_detected";
      bidData.coiPenalty = COI_DEFICIENCY_PENALTY;
    } else if (
      bidData.coiComplianceStatus === "deficiency_detected" &&
      detectCoiAffirmativeCompliance(args.text)
    ) {
      bidData.coiComplianceStatus = "compliant";
      bidData.coiPenalty = 0;
    }

    const effectiveBaseBid = bidData.baseBidAmount ?? 0;
    const effectiveLeadTargetWeeks = bidData.leadTimeTargetWeeks ?? targetWeeksForDivision(tradePkg?.csiDivision);
    const effectiveLeadWeeks = normalizeLeadWeeksFromText(bidData.longLeadEquipmentWeeks ?? 12, args.text);
    const effectiveLeadPenalty = leadTimePenaltyFor(effectiveLeadWeeks, effectiveLeadTargetWeeks);
    const effectiveCoiStatus = bidData.coiComplianceStatus ?? "compliant";
    const effectiveCoiPenalty = bidData.coiPenalty ?? 0;

    // ADR-0003 Deterministic Formula:
    // Leveled Cost = Base Bid + Sum(Scope Gaps) + Lead Time Penalty + COI Penalty - Accepted Alternates
    const scopeGapsSum = (bidData.identifiedExclusions || []).reduce(
      (sum: number, exc: any) => (exc.isWaived ? sum : sum + (exc.costImpact || 0)),
      0
    );
    const acceptedVeDeduct = (bidData.valueEngineeringAlternates || []).reduce(
      (sum: number, ve: any) => (ve.isAccepted ? sum + (ve.costDeduct || 0) : sum),
      0
    );
    const calculatedLeveledCost = Math.max(
      0,
      effectiveBaseBid +
      scopeGapsSum +
      effectiveLeadPenalty +
      effectiveCoiPenalty -
      acceptedVeDeduct
    );

    // Insert Leveled Bid
    await ctx.runMutation(internal.bids.insertParsedBid, {
      tradePackageId: args.tradePackageId,
      contractorId,
      subcontractorName: bidData.subcontractorName || subName,
      baseBidAmount: effectiveBaseBid,
      lineItems: bidData.lineItems || [],
      identifiedExclusions: bidData.identifiedExclusions || [],
      valueEngineeringAlternates: bidData.valueEngineeringAlternates || [],
      longLeadEquipmentWeeks: effectiveLeadWeeks,
      leadTimePenalty: effectiveLeadPenalty,
      leadTimeTargetWeeks: effectiveLeadTargetWeeks,
      coiComplianceStatus: effectiveCoiStatus,
      coiPenalty: effectiveCoiPenalty,
      leveledTotalCost: calculatedLeveledCost,
      levelingProvider:
        llmResult.provider === OFFLINE_RULES_ENGINE
          ? `${OFFLINE_RULES_ENGINE} (no model call)`
          : `${llmResult.provider || "deterministic-fallback"} ${llmResult.model || ""}`.trim(),
    });
    } catch (bidErr: any) {
      const message = bidErr?.message || String(bidErr);
      console.error("Bid ingestion failed; recording an audit event so the quote is not lost silently:", message);
      try {
        const tradePkgForLog = await ctx.runQuery(internal.tradePackages.getPackageInternal, {
          tradePackageId: args.tradePackageId,
        });
        if (tradePkgForLog) {
          await ctx.runMutation(internal.auditLogs.recordLog, {
            projectId: tradePkgForLog.projectId,
            tradePackageId: args.tradePackageId,
            eventType: "bid_ingest_failed",
            title: `Bid Ingestion Failed: ${args.subject}`,
            description: `Proposal from ${args.fromEmail} could not be extracted or saved (${message}). Resend the proposal or ingest it from the Bid Leveling tab.`,
            actor: "TradePulse AI Forensic Leveling Agent",
          });
        }
      } catch (logErr) {
        console.error("Could not record the bid ingestion failure:", logErr);
      }
    }
  },
});

/**
 * Automates AgentMail Webhook Registration:
 * Calls POST https://api.agentmail.to/v0/webhooks to register the Convex endpoint
 * and retrieve the Svix signing secret.
 */
export const registerAgentMailWebhook = internalAction({
  args: {
    webhookUrl: v.optional(v.string()),
  },
  handler: async (_ctx, args): Promise<{ success: boolean; secret?: string; webhookId?: string; message: string }> => {
    const apiKey = process.env.AGENTMAIL_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        message: "AGENTMAIL_API_KEY is not configured in environment.",
      };
    }

    const targetUrl = args.webhookUrl || (process.env.CONVEX_SITE_URL ? `${process.env.CONVEX_SITE_URL}/agentmail/webhook` : "https://brainy-skunk-440.convex.site/agentmail/webhook");

    try {
      // 1. Check existing webhooks
      const listRes = await fetch("https://api.agentmail.to/v0/webhooks", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (listRes.ok) {
        const listData = await listRes.json();
        const existing = (listData.webhooks || []).find((w: any) => w.url === targetUrl);
        if (existing) {
          const detailRes = await fetch(`https://api.agentmail.to/v0/webhooks/${existing.webhook_id}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            return {
              success: true,
              webhookId: detailData.webhook_id || existing.webhook_id,
              secret: detailData.secret,
              message: `Webhook registered. Run 'npx convex env set AGENTMAIL_WEBHOOK_SECRET ${detailData.secret}' to enable cryptographic verification.`,
            };
          }
        }
      }

      // 2. If not found, create new webhook registration
      const response = await fetch("https://api.agentmail.to/v0/webhooks", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: targetUrl,
          event_types: ["message.received", "message.sent"],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const webhookId = data.webhook_id || data.id;
        return {
          success: true,
          webhookId,
          secret: data.secret,
          message: `Webhook registered. Run 'npx convex env set AGENTMAIL_WEBHOOK_SECRET ${data.secret}' to enable cryptographic verification.`,
        };
      } else {
        const errText = await response.text();
        return {
          success: false,
          message: `AgentMail API returned ${response.status}: ${errText}`,
        };
      }
    } catch (err: any) {
      return {
        success: false,
        message: `Network or runtime error creating webhook: ${err?.message || err}`,
      };
    }
  },
});
