import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { sumSovCents } from "./lib/sovRules";
import { auditActor, partyMaySeeContractor, requireDocOfProject, requireDocScope, requireProjectScope } from "./lib/projectScope";
import { v, ConvexError } from "convex/values";
import { validateProjectText } from "./validation";
import { generalContractorNameFor } from "./lib/gcCompanyName";
import {
  currentDraftTerms,
  defaultTermsForProject,
  legacyTermFields,
  refreshAgreementDocument,
  termsContextFor,
} from "./lib/agreementDocument";
import { draftFromTerms, firstTermsError, validateAgreementTerms } from "./lib/agreementTerms";
import { formatCents } from "./lib/money";
import { acceptedIndexesFor, agreementAwardFields, computeAwardSum, excludedScopeNotesFor } from "./lib/awardMath";
import {
  agreementContractSumCents,
  ensureSovAndMilestones,
  hasMoneyActivity,
  removeSovAndMilestonesIfUnbilled,
  sovIsApproved,
} from "./payments/sov";
import { contractorCanBidOnPackage } from "./lib/packageContractors";
import { loadSovRows } from "./lib/sovLines";

/**
 * Awards a bid and generates its subcontract draft (AIA-style terms, not an AIA form). Terms default
 * from the project and the GC company and stay editable until execution (agreementTerms.ts).
 * Contract sum = the bid's base + the alternates the GC accepts (indexes into `bid.alternates`)
 * − accepted VE deducts; leveling plugs and penalties are never included.
 */
export const generateAgreement = mutation({
  args: {
    bidId: v.id("bids"),
    tradePackageId: v.id("tradePackages"),
    acceptedAlternateIndexes: v.optional(v.array(v.number())),
  },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"], write: true });
    const tradePkg = access.doc;
    const project = access.project;
    const bid = await requireDocOfProject(ctx, access, "bids", args.bidId);
    if (bid.tradePackageId !== args.tradePackageId) {
      throw new Error("Bid and trade package do not belong to the same procurement scope.");
    }
    // Check if an agreement already exists for this bid
    const existing = await ctx.db
      .query("agreements")
      .withIndex("by_bid", (q) => q.eq("bidId", args.bidId))
      .first();

    // Executed subcontracts are immutable: awarding a different bid must never
    // silently supersede a signed agreement (A1-02 / A3-03).
    const packageAgreements = await ctx.db
      .query("agreements")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
    const executedAgreement = packageAgreements.find((a) => a.status === "executed");
    if (executedAgreement && executedAgreement.bidId !== args.bidId) {
      throw new ConvexError(
        `An executed subcontract (${executedAgreement.agreementNumber}) already exists for this package. Void or amend it explicitly before awarding a different bid.`
      );
    }

    const sum = computeAwardSum(bid, args.acceptedAlternateIndexes ?? []);
    const awardFields = agreementAwardFields(sum, excludedScopeNotesFor(bid));
    const sumText = `${formatCents(sum.contractSumCents)} (base bid ${formatCents(sum.baseBidCents)}${
      sum.acceptedAlternates.length > 0 ? ` + ${sum.acceptedAlternates.length} accepted alternate${sum.acceptedAlternates.length === 1 ? "" : "s"}` : ", no alternates accepted"
    }${sum.veDeducts.length > 0 ? " − accepted VE deducts" : ""}; leveling plugs excluded)`;
    const contractor = await ctx.db.get(bid.contractorId);
    if (!contractor || !contractorCanBidOnPackage(contractor, tradePkg)) {
      throw new Error("The selected bid is not linked to a valid contractor in this trade package.");
    }
    const subName = contractor.companyName.trim();
    if (!subName) throw new Error("The selected contractor must have a company name before an agreement can be generated.");
    const generalContractor = await generalContractorNameFor(ctx, project);

    if (existing) {
      if (existing.status === "executed") {
        throw new ConvexError("Executed agreements are immutable. Create a formal amendment instead of regenerating this agreement.");
      }
      // Re-award this bid and package, supersede other agreements
      const packageBids = await ctx.db
        .query("bids")
        .withIndex("by_package", (q) => q.eq("tradePackageId", tradePkg._id))
        .collect();
      for (const b of packageBids) {
        if (b._id !== bid._id && b.isAwarded) {
          await ctx.db.patch(b._id, { isAwarded: false });
        }
      }
      const prevAgreements = await ctx.db
        .query("agreements")
        .withIndex("by_package", (q) => q.eq("tradePackageId", tradePkg._id))
        .collect();
      for (const prev of prevAgreements) {
        if (prev._id !== existing._id && prev.status !== "superseded" && prev.status !== "executed") {
          await ctx.db.patch(prev._id, { status: "superseded" });
        }
      }
      await ctx.db.patch(bid._id, { isAwarded: true });
      await ctx.db.patch(tradePkg._id, { status: "awarded" });

      await ctx.db.patch(existing._id, {
        status: "generated",
        contractorId: bid.contractorId,
        subcontractorName: subName,
        subcontractorEmail: contractor.contactEmail,
        generalContractorName: generalContractor,
        ...awardFields,
        scopeSummary: tradePkg.scopeSummary,
        mandatoryInclusions: tradePkg.mandatoryInclusions,
      });
      await refreshAgreementDocument(ctx, existing._id);
      if (sovIsApproved(existing)) {
        // The approval lock covers regeneration too: approved lines are kept, and only a contract sum
        // that no longer matches them sends the SOV back to draft (lines intact) for the GC to reconcile.
        await reopenSovIfSumChanged(ctx, existing._id);
      } else {
        await removeSovAndMilestonesIfUnbilled(ctx, existing._id);
        // A re-award starts a fresh draft SOV prefilled from the newly selected bid.
        if (!(await hasMoneyActivity(ctx, existing._id))) await ctx.db.patch(existing._id, { sov: { status: "draft" } });
      }
      await ensureSovAndMilestones(ctx, existing._id);

      await ctx.db.insert("auditLogs", {
        projectId: project._id,
        tradePackageId: tradePkg._id,
        eventType: "contract_awarded",
        title: `Subcontract Agreement Re-Awarded: ${subName}`,
        description: `Re-activated subcontract agreement ${existing.agreementNumber} for CSI Division ${tradePkg.csiDivision} (${tradePkg.tradeName}) in the amount of ${sumText}.`,
        ...auditActor(access),
        timestamp: Date.now(),
      });
      return await ctx.db.get(existing._id);
    }

    const agreementNumber = `SC-${tradePkg.csiDivision.replace(/\s+/g, "").slice(0, 4)}-${Date.now().toString().slice(-6)}`;
    const terms = await defaultTermsForProject(ctx, project, sum.contractSumCents);

    const agreementId = await ctx.db.insert("agreements", {
      projectId: project._id,
      tradePackageId: tradePkg._id,
      bidId: bid._id,
      contractorId: bid.contractorId,
      agreementNumber,
      documentTitle: "Subcontract Agreement (AIA-style terms) — generated draft, not an AIA form",
      subcontractorName: subName,
      subcontractorEmail: contractor.contactEmail,
      generalContractorName: generalContractor,
      projectTitle: project.title,
      projectLocation: project.location,
      csiDivision: tradePkg.csiDivision,
      tradeName: tradePkg.tradeName,
      ...awardFields,
      ...legacyTermFields(terms),
      terms,
      scopeSummary: tradePkg.scopeSummary,
      mandatoryInclusions: tradePkg.mandatoryInclusions,
      status: "generated",
      contractText: "",
      createdAt: Date.now(),
    });
    await refreshAgreementDocument(ctx, agreementId, terms);
    await ensureSovAndMilestones(ctx, agreementId);

    // Un-award any other bids in this package
    const packageBids = await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", tradePkg._id))
      .collect();
    for (const b of packageBids) {
      if (b._id !== bid._id && b.isAwarded) {
        await ctx.db.patch(b._id, { isAwarded: false });
      }
    }

    // Mark any previous agreements for this package as superseded
    const prevAgreements = await ctx.db
      .query("agreements")
      .withIndex("by_package", (q) => q.eq("tradePackageId", tradePkg._id))
      .collect();
    for (const prev of prevAgreements) {
      if (prev._id !== agreementId && prev.status !== "superseded") {
        await ctx.db.patch(prev._id, { status: "superseded" });
      }
    }

    // Mark the bid as awarded
    await ctx.db.patch(bid._id, { isAwarded: true });

    // Mark the trade package as awarded
    await ctx.db.patch(tradePkg._id, { status: "awarded" });

    // Record in reactive audit stream
    await ctx.db.insert("auditLogs", {
      projectId: project._id,
      tradePackageId: tradePkg._id,
      eventType: "contract_awarded",
      title: `Subcontract Agreement Awarded: ${subName}`,
      description: `Subcontract agreement ${agreementNumber} generated for CSI Division ${tradePkg.csiDivision} (${tradePkg.tradeName}) in the amount of ${sumText} — pending external execution.`,
      ...auditActor(access),
      timestamp: Date.now(),
    });

    return await ctx.db.get(agreementId);
  },
});

/**
 * A11-03: executed agreements are immutable by default, but the GC needs an
 * explicit escape hatch so a mistaken execution is not a permanent dead end.
 * Voiding supersedes the agreement, un-awards the bid, reopens the package, and
 * writes the operator's reason to the audit stream.
 */
export const voidExecutedAgreement = mutation({
  args: {
    agreementId: v.id("agreements"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "agreements", args.agreementId, { roles: ["gc"], write: true });
    const agreement = access.doc;
    if (agreement.status !== "executed") {
      throw new ConvexError("Only an executed agreement can be voided.");
    }
    const reason = validateProjectText(args.reason, "Void reason");
    if (reason.length < 10) {
      throw new ConvexError("Enter a void reason of at least 10 characters for the audit record.");
    }

    await ctx.db.patch(args.agreementId, { status: "superseded" });
    const { removed } = await removeSovAndMilestonesIfUnbilled(ctx, args.agreementId);
    // With its lines gone, no approval is left to honour; a later re-award prefills a fresh draft.
    if (removed) await ctx.db.patch(args.agreementId, { sov: { status: "draft" } });
    const bid = await ctx.db.get(agreement.bidId);
    if (bid) await ctx.db.patch(bid._id, { isAwarded: false });
    const pkg = await ctx.db.get(agreement.tradePackageId);
    if (pkg) await ctx.db.patch(pkg._id, { status: "leveling" });

    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      tradePackageId: agreement.tradePackageId,
      eventType: "compliance_audit",
      title: `Executed Subcontract Voided: ${agreement.agreementNumber}`,
      description: `Executed subcontract ${agreement.agreementNumber} (${agreement.subcontractorName}) was voided: ${reason} The package is reopened for leveling and external amendment.`,
      ...auditActor(access),
      contractorId: agreement.contractorId,
      timestamp: Date.now(),
    });

    return { success: true, agreementNumber: agreement.agreementNumber };
  },
});

export const getAgreementByBid = query({
  args: { bidId: v.id("bids") },
  handler: async (ctx, args) => {
    await requireDocScope(ctx, "bids", args.bidId, { roles: ["gc"] });
    return await ctx.db
      .query("agreements")
      .withIndex("by_bid", (q) => q.eq("bidId", args.bidId))
      .first();
  },
});

export const getAgreementByPackage = query({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"] });
    return await ctx.db
      .query("agreements")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .order("desc")
      .first();
  },
});

/** Subcontract agreements: the GC sees all, a sub only its own vendor's, an owner none. */
export const listAgreements = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc", "owner", "sub"] });
    const agreements = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .collect();
    return agreements.filter((a) => partyMaySeeContractor(access, a.contractorId));
  },
});

export const executeAgreement = mutation({
  args: { agreementId: v.id("agreements") },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "agreements", args.agreementId, { roles: ["gc"], write: true });
    const agreement = access.doc;

    if (agreement.status === "superseded") {
      throw new ConvexError("Cannot execute a superseded agreement. Regenerate or re-award it first.");
    }
    if (agreement.status === "executed") {
      // Backfills agreements executed before SOV generation existed; no-op otherwise.
      await ensureSovAndMilestones(ctx, args.agreementId);
      return { success: true, agreementNumber: agreement.agreementNumber };
    }

    // Project settings may have changed since the draft was generated (state, prime retainage,
    // address, owner), so the terms are checked and the text re-rendered against the project now.
    const terms = currentDraftTerms(agreement, access.project);
    const invalid = firstTermsError(validateAgreementTerms(draftFromTerms(terms), termsContextFor(agreement, access.project)));
    if (invalid) {
      throw new ConvexError({
        code: "INVALID",
        field: invalid.field,
        message: `${invalid.message} Edit the agreement terms before executing.`,
      });
    }
    await refreshAgreementDocument(ctx, args.agreementId, terms);
    await ctx.db.patch(args.agreementId, {
      status: "executed",
      executedAt: Date.now(),
    });
    await ensureSovAndMilestones(ctx, args.agreementId);

    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      tradePackageId: agreement.tradePackageId,
      eventType: "contract_awarded",
      title: `Subcontract Execution Status Recorded`,
      description: `Execution status recorded for ${agreement.agreementNumber} between ${agreement.generalContractorName} and ${agreement.subcontractorName}; external signature verification remains required.`,
      ...auditActor(access),
      contractorId: agreement.contractorId,
      timestamp: Date.now(),
    });

    return { success: true, agreementNumber: agreement.agreementNumber };
  },
});

export function getStateAbbreviation(stateInput?: string): string {
  if (!stateInput) return "TX";
  const cleaned = stateInput
    .replace(/\b(?:USA|US|UNITED STATES)\b/gi, "")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    .replace(/[^a-zA-Z\s]/g, " ")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");

  if (!cleaned) return "TX";

  const map: Record<string, string> = {
    ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA",
    COLORADO: "CO", CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA",
    HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA",
    KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
    MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO",
    MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH",
    OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT",
    VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
    // Canadian Provinces & Territories
    ONTARIO: "ON", "BRITISH COLUMBIA": "BC", ALBERTA: "AB", QUEBEC: "QC",
    MANITOBA: "MB", SASKATCHEWAN: "SK", "NOVA SCOTIA": "NS", "NEW BRUNSWICK": "NB",
    "NEWFOUNDLAND AND LABRADOR": "NL", NEWFOUNDLAND: "NL", "PRINCE EDWARD ISLAND": "PE",
    "NORTHWEST TERRITORIES": "NT", YUKON: "YT", NUNAVUT: "NU",
    // International Regions
    "UNITED KINGDOM": "UK", UK: "UK", ENGLAND: "ENG", SCOTLAND: "SCT", WALES: "WLS",
    AUSTRALIA: "AU", "NEW SOUTH WALES": "NSW", VICTORIA: "VIC", QUEENSLAND: "QLD",
  };

  const validCodes = new Set(Object.values(map));
  if ((cleaned.length === 2 || cleaned.length === 3) && validCodes.has(cleaned)) {
    return cleaned;
  }

  if (map[cleaned]) return map[cleaned];

  const tokens = cleaned.split(" ");
  for (const t of tokens) {
    if ((t.length === 2 || t.length === 3) && validCodes.has(t)) {
      return t;
    }
  }

  for (const [name, abbr] of Object.entries(map)) {
    if (cleaned.startsWith(name) || cleaned.includes(name)) {
      return abbr;
    }
  }

  return (cleaned.length === 2 || cleaned.length === 3) ? cleaned : (map[cleaned] || "TX");
}

const STATE_FULL_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  // Canadian Provinces & Territories
  ON: "Ontario", BC: "British Columbia", AB: "Alberta", QC: "Quebec",
  MB: "Manitoba", SK: "Saskatchewan", NS: "Nova Scotia", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", PE: "Prince Edward Island",
  NT: "Northwest Territories", YT: "Yukon", NU: "Nunavut",
  // International Regions
  UK: "United Kingdom", ENG: "England", SCT: "Scotland", WLS: "Wales",
  AU: "Australia", NSW: "New South Wales", VIC: "Victoria", QLD: "Queensland",
};

export function parseCityAndState(location?: string): { city: string; state: string; stateAbbr: string } {
  if (!location || !location.trim()) {
    return { city: "Austin", state: "Texas", stateAbbr: "TX" };
  }

  const trimmed = location.trim();

  // If comma separated, e.g. "Austin, Texas", "Seattle, WA 98101", "Toronto, ON, Canada"
  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    const city = parts[0] || "Austin";
    const statePart = parts[1] || "";
    const stateAbbr = getStateAbbreviation(statePart);
    const state = STATE_FULL_NAMES[stateAbbr] || statePart || "Texas";
    return { city, state, stateAbbr };
  }

  // No comma, e.g. "Denver CO", "Denver CO 80202", "Vancouver BC", "Austin Texas"
  const tokens = trimmed.split(/\s+/);
  let foundStateAbbr: string | null = null;
  let splitIndex = tokens.length;

  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i].toUpperCase().replace(/[^A-Z]/g, "");
    if ((token.length === 2 || token.length === 3) && STATE_FULL_NAMES[token]) {
      foundStateAbbr = token;
      splitIndex = i;
      break;
    }
  }

  if (!foundStateAbbr) {
    const abbr = getStateAbbreviation(trimmed);
    if (abbr && abbr !== "TX") {
      foundStateAbbr = abbr;
      for (let i = 0; i < tokens.length; i++) {
        if (getStateAbbreviation(tokens.slice(i).join(" ")) === abbr) {
          splitIndex = i;
          break;
        }
      }
    }
  }

  const stateAbbr = foundStateAbbr || "TX";
  const state = STATE_FULL_NAMES[stateAbbr] || "Texas";
  const city = tokens.slice(0, Math.max(1, splitIndex)).join(" ").trim() || "Austin";

  return { city, state, stateAbbr };
}

/**
 * Synchronizes the active subcontract agreement for an awarded bid when its leveling,
 * VE alternates, scope voids, or double buy credits are adjusted.
 * Keeps the subcontract text, mandatory inclusions and contract sum in sync with the award; the
 * agreement's stored terms are kept.
 */
export async function syncAgreementForBid(ctx: any, bidId: any): Promise<any> {
  const bid = await ctx.db.get(bidId);
  if (!bid) return null;

  const existingAgreement = await ctx.db
    .query("agreements")
    .withIndex("by_bid", (q: any) => q.eq("bidId", bidId))
    .filter((q: any) => q.neq(q.field("status"), "superseded"))
    .first();

  if (!existingAgreement) return null;
  if (existingAgreement.status === "executed") {
    throw new ConvexError("Executed agreements are immutable. Create a formal amendment instead of changing the bid.");
  }

  const tradePkg = await ctx.db.get(bid.tradePackageId);
  if (!tradePkg) return null;

  const project = await ctx.db.get(tradePkg.projectId);
  if (!project) return null;

  const contractor = await ctx.db.get(bid.contractorId);
  if (!contractor || !contractorCanBidOnPackage(contractor, tradePkg) || !contractor.companyName.trim()) {
    throw new Error("The awarded bid is not linked to a valid contractor in this trade package.");
  }
  const subcontractorName = contractor.companyName.trim();
  const generalContractorName = await generalContractorNameFor(ctx, project);

  const sum = computeAwardSum(bid, acceptedIndexesFor(bid, existingAgreement.acceptedAlternates));
  await ctx.db.patch(existingAgreement._id, {
    contractorId: bid.contractorId,
    subcontractorName,
    subcontractorEmail: contractor.contactEmail,
    generalContractorName,
    ...agreementAwardFields(sum, excludedScopeNotesFor(bid)),
    scopeSummary: tradePkg.scopeSummary,
    mandatoryInclusions: tradePkg.mandatoryInclusions,
  });
  await refreshAgreementDocument(ctx, existingAgreement._id);
  await reopenSovIfSumChanged(ctx, existingAgreement._id);
  await ensureSovAndMilestones(ctx, existingAgreement._id);

  return await ctx.db.get(existingAgreement._id);
}

/**
 * An approved SOV on a not-yet-executed agreement goes back to draft when a leveling change moves
 * the contract sum away from its total, so it is never left approved with a mismatch.
 */
async function reopenSovIfSumChanged(ctx: MutationCtx, agreementId: Id<"agreements">): Promise<void> {
  const agreement = await ctx.db.get(agreementId);
  if (agreement === null || agreement.sov?.status !== "approved" || agreement.status === "executed") return;
  const rows = await loadSovRows(ctx, agreementId);
  if (sumSovCents(rows) === agreementContractSumCents(agreement)) return;
  await ctx.db.patch(agreementId, {
    sov: { status: "draft", ...(agreement.sov.editedAt !== undefined ? { editedAt: agreement.sov.editedAt } : {}) },
  });
  await ctx.db.insert("auditLogs", {
    projectId: agreement.projectId,
    tradePackageId: agreement.tradePackageId,
    agreementId,
    eventType: "compliance_audit",
    title: `Schedule of values reopened: ${agreement.agreementNumber}`,
    description: `The contract sum changed to ${formatCents(agreementContractSumCents(agreement))} after the schedule of values was approved, so it is back in draft for the GC to reconcile.`,
    actor: "TradePulse Pay",
    timestamp: Date.now(),
  });
}
