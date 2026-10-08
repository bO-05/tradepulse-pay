import { query, mutation, internalMutation, internalQuery, action } from "./_generated/server";
import { auditActor, requireDocScope, requireProjectScope } from "./lib/projectScope";
import { requireProjectScopeInAction } from "./lib/tenancyAction";
import { v, ConvexError } from "convex/values";
import { deleteAgreementCascade, deleteContractorCascade } from "./payments/cascade";
import { api, internal } from "./_generated/api";
import { RFQ_INBOX } from "./lib/mailer";
import {
  normalizeCsiDivision,
  validateBidDeadline,
  validateCsiDivision,
  validatePositiveAmount,
  validateProjectText,
} from "./validation";

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectScope(ctx, args.projectId, { roles: ["gc", "owner"] });
    return await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

export const getPackage = query({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    const { doc } = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc", "owner"] });
    return doc;
  },
});

export const getPackageInternal = internalQuery({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.tradePackageId);
  },
});

export const createTradePackage = mutation({
  args: {
    projectId: v.id("projects"),
    csiDivision: v.string(),
    tradeName: v.string(),
    budgetEstimate: v.number(),
    scopeSummary: v.string(),
    mandatoryInclusions: v.array(v.string()),
    bidDeadline: v.string(),
    agentMailbox: v.optional(v.string()),
    agentMailboxId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    const csiDivision = validateCsiDivision(args.csiDivision);
    const tradeName = validateProjectText(args.tradeName, "Trade package name");
    const scopeSummary = validateProjectText(args.scopeSummary, "Scope summary");
    const budgetEstimate = validatePositiveAmount(args.budgetEstimate, "Budget estimate");
    const bidDeadline = validateBidDeadline(args.bidDeadline);
    const existing = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    if (existing.some((pkg) => normalizeCsiDivision(pkg.csiDivision) === csiDivision)) {
      throw new ConvexError(`CSI Division ${csiDivision} already exists in this project. Use the existing package or choose a different division.`);
    }

    const pkgId = await ctx.db.insert("tradePackages", {
      projectId: args.projectId,
      csiDivision,
      tradeName,
      budgetEstimate,
      scopeSummary,
      mandatoryInclusions: args.mandatoryInclusions,
      bidDeadline,
      agentMailbox: args.agentMailbox ?? RFQ_INBOX,
      agentMailboxId: args.agentMailboxId ?? RFQ_INBOX,
      agentMailboxShared: true,
      status: "draft",
    });

    await ctx.db.insert("auditLogs", {
      projectId: args.projectId,
      tradePackageId: pkgId,
      eventType: "package_created",
      title: `CSI Trade Package Scoped: Division ${csiDivision}`,
      description: `Created ${tradeName} package ($${budgetEstimate.toLocaleString()} budget, ${args.mandatoryInclusions.length} mandatory inclusions).`,
      ...auditActor(access),
      timestamp: Date.now(),
    });

    return pkgId;
  },
});

/** Points every package that still uses another inbox at the shared RFQ inbox (system and agent inboxes never receive RFQ mail). */
export const moveSeedPackagesToRfqInbox = internalMutation({
  args: {},
  handler: async (ctx) => {
    let moved = 0;
    for await (const pkg of ctx.db.query("tradePackages")) {
      if (pkg.agentMailboxId !== RFQ_INBOX || pkg.agentMailbox !== RFQ_INBOX) {
        await ctx.db.patch(pkg._id, { agentMailbox: RFQ_INBOX, agentMailboxId: RFQ_INBOX, agentMailboxShared: true });
        moved++;
      }
    }
    return { moved };
  },
});

export const updateMailbox = internalMutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    agentMailbox: v.string(),
    agentMailboxId: v.string(),
    agentMailboxShared: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.tradePackageId, {
      agentMailbox: args.agentMailbox,
      agentMailboxId: args.agentMailboxId,
      ...(args.agentMailboxShared !== undefined ? { agentMailboxShared: args.agentMailboxShared } : {}),
    });
  },
});

export const updateStatus = mutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    status: v.union(
      v.literal("draft"),
      v.literal("rfqs_dispatched"),
      v.literal("leveling"),
      v.literal("awarded")
    ),
  },
  handler: async (ctx, args) => {
    await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"], write: true });
    // A12-03: "awarded" must be backed by evidence (awarded bid or active
    // agreement); a bare status write would fake an award in the KPI/stepper.
    if (args.status === "awarded") {
      const bids = await ctx.db
        .query("bids")
        .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
        .collect();
      const agreements = await ctx.db
        .query("agreements")
        .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
        .collect();
      const hasAwardEvidence =
        bids.some((b) => b.isAwarded) || agreements.some((a) => a.status !== "superseded");
      if (!hasAwardEvidence) {
        throw new ConvexError(
          "A package can only be marked awarded after a bid is awarded or a subcontract agreement exists."
        );
      }
    }
    await ctx.db.patch(args.tradePackageId, { status: args.status });
  },
});

export const createTradePackageInternal = internalMutation({
  args: {
    projectId: v.id("projects"),
    csiDivision: v.string(),
    tradeName: v.string(),
    budgetEstimate: v.number(),
    scopeSummary: v.string(),
    mandatoryInclusions: v.array(v.string()),
    bidDeadline: v.string(),
  },
  handler: async (ctx, args) => {
    const csiDivision = validateCsiDivision(args.csiDivision);
    const tradeName = validateProjectText(args.tradeName, "Trade package name");
    const scopeSummary = validateProjectText(args.scopeSummary, "Scope summary");
    const budgetEstimate = validatePositiveAmount(args.budgetEstimate, "Budget estimate");
    const bidDeadline = validateBidDeadline(args.bidDeadline);
    const existing = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const duplicate = existing.find((pkg) => normalizeCsiDivision(pkg.csiDivision) === csiDivision);
    if (duplicate) {
      return duplicate._id;
    }

    const pkgId = await ctx.db.insert("tradePackages", {
      projectId: args.projectId,
      csiDivision,
      tradeName,
      budgetEstimate,
      scopeSummary,
      mandatoryInclusions: args.mandatoryInclusions,
      bidDeadline,
      agentMailbox: RFQ_INBOX,
      agentMailboxId: RFQ_INBOX,
      agentMailboxShared: true,
      status: "draft",
    });

    await ctx.db.insert("auditLogs", {
      projectId: args.projectId,
      tradePackageId: pkgId,
      eventType: "package_created",
      title: `AI Auto-Scoped Trade Package: Division ${csiDivision}`,
      description: `Auto-scoped ${tradeName} ($${budgetEstimate.toLocaleString()} budget) via AI specification deconstruction.`,
      actor: "Autonomous AI Spec Scoping Agent",
      timestamp: Date.now(),
    });

    return pkgId;
  },
});

export const generateTradePackagesFromSpec = action({
  args: {
    projectId: v.id("projects"),
    specDocumentTextOverride: v.optional(v.string()),
    /** A6-42: parse and return detected packages without writing, for GC confirmation. */
    previewOnly: v.optional(v.boolean()),
    /** A6-42: write exactly these GC-confirmed packages instead of re-running extraction. */
    confirmedPackages: v.optional(
      v.array(
        v.object({
          csiDivision: v.string(),
          tradeName: v.string(),
          budgetEstimate: v.number(),
          scopeSummary: v.string(),
          mandatoryInclusions: v.array(v.string()),
          bidDeadline: v.string(),
        })
      )
    ),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireProjectScopeInAction(ctx, { projectId: args.projectId }, { roles: ["gc"], write: true });
    let specText: string = args.specDocumentTextOverride || "";
    if (!specText) {
      const project: any = await ctx.runQuery(internal.projects.getProjectInternal, {
        projectId: args.projectId,
      });
      specText = project?.specDocumentText || "Commercial MEP specifications";
    }

    let pkgs: any[] = [];
    if (args.confirmedPackages && args.confirmedPackages.length > 0) {
      // A6-42: the GC confirmed the parsed result; write exactly those packages.
      pkgs = args.confirmedPackages;
    } else {
      // The LLM route is best-effort: if every provider fails or returns unusable JSON,
      // fall back to the deterministic multi-trade package set so the workflow always completes.
      try {
        const reasoningResult: any = await ctx.runAction(internal.llmRouter.executeReasoning, {
          taskType: "spec_generation",
          prompt: specText,
          systemPrompt:
            "You are TradePulse Pro, an expert construction cost engineer and CSI MasterFormat specialist. Analyze the building specifications and deconstruct them into discrete commercial trade packages with CSI division numbers, trade titles, budget estimates, and mandatory inclusions.",
        });
        const parsed = reasoningResult?.parsedJson;
        pkgs = (Array.isArray(parsed?.packages) && parsed.packages.length > 0)
          ? parsed.packages
          : (Array.isArray(parsed) && parsed.length > 0)
          ? parsed
          : [];
      } catch (reasoningErr) {
        console.warn("CSI spec reasoning failed; using deterministic package generation:", reasoningErr);
      }

      if (pkgs.length === 0) {
        pkgs = [
          {
            csiDivision: "01 00 00",
            tradeName: "General Requirements & Site Logistics",
            budgetEstimate: 450000,
            scopeSummary: "Site logistics, crane hoisting coordination, daily cleanup, and temporary utilities.",
            mandatoryInclusions: ["Continuous jobsite cleanup", "Crane staging coordination", "OSHA 30 safety compliance"],
            bidDeadline: "2026-10-31",
          },
          {
            csiDivision: "26 00 00",
            tradeName: "Electrical & Lighting Systems",
            budgetEstimate: 1250000,
            scopeSummary: "Main switchgear, emergency lighting, seismic bracing, and temporary power.",
            mandatoryInclusions: ["Crane hoisting", "Seismic bracing", "UL 1479 firestopping"],
            bidDeadline: "2026-10-31",
          },
          {
            csiDivision: "23 00 00",
            tradeName: "HVAC Mechanical Systems",
            budgetEstimate: 1650000,
            scopeSummary: "Rooftop air handling units, VAV terminal boxes, hydronic chiller loops, and BACnet controls.",
            mandatoryInclusions: ["Certified TAB report", "BACnet MS/TP gateway", "Spring vibration isolation"],
            bidDeadline: "2026-10-31",
          },
          {
            csiDivision: "22 00 00",
            tradeName: "Plumbing Systems",
            budgetEstimate: 920000,
            scopeSummary: "Domestic water piping, sanitary waste and venting, and triplex booster pump system.",
            mandatoryInclusions: ["Factory certified pump startup", "Backflow certification", "Seismic snubbers"],
            bidDeadline: "2026-10-31",
          },
        ];
      }
    }

    if (args.previewOnly) {
      // A6-42: echo the detected divisions/scope and let the GC confirm before any write.
      return {
        success: true,
        preview: true,
        packagesCount: pkgs.length,
        packages: pkgs,
      };
    }

    const createdIds: string[] = [];
    for (const pkg of pkgs) {
      try {
        const csiDivision =
          typeof pkg?.csiDivision === "string" && pkg.csiDivision.trim().length > 0
            ? pkg.csiDivision
            : "26 00 00";
        const tradeName =
          typeof pkg?.tradeName === "string" && pkg.tradeName.trim().length > 0
            ? pkg.tradeName
            : `CSI Division ${csiDivision} Trade`;
        const budgetEstimate =
          Number.isFinite(Number(pkg?.budgetEstimate)) && Number(pkg.budgetEstimate) > 0
            ? Number(pkg.budgetEstimate)
            : 500000;
        const scopeSummary =
          typeof pkg?.scopeSummary === "string" && pkg.scopeSummary.trim().length > 0
            ? pkg.scopeSummary
            : `Commercial scope of work for CSI MasterFormat Division ${csiDivision}.`;
        const mandatoryInclusions =
          Array.isArray(pkg?.mandatoryInclusions) && pkg.mandatoryInclusions.some((i: any) => typeof i === "string" && i.trim())
            ? pkg.mandatoryInclusions.filter((i: any) => typeof i === "string" && i.trim())
            : ["Code compliance and permits", "Coordination with General Contractor"];
        let bidDeadline =
          typeof pkg?.bidDeadline === "string" && pkg.bidDeadline.trim().length > 0
            ? pkg.bidDeadline
            : "2026-10-31";
        const parsedDeadline = Date.parse(bidDeadline);
        if (!Number.isFinite(parsedDeadline) || parsedDeadline < Date.now() + 7 * 24 * 60 * 60 * 1000) {
          bidDeadline = "2026-10-31";
        }

        const pkgId: any = await ctx.runMutation(
          internal.tradePackages.createTradePackageInternal,
          {
            projectId: args.projectId,
            csiDivision,
            tradeName,
            budgetEstimate,
            scopeSummary,
            mandatoryInclusions,
            bidDeadline,
          }
        );
        createdIds.push(pkgId);

        // Provision dynamic AgentMail mailbox for this auto-scoped package
        try {
          const prefix = `trade-${csiDivision.replace(/\s+/g, "").toLowerCase()}`;
          await ctx.runAction(api.rfqActions.provisionPackageInbox, {
            tradePackageId: pkgId,
            usernamePrefix: prefix,
          });
        } catch (inboxErr) {
          console.warn("Dynamic inbox provisioning note:", inboxErr);
        }
      } catch (pkgErr) {
        console.warn("Skipping invalid generated trade package:", pkgErr);
      }
    }

    if (createdIds.length === 0) {
      throw new Error(
        "The autonomous spec breakdown could not create any valid trade packages. Review the specification text or create the trade packages manually."
      );
    }

    return {
      success: true,
      packagesCount: createdIds.length,
      packageIds: createdIds,
      packages: pkgs,
    };
  },
});

export const deleteTradePackage = mutation({
  args: {
    tradePackageId: v.id("tradePackages"),
  },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"], write: true });
    const pkg = access.doc;

    // Executed subcontracts are immutable; deleting the package would destroy them.
    const executed = await ctx.db
      .query("agreements")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
    const executedAgreement = executed.find((a) => a.status === "executed");
    if (executedAgreement) {
      throw new ConvexError(
        `This package has an executed subcontract (${executedAgreement.agreementNumber}) and cannot be deleted. Void or amend the executed agreement first.`
      );
    }

    // 1. Delete all bids and their agreements
    const bids = await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
    for (const b of bids) {
      const agreements = await ctx.db
        .query("agreements")
        .withIndex("by_bid", (q) => q.eq("bidId", b._id))
        .collect();
      for (const a of agreements) {
        await deleteAgreementCascade(ctx, a._id);
      }
      await ctx.db.delete(b._id);
    }

    // 2. Delete all contractors
    const contractors = await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
    for (const c of contractors) {
      await deleteContractorCascade(ctx, c._id);
    }

    // 3. Delete all conversations
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
    for (const c of conversations) {
      await ctx.db.delete(c._id);
    }

    // 4. Delete package files and their storage blobs.
    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
    for (const file of files) {
      if (!file.storageId.startsWith("http") && !file.storageId.startsWith("/")) {
        try {
          await ctx.storage.delete(file.storageId as any);
        } catch {
          // Keep deletion idempotent for legacy/external storage identifiers.
        }
      }
      await ctx.db.delete(file._id);
    }

    // 5. Delete all agreements for this package
    const packageAgreements = await ctx.db
      .query("agreements")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
    for (const a of packageAgreements) {
      await deleteAgreementCascade(ctx, a._id);
    }

    // 6. Delete the trade package itself
    await ctx.db.delete(args.tradePackageId);

    // Audit log
    await ctx.db.insert("auditLogs", {
      projectId: pkg.projectId,
      eventType: "compliance_audit",
      title: `Trade Package Removed: Division ${pkg.csiDivision}`,
      description: `Deleted CSI Division ${pkg.csiDivision} (${pkg.tradeName}) package and cascaded cleanup of associated bids, contractors, and agreements.`,
      ...auditActor(access),
      timestamp: Date.now(),
    });

    return { success: true };
  },
});
