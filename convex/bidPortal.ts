import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { syncAgreementForBid } from "./agreements";
import { bidAlternateValidator, bidUnitPriceValidator } from "./lib/bidValidators";
import { CLEAR_LEGACY_BID_DOLLARS, bidCents, computeLeveledTotalCents, type BidLineItemCents } from "./lib/bidMoney";
import { describeTermChanges, recordBidRevision, termsOfBid, type BidTerms, type RevisionSource } from "./lib/bidRevisions";
import { firstBidTermError, validateBidTerms, type CleanBidTerms } from "./lib/bidTerms";
import { formatCents } from "./lib/money";
import { biddingClosedReason } from "./lib/biddingClosed";
import { isBidDocumentForPackage } from "./lib/bidDocuments";
import { keptPlugFields } from "./lib/levelingPlugs";
import { reconcileBidderExclusions } from "./lib/exclusionOwnership";
import { contractorCanBidOnPackage } from "./lib/packageContractors";
import { auditActor, requireDocOfProject, requireDocScope } from "./lib/projectScope";
import { bidDueHasPassed, bidDuePassedMessage, packageDue, projectStateOf } from "./lib/bidDue";
import { accessibleProjectIds, notFound, requireCompanyMember, type ProjectAccess } from "./lib/tenancy";

/**
 * Sub bid portal (architecture §15). A sub company member sees the packages its linked bidder
 * records are invited to, reads the bid documents and published Q&A, and submits or revises a
 * structured bid. The GC sees every bid with its revision history, can enter a bid on a bidder's
 * behalf, confirm or correct AI-parsed bids, and publish bidder questions without the asker's name.
 */

const termsArgs = {
  baseAmountCents: v.number(),
  alternates: v.array(bidAlternateValidator),
  exclusions: v.array(v.string()),
  inclusions: v.array(v.string()),
  unitPrices: v.array(bidUnitPriceValidator),
  qualifications: v.optional(v.string()),
  validUntil: v.optional(v.string()),
  note: v.optional(v.string()),
};

type TermsArgs = {
  baseAmountCents: number;
  alternates: { description: string; amountCents: number }[];
  exclusions: string[];
  inclusions: string[];
  unitPrices: { item: string; unit: string; unitPriceCents: number }[];
  qualifications?: string;
  validUntil?: string;
  note?: string;
};

function cleanTermsOrThrow(args: TermsArgs): CleanBidTerms {
  const result = validateBidTerms(args);
  if (!result.ok) {
    const [field] = Object.keys(result.errors);
    throw new ConvexError({ code: "INVALID" as const, message: firstBidTermError(result.errors), field });
  }
  return result.terms;
}

const closedReason = biddingClosedReason;

/** Portal submissions also close at the package's due instant; GC-entered and emailed bids do not. */
function portalClosedReason(pkg: Doc<"tradePackages">, project: Doc<"projects">, now = Date.now()): string | null {
  const reason = closedReason(pkg, project);
  if (reason !== null) return reason;
  const state = projectStateOf(project);
  return bidDueHasPassed(pkg, state, now) ? bidDuePassedMessage(pkg, state) : null;
}

/** The caller's bidder record on the package, for human sub company members only. */
export async function invitedBidderOf(
  ctx: QueryCtx,
  access: ProjectAccess & { doc: Doc<"tradePackages"> },
): Promise<{ access: ProjectAccess; pkg: Doc<"tradePackages">; contractor: Doc<"contractors"> }> {
  // Billing agents act on an executed agreement's pay apps only; bidding belongs to company members.
  if (access.user.actorType === "agent" || access.company === null || access.company.kind !== "sub") throw notFound();
  const pkg = access.doc;
  for (const contractorId of access.contractorIds) {
    const contractor = await ctx.db.get(contractorId);
    if (contractor !== null && contractorCanBidOnPackage(contractor, pkg)) return { access, pkg, contractor };
  }
  throw notFound();
}

async function bidOf(ctx: QueryCtx, tradePackageId: Id<"tradePackages">, contractorId: Id<"contractors">) {
  return await ctx.db
    .query("bids")
    .withIndex("by_package_and_contractor", (q) => q.eq("tradePackageId", tradePackageId).eq("contractorId", contractorId))
    .first();
}

async function revisionsOf(ctx: QueryCtx, bidId: Id<"bids">) {
  return await ctx.db
    .query("bidRevisions")
    .withIndex("by_bid_and_revision", (q) => q.eq("bidId", bidId))
    .take(200);
}

/** Revisions oldest first, each with what changed from the one before it. */
function historyView(revisions: Doc<"bidRevisions">[]) {
  const sorted = [...revisions].sort((a, b) => a.revisionNumber - b.revisionNumber || a.createdAt - b.createdAt);
  return sorted.map((r, i) => {
    const terms: BidTerms = {
      baseAmountCents: r.baseAmountCents,
      alternates: r.alternates,
      exclusions: r.exclusions,
      inclusions: r.inclusions,
      unitPrices: r.unitPrices,
      ...(r.qualifications !== undefined ? { qualifications: r.qualifications } : {}),
      ...(r.validUntil !== undefined ? { validUntil: r.validUntil } : {}),
    };
    const prev = sorted[i - 1];
    const changes = prev
      ? describeTermChanges(
          {
            baseAmountCents: prev.baseAmountCents,
            alternates: prev.alternates,
            exclusions: prev.exclusions,
            inclusions: prev.inclusions,
            unitPrices: prev.unitPrices,
            ...(prev.qualifications !== undefined ? { qualifications: prev.qualifications } : {}),
            ...(prev.validUntil !== undefined ? { validUntil: prev.validUntil } : {}),
          },
          terms,
        )
      : [];
    return {
      _id: r._id,
      revisionNumber: r.revisionNumber,
      source: r.source,
      ...terms,
      note: r.note ?? null,
      submittedByName: r.submittedByName,
      sourceInboundEmailId: r.sourceInboundEmailId ?? null,
      createdAt: r.createdAt,
      changes,
    };
  });
}

/**
 * Keeps the GC's plug on an exclusion the bidder still lists; new exclusions start with no plug.
 * Exclusions the GC added while leveling are kept with their plugs whatever the bidder lists.
 */
function syncIdentifiedExclusions(existing: Doc<"bids"> | null, exclusions: string[]): Doc<"bids">["identifiedExclusions"] {
  const current = existing?.identifiedExclusions ?? [];
  const bidderRows = exclusions.map((description): Doc<"bids">["identifiedExclusions"][number] => {
    const kept = current.find((e) => e.description === description);
    if (kept) {
      return {
        ...(kept.canonicalCode ? { canonicalCode: kept.canonicalCode } : {}),
        description,
        ...keptPlugFields(kept),
        severity: kept.severity,
        ...(kept.isWaived !== undefined ? { isWaived: kept.isWaived } : {}),
      };
    }
    return { description, costImpactCents: 0, severity: "moderate" };
  });
  return reconcileBidderExclusions(existing, bidderRows);
}

type Submitter = {
  source: RevisionSource;
  name: string;
  userId?: Id<"users">;
  companyId?: Id<"companies">;
};

/**
 * Writes the bidder-facing terms as the bid's next revision. Leveling adjustments the GC made
 * (plugs, penalties, accepted VE) are kept; the leveled total is recomputed in cents.
 */
async function writeBidRevision(
  ctx: MutationCtx,
  args: {
    pkg: Doc<"tradePackages">;
    project: Doc<"projects">;
    contractor: Doc<"contractors">;
    terms: CleanBidTerms;
    submitter: Submitter;
    existing: Doc<"bids"> | null;
  },
): Promise<{ bidId: Id<"bids">; revisionNumber: number }> {
  const { pkg, project, contractor, terms, submitter, existing } = args;
  const reason = submitter.source === "portal" ? portalClosedReason(pkg, project) : closedReason(pkg, project);
  if (reason !== null || existing?.isAwarded) {
    throw new ConvexError({ code: "CLOSED" as const, message: reason ?? "Bidding on this package is closed: it has been awarded." });
  }
  const current = existing ? bidCents(existing) : { leadTimePenaltyCents: 0, coiPenaltyCents: 0 };
  const identifiedExclusions = syncIdentifiedExclusions(existing, terms.exclusions);
  const valueEngineeringAlternates = (existing?.valueEngineeringAlternates ?? []).map((a) => ({
    description: a.description,
    costDeductCents: a.costDeductCents ?? 0,
    isAccepted: a.isAccepted,
  }));
  const existingLines = (existing?.lineItems ?? []) as BidLineItemCents[];
  const linesTotal = existingLines.reduce((s, li) => s + (li.totalCostCents ?? 0), 0);
  const lineItems: BidLineItemCents[] =
    existingLines.length > 0 && linesTotal === terms.baseAmountCents
      ? existingLines.map((li) => ({ item: li.item, unit: li.unit, quantity: li.quantity, unitCostCents: li.unitCostCents ?? 0, totalCostCents: li.totalCostCents ?? 0 }))
      : [{ item: "Base bid", unit: "LS", quantity: 1, unitCostCents: terms.baseAmountCents, totalCostCents: terms.baseAmountCents }];
  const leveledTotalCents = computeLeveledTotalCents({
    baseAmountCents: terms.baseAmountCents,
    exclusions: identifiedExclusions,
    veAlternates: valueEngineeringAlternates,
    leadTimePenaltyCents: current.leadTimePenaltyCents,
    coiPenaltyCents: current.coiPenaltyCents,
  });
  const now = Date.now();
  const isGcEdit = submitter.source === "gc_edit";
  const fields = {
    ...CLEAR_LEGACY_BID_DOLLARS,
    subcontractorName: contractor.companyName.trim() || existing?.subcontractorName || "Bidder",
    baseAmountCents: terms.baseAmountCents,
    lineItems,
    identifiedExclusions,
    valueEngineeringAlternates,
    leadTimePenaltyCents: current.leadTimePenaltyCents,
    coiPenaltyCents: current.coiPenaltyCents,
    leveledTotalCents,
    alternates: terms.alternates,
    exclusions: terms.exclusions,
    inclusions: terms.inclusions,
    unitPrices: terms.unitPrices,
    qualifications: terms.qualifications,
    validUntil: terms.validUntil,
    // A GC correction of an AI-parsed bid keeps its origin and marks it confirmed.
    ...(isGcEdit
      ? { confirmedByUserId: submitter.userId, confirmedByName: submitter.name, confirmedAt: now }
      : {
          source: submitter.source as Doc<"bids">["source"],
          sourceInboundEmailId: undefined,
          submittedByUserId: submitter.userId,
          submittedByName: submitter.name,
          submittedByCompanyId: submitter.companyId,
          confirmedByUserId: undefined,
          confirmedByName: undefined,
          confirmedAt: undefined,
        }),
  };
  let bidId: Id<"bids">;
  let revisionNumber: number;
  if (existing) {
    bidId = existing._id;
    revisionNumber = (existing.revisionNumber ?? 1) + 1;
    await ctx.db.patch(existing._id, { ...fields, revisionNumber, lastRevisedAt: now, ...(isGcEdit ? {} : { receivedAt: now }) });
  } else {
    revisionNumber = 1;
    bidId = await ctx.db.insert("bids", {
      tradePackageId: pkg._id,
      contractorId: contractor._id,
      ...fields,
      longLeadEquipmentWeeks: 0,
      coiComplianceStatus: "compliant",
      isAwarded: false,
      revisionNumber,
      receivedAt: now,
    });
  }
  const saved = (await ctx.db.get(bidId))!;
  await recordBidRevision(ctx, saved, {
    source: submitter.source,
    terms: termsOfBid(saved),
    ...(terms.note ? { note: terms.note } : {}),
    submittedByUserId: submitter.userId,
    submittedByName: submitter.name,
    submittedByCompanyId: submitter.companyId,
  });
  if (!isGcEdit && contractor.rfqStatus !== "bid_received") await ctx.db.patch(contractor._id, { rfqStatus: "bid_received" });
  if (pkg.status === "draft" || pkg.status === "rfqs_dispatched") await ctx.db.patch(pkg._id, { status: "leveling" });
  if (saved.isAwarded) await syncAgreementForBid(ctx, bidId);
  return { bidId, revisionNumber };
}

function bidderTermsView(bid: Doc<"bids">) {
  return {
    _id: bid._id,
    revisionNumber: bid.revisionNumber ?? 1,
    receivedAt: bid.receivedAt,
    lastRevisedAt: bid.lastRevisedAt ?? null,
    isAwarded: bid.isAwarded,
    ...termsOfBid(bid),
  };
}

type InvitationStatus = "not_submitted" | "submitted" | "awarded" | "not_awarded" | "closed";

function invitationStatus(pkg: Doc<"tradePackages">, project: Doc<"projects">, bid: Doc<"bids"> | null): InvitationStatus {
  if (bid?.isAwarded) return "awarded";
  if (pkg.status === "awarded") return "not_awarded";
  if (portalClosedReason(pkg, project) !== null) return "closed";
  return bid ? "submitted" : "not_submitted";
}

async function gcCompanyName(ctx: QueryCtx, project: Doc<"projects">): Promise<string> {
  const company = project.gcCompanyId ? await ctx.db.get(project.gcCompanyId) : null;
  return company?.name ?? "General contractor";
}

/** Bid invitations of the caller's sub company: one row per package one of its bidder records may bid on. */
export const listMyBidInvitations = query({
  args: {},
  handler: async (ctx) => {
    const { user, company } = await requireCompanyMember(ctx);
    if (user.actorType === "agent" || company.kind !== "sub") throw notFound();
    const companyId = company._id;
    const contractors = await ctx.db
      .query("contractors")
      .withIndex("by_linkedCompanyId", (q) => q.eq("linkedCompanyId", companyId))
      .take(200);
    if (contractors.length === 0) return [];
    const rows = [];
    for (const projectId of await accessibleProjectIds(ctx)) {
      const project = await ctx.db.get(projectId);
      if (project === null) continue;
      const packages = await ctx.db
        .query("tradePackages")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(200);
      for (const pkg of packages) {
        const contractor = contractors.find((c) => contractorCanBidOnPackage(c, pkg));
        if (!contractor) continue;
        const bid = await bidOf(ctx, pkg._id, contractor._id);
        rows.push({
          tradePackageId: pkg._id,
          projectId,
          projectTitle: project.title,
          projectLocation: project.location,
          gcName: await gcCompanyName(ctx, project),
          csiDivision: pkg.csiDivision,
          tradeName: pkg.tradeName,
          bidDeadline: pkg.bidDeadline,
          ...packageDue(pkg, project),
          bidderName: contractor.companyName,
          status: invitationStatus(pkg, project, bid),
          revisionNumber: bid ? (bid.revisionNumber ?? 1) : 0,
          lastSubmittedAt: bid ? (bid.lastRevisedAt ?? bid.receivedAt) : null,
        });
      }
    }
    return rows.sort((a, b) => (a.bidClosesAt ?? Infinity) - (b.bidClosesAt ?? Infinity) || a.bidDeadline.localeCompare(b.bidDeadline));
  },
});

/** Published Q&A for every invited bidder: no asker identity, only the GC-approved text. */
async function publishedQuestions(ctx: QueryCtx, pkgId: Id<"tradePackages">) {
  const rows = await ctx.db
    .query("conversations")
    .withIndex("by_package", (q) => q.eq("tradePackageId", pkgId))
    .take(500);
  return rows
    .filter((c) => c.publishedAt !== undefined)
    .sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0))
    .map((c) => ({
      _id: c._id,
      question: c.publishedQuestion ?? c.inboundQuestion,
      answer: c.publishedAnswer ?? c.autonomousReply,
      publishedAt: c.publishedAt as number,
    }));
}

/** One invited package as its bidder sees it: scope, due date, documents, published Q&A and the bidder's own bid. */
export const getPackageForBidder = query({
  args: { tradePackageId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["sub"] });
    const { access, pkg, contractor } = await invitedBidderOf(ctx, scope);
    const project = access.project;
    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(500);
    const documents = files
      .filter((f) => isBidDocumentForPackage(f, pkg))
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
      .map((f) => {
        const isPublic = f.storageId.startsWith("http") || f.storageId.startsWith("/");
        return {
          _id: f._id,
          fileName: f.fileName,
          fileType: f.fileType,
          fileSize: f.fileSize,
          uploadedAt: f.uploadedAt,
          url: isPublic ? f.storageId : null,
          downloadPath: isPublic ? null : `/api/project-files/${f._id}`,
        };
      });
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_contractor", (q) => q.eq("contractorId", contractor._id))
      .take(200);
    const myQuestions = conversations
      .filter((c) => c.tradePackageId === pkg._id && c.origin === "portal")
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((c) => ({
        _id: c._id,
        question: c.inboundQuestion,
        askedAt: c.timestamp,
        published: c.publishedAt !== undefined,
      }));
    const bid = await bidOf(ctx, pkg._id, contractor._id);
    const revisions = bid ? historyView(await revisionsOf(ctx, bid._id)) : [];
    const acks = await ctx.db
      .query("addendumAcknowledgments")
      .withIndex("by_package_and_contractor", (q) => q.eq("tradePackageId", pkg._id).eq("contractorId", contractor._id))
      .take(200);
    const acknowledged = new Map<string, number>(acks.map((a) => [a.projectFileId as string, a.acknowledgedAt]));
    return {
      package: {
        _id: pkg._id,
        csiDivision: pkg.csiDivision,
        tradeName: pkg.tradeName,
        scopeSummary: pkg.scopeSummary,
        mandatoryInclusions: pkg.mandatoryInclusions,
        bidDeadline: pkg.bidDeadline,
        ...packageDue(pkg, project),
      },
      project: { _id: project._id, title: project.title, location: project.location },
      gcName: await gcCompanyName(ctx, project),
      bidderName: contractor.companyName,
      status: invitationStatus(pkg, project, bid),
      closedReason: bid?.isAwarded ? "Your bid was awarded; revisions are closed." : portalClosedReason(pkg, project),
      documents,
      addenda: documents
        .filter((d) => d.fileType === "addendum")
        .map((d) => ({ ...d, acknowledgedAt: acknowledged.get(d._id) ?? null })),
      questions: await publishedQuestions(ctx, pkg._id),
      myQuestions,
      myBid: bid ? { ...bidderTermsView(bid), revisions: revisions.map(({ sourceInboundEmailId: _s, submittedByName: _n, ...r }) => r) } : null,
    };
  },
});

/** The sub submits its bid, or revises it (each submission is a new revision). */
export const submitPortalBid = mutation({
  args: { tradePackageId: v.string(), ...termsArgs },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["sub"], write: true });
    const { access, pkg, contractor } = await invitedBidderOf(ctx, scope);
    const { tradePackageId: _p, ...input } = args;
    const terms = cleanTermsOrThrow(input);
    const existing = await bidOf(ctx, pkg._id, contractor._id);
    const actor = auditActor(access);
    const { bidId, revisionNumber } = await writeBidRevision(ctx, {
      pkg,
      project: access.project,
      contractor,
      terms,
      existing,
      submitter: { source: "portal", name: actor.actor, userId: access.user._id, companyId: access.company?._id },
    });
    await ctx.db.insert("auditLogs", {
      projectId: pkg.projectId,
      tradePackageId: pkg._id,
      eventType: "quote_received",
      title: `Bid ${revisionNumber === 1 ? "submitted" : `revision ${revisionNumber} submitted`}: ${contractor.companyName}`,
      description: `${actor.actor} (${access.company?.name ?? contractor.companyName}) submitted a base bid of ${formatCents(terms.baseAmountCents)} for Division ${pkg.csiDivision} through the bid portal.`,
      ...actor,
      contractorId: contractor._id,
      timestamp: Date.now(),
    });
    return { bidId, revisionNumber, baseAmountCents: terms.baseAmountCents };
  },
});

/** The sub asks a pre-bid question. The GC sees who asked; other bidders see it only once published, without a name. */
export const askBidQuestion = mutation({
  args: { tradePackageId: v.string(), question: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["sub"], write: true });
    const { access, pkg, contractor } = await invitedBidderOf(ctx, scope);
    const question = args.question.trim().replace(/\s+\n/g, "\n");
    if (question.length < 5) throw new ConvexError({ code: "INVALID" as const, message: "Type your question (at least 5 characters).", field: "question" });
    if (question.length > 2000) throw new ConvexError({ code: "INVALID" as const, message: "Keep the question under 2,000 characters.", field: "question" });
    const now = Date.now();
    const conversationId = await ctx.db.insert("conversations", {
      tradePackageId: pkg._id,
      contractorId: contractor._id,
      threadId: `portal:${pkg._id}:${contractor._id}:${now}`,
      inboundSubject: `Bid portal question — ${pkg.csiDivision} ${pkg.tradeName}`,
      inboundQuestion: question,
      autonomousReply: "",
      confidenceScore: 0,
      status: "pending_analysis",
      timestamp: now,
      origin: "portal",
      askedByUserId: access.user._id,
      askedByCompanyId: access.company?._id,
    });
    const actor = auditActor(access);
    await ctx.db.insert("auditLogs", {
      projectId: pkg.projectId,
      tradePackageId: pkg._id,
      eventType: "rfi_clarified",
      title: `Bidder question received: ${contractor.companyName}`,
      description: `${actor.actor} asked a question about Division ${pkg.csiDivision} in the bid portal. An AI draft answer is prepared for GC review; nothing is sent automatically.`,
      ...actor,
      contractorId: contractor._id,
      timestamp: now,
    });
    await ctx.scheduler.runAfter(0, internal.bidPortal.draftPortalAnswer, { conversationId });
    return { conversationId };
  },
});

export const portalQuestionContext = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.conversationId);
    if (convo === null || convo.origin !== "portal" || convo.status !== "pending_analysis") return null;
    const pkg = await ctx.db.get(convo.tradePackageId);
    const project = pkg ? await ctx.db.get(pkg.projectId) : null;
    if (pkg === null || project === null) return null;
    return {
      question: convo.inboundQuestion,
      csiDivision: pkg.csiDivision,
      tradeName: pkg.tradeName,
      scopeSummary: pkg.scopeSummary,
      mandatoryInclusions: pkg.mandatoryInclusions,
      gcName: await gcCompanyName(ctx, project),
    };
  },
});

/** Stores the AI draft. The answer stays a draft for GC review ("escalated_to_pm"); it is never sent or published by itself. */
export const storePortalDraft = internalMutation({
  args: { conversationId: v.id("conversations"), draft: v.optional(v.string()), confidenceScore: v.optional(v.number()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const convo = await ctx.db.get(args.conversationId);
    if (convo === null || convo.status !== "pending_analysis") return;
    if (args.draft === undefined) {
      await ctx.db.patch(convo._id, { status: "failed_analysis", analysisError: (args.error ?? "The AI draft could not be prepared.").slice(0, 400) });
      return;
    }
    await ctx.db.patch(convo._id, {
      autonomousReply: args.draft,
      confidenceScore: args.confidenceScore ?? 0,
      status: "escalated_to_pm",
      analysisError: undefined,
    });
  },
});

export const draftPortalAnswer = internalAction({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.bidPortal.portalQuestionContext, args);
    if (context === null) return;
    try {
      const result = await ctx.runAction(internal.llmRouter.executeReasoning, {
        taskType: "rfi_reply",
        prompt: `Bidder question: ${context.question}\nContext: CSI ${context.csiDivision} (${context.tradeName}). Scope: ${context.scopeSummary}. Mandatory inclusions: ${context.mandatoryInclusions.join("; ")}. Draft a concise markdown answer: a one-line determination, the reasons with spec/section references, and any action required of the bidder.`,
        systemPrompt: `You draft answers to subcontractor pre-bid questions on behalf of ${context.gcName}. A GC project manager reviews and edits every draft before anything is published to bidders.`,
        companyName: context.gcName,
      });
      await ctx.runMutation(internal.bidPortal.storePortalDraft, {
        conversationId: args.conversationId,
        draft: String(result.content ?? ""),
        confidenceScore: typeof result.confidenceScore === "number" ? result.confidenceScore : 0,
      });
    } catch (err) {
      await ctx.runMutation(internal.bidPortal.storePortalDraft, {
        conversationId: args.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// ---------------------------------------------------------------------------------------------
// GC side
// ---------------------------------------------------------------------------------------------

/** Every bid on the package with its source, attribution and revision history (GC only). */
export const listPackageBidsWithHistory = query({
  args: { tradePackageId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"] });
    const bids = await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", access.doc._id))
      .take(200);
    const out = [];
    for (const bid of bids) {
      const message = bid.sourceInboundEmailId ? await ctx.db.get(bid.sourceInboundEmailId) : null;
      out.push({
        ...bidderTermsView(bid),
        packageAwarded: access.doc.status === "awarded",
        contractorId: bid.contractorId,
        subcontractorName: bid.subcontractorName,
        leveledTotalCents: bidCents(bid).leveledTotalCents,
        source: bid.source ?? "legacy",
        submittedByName: bid.submittedByName ?? null,
        sourceInboundEmail: message ? { _id: message._id, subject: message.subject, receivedAt: message.receivedAt } : null,
        confirmedByName: bid.confirmedByName ?? null,
        confirmedAt: bid.confirmedAt ?? null,
        history: historyView(await revisionsOf(ctx, bid._id)),
      });
    }
    return out.sort((a, b) => a.subcontractorName.localeCompare(b.subcontractorName));
  },
});

/** The GC records a bid it received by phone or paper; it is attributed to the GC user, never to the bidder. */
export const enterBidOnBehalf = mutation({
  args: { tradePackageId: v.string(), contractorId: v.string(), ...termsArgs },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"], write: true });
    const pkg = access.doc;
    const contractor = await requireDocOfProject(ctx, access, "contractors", args.contractorId);
    if (!contractorCanBidOnPackage(contractor, pkg)) throw notFound();
    const { tradePackageId: _p, contractorId: _c, ...input } = args;
    const terms = cleanTermsOrThrow(input);
    const existing = await bidOf(ctx, pkg._id, contractor._id);
    const actor = auditActor(access);
    const { bidId, revisionNumber } = await writeBidRevision(ctx, {
      pkg,
      project: access.project,
      contractor,
      terms,
      existing,
      submitter: { source: "gc_entered", name: actor.actor, userId: access.user._id, companyId: access.company?._id },
    });
    await ctx.db.insert("auditLogs", {
      projectId: pkg.projectId,
      tradePackageId: pkg._id,
      eventType: "quote_received",
      title: `Bid entered on behalf of ${contractor.companyName}`,
      description: `${actor.actor} entered ${contractor.companyName}'s base bid of ${formatCents(terms.baseAmountCents)} (revision ${revisionNumber}) for Division ${pkg.csiDivision}.`,
      ...actor,
      contractorId: contractor._id,
      timestamp: Date.now(),
    });
    return { bidId, revisionNumber };
  },
});

/**
 * The GC confirms an AI-parsed (or any) bid, optionally correcting its terms. A correction is
 * recorded as a "GC edit" revision; confirming unchanged terms records no revision.
 */
export const confirmParsedBid = mutation({
  args: { bidId: v.string(), ...termsArgs },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "bids", args.bidId, { roles: ["gc"], write: true });
    const bid = access.doc;
    const pkg = await ctx.db.get(bid.tradePackageId);
    const contractor = await ctx.db.get(bid.contractorId);
    if (pkg === null || contractor === null) throw notFound();
    const { bidId: _b, ...input } = args;
    const terms = cleanTermsOrThrow(input);
    const actor = auditActor(access);
    const before = termsOfBid(bid);
    const after: BidTerms = {
      baseAmountCents: terms.baseAmountCents,
      alternates: terms.alternates,
      exclusions: terms.exclusions,
      inclusions: terms.inclusions,
      unitPrices: terms.unitPrices,
      ...(terms.qualifications !== undefined ? { qualifications: terms.qualifications } : {}),
      ...(terms.validUntil !== undefined ? { validUntil: terms.validUntil } : {}),
    };
    const changes = describeTermChanges(before, after);
    let revisionNumber = bid.revisionNumber ?? 1;
    if (changes.length > 0) {
      ({ revisionNumber } = await writeBidRevision(ctx, {
        pkg,
        project: access.project,
        contractor,
        terms,
        existing: bid,
        submitter: { source: "gc_edit", name: actor.actor, userId: access.user._id, companyId: access.company?._id },
      }));
    } else {
      await ctx.db.patch(bid._id, { confirmedByUserId: access.user._id, confirmedByName: actor.actor, confirmedAt: Date.now() });
    }
    await ctx.db.insert("auditLogs", {
      projectId: pkg.projectId,
      tradePackageId: pkg._id,
      eventType: "bid_leveled",
      title: `${changes.length > 0 ? "Bid corrected and confirmed" : "Bid confirmed"}: ${bid.subcontractorName}`,
      description:
        changes.length > 0
          ? `${actor.actor} corrected ${bid.subcontractorName}'s bid (revision ${revisionNumber}): ${changes.join("; ")}.`
          : `${actor.actor} confirmed ${bid.subcontractorName}'s bid of ${formatCents(terms.baseAmountCents)} as parsed.`,
      ...actor,
      contractorId: bid.contractorId,
      timestamp: Date.now(),
    });
    return { bidId: bid._id, revisionNumber, changed: changes.length > 0 };
  },
});

/** Bidder questions on the package for the GC: who asked, the AI draft, and what was published. */
export const listPackageQuestions = query({
  args: { tradePackageId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"] });
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_package", (q) => q.eq("tradePackageId", access.doc._id))
      .order("desc")
      .take(200);
    const gcCompany = access.project.gcCompanyId ? await ctx.db.get(access.project.gcCompanyId) : null;
    const isDemo = gcCompany ? gcCompany.isDemo : true;
    const inbound = await ctx.db
      .query("inboundEmails")
      .withIndex("by_tradePackageId", (q) => q.eq("tradePackageId", access.doc._id))
      .order("desc")
      .take(500);
    const routedByThread = new Map<string, Doc<"inboundEmails">>();
    for (const m of inbound) {
      const key = `${m.threadId}|${m.contractorId}`;
      if (m.routing === "routed" && !routedByThread.has(key)) routedByThread.set(key, m);
    }
    const out = [];
    for (const c of rows) {
      const contractor = await ctx.db.get(c.contractorId);
      const company = c.askedByCompanyId ? await ctx.db.get(c.askedByCompanyId) : null;
      const asker = c.askedByUserId ? await ctx.db.get(c.askedByUserId) : null;
      const sourceEmail = c.sourceInboundEmailId
        ? await ctx.db.get(c.sourceInboundEmailId)
        : c.origin === "portal"
          ? null
          : (routedByThread.get(`${c.threadId}|${c.contractorId}`) ?? null);
      out.push({
        _id: c._id,
        origin: c.origin ?? "email",
        isDemo,
        subject: c.inboundSubject,
        replyTo: sourceEmail?.from ?? null,
        aiDraft: c.aiDraft ?? null,
        answerText: c.answerText ?? null,
        answerEmailStatus: c.answerEmailStatus ?? null,
        answerEmailError: c.answerEmailError ?? null,
        answeredAt: c.answeredAt ?? null,
        answeredByName: c.answeredByName ?? null,
        question: c.inboundQuestion,
        askedAt: c.timestamp,
        askerCompanyName: company?.name ?? contractor?.companyName ?? "Bidder",
        askerName: asker?.name ?? null,
        draft: c.autonomousReply,
        status: c.status,
        analysisError: c.analysisError ?? null,
        publishedAt: c.publishedAt ?? null,
        publishedQuestion: c.publishedQuestion ?? null,
        publishedAnswer: c.publishedAnswer ?? null,
      });
    }
    return out;
  },
});

/** Publishes a question and the GC-reviewed answer to every invited bidder, without the asker's name. */
export const publishQuestion = mutation({
  args: { conversationId: v.string(), question: v.string(), answer: v.string() },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "conversations", args.conversationId, { roles: ["gc"], write: true });
    const convo = access.doc;
    const question = args.question.trim();
    const answer = args.answer.trim();
    if (question.length < 5 || question.length > 2000) {
      throw new ConvexError({ code: "INVALID" as const, message: "Enter the question to publish (5–2,000 characters).", field: "question" });
    }
    if (answer.length < 2 || answer.length > 8000) {
      throw new ConvexError({ code: "INVALID" as const, message: "Enter the answer to publish (up to 8,000 characters).", field: "answer" });
    }
    const actor = auditActor(access);
    const now = Date.now();
    await ctx.db.patch(convo._id, {
      publishedAt: now,
      publishedQuestion: question,
      publishedAnswer: answer,
      publishedByUserId: access.user._id,
      autonomousReply: answer,
      status: "clarified",
      pmCertifiedAt: now,
      pmCertifiedBy: actor.actor,
    });
    const pkg = await ctx.db.get(convo.tradePackageId);
    if (pkg) {
      await ctx.db.insert("auditLogs", {
        projectId: pkg.projectId,
        tradePackageId: pkg._id,
        eventType: "rfi_clarified",
        title: `Q&A published to bidders: Division ${pkg.csiDivision}`,
        description: `${actor.actor} published an answer to a bidder question for every invited bidder. The asker is not named.`,
        ...actor,
        timestamp: now,
      });
    }
    return { conversationId: convo._id, publishedAt: now };
  },
});
