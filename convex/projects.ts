import { query, mutation, internalQuery, internalMutation, type MutationCtx } from "./_generated/server";
import { forbiddenMessage, requireRole } from "./lib/roles";
import { requireCompanyMember } from "./lib/tenancy";
import { auditActor, callerProjects, requireDemoCompany, requireProjectScope } from "./lib/projectScope";
import type { Doc } from "./_generated/dataModel";
import { linkDemoProfiles } from "./demoAccounts";
import { attachProjectToDemo, ensureDemoCompanies, findDemoGcCompanyId, type DemoCompanyIds } from "./lib/demoTenancy";
import { backfillVendorsForCompany } from "./lib/vendorDirectory";
import { applyDemoLicenseNumbers } from "./kernel/demoLicenses";
import { remapAgentLinks, snapshotActiveAgentLinks } from "./lib/agentLinkRemap";
import { v, ConvexError } from "convex/values";
import { classifyUnflaggedDrafts, refreshAgreementDocument } from "./lib/agreementDocument";
import { getRealDocumentPdfBytes } from "./realDocuments";
import { deleteAgreementCascade, deleteContractorCascade } from "./payments/cascade";

/**
 * Seed metadata must equal the bytes actually served by the document endpoints,
 * otherwise the file-size labels lie about what the download contains.
 */
function authoritativeDocSize(fileName: string, fallback: number): number {
  return getRealDocumentPdfBytes(fileName)?.length ?? fallback;
}
import { DEFAULT_GENERAL_CONTRACTOR, validateProjectText } from "./validation";
import { firstProjectSetupError, validateProjectSetup } from "./lib/projectSetup";
import { formatRetainagePercent } from "./lib/retainageRules";
import { formatCents } from "./lib/money";
import { bidRowFromDollars } from "./lib/bidMoney";

/** The caller's seeded demo project (or newest accessible project); never another company's. */
export const getDemoProject = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["gc", "owner"]);
    const projects = await callerProjects(ctx);
    return projects.find((p) => p.isDemoProject) ?? projects[0] ?? null;
  },
});

/** Project switcher/list: only projects the caller's company can access (archived hidden by default). */
export const listProjects = query({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc", "owner", "sub"]);
    return await callerProjects(ctx, { includeArchived: args.includeArchived === true });
  },
});

export const getProject = query({
  // A string so a malformed id from a URL reads "Not found." like a foreign or deleted one.
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireProjectScope(ctx, args.projectId, { roles: ["gc", "owner", "sub"] });
    return project;
  },
});

export const getProjectInternal = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.projectId);
  },
});

export const getProjectCompanyNameInternal = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<string | null> => {
    const project = await ctx.db.get(args.projectId);
    if (!project?.gcCompanyId) return null;
    const company = await ctx.db.get(project.gcCompanyId);
    return company?.name ?? null;
  },
});

const setupArgs = {
  title: v.string(),
  ownerName: v.string(),
  address: v.object({ line1: v.string(), city: v.string(), zip: v.string(), state: v.optional(v.string()) }),
  state: v.string(),
  contractValueCents: v.number(),
  retainageBps: v.number(),
  billingDay: v.number(),
  startDate: v.string(),
  substantialCompletionDate: v.optional(v.string()),
};

type SetupArgs = {
  title: string;
  ownerName: string;
  address: { line1: string; city: string; zip: string; state?: string };
  state: string;
  contractValueCents: number;
  retainageBps: number;
  billingDay: number;
  startDate: string;
  substantialCompletionDate?: string;
};

/** Validates the §14 setup fields with the wizard's rules and returns the values to store. */
function cleanSetup(args: SetupArgs) {
  const state = args.state.trim().toUpperCase();
  if (args.address.state !== undefined && args.address.state.trim() !== "" && args.address.state.trim().toUpperCase() !== state) {
    throw new ConvexError({ code: "INVALID", field: "state", message: "The address state must match the project state." });
  }
  const sc = args.substantialCompletionDate?.trim() ?? "";
  const input = {
    title: args.title,
    ownerName: args.ownerName,
    address: args.address,
    state,
    contractValueCents: args.contractValueCents,
    retainageBps: args.retainageBps,
    billingDay: args.billingDay,
    startDate: args.startDate.trim(),
    substantialCompletionDate: sc,
  };
  const errors = validateProjectSetup(input);
  const first = firstProjectSetupError(errors);
  if (first) throw new ConvexError({ code: "INVALID", field: first.field, message: first.message, fields: errors });
  const weeks =
    sc === "" ? 52 : Math.max(1, Math.ceil((Date.parse(`${sc}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / (7 * 86_400_000)));
  const city = args.address.city.trim();
  return {
    title: args.title.trim().replace(/\s+/g, " "),
    ownerName: args.ownerName.trim().replace(/\s+/g, " "),
    address: { line1: args.address.line1.trim(), city, state, zip: args.address.zip.trim() },
    state,
    contractValueCents: args.contractValueCents,
    retainageBps: args.retainageBps,
    billingDay: args.billingDay,
    startDate: input.startDate,
    substantialCompletionDate: sc === "" ? undefined : sc,
    // Legacy procurement screens still read these.
    location: `${city}, ${state}`,
    estBudget: args.contractValueCents / 100,
    targetCompletionWeeks: Math.min(weeks, 520),
  };
}

function setupSummary(p: ReturnType<typeof cleanSetup>): string {
  return `${p.location}; contract ${formatCents(p.contractValueCents)}, retainage ${formatRetainagePercent(p.retainageBps)}, billing day ${p.billingDay}.`;
}

/** New project wizard (architecture §14). The owning company always comes from the session. */
export const createProject = mutation({
  args: {
    ...setupArgs,
    projectType: v.optional(v.string()),
    specDocumentText: v.optional(v.string()),
    isDemoProject: v.optional(v.boolean()),
    generalContractorName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["gc"]);
    const { user, company } = await requireCompanyMember(ctx);
    if (company.kind !== "gc") throw new ConvexError({ code: "FORBIDDEN", message: forbiddenMessage(["gc"]) });
    if (user.emailVerificationTime === undefined) {
      throw new ConvexError({ code: "EMAIL_UNVERIFIED", message: "Verify your email first." });
    }
    const setup = cleanSetup(args);
    const projectType = args.projectType?.trim() ? validateProjectText(args.projectType, "Project type") : "Commercial";
    const specDocumentText = args.specDocumentText?.trim() || `Project Scope for ${setup.title}.`;
    const generalContractorName = args.generalContractorName?.trim()
      ? validateProjectText(args.generalContractorName, "General contractor name")
      : company.isDemo
        ? DEFAULT_GENERAL_CONTRACTOR
        : company.name;

    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      ...setup,
      projectType,
      specDocumentText,
      // Demo seed code looks projects up by this flag, so only the Demo company may set it.
      isDemoProject: args.isDemoProject === true && company.isDemo,
      generalContractorName,
      gcCompanyId: company._id,
      status: "active",
      createdAt: now,
    });

    await ctx.db.insert("auditLogs", {
      projectId,
      eventType: "project_created",
      title: `Project created: ${setup.title}`,
      description: `Owner ${setup.ownerName}; ${setupSummary(setup)}`,
      ...auditActor({ user, viewer, company }),
      timestamp: now,
    });

    return projectId;
  },
});

/** Project settings (GC of the owning company only). Archived projects must be restored first. */
export const updateProject = mutation({
  args: { projectId: v.string(), ...setupArgs },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    const projectId = access.project._id;
    const { projectId: _ignored, ...fields } = args;
    const setup = cleanSetup(fields);
    // Provenance must be inferred against the state the drafts were saved under, before it changes.
    await classifyUnflaggedDrafts(ctx, access.project);
    await ctx.db.patch(projectId, setup);
    await ctx.db.insert("auditLogs", {
      projectId,
      eventType: "project_updated",
      title: `Project settings updated: ${setup.title}`,
      description: setupSummary(setup),
      ...auditActor(access),
      timestamp: Date.now(),
    });
    return null;
  },
});

/** Hides the project from lists and makes it read-only; nothing is deleted. */
export const archiveProject = mutation({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    if (access.project.isDemoProject) {
      throw new ConvexError({ code: "INVALID", message: "The Demo company's walkthrough project can't be archived." });
    }
    await ctx.db.patch(access.project._id, { archived: true, status: "archived" });
    await ctx.db.insert("auditLogs", {
      projectId: access.project._id,
      eventType: "project_archived",
      title: `Project archived: ${access.project.title}`,
      description: "Hidden from project lists and read-only until restored.",
      ...auditActor(access),
      timestamp: Date.now(),
    });
    return null;
  },
});

export const restoreProject = mutation({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"] });
    if (access.user.emailVerificationTime === undefined) {
      throw new ConvexError({ code: "EMAIL_UNVERIFIED", message: "Verify your email first." });
    }
    if (access.project.archived !== true) return null;
    await ctx.db.patch(access.project._id, { archived: false, status: "active" });
    await ctx.db.insert("auditLogs", {
      projectId: access.project._id,
      eventType: "project_restored",
      title: `Project restored: ${access.project.title}`,
      description: "Back in project lists and editable.",
      ...auditActor(access),
      timestamp: Date.now(),
    });
    return null;
  },
});

/** The Demo GC company's seeded walkthrough projects (isDemoProject), found through the company id. */
async function demoSeedProjects(ctx: MutationCtx, demoIds: DemoCompanyIds): Promise<Doc<"projects">[]> {
  const owned = await ctx.db
    .query("projects")
    .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", demoIds.gc))
    .take(2000);
  return owned.filter((p) => p.isDemoProject === true);
}

/** Deletes one Demo-company project and every row reached from it by id. */
async function deleteDemoProjectRows(ctx: MutationCtx, proj: Doc<"projects">): Promise<void> {
  const pkgs = await ctx.db
    .query("tradePackages")
    .withIndex("by_project", (q) => q.eq("projectId", proj._id))
    .collect();
  for (const pkg of pkgs) {
    const contractors = await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
      .collect();
    for (const c of contractors) await deleteContractorCascade(ctx, c._id);
    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
      .collect();
    for (const c of convos) await ctx.db.delete(c._id);
    const bids = await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
      .collect();
    for (const b of bids) await ctx.db.delete(b._id);
    const agreements = await ctx.db
      .query("agreements")
      .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
      .collect();
    for (const a of agreements) await deleteAgreementCascade(ctx, a._id);
    await ctx.db.delete(pkg._id);
  }
  const projAgreements = await ctx.db
    .query("agreements")
    .withIndex("by_project", (q) => q.eq("projectId", proj._id))
    .collect();
  for (const a of projAgreements) await deleteAgreementCascade(ctx, a._id);
  const files = await ctx.db
    .query("projectFiles")
    .withIndex("by_project", (q) => q.eq("projectId", proj._id))
    .collect();
  for (const f of files) {
    if (f.storageId && !f.storageId.startsWith("http") && !f.storageId.startsWith("local_") && !f.storageId.startsWith("/")) {
      try {
        await ctx.storage.delete(f.storageId as any);
      } catch {
        // Ignore if blob already removed
      }
    }
    await ctx.db.delete(f._id);
  }
  const members = await ctx.db
    .query("projectMembers")
    .withIndex("by_projectId", (q) => q.eq("projectId", proj._id))
    .collect();
  for (const m of members) await ctx.db.delete(m._id);
  // auditLogs are kept as history; listRecentLogs hides entries of deleted projects.
  await ctx.db.delete(proj._id);
}

/**
 * Seeds the Demo company's walkthrough project (The Domain Tower B). `force` deletes and recreates
 * only the Demo GC company's seeded demo projects, reached by id from the Demo company; rows of
 * other companies are never read for deletion, whatever their names, emails or phone numbers.
 */
async function seedDemoProject(ctx: MutationCtx, args: { force?: boolean }) {
  {
    const demoIds = await ensureDemoCompanies(ctx);
    // Pre-tenancy demo projects (no company yet) belong to the Demo company, as in the migration.
    const flagged = await ctx.db
      .query("projects")
      .withIndex("by_demo", (q) => q.eq("isDemoProject", true))
      .take(50);
    for (const p of flagged) {
      if (p.gcCompanyId === undefined) await attachProjectToDemo(ctx, p._id, demoIds);
    }
    const demoProjects = (await demoSeedProjects(ctx, demoIds)).sort((a, b) => a._creationTime - b._creationTime);
    const existing = demoProjects[0];

    if (existing && !args.force) {
      return { status: "already_seeded", projectId: existing._id };
    }

    for (const proj of demoProjects) {
      await deleteDemoProjectRows(ctx, proj);
    }

    // 1. Seed Project Root
    const projectId = await ctx.db.insert("projects", {
      title: "The Domain Tower B - Commercial MEP",
      location: "Austin, TX",
      projectType: "Class-A Commercial Mixed-Use",
      estBudget: 4250000,
      targetCompletionWeeks: 48,
      specDocumentText: `PROJECT SPECIFICATION SUMMARY
Section 01 00 00 - General Requirements:
All trade subcontractors shall provide continuous jobsite cleanup, hoist their own equipment to designated roof pads, coordinate seismic bracing according to IBC Section 1613, and provide temporary power distribution boards from main utility tie-in.

Section 26 00 00 - Electrical Systems:
Furnish and install 1600A main service switchboard, 480/277V step-down distribution dry transformers, lighting control panels, emergency battery backup inverters, and branch conduit routing. Subcontractor is strictly responsible for crane rigging and hoisting up to 14th-floor penthouse plant room. All firestop floor/wall penetration penetrations must comply with UL 1479.`,
      isDemoProject: true,
      generalContractorName: DEFAULT_GENERAL_CONTRACTOR,
      gcCompanyId: demoIds.gc,
      createdAt: Date.now() - 86400000 * 3,
    });

    // 2. Seed Division 26 Electrical Trade Package
    const elecPackageId = await ctx.db.insert("tradePackages", {
      projectId,
      csiDivision: "26 00 00",
      tradeName: "Electrical & Lighting Systems",
      budgetEstimate: 1250000,
      agentMailbox: "dullstreet57@agentmail.to",
      agentMailboxId: "dullstreet57@agentmail.to",
      agentMailboxShared: true,
      scopeSummary: "Complete commercial electrical distribution, 1600A switchgear, penthouse crane hoisting, emergency lighting, and seismic bracing.",
      mandatoryInclusions: [
        "Crane hoisting to 14th-floor mechanical room",
        "Seismic bracing (IBC Section 1613)",
        "Temporary 400A jobsite power distribution",
        "UL 1479 floor/wall firestopping",
      ],
      bidDeadline: "2026-09-25",
      status: "leveling",
    });

    // Seed Division 23 HVAC Trade Package
    const hvacPackageId = await ctx.db.insert("tradePackages", {
      projectId,
      csiDivision: "23 00 00",
      tradeName: "Heating, Ventilating & Air Conditioning",
      budgetEstimate: 1850000,
      agentMailbox: "dullstreet57@agentmail.to",
      agentMailboxId: "dullstreet57@agentmail.to",
      agentMailboxShared: true,
      scopeSummary: "Chilled water air handling units, VAV terminal boxes, rooftop cooling tower connection, and BACnet automated controls.",
      mandatoryInclusions: [
        "Rooftop crane pick and rigging",
        "BACnet MS/TP integration gateway",
        "Vibration isolation spring hangers",
        "Testing, Adjusting, and Balancing (TAB) certification",
      ],
      bidDeadline: "2026-09-28",
      status: "rfqs_dispatched",
    });

    // Seed Division 22 Plumbing Trade Package
    const plumbingPackageId = await ctx.db.insert("tradePackages", {
      projectId,
      csiDivision: "22 00 00",
      tradeName: "Plumbing & Domestic Water Systems",
      budgetEstimate: 950000,
      agentMailbox: "dullstreet57@agentmail.to",
      agentMailboxId: "dullstreet57@agentmail.to",
      agentMailboxShared: true,
      scopeSummary: "Domestic hot/cold copper supply, cast iron sanitary waste, roof drainage overflow, and triplex water booster pump skid.",
      mandatoryInclusions: [
        "Triplex booster pump startup and testing",
        "Core drilling and sleeve penetrations",
        "Backflow preventer city inspection certificate",
      ],
      bidDeadline: "2026-10-02",
      status: "draft",
    });

    // 3. Seed Contractors for Electrical Package
    const c1 = await ctx.db.insert("contractors", {
      tradePackageId: elecPackageId,
      companyName: "Rosendin Electric, Inc.",
      contactEmail: "estimating@rosendin.com",
      phone: "+1 (512) 835-2400",
      licenseNumber: "TX-TECL-18042",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://www.rosendin.com",
      rfqStatus: "bid_received",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    const c2 = await ctx.db.insert("contractors", {
      tradePackageId: elecPackageId,
      companyName: "Alterman, Inc.",
      contactEmail: "estimating@goalterman.com",
      phone: "+1 (512) 454-0326",
      licenseNumber: "TX-TECL-19204",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://goalterman.com",
      rfqStatus: "bid_received",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    await ctx.db.insert("contractors", {
      tradePackageId: elecPackageId,
      companyName: "Prism Electric, Inc.",
      contactEmail: "estimating@prismelectric.com",
      phone: "+1 (512) 419-7476",
      licenseNumber: "TX-TECL-33109",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://prismelectric.com",
      rfqStatus: "invited",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    await ctx.db.insert("contractors", {
      tradePackageId: elecPackageId,
      companyName: "Bergelectric Corp.",
      contactEmail: "estimating@bergelectric.com",
      phone: "+1 (512) 458-1221",
      licenseNumber: "TX-TECL-28941",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://www.bergelectric.com",
      rfqStatus: "invited",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    // 4. Seed Pre-Bid Q&A Conversations
    await ctx.db.insert("conversations", {
      tradePackageId: elecPackageId,
      contractorId: c1,
      threadId: "th_rfq_elec_rosendin_01",
      inboundSubject: "RFI #1: Division 26 Temporary Power Responsibility",
      inboundQuestion: "Does the base electrical package include furnishing the temporary 400A jobsite distribution board, or does GC provide temporary power at the perimeter trailer?",
      autonomousReply: "Per TradePulse Spec Analysis (Section 01 00 00 & Div 26 Scope Summary): Subcontractor is responsible for furnishing and maintaining the 400A jobsite power distribution board from the utility tap. GC will only coordinate with Austin Energy for initial utility meter drop.",
      confidenceScore: 0.96,
      status: "clarified",
      timestamp: Date.now() - 86400000,
    });

    await ctx.db.insert("conversations", {
      tradePackageId: elecPackageId,
      contractorId: c2,
      threadId: "th_rfq_elec_alterman_02",
      inboundSubject: "RFI #2: Switchgear Hoisting Clearance",
      inboundQuestion: "Is the penthouse freight elevator rated for the 1600A switchgear sections, or is rooftop crane mobilization required?",
      autonomousReply: "Per TradePulse Spec Analysis (Section 26 00 00): Penthouse freight elevator capacity is capped at 3,500 lbs; the 1600A switchgear weighs 7,200 lbs. Rooftop crane rigging and hoisting must be included in Division 26 scope.",
      confidenceScore: 0.94,
      status: "clarified",
      timestamp: Date.now() - 43200000,
    });

    await ctx.db.insert("conversations", {
      tradePackageId: elecPackageId,
      contractorId: c2,
      threadId: "th_rfq_elec_alterman_03",
      inboundSubject: "RFI #3: Switchboard Bus Duct vs Conduit Feeders",
      inboundQuestion: "Spec Section 26 24 13 indicates copper bus duct from vault to 14th floor, but drawing E-101 shows parallel 4-inch rigid conduits. Please clarify governing document.",
      autonomousReply: "TradePulse AI Draft Clarification: Specification Section 26 24 13 Article 2.1 designates copper sandwich busway as primary feeder; drawings show alternate conduit pathway. Citing Document Priority clause: specifications govern over drawings. Flagged for Project Manager / Electrical Engineer confirmation before addendum issuance.",
      confidenceScore: 0.88,
      status: "escalated_to_pm",
      timestamp: Date.now() - 21600000,
    });

    // 5. Seed Bids & Forensic Normalization Records (The "Apples-to-Apples" Leveling Matrix)
    // Bidder 1: Rosendin Electric, Inc. (Higher Base, Fully Compliant, Zero Hidden Exclusions)
    const b1 = await ctx.db.insert("bids", bidRowFromDollars({
      tradePackageId: elecPackageId,
      contractorId: c1,
      subcontractorName: "Rosendin Electric, Inc.",
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
          isAccepted: false,
        },
      ],
      longLeadEquipmentWeeks: 10,
      leadTimePenalty: 0,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      leveledTotalCost: 1225000, // True leveled cost matches base
      // A7-04/A1-06: the seeded agreement below belongs to this bid, so the bid
      // must carry the award flag; otherwise the matrix shows 0 AWARDED while
      // the KPI/register count 1/3 awarded.
      isAwarded: true,
      receivedAt: Date.now() - 3600000 * 18,
    }));

    // Bidder 2: Alterman, Inc. (Appears $125k cheaper on paper, but hides $185k of exclusions + COI deficiency!)
    await ctx.db.insert("bids", bidRowFromDollars({
      tradePackageId: elecPackageId,
      contractorId: c2,
      subcontractorName: "Alterman, Inc.",
      baseBidAmount: 1100000, // Deceptive low base bid!
      lineItems: [
        { item: "1600A Main Switchboard (Furnish Only)", unit: "LS", quantity: 1, unitCost: 420000, totalCost: 420000 },
        { item: "Emergency Lighting & Inverters", unit: "LS", quantity: 1, unitCost: 170000, totalCost: 170000 },
        { item: "Branch Conduit & Wire Feeder Runs", unit: "LF", quantity: 24000, unitCost: 17, totalCost: 408000 },
        { item: "Site Distribution & Temporary Hookups", unit: "LS", quantity: 1, unitCost: 102000, totalCost: 102000 },
      ],
      identifiedExclusions: [
        {
          description: "Crane hoisting & rigging to penthouse mechanical floor excluded (GC to furnish)",
          costImpact: 45000,
          severity: "critical",
          isWaived: false,
        },
        {
          description: "UL 1479 firestop floor penetrations excluded (By drywall trade)",
          costImpact: 22000,
          severity: "critical",
          isWaived: false,
        },
        {
          description: "Seismic engineered structural bracing excluded (By others)",
          costImpact: 55000,
          severity: "critical",
          isWaived: false,
        },
        {
          description: "Overtime/weekend acceleration excluded from base rate",
          costImpact: 25000,
          severity: "moderate",
          isWaived: false,
        },
      ],
      valueEngineeringAlternates: [],
      longLeadEquipmentWeeks: 16, // 4 weeks over 12-week target schedule!
      leadTimePenalty: 24000, // $6,000 / week liquidated delay risk
      coiComplianceStatus: "deficiency_detected", // Missing $2M Umbrella & Completed Operations rider
      coiPenalty: 15000, // Additional insurance rider endorsement fee
      // Leveled = 1,100,000 + 45k + 22k + 55k + 25k + 24k + 15k = $1,286,000!
      // In reality $61,000 MORE EXPENSIVE than Rosendin Electric!
      leveledTotalCost: 1286000,
      isAwarded: false,
      receivedAt: Date.now() - 3600000 * 12,
    }));

    // 6. Seed Division 23 HVAC Contractors, RFIs, and Leveling Bids
    const h1 = await ctx.db.insert("contractors", {
      tradePackageId: hvacPackageId,
      companyName: "TDIndustries, Inc.",
      contactEmail: "estimating@tdindustries.com",
      phone: "+1 (512) 310-5300",
      licenseNumber: "TX-TACLA-11842E",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://www.tdindustries.com",
      rfqStatus: "bid_received",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    const h2 = await ctx.db.insert("contractors", {
      tradePackageId: hvacPackageId,
      companyName: "The Brandt Companies, LLC",
      contactEmail: "estimating@brandt.us",
      phone: "+1 (512) 491-9100",
      licenseNumber: "TX-TACLA-01048C",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://brandt.us",
      rfqStatus: "bid_received",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    await ctx.db.insert("contractors", {
      tradePackageId: hvacPackageId,
      companyName: "Southland Industries",
      contactEmail: "estimating@southlandind.com",
      phone: "+1 (512) 443-1566",
      licenseNumber: "TX-TACLA-00192C",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://southlandind.com",
      rfqStatus: "invited",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    await ctx.db.insert("contractors", {
      tradePackageId: hvacPackageId,
      companyName: "Dynamic Systems, Inc.",
      contactEmail: "commercial@dynamicsystemsusa.com",
      phone: "+1 (512) 443-1566",
      licenseNumber: "TX-TACLA-04982C",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://www.dynamicsystemsusa.com",
      rfqStatus: "invited",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    await ctx.db.insert("conversations", {
      tradePackageId: hvacPackageId,
      contractorId: h1,
      threadId: "th_rfq_hvac_tdindustries_01",
      inboundSubject: "RFI #1: Division 23 BACnet MS/TP Gateway Interface Protocol",
      inboundQuestion: "Does Division 23 HVAC include furnishing and programming the BACnet MS/TP integration gateway to the base building automation system (BAS), or is the controls vendor providing the hardware gateway?",
      autonomousReply: "Per TradePulse Spec Analysis (Section 23 09 00 & Div 23 Scope): Division 23 Subcontractor must furnish the native BACnet MS/TP integration gateway hardware and coordinate protocol points with the Master Building Automation System (BAS) contractor.",
      confidenceScore: 0.97,
      status: "clarified",
      timestamp: Date.now() - 72000000,
    });

    await ctx.db.insert("bids", bidRowFromDollars({
      tradePackageId: hvacPackageId,
      contractorId: h1,
      subcontractorName: "TDIndustries, Inc.",
      baseBidAmount: 1820000,
      lineItems: [
        { item: "Chilled Water AHU Units & Piping", unit: "LS", quantity: 1, unitCost: 820000, totalCost: 820000 },
        { item: "VAV Terminal Units & Electric Reheat", unit: "EA", quantity: 110, unitCost: 3500, totalCost: 385000 },
        { item: "Galvanized Ductwork Distribution", unit: "LF", quantity: 18000, unitCost: 22, totalCost: 396000 },
        { item: "Rooftop Crane Hoisting to Cooling Tower Pad", unit: "LS", quantity: 1, unitCost: 48000, totalCost: 48000 },
        { item: "Certified TAB Air/Hydronic Balance Report", unit: "LS", quantity: 1, unitCost: 28000, totalCost: 28000 },
        { item: "BACnet MS/TP Automation Gateway Card", unit: "LS", quantity: 1, unitCost: 18000, totalCost: 18000 },
        { item: "Spring Vibration Isolator Hangers", unit: "LS", quantity: 1, unitCost: 14000, totalCost: 14000 },
        { item: "Testing, Startup & 1-Yr Warranty", unit: "LS", quantity: 1, unitCost: 111000, totalCost: 111000 },
      ],
      identifiedExclusions: [],
      longLeadEquipmentWeeks: 12,
      leadTimePenalty: 0,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      leveledTotalCost: 1820000,
      isAwarded: false,
      receivedAt: Date.now() - 3600000 * 16,
    }));

    await ctx.db.insert("bids", bidRowFromDollars({
      tradePackageId: hvacPackageId,
      contractorId: h2,
      subcontractorName: "The Brandt Companies, LLC",
      baseBidAmount: 1650000,
      lineItems: [
        { item: "Chilled Water AHU Units & Piping", unit: "LS", quantity: 1, unitCost: 780000, totalCost: 780000 },
        { item: "VAV Terminal Units & Electric Reheat", unit: "EA", quantity: 110, unitCost: 3200, totalCost: 352000 },
        { item: "Galvanized Ductwork Distribution", unit: "LF", quantity: 18000, unitCost: 20, totalCost: 360000 },
        { item: "General Testing & Start-up", unit: "LS", quantity: 1, unitCost: 158000, totalCost: 158000 },
      ],
      identifiedExclusions: [
        {
          description: "Rooftop crane hoisting to cooling tower deck excluded (GC to furnish crane)",
          costImpact: 48000,
          severity: "critical",
        },
        {
          description: "Testing, Adjusting, and Balancing (TAB) certified report excluded",
          costImpact: 28000,
          severity: "critical",
        },
        {
          description: "BACnet MS/TP automation integration gateway excluded",
          costImpact: 18000,
          severity: "moderate",
        },
        {
          description: "Spring vibration isolation hangers excluded (Un-isolated provided)",
          costImpact: 14000,
          severity: "moderate",
        },
      ],
      longLeadEquipmentWeeks: 18,
      leadTimePenalty: 12000,
      coiComplianceStatus: "deficiency_detected",
      coiPenalty: 15000,
      leveledTotalCost: 1785000,
      isAwarded: false,
      receivedAt: Date.now() - 3600000 * 10,
    }));

    // 7. Seed Division 22 Plumbing Contractors, RFIs, and Leveling Bids
    const p1 = await ctx.db.insert("contractors", {
      tradePackageId: plumbingPackageId,
      companyName: "Clarke Kent Plumbing",
      contactEmail: "dispatch@clarkekentplumbing.com",
      phone: "+1 (512) 282-7000",
      licenseNumber: "TX-RMP-39182",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://clarkekentplumbing.com",
      rfqStatus: "bid_received",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    const p2 = await ctx.db.insert("contractors", {
      tradePackageId: plumbingPackageId,
      companyName: "Limbach Facility Services LLC",
      contactEmail: "estimating@limbachinc.com",
      phone: "+1 (512) 456-3570",
      licenseNumber: "TX-RMP-41029",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://limbachinc.com",
      rfqStatus: "bid_received",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    await ctx.db.insert("contractors", {
      tradePackageId: plumbingPackageId,
      companyName: "TDIndustries, Inc. (Plumbing)",
      contactEmail: "plumbing@tdindustries.com",
      phone: "+1 (512) 310-5300",
      licenseNumber: "TX-RMP-40912",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://www.tdindustries.com",
      rfqStatus: "invited",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    await ctx.db.insert("contractors", {
      tradePackageId: plumbingPackageId,
      companyName: "Daniel's Plumbing & Air Conditioning",
      contactEmail: "service@danielshomeservices.com",
      phone: "+1 (512) 490-6733",
      licenseNumber: "TX-RMP-38912",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: "https://danielshomeservices.com",
      rfqStatus: "invited",
      dispatchedAt: Date.now() - 86400000 * 2,
    });

    await ctx.db.insert("conversations", {
      tradePackageId: plumbingPackageId,
      contractorId: p1,
      threadId: "th_rfq_plumb_clarke_01",
      inboundSubject: "RFI #1: Division 22 Triplex Water Booster Pump Factory Commissioning",
      inboundQuestion: "Does Division 22 require the plumbing trade to contract factory certified startup technicians for the triplex domestic water booster pump skid, or does owner accept standard contractor mechanical startup?",
      autonomousReply: "Per TradePulse Spec Analysis (Section 22 11 23 & Div 22 Scope): Subcontractor must furnish factory-certified technician startup, 3-day on-site owner training, and manufacturer certified commissioning documentation for the triplex domestic water booster pump skid.",
      confidenceScore: 0.98,
      status: "clarified",
      timestamp: Date.now() - 54000000,
    });

    await ctx.db.insert("bids", bidRowFromDollars({
      tradePackageId: plumbingPackageId,
      contractorId: p1,
      subcontractorName: "Clarke Kent Plumbing",
      baseBidAmount: 935000,
      lineItems: [
        { item: "Domestic Copper Water Supply Piping", unit: "LF", quantity: 9500, unitCost: 35, totalCost: 332500 },
        { item: "Cast Iron Sanitary Waste & Vent Piping", unit: "LF", quantity: 8200, unitCost: 38, totalCost: 311600 },
        { item: "Triplex Water Booster Pump Skid", unit: "LS", quantity: 1, unitCost: 145000, totalCost: 145000 },
        { item: "Core Drilling & Firestop Rated Sleeves", unit: "LS", quantity: 1, unitCost: 16000, totalCost: 16000 },
        { item: "City of Austin Backflow Inspection Certificate", unit: "LS", quantity: 1, unitCost: 8500, totalCost: 8500 },
        { item: "Booster Factory Startup & 1-Yr Warranty", unit: "LS", quantity: 1, unitCost: 12000, totalCost: 12000 },
        { item: "Commercial Fixture Rough-in & Trim", unit: "LS", quantity: 1, unitCost: 109400, totalCost: 109400 },
      ],
      identifiedExclusions: [],
      longLeadEquipmentWeeks: 10,
      leadTimePenalty: 0,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      leveledTotalCost: 935000,
      isAwarded: false,
      receivedAt: Date.now() - 3600000 * 14,
    }));

    await ctx.db.insert("bids", bidRowFromDollars({
      tradePackageId: plumbingPackageId,
      contractorId: p2,
      subcontractorName: "Limbach Facility Services LLC",
      baseBidAmount: 820000,
      lineItems: [
        { item: "Domestic Copper Water Supply Piping", unit: "LF", quantity: 9500, unitCost: 31, totalCost: 294500 },
        { item: "Cast Iron Sanitary Waste & Vent Piping", unit: "LF", quantity: 8200, unitCost: 34, totalCost: 278800 },
        { item: "Triplex Water Booster Pump Skid", unit: "LS", quantity: 1, unitCost: 138000, totalCost: 138000 },
        { item: "Commercial Fixture Rough-in & Trim", unit: "LS", quantity: 1, unitCost: 108700, totalCost: 108700 },
      ],
      identifiedExclusions: [
        {
          description: "Core drilling and floor/wall penetration sleeves excluded",
          costImpact: 16000,
          severity: "critical",
        },
        {
          description: "City of Austin backflow preventer inspection certification excluded",
          costImpact: 8500,
          severity: "minor",
        },
        {
          description: "Triplex booster pump factory certified technician startup excluded",
          costImpact: 12000,
          severity: "moderate",
        },
        {
          description: "Crane hoisting & rigging to penthouse mechanical floor excluded (GC to furnish crane)",
          costImpact: 25000,
          severity: "critical",
        },
      ],
      longLeadEquipmentWeeks: 18,
      leadTimePenalty: 12000,
      coiComplianceStatus: "deficiency_detected",
      coiPenalty: 15000,
      leveledTotalCost: 908500,
      isAwarded: false,
      receivedAt: Date.now() - 3600000 * 8,
    }));

    // 8. Seed Live Reactive Activity Audit Stream Events
    await ctx.db.insert("auditLogs", {
      projectId,
      tradePackageId: elecPackageId,
      eventType: "contractor_invited",
      title: "RFQ Dispatched: Division 26 Electrical Systems",
      description: "RFQ invitations dispatched to the recorded regional commercial contractors via AgentMail (license status shown as recorded; no registry lookup performed).",
      actor: "TradePulse AI Agent",
      timestamp: Date.now() - 86400000 * 2,
    });

    await ctx.db.insert("auditLogs", {
      projectId,
      tradePackageId: elecPackageId,
      eventType: "rfi_clarified",
      title: "Pre-Bid RFI #1 Clarified by TradePulse AI",
      description: "Answered temporary power query for Rosendin Electric, Inc. citing Section 01 00 00 with 96% model confidence.",
      actor: "TradePulse AI Spec Agent",
      timestamp: Date.now() - 86400000,
    });

    await ctx.db.insert("auditLogs", {
      projectId,
      tradePackageId: elecPackageId,
      eventType: "bid_leveled",
      title: "Forensic Bid Leveling Matrix Generated",
      description: "Normalized proposals from Rosendin Electric, Inc. ($1,225,000) and Alterman, Inc. ($1,286,000 normalized with $186,000 in scope adjustments).",
      actor: "Forensic Leveling Engine (ADR-0003)",
      timestamp: Date.now() - 3600000 * 12,
    });

    // 9. Seed Initial Project Files (drawings, specs, quotes, COIs) to guarantee zero empty states
    await ctx.db.insert("projectFiles", {
      projectId,
      tradePackageId: elecPackageId,
      storageId: "/specs/01_00_00_General_Requirements.pdf",
      fileName: "01_00_00_General_Requirements.pdf",
      fileType: "spec",
      fileSize: authoritativeDocSize("01_00_00_General_Requirements.pdf", 774760),
      uploadedBy: "Chief Commercial Estimator",
      uploadedAt: Date.now() - 86400000 * 3,
    });

    await ctx.db.insert("projectFiles", {
      projectId,
      tradePackageId: elecPackageId,
      storageId: "/specs/26_00_00_Electrical_Systems_Spec.pdf",
      fileName: "26_00_00_Electrical_Systems_Spec.pdf",
      fileType: "spec",
      fileSize: authoritativeDocSize("26_00_00_Electrical_Systems_Spec.pdf", 931307),
      uploadedBy: "Lead Electrical Engineer (PE)",
      uploadedAt: Date.now() - 86400000 * 3,
    });

    await ctx.db.insert("projectFiles", {
      projectId,
      tradePackageId: hvacPackageId,
      storageId: "/specs/23_00_00_HVAC_Systems_Spec.pdf",
      fileName: "23_00_00_HVAC_Systems_Spec.pdf",
      fileType: "spec",
      fileSize: authoritativeDocSize("23_00_00_HVAC_Systems_Spec.pdf", 165362),
      uploadedBy: "Lead Mechanical Engineer (PE)",
      uploadedAt: Date.now() - 86400000 * 3,
    });

    await ctx.db.insert("projectFiles", {
      projectId,
      tradePackageId: plumbingPackageId,
      storageId: "/specs/22_00_00_Plumbing_Systems_Spec.pdf",
      fileName: "22_00_00_Plumbing_Systems_Spec.pdf",
      fileType: "spec",
      fileSize: authoritativeDocSize("22_00_00_Plumbing_Systems_Spec.pdf", 4391422),
      uploadedBy: "Project Plumbing Engineer (PE)",
      uploadedAt: Date.now() - 86400000 * 3,
    });

    await ctx.db.insert("projectFiles", {
      projectId,
      tradePackageId: elecPackageId,
      storageId: "/drawings/E-101_Main_Switchgear_Penthouse_Plan.pdf",
      fileName: "E-101_Main_Switchgear_Penthouse_Plan.pdf",
      fileType: "blueprint",
      fileSize: 4094,
      uploadedBy: "Project Architect / BIM Coordinator",
      uploadedAt: Date.now() - 86400000 * 2,
    });

    await ctx.db.insert("projectFiles", {
      projectId,
      tradePackageId: elecPackageId,
      storageId: "/quotes/Rosendin_Electric_Proposal_AIA.pdf",
      fileName: "Rosendin_Electric_Proposal_AIA.pdf",
      fileType: "quote_pdf",
      fileSize: 6066,
      uploadedBy: "Rosendin Electric, Inc.",
      uploadedAt: Date.now() - 3600000 * 18,
    });

    await ctx.db.insert("projectFiles", {
      projectId,
      tradePackageId: elecPackageId,
      storageId: "/quotes/Alterman_Power_Quote_Proposal.pdf",
      fileName: "Alterman_Power_Quote_Proposal.pdf",
      fileType: "quote_pdf",
      fileSize: 5270,
      uploadedBy: "Alterman, Inc.",
      uploadedAt: Date.now() - 3600000 * 12,
    });

    await ctx.db.insert("projectFiles", {
      projectId,
      tradePackageId: elecPackageId,
      storageId: "/insurance/Rosendin_Electric_ACORD25_COI.pdf",
      fileName: "Rosendin_Electric_ACORD25_COI.pdf",
      fileType: "coi_certificate",
      fileSize: 4160,
      uploadedBy: "Rosendin Risk Management / Travelers",
      uploadedAt: Date.now() - 3600000 * 10,
    });

    // 10. Seed the A401-style draft subcontract for Rosendin Electric, Inc.
    const agreementNumber = "A401-2026-2601-18042";
    const demoAgreementId = await ctx.db.insert("agreements", {
      projectId,
      tradePackageId: elecPackageId,
      bidId: b1,
      contractorId: c1,
      agreementNumber,
      documentTitle: "Subcontract Agreement (A401-style structure) — generated draft, not an AIA-licensed form",
      subcontractorName: "Rosendin Electric, Inc.",
      generalContractorName: DEFAULT_GENERAL_CONTRACTOR,
      subcontractorEmail: "estimating@rosendin.com",
      projectTitle: "The Domain Tower B - Commercial MEP",
      projectLocation: "Austin, TX",
      csiDivision: "26 00 00",
      tradeName: "Electrical & Lighting Systems",
      contractSum: 1225000,
      retainagePercent: 10,
      liquidatedDamagesDaily: 1200,
      scopeSummary: "Complete commercial electrical distribution, 1600A switchgear, penthouse crane hoisting, emergency lighting, and seismic bracing.",
      mandatoryInclusions: [
        "Crane hoisting to 14th-floor mechanical room",
        "Seismic bracing (IBC Section 1613)",
        "Temporary 400A jobsite power distribution",
        "UL 1479 floor/wall firestopping",
      ],
      status: "generated",
      contractText: "",
      createdAt: Date.now() - 3600000 * 6,
    });
    await refreshAgreementDocument(ctx, demoAgreementId);

    return {
      status: "seeded_success",
      projectId,
      electricalPackageId: elecPackageId,
      hvacPackageId,
      plumbingPackageId,
    };
  }
}

/**
 * Reseeding recreates contractors and agreements, so demo sub profiles are relinked and active
 * billing-agent links are remapped to the new contractor ids by name.
 */
async function reseedAndRelink(ctx: MutationCtx, args: { force?: boolean }) {
  const links = await snapshotActiveAgentLinks(ctx);
  const result = await seedDemoProject(ctx, args);
  await applyDemoLicenseNumbers(ctx);
  await linkDemoProfiles(ctx);
  await remapAgentLinks(ctx, links);
  const demoGcId = await findDemoGcCompanyId(ctx);
  if (demoGcId !== null) await backfillVendorsForCompany(ctx, demoGcId);
  return result;
}

/**
 * Demo seed / reset (`force: true` wipes and reseeds the demo project). Only a GC of the Demo
 * company may run it; it touches only the Demo company's seeded project.
 */
export const seedInitialData = mutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireDemoCompany(ctx, ["gc"]);
    return await reseedAndRelink(ctx, args);
  },
});

/** CLI / scheduler entry point for the same seed (no signed-in user). */
export const seedInitialDataInternal = internalMutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, args) => await reseedAndRelink(ctx, args),
});

export const deleteProject = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { project } = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    if (project.isDemoProject) {
      throw new Error("The default demo project cannot be deleted.");
    }

    // A10-02: deleting the project must not silently destroy an executed
    // subcontract; the same immutability rule applies as for packages/bids.
    const executedAgreements = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const executedAgreement = executedAgreements.find((a) => a.status === "executed");
    if (executedAgreement) {
      throw new ConvexError(
        `This project has an executed subcontract (${executedAgreement.agreementNumber}) and cannot be deleted. Void or amend the executed agreement first.`
      );
    }

    const packages = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    for (const pkg of packages) {
      const bids = await ctx.db
        .query("bids")
        .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
        .collect();
      for (const b of bids) {
        await ctx.db.delete(b._id);
      }

      const contractors = await ctx.db
        .query("contractors")
        .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
        .collect();
      for (const c of contractors) {
        await deleteContractorCascade(ctx, c._id);
      }

      const agreements = await ctx.db
        .query("agreements")
        .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
        .collect();
      for (const a of agreements) {
        await deleteAgreementCascade(ctx, a._id);
      }

      const convos = await ctx.db
        .query("conversations")
        .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
        .collect();
      for (const c of convos) {
        await ctx.db.delete(c._id);
      }

      await ctx.db.delete(pkg._id);
    }

    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const f of files) {
      if (f.storageId && !f.storageId.startsWith("http") && !f.storageId.startsWith("local_")) {
        try {
          await ctx.storage.delete(f.storageId as any);
        } catch {
          // Ignore if blob already removed
        }
      }
      await ctx.db.delete(f._id);
    }

    // auditLogs are kept as history; listRecentLogs hides entries of deleted projects.

    // A3-07: clash resolutions belonged to the project and were left orphaned.
    const clashResolutions = await ctx.db
      .query("clashResolutions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const cr of clashResolutions) {
      await ctx.db.delete(cr._id);
    }

    await ctx.db.delete(args.projectId);
    return { success: true };
  },
});
