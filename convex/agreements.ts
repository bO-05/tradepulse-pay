import { mutation, query } from "./_generated/server";
import { requireRole } from "./lib/roles";
import { v, ConvexError } from "convex/values";
import { DEFAULT_GENERAL_CONTRACTOR, validateProjectText } from "./validation";
import { LIQUIDATED_DAMAGES_PER_DAY, RETAINAGE_PERCENT } from "./terms";
import { ensureSovAndMilestones, removeSovAndMilestonesIfUnbilled } from "./payments/sov";

/**
 * AIA Document A401™ - 2017 Standard Form of Agreement Between Contractor and Subcontractor.
 * Generates an authentic, legally formatted construction subcontract agreement
 * tying together CSI MasterFormat scope, mandatory inclusions, leveled subcontract sum,
 * retainage, and ACORD 25 insurance requirements.
 */
export const generateAgreement = mutation({
  args: {
    bidId: v.id("bids"),
    tradePackageId: v.id("tradePackages"),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    // Check if an agreement already exists for this bid
    const existing = await ctx.db
      .query("agreements")
      .withIndex("by_bid", (q) => q.eq("bidId", args.bidId))
      .first();

    const bid = await ctx.db.get(args.bidId);
    if (!bid) throw new Error("Bid not found");
    if (bid.tradePackageId !== args.tradePackageId) {
      throw new Error("Bid and trade package do not belong to the same procurement scope.");
    }

    const tradePkg = await ctx.db.get(args.tradePackageId);
    if (!tradePkg) throw new Error("Trade package not found");

    const project = await ctx.db.get(tradePkg.projectId);
    if (!project) throw new Error("Project not found");

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

    const acceptedVeTotal = (bid.valueEngineeringAlternates || []).reduce(
      (sum, ve) => (ve.isAccepted ? sum + (ve.costDeduct || 0) : sum),
      0
    );
    const contractSum = Math.max(0, bid.leveledTotalCost);
    const retainagePercent = RETAINAGE_PERCENT;
    const liquidatedDamagesDaily = LIQUIDATED_DAMAGES_PER_DAY;

    // A16-01: the server runs in UTC and cannot know the operator's timezone.
    // Label the generated date explicitly so it is never misread as local.
    const formattedDate = `${new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    })} (UTC)`;

    const contractLocation = project.location || "Austin, Texas";
    const { city: gcCity, state: gcState, stateAbbr } = parseCityAndState(contractLocation);
    const generalContractor = project.generalContractorName?.trim() || DEFAULT_GENERAL_CONTRACTOR;
    const contractor = await ctx.db.get(bid.contractorId);
    if (!contractor || contractor.tradePackageId !== tradePkg._id) {
      throw new Error("The selected bid is not linked to a valid contractor in this trade package.");
    }
    const subName = contractor.companyName.trim();
    if (!subName) throw new Error("The selected contractor must have a company name before an agreement can be generated.");

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

      const updatedText = generateAiaA401AgreementText({
        agreementNumber: existing.agreementNumber,
        formattedDate,
        generalContractor,
        gcCity,
        gcState,
        stateAbbr,
        subName,
        contactEmail:
          contractor?.contactEmail ??
          `estimating@${subName.toLowerCase().replace(/[^a-z0-9]/g, "") || "contractor"}.com`,
        licenseNumber: contractor?.licenseNumber ?? "Not verified",
        licenseStatus: contractor?.licenseStatus ?? "Unverified - verify before execution",
        projectTitle: project.title,
        projectLocation: project.location,
        projectType: project.projectType,
        csiDivision: tradePkg.csiDivision,
        tradeName: tradePkg.tradeName,
        scopeSummary: tradePkg.scopeSummary,
        mandatoryInclusions: tradePkg.mandatoryInclusions,
        contractSum,
        baseBidAmount: bid.baseBidAmount,
        acceptedVeTotal,
        leveledTotalCost: bid.leveledTotalCost,
        retainagePercent,
        liquidatedDamagesDaily,
        bidDeadline: tradePkg.bidDeadline,
      });

      await ctx.db.patch(existing._id, {
        status: "generated",
        contractorId: bid.contractorId,
        subcontractorName: subName,
        subcontractorEmail: contractor.contactEmail,
        generalContractorName: generalContractor,
        contractSum,
        contractText: updatedText,
        scopeSummary: tradePkg.scopeSummary,
        mandatoryInclusions: tradePkg.mandatoryInclusions,
      });
      await removeSovAndMilestonesIfUnbilled(ctx, existing._id);

      await ctx.db.insert("auditLogs", {
        projectId: project._id,
        tradePackageId: tradePkg._id,
        eventType: "contract_awarded",
        title: `AIA A401 Subcontract Agreement Re-Awarded: ${existing.subcontractorName}`,
        description: `Re-activated subcontract agreement ${existing.agreementNumber} for CSI Division ${tradePkg.csiDivision} (${tradePkg.tradeName}) in the amount of $${contractSum.toLocaleString("en-US")}.`,
        actor: "Chief Estimator / GC Procurement",
        timestamp: Date.now(),
      });
      return await ctx.db.get(existing._id);
    }

    const agreementNumber = `A401-2026-${tradePkg.csiDivision.replace(/\s+/g, "").slice(0, 4)}-${Date.now().toString().slice(-4)}`;

    const contractText = generateAiaA401AgreementText({
      agreementNumber,
      formattedDate,
      generalContractor,
      gcCity,
      gcState,
      stateAbbr,
      subName,
      contactEmail:
        contractor?.contactEmail ??
        `estimating@${subName.toLowerCase().replace(/[^a-z0-9]/g, "") || "contractor"}.com`,
      licenseNumber: contractor?.licenseNumber ?? "Not verified",
      licenseStatus: contractor?.licenseStatus ?? "Unverified - verify before execution",
      projectTitle: project.title,
      projectLocation: project.location,
      projectType: project.projectType,
      csiDivision: tradePkg.csiDivision,
      tradeName: tradePkg.tradeName,
      scopeSummary: tradePkg.scopeSummary,
      mandatoryInclusions: tradePkg.mandatoryInclusions,
      contractSum,
      baseBidAmount: bid.baseBidAmount,
      acceptedVeTotal,
      leveledTotalCost: bid.leveledTotalCost,
      retainagePercent,
      liquidatedDamagesDaily,
      bidDeadline: tradePkg.bidDeadline,
    });

    const agreementId = await ctx.db.insert("agreements", {
      projectId: project._id,
      tradePackageId: tradePkg._id,
      bidId: bid._id,
      contractorId: bid.contractorId,
      agreementNumber,
      documentTitle: "Subcontract Agreement (A401-style structure) — generated draft, not an AIA-licensed form",
      subcontractorName: subName,
      subcontractorEmail: contractor.contactEmail,
      generalContractorName: generalContractor,
      projectTitle: project.title,
      projectLocation: project.location,
      csiDivision: tradePkg.csiDivision,
      tradeName: tradePkg.tradeName,
      contractSum,
      retainagePercent,
      liquidatedDamagesDaily,
      scopeSummary: tradePkg.scopeSummary,
      mandatoryInclusions: tradePkg.mandatoryInclusions,
      status: "generated",
      contractText,
      createdAt: Date.now(),
    });

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
      title: `AIA A401 Subcontract Agreement Awarded: ${subName}`,
      description: `Subcontract agreement ${agreementNumber} generated for CSI Division ${tradePkg.csiDivision} (${tradePkg.tradeName}) in the amount of $${contractSum.toLocaleString("en-US")} — pending external execution.`,
      actor: "Chief Estimator / GC Procurement",
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
    await requireRole(ctx, ["gc"]);
    const agreement = await ctx.db.get(args.agreementId);
    if (!agreement) throw new ConvexError("Agreement not found.");
    if (agreement.status !== "executed") {
      throw new ConvexError("Only an executed agreement can be voided.");
    }
    const reason = validateProjectText(args.reason, "Void reason");
    if (reason.length < 10) {
      throw new ConvexError("Enter a void reason of at least 10 characters for the audit record.");
    }

    await ctx.db.patch(args.agreementId, { status: "superseded" });
    await removeSovAndMilestonesIfUnbilled(ctx, args.agreementId);
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
      actor: "GC Procurement / Legal",
      timestamp: Date.now(),
    });

    return { success: true, agreementNumber: agreement.agreementNumber };
  },
});

export const getAgreementByBid = query({
  args: { bidId: v.id("bids") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agreements")
      .withIndex("by_bid", (q) => q.eq("bidId", args.bidId))
      .first();
  },
});

export const getAgreementByPackage = query({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agreements")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .order("desc")
      .first();
  },
});

export const listAgreements = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .collect();
  },
});

export const executeAgreement = mutation({
  args: { agreementId: v.id("agreements") },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const agreement = await ctx.db.get(args.agreementId);
    if (!agreement) throw new Error("Agreement not found");

    if (agreement.status === "superseded") {
      throw new ConvexError("Cannot execute a superseded agreement. Regenerate or re-award it first.");
    }
    if (agreement.status === "executed") {
      // Backfills agreements executed before SOV generation existed; no-op otherwise.
      await ensureSovAndMilestones(ctx, args.agreementId);
      return { success: true, agreementNumber: agreement.agreementNumber };
    }

    await ctx.db.patch(args.agreementId, {
      status: "executed",
      executedAt: Date.now(),
    });
    await ensureSovAndMilestones(ctx, args.agreementId);

    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      tradePackageId: agreement.tradePackageId,
      eventType: "contract_awarded",
      title: `AIA A401 Execution Status Recorded`,
      description: `Execution status recorded for ${agreement.agreementNumber} between ${agreement.generalContractorName} and ${agreement.subcontractorName}; external signature verification remains required.`,
      actor: "Commercial Project Executive",
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
 * Ensures the statutory AIA Document A401 contractText, mandatoryInclusions, and
 * contractSum stay 100% in sync with the agreed procurement terms.
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
  if (!contractor || contractor.tradePackageId !== tradePkg._id || !contractor.companyName.trim()) {
    throw new Error("The awarded bid is not linked to a valid contractor in this trade package.");
  }
  const subcontractorName = contractor.companyName.trim();
  const generalContractorName = project.generalContractorName?.trim() || DEFAULT_GENERAL_CONTRACTOR;

  const acceptedVeTotal = (bid.valueEngineeringAlternates || []).reduce(
    (sum: number, ve: any) => (ve.isAccepted ? sum + (ve.costDeduct || 0) : sum),
    0
  );
  const contractSum = Math.max(0, bid.leveledTotalCost);
  const retainagePercent = existingAgreement.retainagePercent || RETAINAGE_PERCENT;
  const liquidatedDamagesDaily = existingAgreement.liquidatedDamagesDaily || LIQUIDATED_DAMAGES_PER_DAY;

  const formattedDate = `${new Date(existingAgreement.createdAt || Date.now()).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  })} (UTC)`;

  const contractLocation = project.location || "Austin, Texas";
  const { city: gcCity, state: gcState, stateAbbr } = parseCityAndState(contractLocation);

  const updatedContractText = generateAiaA401AgreementText({
    agreementNumber: existingAgreement.agreementNumber,
    formattedDate,
    generalContractor: generalContractorName,
    gcCity,
    gcState,
    stateAbbr,
    subName: subcontractorName,
    contactEmail:
      contractor.contactEmail ||
      `estimating@${subcontractorName.toLowerCase().replace(/[^a-z0-9]/g, "") || "contractor"}.com`,
    licenseNumber: contractor.licenseNumber || "Not verified",
    licenseStatus: contractor.licenseStatus || "Unverified - verify before execution",
    projectTitle: project.title,
    projectLocation: project.location,
    projectType: project.projectType,
    csiDivision: tradePkg.csiDivision,
    tradeName: tradePkg.tradeName,
    scopeSummary: tradePkg.scopeSummary,
    mandatoryInclusions: tradePkg.mandatoryInclusions,
    contractSum,
    baseBidAmount: bid.baseBidAmount,
    acceptedVeTotal,
    leveledTotalCost: bid.leveledTotalCost,
    retainagePercent,
    liquidatedDamagesDaily,
    bidDeadline: tradePkg.bidDeadline,
  });

  await ctx.db.patch(existingAgreement._id, {
    contractorId: bid.contractorId,
    subcontractorName,
    subcontractorEmail: contractor.contactEmail,
    generalContractorName,
    contractSum,
    contractText: updatedContractText,
    scopeSummary: tradePkg.scopeSummary,
    mandatoryInclusions: tradePkg.mandatoryInclusions,
  });

  return await ctx.db.get(existingAgreement._id);
}

export function numberToWords(num: number): string {
  num = Math.round(num);
  const units = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  if (num >= 1000000) {
    const millions = Math.floor(num / 1000000);
    const rem = num % 1000000;
    return `${numberToWords(millions)} Million` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 1000) {
    const thousands = Math.floor(num / 1000);
    const rem = num % 1000;
    return `${numberToWords(thousands)} Thousand` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 100) {
    const hundreds = Math.floor(num / 100);
    const rem = num % 100;
    return `${units[hundreds]} Hundred` + (rem ? ` ${numberToWords(rem)}` : "");
  }
  if (num >= 20) {
    const t = Math.floor(num / 10);
    const rem = num % 10;
    return tens[t] + (rem ? `-${units[rem]}` : "");
  }
  if (num > 0) return units[num];
  return "Zero";
}

export function generateAiaA401AgreementText(params: {
  agreementNumber: string;
  formattedDate: string;
  generalContractor: string;
  gcCity: string;
  gcState: string;
  stateAbbr: string;
  subName: string;
  contactEmail: string;
  licenseNumber: string;
  licenseStatus: string;
  projectTitle: string;
  projectLocation: string;
  projectType: string;
  csiDivision: string;
  tradeName: string;
  scopeSummary: string;
  mandatoryInclusions: string[];
  contractSum: number;
  baseBidAmount: number;
  acceptedVeTotal: number;
  leveledTotalCost: number;
  retainagePercent: number;
  liquidatedDamagesDaily: number;
  bidDeadline: string;
}): string {
  return `================================================================================
SUBCONTRACT AGREEMENT — A401-STYLE STRUCTURE (GENERATED DRAFT)
AGREEMENT NO: ${params.agreementNumber}
================================================================================

NOTICE: This is a TradePulse-generated draft that follows the A401 article
structure. It is not an official AIA document or a licensed AIA form, and the
parties, addresses, license numbers and dates marked [from the Prime Agreement]
must be completed from the executed Prime Agreement before use. TradePulse does
not provide a signature service.

AGREEMENT made as of the ${params.formattedDate}.

BETWEEN the Contractor:
  ${params.generalContractor}
  Address & license: [from the Prime Agreement — verify before execution]

and the Subcontractor:
  ${params.subName}
  Contact: ${
    /\.invalid$/i.test(params.contactEmail)
      ? "not published — obtain the subcontractor's notice address before execution"
      : params.contactEmail
  }
  License No: ${params.licenseNumber} (${params.licenseStatus})

The Prime Project:
  ${params.projectTitle}
  Location: ${params.projectLocation}
  Type: ${params.projectType}
  Owner: [Owner from the Prime Agreement]

The Prime Agreement between Contractor and Owner is dated: [Prime Agreement date]
The Architect / Owner Representative: [from the Prime Agreement]

--------------------------------------------------------------------------------
TABLE OF ARTICLES
--------------------------------------------------------------------------------
ARTICLE 1   THE SUBCONTRACT DOCUMENTS & CSI MASTERFORMAT SPECIFICATIONS
ARTICLE 2   MUTUAL RIGHTS AND RESPONSIBILITIES
ARTICLE 3   CONTRACTOR OBLIGATIONS & SITE LOGISTICS
ARTICLE 4   SUBCONTRACTOR WORK & MANDATORY SCOPE INCLUSIONS
ARTICLE 5   CHANGES IN THE WORK & CHANGE ORDER PROTOCOL
ARTICLE 6   SUBCONTRACT SUM, SCHEDULE OF VALUES & PROGRESS PAYMENTS
ARTICLE 7   INSURANCE, ACORD 25 COI & INDEMNIFICATION
ARTICLE 8   SAFETY, QUALITY ASSURANCE & STATUTORY WARRANTIES
ARTICLE 9   DISPUTE RESOLUTION & BINDING ARBITRATION
ARTICLE 10  ATTESTATION & FORMAL EXECUTION

--------------------------------------------------------------------------------
ARTICLE 1 - THE SUBCONTRACT DOCUMENTS
--------------------------------------------------------------------------------
§ 1.1 The Subcontract Documents consist of:
  (1) this A401-style Subcontract Agreement draft;
  (2) the Prime Agreement between Contractor and Owner;
  (3) the Conditions of the Subcontract (General, Supplementary, and Special);
  (4) CSI MasterFormat Division ${params.csiDivision} (${params.tradeName}) Drawings and Specifications;
  (5) Addenda issued prior to execution; and
  (6) Written Pre-Bid Clarifications and Modifications recorded in TradePulse Pro.

--------------------------------------------------------------------------------
ARTICLE 2 - MUTUAL RIGHTS AND RESPONSIBILITIES
--------------------------------------------------------------------------------
§ 2.1 The Contractor and Subcontractor shall be mutually bound by the terms of this
Agreement and, to the extent that the provisions of the Prime Agreement apply to
the Work of the Subcontractor, the Contractor shall assume toward the Subcontractor
all obligations and responsibilities that the Owner assumes toward the Contractor.

--------------------------------------------------------------------------------
ARTICLE 3 - CONTRACTOR OBLIGATIONS & SITE LOGISTICS
--------------------------------------------------------------------------------
§ 3.1 Contractor shall coordinate utility hookup points, establish perimeter benchmarks,
and administer the TradePulse Pro project procurement portal for RFI clarifications.
All hoisting logistics, floor loading capacities, and crane pick zones shall be
coordinated through Contractor's field superintendent.

--------------------------------------------------------------------------------
ARTICLE 4 - SUBCONTRACTOR WORK & MANDATORY SCOPE INCLUSIONS
--------------------------------------------------------------------------------
§ 4.1 Scope of Work: The Subcontractor shall furnish all labor, materials, equipment,
services, hoisting, and supervision necessary to complete Division ${params.csiDivision}:
${params.tradeName}.

Summary of Scope:
${params.scopeSummary}

§ 4.2 MANDATORY SCOPE INCLUSIONS:
The Subcontractor explicitly certifies and agrees that the Subcontract Sum includes
complete and unabridged fulfillment of the following mandatory trade obligations:
${params.mandatoryInclusions.map((inc) => `  [✓] ${inc}`).join("\n")}

§ 4.3 No fine-print exclusions, unauthorized substitutions, or scope gap carve-outs
shall be recognized or allowed unless approved in an executed Change Order.

--------------------------------------------------------------------------------
ARTICLE 5 - CHANGES IN THE WORK
--------------------------------------------------------------------------------
§ 5.1 The Contractor may, without invalidating the Subcontract, order Changes in the Work
within the general scope of this Subcontract. Such changes shall be authorized by
written Change Order prior to commencement of extra work. Overhead and profit
on approved change orders shall not exceed 10% overhead and 5% profit.

--------------------------------------------------------------------------------
ARTICLE 6 - SUBCONTRACT SUM & PROGRESS PAYMENTS
--------------------------------------------------------------------------------
§ 6.1 The Contractor shall pay the Subcontractor in current funds for the Subcontractor's
performance of the Subcontract the Subcontract Sum of:
  $${params.contractSum.toLocaleString("en-US")} (${numberToWords(params.contractSum)} Dollars).
  (Accounting Reconciliation: Base Bid $${params.baseBidAmount.toLocaleString("en-US")}, plus scope-gap exclusions, lead-time, and COI adjustments, less Accepted VE Deducts $${params.acceptedVeTotal.toLocaleString("en-US")}. Baseline Leveled Cost: $${params.leveledTotalCost.toLocaleString("en-US")}).

§ 6.2 Progress Payments: Contractor shall pay Subcontractor monthly based on approved
Schedule of Values minus ${params.retainagePercent}% retainage.
Payment terms: Net 30 days following Owner funding.
Liquidated Damages: $${params.liquidatedDamagesDaily.toLocaleString("en-US")} per calendar day for unexcused project delays past Substantial Completion (see the Project Schedule / Prime Agreement).

--------------------------------------------------------------------------------
ARTICLE 7 - INSURANCE & INDEMNIFICATION
--------------------------------------------------------------------------------
§ 7.1 Prior to commencing Work, Subcontractor shall furnish Contractor with an official
ACORD 25 Certificate of Liability Insurance evidencing:
  - Commercial General Liability: $1,000,000 per occurrence / $2,000,000 general aggregate
  - Commercial Umbrella / Excess Liability: $5,000,000 each occurrence
  - Workers' Compensation & Employer's Liability: Statutory limits
  - Contractor and Owner named as Additional Insureds on Primary & Non-Contributory basis
  - 30-Day Written Notice of Cancellation

--------------------------------------------------------------------------------
ARTICLE 8 - SAFETY & STATUTORY WARRANTIES
--------------------------------------------------------------------------------
§ 8.1 Subcontractor warrants that all materials and equipment furnished under this
Subcontract will be new and of recent manufacture, and that Work will be free from
defects and conform strictly to CSI MasterFormat Division ${params.csiDivision} specs.
Warranty period: One (1) full year from Substantial Completion.

--------------------------------------------------------------------------------
ARTICLE 9 - DISPUTE RESOLUTION
--------------------------------------------------------------------------------
§ 9.1 Any claim arising out of or related to this Subcontract Agreement shall be
subject to mediation as a condition precedent to binding dispute resolution administered
by the American Arbitration Association (AAA) in ${params.gcCity}, ${params.gcState}.

--------------------------------------------------------------------------------
ARTICLE 10 - ATTESTATION & FORMAL EXECUTION
--------------------------------------------------------------------------------
IN WITNESS WHEREOF, the parties hereto have executed this Subcontract Agreement
as of the day and year first written above.

CONTRACTOR: ${params.generalContractor}
By: ___________________________________       Date: ${params.formattedDate}
    Authorized Executive Officer

SUBCONTRACTOR: ${params.subName}
By: ___________________________________       Date: ${params.formattedDate}
    Authorized Corporate Principal

================================================================================
Generated autonomously via TradePulse Pro Procurement Platform
Generated draft based on the AIA A401 article structure — not an AIA-licensed form
================================================================================`;
}
