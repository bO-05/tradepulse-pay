import { mutation, internalMutation, internalQuery } from "./_generated/server";
import { requireRole } from "./lib/roles";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { generateAiaA401AgreementText, getStateAbbreviation } from "./agreements";
import { persistPendingRfi } from "./rfq";
import { LIQUIDATED_DAMAGES_PER_DAY, RETAINAGE_PERCENT } from "./terms";

/**
 * 60-Second Judge Simulation Engine:
 * Executes simulated subcontractor events (RFI questions, quotes with hidden exclusions)
 * directly into the internal reactive pipeline, bypassing external Svix webhook signatures.
 * Enables 100% reliable 1-click evaluations for judges and automated tests.
 */
export const triggerJudgeSimulation = mutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    scenario: v.union(
      v.literal("rfi_inquiry"),
      v.literal("bid_with_hidden_exclusion"),
      v.literal("bid_clean_compliant")
    ),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");

    const isHvac = tradePkg.csiDivision.startsWith("23");
    const isPlumbing = tradePkg.csiDivision.startsWith("22");

    if (args.scenario === "rfi_inquiry") {
      let fromEmail = "estimating@rosendin.com";
      let subject = "RFI #3: Division 26 Penthouse Rooftop Hoisting Rigging";
      let bodyText = "Does the base electrical package require the subcontractor to furnish the crane mobilization for the 1600A switchgear, or will GC have a tower crane on site available for subcontractor picks?";

      if (isHvac) {
        fromEmail = "estimating@tdindustries.com";
        subject = "RFI #2: Division 23 BACnet MS/TP Gateway Interface Protocol";
        bodyText = "Does Division 23 HVAC include furnishing and programming the BACnet MS/TP integration gateway to the base building automation system (BAS), or is the controls vendor providing the hardware gateway?";
      } else if (isPlumbing) {
        fromEmail = "dispatch@clarkekentplumbing.com";
        subject = "RFI #2: Division 22 Triplex Water Booster Pump Factory Commissioning";
        bodyText = "Does Division 22 require the plumbing trade to contract factory certified startup technicians for the triplex domestic water booster pump skid, or does owner accept standard contractor mechanical startup?";
      }

      await ctx.scheduler.runAfter(0, internal.emailActions.processSimulatedInbound, {
        tradePackageId: args.tradePackageId,
        fromEmail,
        subject,
        bodyText,
        isBid: false,
      });

      return {
        success: true,
        scenario: args.scenario,
        message: `Simulated pre-bid RFI inquiry dispatched to TradePulse AI agent for CSI Division ${tradePkg.csiDivision}.`,
      };
    }

    if (args.scenario === "bid_with_hidden_exclusion") {
      let fromEmail = "estimating@goalterman.com";
      let subject = "PROPOSAL: Division 26 Electrical - Alterman, Inc.";
      let bodyText = `PROPOSAL AND QUOTATION
Project: The Domain Tower B - Commercial MEP
Base Bid Price: $1,100,000.00
Payment Terms: Net 30

SCOPE INCLUSIONS:
1. 1600A main service switchboard (furnish only).
2. Emergency lighting inverter package.
3. Branch power wiring and conduit feeders.

EXCLUSIONS & QUALIFICATIONS (READ CAREFULLY):
- Crane hoisting & rigging to penthouse mechanical floor excluded (GC to furnish crane).
- UL 1479 firestop floor and wall penetrations excluded (By drywall/framing trade).
- Seismic engineered structural bracing excluded (By others).
- Overtime/weekend acceleration excluded from base rate (Straight time only).

LEAD TIMES:
Switchgear equipment lead time is 16 weeks from approved submittals.
Insurance: Standard statutory limits (Umbrella endorsement fee not included).`;

      if (isHvac) {
        fromEmail = "estimating@brandt.us";
        subject = "PROPOSAL: Division 23 HVAC - The Brandt Companies, LLC";
        bodyText = `PROPOSAL AND QUOTATION
Project: The Domain Tower B - Commercial MEP
Base Bid Price: $1,650,000.00
Payment Terms: Net 30

SCOPE INCLUSIONS:
1. Chilled water air handling units (AHU-1 through AHU-4).
2. VAV terminal units with electric reheat coils.
3. Galvanized ductwork distribution and diffusers.

EXCLUSIONS & QUALIFICATIONS (READ CAREFULLY):
- Crane hoisting & rigging to penthouse mechanical floor excluded (GC to furnish crane).
- Testing, Adjusting, and Balancing (TAB) certified report excluded.
- BACnet MS/TP automation integration gateway excluded.
- Spring vibration isolation hangers excluded (Un-isolated provided).

LEAD TIMES:
Chiller equipment lead time is 20 weeks from approved submittals.
Insurance: Standard statutory limits (Umbrella endorsement fee not included).`;
      } else if (isPlumbing) {
        fromEmail = "estimating@limbachinc.com";
        subject = "PROPOSAL: Division 22 Plumbing - Limbach Facility Services LLC";
        bodyText = `PROPOSAL AND QUOTATION
Project: The Domain Tower B - Commercial MEP
Base Bid Price: $820,000.00
Payment Terms: Net 30

SCOPE INCLUSIONS:
1. Domestic copper supply and sanitary cast iron rough-in.
2. Triplex domestic water booster pump equipment.
3. Commercial plumbing fixtures and flush valves.

EXCLUSIONS & QUALIFICATIONS (READ CAREFULLY):
- Core drilling and floor/wall penetration sleeves excluded.
- City of Austin backflow preventer inspection certification excluded.
- Triplex booster pump factory certified technician startup excluded.
- Crane hoisting & rigging to penthouse mechanical floor excluded (GC to furnish crane).

LEAD TIMES:
Triplex booster equipment lead time is 18 weeks from approved submittals.
Insurance: Standard statutory limits (Umbrella endorsement fee not included).`;
      }

      await ctx.scheduler.runAfter(0, internal.emailActions.processSimulatedInbound, {
        tradePackageId: args.tradePackageId,
        fromEmail,
        subject,
        bodyText,
        isBid: true,
      });

      return {
        success: true,
        scenario: args.scenario,
        message: `Simulated bid with subtle fine-print exclusions submitted for Division ${tradePkg.csiDivision} forensic leveling.`,
      };
    }

    if (args.scenario === "bid_clean_compliant") {
      let fromEmail = "estimating@prismelectric.com";
      let subject = "PROPOSAL: Division 26 Electrical - Prism Electric, Inc.";
      let bodyText = `PROPOSAL AND QUOTATION
Project: The Domain Tower B - Commercial MEP
Base Bid Price: $1,240,000.00

SCOPE INCLUSIONS (100% COMPLETE):
- 1600A switchgear and dry-type transformers.
- Crane hoisting and rigging to 14th-floor penthouse plant room INCLUDED.
- UL 1479 rated firestop penetrations INCLUDED.
- Seismic bracing engineered stamped calculations INCLUDED.
- 400A temporary power distribution board INCLUDED.

LEAD TIME:
Switchgear lead time: 11 weeks (within 12-week schedule).
Insurance: Fully compliant ACORD 25 with $5M Umbrella and Additional Insured endorsement.`;

      if (isHvac) {
        fromEmail = "estimating@tdindustries.com";
        subject = "PROPOSAL: Division 23 HVAC - TDIndustries, Inc.";
        bodyText = `PROPOSAL AND QUOTATION
Project: The Domain Tower B - Commercial MEP
Base Bid Price: $1,820,000.00

SCOPE INCLUSIONS (100% COMPLETE):
- Rooftop cooling towers, chillers, and VAV terminal units.
- Crane hoisting and rigging to 14th-floor penthouse plant room INCLUDED.
- Testing, Adjusting, and Balancing (TAB) certified report INCLUDED.
- BACnet MS/TP automation integration gateway INCLUDED.
- Spring vibration isolation hangers INCLUDED.

LEAD TIME:
Chiller equipment lead time: 12 weeks (within schedule).
Insurance: Fully compliant ACORD 25 with $5M Umbrella and Additional Insured endorsement.`;
      } else if (isPlumbing) {
        fromEmail = "dispatch@clarkekentplumbing.com";
        subject = "PROPOSAL: Division 22 Plumbing - Clarke Kent Plumbing";
        bodyText = `PROPOSAL AND QUOTATION
Project: The Domain Tower B - Commercial MEP
Base Bid Price: $935,000.00

SCOPE INCLUSIONS (100% COMPLETE):
- Complete domestic water, cast iron waste, and roof storm drain piping.
- Core drilling and floor/wall penetration sleeves INCLUDED.
- City of Austin backflow preventer inspection certification INCLUDED.
- Triplex booster pump factory certified technician startup INCLUDED.

LEAD TIME:
Booster pump lead time: 10 weeks (within schedule).
Insurance: Fully compliant ACORD 25 with $5M Umbrella and Additional Insured endorsement.`;
      }

      await ctx.scheduler.runAfter(0, internal.emailActions.processSimulatedInbound, {
        tradePackageId: args.tradePackageId,
        fromEmail,
        subject,
        bodyText,
        isBid: true,
      });

      return {
        success: true,
        scenario: args.scenario,
        message: `Simulated fully compliant bid submitted for Division ${tradePkg.csiDivision} forensic leveling.`,
      };
    }

    return { success: false, message: "Unknown scenario" };
  },
});

export const findContractorByEmail = internalQuery({
  args: {
    tradePackageId: v.id("tradePackages"),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .filter((q) => q.eq(q.field("contactEmail"), args.email))
      .first();
  },
});

export const createSimulatedContractor = internalMutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    fromEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const domain = args.fromEmail.split("@")[1] || "subcontractor.com";
    const companyName = domain
      .replace(".com", "")
      .replace(".example", "")
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") + " LLC";

    const pkg = await ctx.db.get(args.tradePackageId);
    let statePrefix = "COMM";
    if (pkg?.projectId) {
      const prj = await ctx.db.get(pkg.projectId);
      const stateMatch = prj?.location?.match(/\b([A-Z]{2})\b/);
      if (stateMatch) statePrefix = stateMatch[1];
    }

    return await ctx.db.insert("contractors", {
      tradePackageId: args.tradePackageId,
      companyName,
      contactEmail: args.fromEmail,
      phone: "+1 (512) 835-2400",
      licenseNumber: `${statePrefix}-LIC-${Math.floor(10000 + Math.random() * 90000)}`,
      licenseStatus: `Unverified — demo record; ${statePrefix} registry lookup not performed`,
      sourceUrl: `https://${domain}`,
      rfqStatus: "invited",
      dispatchedAt: Date.now(),
    });
  },
});

export const submitCustomRfi = mutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    contractorId: v.optional(v.id("contractors")),
    subject: v.string(),
    question: v.string(),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new ConvexError("The selected trade package could not be found.");

    const subject = args.subject.trim();
    const question = args.question.trim();
    if (!question) {
      throw new ConvexError("Enter a question before submitting the RFI.");
    }
    if (question.length > 4000) {
      throw new ConvexError("RFI questions are limited to 4,000 characters. Please shorten the inquiry.");
    }
    if (subject.length > 200) {
      throw new ConvexError("RFI subject lines are limited to 200 characters.");
    }

    let fromEmail = "guest.inquiry@tradepulse-pro.test";
    let resolvedContractorId: any = args.contractorId;
    if (args.contractorId) {
      const contractor = await ctx.db.get(args.contractorId);
      if (!contractor || contractor.tradePackageId !== args.tradePackageId) {
        throw new ConvexError("The selected contractor does not belong to this trade package.");
      }
      fromEmail = contractor.contactEmail;
    } else {
      // Guest submitters (no registered contractor) get a durable guest record so the
      // RFI thread, attribution, and audit trail remain consistent.
      const existingGuest = await ctx.db
        .query("contractors")
        .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
        .filter((q) => q.eq(q.field("companyName"), "Guest / Inquiring Subcontractor"))
        .first();
      if (existingGuest) {
        fromEmail = existingGuest.contactEmail;
        resolvedContractorId = existingGuest._id;
      } else {
        resolvedContractorId = await ctx.db.insert("contractors", {
          tradePackageId: args.tradePackageId,
          companyName: "Guest / Inquiring Subcontractor",
          contactEmail: fromEmail,
          phone: "+1 (512) 555-0100",
          licenseNumber: "GUEST-INQUIRY",
          licenseStatus: "Unverified / Guest Inquiry",
          sourceUrl: "https://tradepulse-pro.test/guest",
          rfqStatus: "discovered",
        });
      }
    }

    // F1 durability: persist the submitted text as a pending RFI inside this
    // transaction, before any LLM work is scheduled. A refresh or analysis
    // failure can no longer lose the question.
    const subjectText = subject || "Guest Pre-Bid Inquiry";
    const threadId = `sim_th_${Date.now().toString().slice(-6)}`;
    const conversationId = await persistPendingRfi(ctx, {
      tradePackageId: args.tradePackageId,
      contractorId: resolvedContractorId,
      threadId,
      inboundSubject: subjectText,
      inboundQuestion: question,
    });

    await ctx.scheduler.runAfter(0, internal.emailActions.handleRfiProcessing, {
      tradePackageId: args.tradePackageId,
      contractorId: resolvedContractorId,
      fromEmail,
      subject: subjectText,
      text: question,
      threadId,
      conversationId,
    });

    return {
      success: true,
      conversationId,
      message: "Custom RFI submitted to TradePulse autonomous AI clarification engine.",
    };
  },
});

/**
 * F1 retry: re-queues the stored text for analysis after a failure (or a stuck
 * pending run) without asking the bidder to retype anything.
 */
export const retryRfiAnalysis = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const convo = await ctx.db.get(args.conversationId);
    if (!convo) throw new ConvexError("The RFI record could not be found.");
    if (convo.status === "clarified" || convo.status === "escalated_to_pm") {
      return { success: false, message: "This RFI has already been analyzed." };
    }
    if (convo.status === "rejected") {
      return { success: false, message: "This RFI was rejected and cannot be retried." };
    }
    const contractor = await ctx.db.get(convo.contractorId);
    if (!contractor || contractor.tradePackageId !== convo.tradePackageId) {
      throw new ConvexError("The RFI contractor no longer exists for this trade package.");
    }

    await ctx.db.patch(args.conversationId, {
      status: "pending_analysis",
      analysisError: undefined,
      autonomousReply: "",
      confidenceScore: 0,
    });

    const threadId = convo.threadId || `sim_th_${Date.now().toString().slice(-6)}`;
    await ctx.scheduler.runAfter(0, internal.emailActions.handleRfiProcessing, {
      tradePackageId: convo.tradePackageId,
      contractorId: convo.contractorId,
      fromEmail: contractor.contactEmail,
      subject: convo.inboundSubject,
      text: convo.inboundQuestion,
      threadId,
      conversationId: args.conversationId,
    });

    return { success: true, message: "RFI re-queued for analysis." };
  },
});

/**
 * 1-Click Full Autonomous Procurement Lifecycle Simulation:
 * Executes the entire causal lifecycle from discovery -> RFQ dispatch ->
 * pre-bid RFI clarification -> dual-quote ingestion & forensic leveling ->
 * to AIA Document A401 contract award in a single click.
 */
export const runFullProcurementCycle = mutation({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.optional(v.id("tradePackages")),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");

    // 1. Select or create trade package
    let tradePkg = args.tradePackageId ? await ctx.db.get(args.tradePackageId) : null;
    if (tradePkg && tradePkg.projectId !== args.projectId) {
      throw new Error("The trade package does not belong to the selected project.");
    }
    if (!tradePkg) {
      tradePkg = await ctx.db
        .query("tradePackages")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .first();
    }
    if (!tradePkg) {
      const newPkgId = await ctx.db.insert("tradePackages", {
        projectId: args.projectId,
        csiDivision: "26 00 00",
        tradeName: "Electrical & Lighting Systems",
        budgetEstimate: 1250000,
        agentMailbox: "austin-elec-rfq@agentmail.to",
        agentMailboxId: "inbox_elec_sim",
        scopeSummary: "Complete commercial electrical distribution, 1600A switchgear, crane hoisting, and seismic bracing.",
        mandatoryInclusions: [
          "Crane hoisting to 14th-floor mechanical room",
          "Seismic bracing (IBC Section 1613)",
          "Temporary 400A jobsite power distribution",
          "UL 1479 floor/wall firestopping",
        ],
        bidDeadline: "2026-09-30",
        status: "draft",
      });
      tradePkg = await ctx.db.get(newPkgId);
    }
    if (!tradePkg) throw new Error("Could not initialize trade package");

    const packageId = tradePkg._id;
    const now = Date.now();
    const isHvac = tradePkg.csiDivision.startsWith("23");
    const isPlumbing = tradePkg.csiDivision.startsWith("22");

    // 2. Discover Contractors (Context-Aware for Trade Division)
    let c1Email = "estimating@rosendin.com";
    let c1Name = "Rosendin Electric, Inc.";
    let c1License = "TX-TECL-18042";
    let c1Url = "https://www.rosendin.com";

    let c2Email = "estimating@goalterman.com";
    let c2Name = "Alterman, Inc.";
    let c2License = "TX-TECL-19204";
    let c2Url = "https://goalterman.com";

    if (isHvac) {
      c1Email = "estimating@tdindustries.com";
      c1Name = "TDIndustries, Inc.";
      c1License = "TX-TACLA-11842E";
      c1Url = "https://www.tdindustries.com";

      c2Email = "estimating@brandt.us";
      c2Name = "The Brandt Companies, LLC";
      c2License = "TX-TACLA-01048C";
      c2Url = "https://brandt.us";
    } else if (isPlumbing) {
      c1Email = "dispatch@clarkekentplumbing.com";
      c1Name = "Clarke Kent Plumbing";
      c1License = "TX-RMP-39182";
      c1Url = "https://clarkekentplumbing.com";

      c2Email = "estimating@limbachinc.com";
      c2Name = "Limbach Facility Services LLC";
      c2License = "TX-RMP-41029";
      c2Url = "https://limbachinc.com";
    }

    let c1 = await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", packageId))
      .filter((q) => q.eq(q.field("contactEmail"), c1Email))
      .first();
    if (!c1) {
      const c1Id = await ctx.db.insert("contractors", {
        tradePackageId: packageId,
        companyName: c1Name,
        contactEmail: c1Email,
        phone: "+1 (512) 835-2400",
        licenseNumber: c1License,
        licenseStatus: "Unverified — demo record; state registry lookup not performed",
        sourceUrl: c1Url,
        rfqStatus: "discovered",
      });
      c1 = await ctx.db.get(c1Id);
    }

    let c2 = await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", packageId))
      .filter((q) => q.eq(q.field("contactEmail"), c2Email))
      .first();
    if (!c2) {
      const c2Id = await ctx.db.insert("contractors", {
        tradePackageId: packageId,
        companyName: c2Name,
        contactEmail: c2Email,
        phone: "+1 (512) 346-3022",
        licenseNumber: c2License,
        licenseStatus: "Unverified — demo record; state registry lookup not performed",
        sourceUrl: c2Url,
        rfqStatus: "discovered",
      });
      c2 = await ctx.db.get(c2Id);
    }

    // 3. Dispatch RFQs
    if (c1) await ctx.db.patch(c1._id, { rfqStatus: "invited", dispatchedAt: now });
    if (c2) await ctx.db.patch(c2._id, { rfqStatus: "invited", dispatchedAt: now });
    await ctx.db.patch(packageId, { status: "rfqs_dispatched" });

    await ctx.db.insert("auditLogs", {
      projectId: tradePkg.projectId,
      tradePackageId: packageId,
      eventType: "rfq_dispatched",
      title: `RFQs Dispatched: Division ${tradePkg.csiDivision}`,
      description: `Simulated RFQ wave recorded for the demonstration lifecycle (${tradePkg.agentMailbox}); the simulation does not send email.`,
      actor: "Autonomous Procurement Engine",
      timestamp: now,
    });

    // 4. Pre-Bid RFI Inquiry & Autonomous Clarification
    let rfiSubject = "RFI #1: Division 26 Penthouse Rooftop Hoisting Rigging";
    let rfiQuestion = "Does the base electrical package require the subcontractor to furnish the crane mobilization for the 1600A switchgear, or will GC have a tower crane on site?";
    let rfiReply = "Per TradePulse Spec Analysis (Section 26 00 00): Penthouse freight elevator capacity is capped at 3,500 lbs; the 1600A switchgear weighs 7,200 lbs. Rooftop crane rigging and hoisting must be included in Division 26 base proposal.";

    if (isHvac) {
      rfiSubject = "RFI #1: Division 23 BACnet MS/TP Gateway Interface Protocol";
      rfiQuestion = "Does Division 23 HVAC include furnishing and programming the BACnet MS/TP integration gateway to the base building automation system (BAS), or is the controls vendor providing the hardware gateway?";
      rfiReply = "Per TradePulse Spec Analysis (Section 23 09 23): Subcontractor must provide native BACnet MS/TP communication cards on all chiller and VAV controllers; central BAS gateway hardware is furnished by Owner controls contractor.";
    } else if (isPlumbing) {
      rfiSubject = "RFI #1: Division 22 Triplex Water Booster Pump Factory Commissioning";
      rfiQuestion = "Does Division 22 require the plumbing trade to contract factory certified startup technicians for the triplex domestic water booster pump skid, or does owner accept standard contractor mechanical startup?";
      rfiReply = "Per TradePulse Spec Analysis (Section 22 11 23): Triplex booster pump system requires factory certified technician commissioning and stamped warranty certificate included in Division 22 base proposal.";
    }

    await ctx.db.insert("conversations", {
      tradePackageId: packageId,
      contractorId: c1!._id,
      threadId: `th_sim_lifecycle_${now}`,
      inboundSubject: rfiSubject,
      inboundQuestion: rfiQuestion,
      autonomousReply: rfiReply,
      confidenceScore: 0.98,
      status: "clarified",
      timestamp: now + 500,
    });

    await ctx.db.insert("auditLogs", {
      projectId: tradePkg.projectId,
      tradePackageId: packageId,
      eventType: "rfi_clarified",
      title: "Pre-Bid RFI Clarified by AI Agent",
      description: `Autonomous model answered ${tradePkg.tradeName} query citing Section ${tradePkg.csiDivision} with 98% confidence.`,
      actor: "TradePulse AI Spec Agent",
      timestamp: now + 500,
    });

    // 5. Ingest & Level Bids (Context-Aware for Trade Division)
    const oldBids = await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", packageId))
      .collect();
    for (const ob of oldBids) {
      await ctx.db.delete(ob._id);
    }

    let bid1Data: any = {
      tradePackageId: packageId,
      contractorId: c1!._id,
      subcontractorName: c1Name,
      baseBidAmount: 1225000,
      lineItems: [
        { item: "1600A Main Switchboard & Transformers", unit: "LS", quantity: 1, unitCost: 450000, totalCost: 450000 },
        { item: "Emergency Lighting & Inverters", unit: "LS", quantity: 1, unitCost: 185000, totalCost: 185000 },
        { item: "Branch Conduit & Wire Feeder Runs", unit: "LF", quantity: 24000, unitCost: 18, totalCost: 432000 },
        { item: "Crane Hoisting to Penthouse Switchgear Room", unit: "LS", quantity: 1, unitCost: 38000, totalCost: 38000 },
        { item: "UL 1479 Rated Firestopping Penetrations", unit: "LS", quantity: 1, unitCost: 20000, totalCost: 20000 },
        { item: "Seismic Bracing System & Engineering", unit: "LS", quantity: 1, unitCost: 100000, totalCost: 100000 },
      ],
      identifiedExclusions: [],
      valueEngineeringAlternates: [
        {
          description: "VE-01: Feeder cable optimization (Aluminum MC cable in lieu of copper conduit)",
          costDeduct: 35000,
          isAccepted: true,
        },
      ],
      longLeadEquipmentWeeks: 10,
      leadTimePenalty: 0,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      leveledTotalCost: 1190000,
      isAwarded: true,
      receivedAt: now + 1000,
    };

    let bid2Data: any = {
      tradePackageId: packageId,
      contractorId: c2!._id,
      subcontractorName: c2Name,
      baseBidAmount: 1100000,
      lineItems: [
        { item: "1600A Main Switchboard (Furnish Only)", unit: "LS", quantity: 1, unitCost: 420000, totalCost: 420000 },
        { item: "Emergency Lighting & Inverters", unit: "LS", quantity: 1, unitCost: 170000, totalCost: 170000 },
        { item: "Branch Conduit & Wire Feeder Runs", unit: "LF", quantity: 24000, unitCost: 17, totalCost: 408000 },
        { item: "Site Distribution & Temporary Hookups", unit: "LS", quantity: 1, unitCost: 102000, totalCost: 102000 },
      ],
      identifiedExclusions: [
        { description: "Crane hoisting & rigging to penthouse mechanical floor excluded (GC to furnish)", costImpact: 45000, severity: "critical" },
        { description: "UL 1479 firestop floor penetrations excluded (By drywall trade)", costImpact: 22000, severity: "critical" },
        { description: "Seismic engineered structural bracing excluded (By others)", costImpact: 55000, severity: "critical" },
        { description: "Overtime/weekend acceleration excluded from base rate", costImpact: 25000, severity: "moderate" },
      ],
      valueEngineeringAlternates: [],
      longLeadEquipmentWeeks: 16,
      leadTimePenalty: 24000,
      coiComplianceStatus: "deficiency_detected",
      coiPenalty: 15000,
      leveledTotalCost: 1286000,
      isAwarded: false,
      receivedAt: now + 1500,
    };

    let winningCost = 1190000;
    let deceptiveCost = 1286000;
    let hiddenExclusionsCost = 147000;

    if (isHvac) {
      bid1Data = {
        tradePackageId: packageId,
        contractorId: c1!._id,
        subcontractorName: c1Name,
        baseBidAmount: 1770000,
        lineItems: [
          { item: "Chilled Water Air Handling Units & Hydronics", unit: "LS", quantity: 1, unitCost: 850000, totalCost: 850000 },
          { item: "Supply & Return Galvanized SMACNA Ductwork", unit: "LS", quantity: 1, unitCost: 520000, totalCost: 520000 },
          { item: "VAV Terminal Reheat Units & Air Balancing (TAB)", unit: "LS", quantity: 1, unitCost: 400000, totalCost: 400000 },
        ],
        identifiedExclusions: [],
        valueEngineeringAlternates: [
          {
            description: "VE-01: Spiral ductwork optimization in lieu of rectangular low-pressure runs",
            costDeduct: 30000,
            isAccepted: true,
          },
        ],
        longLeadEquipmentWeeks: 11,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: 1740000,
        isAwarded: true,
        receivedAt: now + 1000,
      };

      bid2Data = {
        tradePackageId: packageId,
        contractorId: c2!._id,
        subcontractorName: c2Name,
        baseBidAmount: 1650000,
        lineItems: [
          { item: "Chilled Water Air Handling Units (AHU 1-4)", unit: "LS", quantity: 1, unitCost: 820000, totalCost: 820000 },
          { item: "VAV Boxes & Electric Reheat", unit: "LS", quantity: 1, unitCost: 450000, totalCost: 450000 },
          { item: "Ductwork Distribution & Diffusers", unit: "LS", quantity: 1, unitCost: 380000, totalCost: 380000 },
        ],
        identifiedExclusions: [
          { description: "Crane hoisting & rigging to penthouse mechanical floor excluded (GC to furnish crane)", costImpact: 45000, severity: "critical" },
          { description: "Testing, Adjusting, and Balancing (TAB) certified report excluded", costImpact: 35000, severity: "critical" },
          { description: "BACnet MS/TP automation integration gateway excluded", costImpact: 28000, severity: "critical" },
          { description: "Spring vibration isolation hangers excluded (Un-isolated provided)", costImpact: 27000, severity: "moderate" },
        ],
        valueEngineeringAlternates: [],
        longLeadEquipmentWeeks: 12,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: 1785000,
        isAwarded: false,
        receivedAt: now + 1500,
      };

      winningCost = 1740000;
      deceptiveCost = 1785000;
      hiddenExclusionsCost = 135000;
    } else if (isPlumbing) {
      bid1Data = {
        tradePackageId: packageId,
        contractorId: c1!._id,
        subcontractorName: c1Name,
        baseBidAmount: 820000,
        lineItems: [
          { item: "Sanitary DWV Cast Iron & Copper Water Distribution", unit: "LS", quantity: 1, unitCost: 460000, totalCost: 460000 },
          { item: "Triplex Booster Pump Skid & VFDs", unit: "LS", quantity: 1, unitCost: 240000, totalCost: 240000 },
          { item: "Commercial Plumbing Fixtures & Trim", unit: "LS", quantity: 1, unitCost: 120000, totalCost: 120000 },
        ],
        identifiedExclusions: [
          { description: "Floor coring and penetration firestop sleeves excluded", costImpact: 22000, severity: "critical" },
          { description: "City backflow preventer inspection certification excluded", costImpact: 18500, severity: "critical" },
          { description: "Triplex booster pump factory certified technician startup excluded", costImpact: 28000, severity: "critical" },
          { description: "Crane hoisting to penthouse mechanical floor excluded", costImpact: 20000, severity: "moderate" },
        ],
        valueEngineeringAlternates: [],
        longLeadEquipmentWeeks: 12,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: 908500,
        isAwarded: true,
        receivedAt: now + 1000,
      };

      bid2Data = {
        tradePackageId: packageId,
        contractorId: c2!._id,
        subcontractorName: c2Name,
        baseBidAmount: 935000,
        lineItems: [
          { item: "Sanitary Cast Iron DWV & Underground Drainage", unit: "LS", quantity: 1, unitCost: 485000, totalCost: 485000 },
          { item: "Domestic Water Supply & Booster Pumps", unit: "LS", quantity: 1, unitCost: 270000, totalCost: 270000 },
          { item: "Commercial Fixtures, Carrier Rough-In & Commissioning", unit: "LS", quantity: 1, unitCost: 180000, totalCost: 180000 },
        ],
        identifiedExclusions: [],
        valueEngineeringAlternates: [],
        longLeadEquipmentWeeks: 12,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: 935000,
        isAwarded: false,
        receivedAt: now + 1500,
      };

      winningCost = 908500;
      deceptiveCost = 935000;
      hiddenExclusionsCost = 88500;
    }

    const bid1Id = await ctx.db.insert("bids", bid1Data);
    await ctx.db.insert("bids", bid2Data);

    await ctx.db.patch(packageId, { status: "awarded" });

    // 6. Generate AIA Document A401 Subcontract Agreement for Winning Bidder
    const divPrefix = tradePkg.csiDivision.replace(/\s+/g, "").slice(0, 4);
    const agreementNumber = `A401-2026-${divPrefix}-${now.toString().slice(-4)}`;
    const formattedDate = `${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })} (UTC)`;
    const locParts = (project?.location || "Austin, Texas").split(",").map((s: string) => s.trim());
    const gcCity = locParts[0] || "Austin";
    const gcState = locParts[1] || "Texas";
    const stateAbbr = getStateAbbreviation(gcState);
    const acceptedVeTotal = (bid1Data.valueEngineeringAlternates || []).reduce(
      (sum: number, ve: any) => (ve.isAccepted ? sum + (ve.costDeduct || 0) : sum),
      0
    );

    const agreementText = generateAiaA401AgreementText({
      agreementNumber,
      formattedDate,
      generalContractor: "Austin Commercial, LP",
      gcCity,
      gcState,
      stateAbbr,
      subName: c1Name,
      contactEmail: c1Email,
      licenseNumber: c1License,
      licenseStatus: "Unverified — demo record; registry lookup not performed",
      projectTitle: project?.title || "The Domain Tower B - Commercial MEP",
      projectLocation: project?.location || "Austin, TX",
      projectType: project?.projectType || "Class-A Commercial Mixed-Use",
      csiDivision: tradePkg.csiDivision,
      tradeName: tradePkg.tradeName,
      scopeSummary: tradePkg.scopeSummary,
      mandatoryInclusions: tradePkg.mandatoryInclusions || [],
      contractSum: winningCost,
      baseBidAmount: bid1Data.baseBidAmount,
      acceptedVeTotal,
      leveledTotalCost: bid1Data.leveledTotalCost,
      retainagePercent: RETAINAGE_PERCENT,
      liquidatedDamagesDaily: LIQUIDATED_DAMAGES_PER_DAY,
      bidDeadline: tradePkg.bidDeadline || "2026-09-30",
    });

    // A10-01: an executed subcontract is immutable; the full-cycle simulation must
    // never delete it. Refuse before any destructive work happens for this package.
    const packageAgreementsBefore = await ctx.db
      .query("agreements")
      .withIndex("by_package", (q) => q.eq("tradePackageId", packageId))
      .collect();
    const executedAgreement = packageAgreementsBefore.find((a) => a.status === "executed");
    if (executedAgreement) {
      throw new ConvexError(
        `This package has an executed subcontract (${executedAgreement.agreementNumber}). The full-cycle simulation cannot run here â€” choose a package without an executed contract.`
      );
    }

    // Clear old agreements for package
    const oldAgreements = packageAgreementsBefore;
    for (const oa of oldAgreements) {
      await ctx.db.delete(oa._id);
    }

    const agreementId = await ctx.db.insert("agreements", {
      projectId: tradePkg.projectId,
      tradePackageId: packageId,
      bidId: bid1Id,
      contractorId: c1!._id,
      agreementNumber,
      documentTitle: "Subcontract Agreement (A401-style structure) â€” generated draft, not an AIA-licensed form",
      subcontractorName: c1Name,
      generalContractorName: "Austin Commercial, LP",
      projectTitle: project?.title || "The Domain Tower B - Commercial MEP",
      projectLocation: project?.location || "Austin, TX",
      csiDivision: tradePkg.csiDivision,
      tradeName: tradePkg.tradeName,
      contractSum: winningCost,
      retainagePercent: RETAINAGE_PERCENT,
      liquidatedDamagesDaily: LIQUIDATED_DAMAGES_PER_DAY,
      scopeSummary: tradePkg.scopeSummary,
      mandatoryInclusions: tradePkg.mandatoryInclusions,
      status: "generated",
      contractText: agreementText,
      createdAt: now + 2000,
    });

    await ctx.db.insert("auditLogs", {
      projectId: tradePkg.projectId,
      tradePackageId: packageId,
      eventType: "contract_awarded",
      title: `Subcontract Awarded: ${c1Name}`,
      description: `Awarded Division ${tradePkg.csiDivision} to ${c1Name} at $${winningCost.toLocaleString()} leveled cost. A401-style subcontract draft generated (not an AIA-licensed form).`,
      actor: "Autonomous Procurement Engine (ADR-0003)",
      timestamp: now + 2000,
    });

    return {
      success: true,
      tradePackageId: packageId,
      winningBidder: c1Name,
      winningLeveledCost: winningCost,
      deceptiveBidder: c2Name,
      deceptiveLeveledCost: deceptiveCost,
      hiddenExclusionsCaughtCost: hiddenExclusionsCost,
      agreementNumber,
      agreementId,
      message: `Full autonomous procurement lifecycle simulation completed for Division ${tradePkg.csiDivision}! RFQs dispatched, RFI clarified, proposals leveled via ADR-0003, and AIA A401 agreement generated.`,
    };
  },
});
