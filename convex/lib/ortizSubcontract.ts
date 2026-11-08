import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { projectStartMs } from "../billing/trancheRules";
import { sovSourceFingerprint } from "../payments/sovMath";
import { defaultAgreementTerms } from "./agreementTerms";
import { refreshAgreementDocument } from "./agreementDocument";
import { seededProposalBidRow } from "./bidMoney";
import { DEMO_SOV_APPROVER } from "./demoBilling";
import { DEMO_GC_EMAIL } from "./demoPlugs";
import type { DemoCompanyIds } from "./demoTenancy";
import { formatCents } from "./money";

/**
 * The Ortiz Plumbing subcontract on the Lopez residential reference job (architecture §3.4).
 *
 * A residential sub is a real subcontractor, not a special case: one plumbing trade package, one
 * awarded bid, one executed agreement with three milestones, 5% retainage and the lien-waiver gate
 * on. Rows are found by stable natural keys (trade name, company name, agreement number, SOV line
 * number, milestone order) so a re-seed never duplicates them and never rewrites money that has
 * already moved.
 *
 * The three milestones list one schedule-of-values line each. That mapping is what lets the rules
 * engine see the Fixtures set work as unearned while the Rough-in line is funded: a milestone that
 * listed all three lines would credit every line with the same progress.
 */

export const ORTIZ_COMPANY_NAME = "Ortiz Plumbing";
export const ORTIZ_TRADE_NAME = "Plumbing";
export const ORTIZ_CSI_DIVISION = "22 00 00";
export const ORTIZ_AGREEMENT_NUMBER = "SC-22-ORTIZ-0001";
export const ORTIZ_CONTRACT_SUM_CENTS = 900_000;
export const ORTIZ_RETAINAGE_BPS = 500;
export const ORTIZ_BID_LINE_ITEM = "Plumbing — rough-in, fixtures and final";

/** Contact detail for a seeded demo bidder; `.invalid` is the reserved placeholder domain. */
export const ORTIZ_CONTACT_EMAIL = "estimating@ortiz-plumbing.demo.invalid";
export const ORTIZ_SOURCE_URL = "https://ortiz-plumbing.demo.invalid";

export const ORTIZ_SOV_LINES = [
  { lineNo: 1, name: "Rough-in", scheduledValueCents: 400_000 },
  { lineNo: 2, name: "Fixtures set", scheduledValueCents: 350_000 },
  { lineNo: 3, name: "Final", scheduledValueCents: 150_000 },
] as const;

export const ORTIZ_EXCLUDED_SCOPE_NOTES = [
  "Fixtures and appliance set are not billable until the Fixtures set milestone is complete.",
];

const SCOPE_SUMMARY =
  "Residential kitchen plumbing: re-pipe supply and waste for the relocated sink and dishwasher, set fixtures at rough-in and trim, and complete the final inspection.";
const MANDATORY_INCLUSIONS = ["Rough-in and pressure test", "Fixture set and trim", "Final inspection punch list"];

const DAY_MS = 24 * 60 * 60 * 1000;

export type OrtizCreationCounts = {
  tradePackage: boolean;
  contractor: boolean;
  bid: boolean;
  agreement: boolean;
  sovLines: number;
  milestones: number;
};

export type OrtizSubcontractSummary = {
  tradePackageId: Id<"tradePackages">;
  contractorId: Id<"contractors">;
  bidId: Id<"bids">;
  agreementId: Id<"agreements">;
  agreementNumber: string;
  status: string;
  contractSumCents: number;
  retainageBps: number | null;
  lienWaiverGateEnabled: boolean;
  sovLinesCents: number;
  milestoneCents: number[];
  created: OrtizCreationCounts;
};

function demoGcUser(ctx: MutationCtx): Promise<Doc<"users"> | null> {
  return ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", DEMO_GC_EMAIL))
    .first();
}

async function findTradePackage(ctx: MutationCtx, projectId: Id<"projects">): Promise<Doc<"tradePackages"> | null> {
  const packages = await ctx.db
    .query("tradePackages")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(200);
  return packages.find((p) => p.tradeName.trim().toLowerCase() === ORTIZ_TRADE_NAME.toLowerCase()) ?? null;
}

async function findOrtizContractor(
  ctx: MutationCtx,
  tradePackageId: Id<"tradePackages">,
): Promise<Doc<"contractors"> | null> {
  const bidders = await ctx.db
    .query("contractors")
    .withIndex("by_package", (q) => q.eq("tradePackageId", tradePackageId))
    .take(500);
  return bidders.find((c) => c.companyName.trim().toLowerCase() === ORTIZ_COMPANY_NAME.toLowerCase()) ?? null;
}

async function findAgreement(ctx: MutationCtx, projectId: Id<"projects">): Promise<Doc<"agreements"> | null> {
  const agreements = await ctx.db
    .query("agreements")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(200);
  return agreements.find((a) => a.agreementNumber === ORTIZ_AGREEMENT_NUMBER) ?? null;
}

type SownRows = { lines: Doc<"scheduleOfValues">[]; milestones: Doc<"milestones">[] };

/** Creates any missing SOV lines and milestones; never patches a row that already exists. */
async function ensureOrtizSovAndMilestones(
  ctx: MutationCtx,
  agreement: Doc<"agreements">,
  bid: Doc<"bids">,
): Promise<SownRows & { createdLines: number; createdMilestones: number }> {
  const existingLines = await ctx.db
    .query("scheduleOfValues")
    .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id))
    .take(1000);
  const byLineNo = new Map(existingLines.map((line) => [line.lineNo, line]));
  const fingerprint = sovSourceFingerprint({
    bidId: bid._id,
    contractSumCents: ORTIZ_CONTRACT_SUM_CENTS,
    lineItems: bid.lineItems,
    acceptedAlternates: agreement.acceptedAlternates ?? [],
    leadWeeks: bid.longLeadEquipmentWeeks,
  });
  let createdLines = 0;
  const lines: Doc<"scheduleOfValues">[] = [];
  for (const line of ORTIZ_SOV_LINES) {
    const found = byLineNo.get(line.lineNo);
    if (found !== undefined) {
      lines.push(found);
      continue;
    }
    const id = await ctx.db.insert("scheduleOfValues", {
      agreementId: agreement._id,
      lineNo: line.lineNo,
      description: line.name,
      csiCode: ORTIZ_CSI_DIVISION,
      scheduledValueCents: line.scheduledValueCents,
      excludedScope: false,
      sourceFingerprint: fingerprint,
      sourceBidLineRef: "lineItems[0]",
    });
    const row = await ctx.db.get(id);
    if (row !== null) lines.push(row);
    createdLines++;
  }

  const project = await ctx.db.get(agreement.projectId);
  const startMs = projectStartMs(project) ?? project?.createdAt ?? Date.now();
  const existingMilestones = await ctx.db
    .query("milestones")
    .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
    .take(100);
  const byOrder = new Map(existingMilestones.map((m) => [m.order, m]));
  let createdMilestones = 0;
  for (const [index, line] of ORTIZ_SOV_LINES.entries()) {
    if (byOrder.has(line.lineNo)) continue;
    const sovLine = lines.find((l) => l.lineNo === line.lineNo);
    await ctx.db.insert("milestones", {
      agreementId: agreement._id,
      name: line.name,
      order: line.lineNo,
      plannedDate: startMs + (index + 1) * 14 * DAY_MS,
      amountCents: line.scheduledValueCents,
      status: "planned",
      sovLineIds: sovLine === undefined ? lines.map((l) => l._id) : [sovLine._id],
    });
    createdMilestones++;
  }

  // A row inserted above is missing from the pre-read lists; reload so the summary is exact.
  const milestones =
    createdMilestones === 0
      ? existingMilestones
      : await ctx.db
          .query("milestones")
          .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
          .take(100);
  const finalLines =
    createdLines === 0
      ? existingLines
      : await ctx.db
          .query("scheduleOfValues")
          .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id))
          .take(1000);
  return { lines: finalLines, milestones: [...milestones].sort((a, b) => a.order - b.order), createdLines, createdMilestones };
}

/**
 * Ensures the plumbing trade package, Ortiz bidder, awarded bid, executed agreement, three SOV
 * lines and three milestones on this project. Idempotent and additive.
 */
export async function ensureOrtizSubcontract(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  demoIds: DemoCompanyIds,
): Promise<OrtizSubcontractSummary> {
  const project = await ctx.db.get(projectId);
  if (project === null) throw new Error("The residential reference project does not exist.");
  const now = Date.now();
  const created: OrtizCreationCounts = { tradePackage: false, contractor: false, bid: false, agreement: false, sovLines: 0, milestones: 0 };

  let tradePackage = await findTradePackage(ctx, projectId);
  if (tradePackage === null) {
    const id = await ctx.db.insert("tradePackages", {
      projectId,
      csiDivision: ORTIZ_CSI_DIVISION,
      tradeName: ORTIZ_TRADE_NAME,
      budgetEstimate: ORTIZ_CONTRACT_SUM_CENTS / 100,
      agentMailbox: "dullstreet57@agentmail.to",
      agentMailboxId: "dullstreet57@agentmail.to",
      agentMailboxShared: true,
      scopeSummary: SCOPE_SUMMARY,
      mandatoryInclusions: MANDATORY_INCLUSIONS,
      bidDeadline: "2026-10-06",
      status: "awarded",
    });
    tradePackage = await ctx.db.get(id);
    created.tradePackage = true;
  } else if (tradePackage.csiDivision !== ORTIZ_CSI_DIVISION || tradePackage.status !== "awarded") {
    await ctx.db.patch(tradePackage._id, { csiDivision: ORTIZ_CSI_DIVISION, status: "awarded" });
    tradePackage = await ctx.db.get(tradePackage._id);
  }
  if (tradePackage === null) throw new Error("The plumbing trade package could not be created.");

  let contractor = await findOrtizContractor(ctx, tradePackage._id);
  if (contractor === null) {
    const id = await ctx.db.insert("contractors", {
      tradePackageId: tradePackage._id,
      companyName: ORTIZ_COMPANY_NAME,
      contactEmail: ORTIZ_CONTACT_EMAIL,
      licenseNumber: "Not verified",
      licenseStatus: "Unverified — demo record; state registry lookup not performed",
      sourceUrl: ORTIZ_SOURCE_URL,
      rfqStatus: "bid_received",
      dispatchedAt: now - 3 * DAY_MS,
      linkedCompanyId: demoIds["sub:ortiz"],
    });
    contractor = await ctx.db.get(id);
    created.contractor = true;
  } else if (contractor.linkedCompanyId !== demoIds["sub:ortiz"]) {
    await ctx.db.patch(contractor._id, { linkedCompanyId: demoIds["sub:ortiz"] });
    contractor = await ctx.db.get(contractor._id);
  }
  if (contractor === null) throw new Error("The Ortiz Plumbing bidder could not be created.");

  const invited = tradePackage.invitedContractorIds ?? [];
  if (!invited.includes(contractor._id)) {
    await ctx.db.patch(tradePackage._id, { invitedContractorIds: [...invited, contractor._id] });
  }

  const existingBids = await ctx.db
    .query("bids")
    .withIndex("by_package_and_contractor", (q) => q.eq("tradePackageId", tradePackage!._id).eq("contractorId", contractor!._id))
    .take(10);
  let bid: Doc<"bids"> | null = existingBids[0] ?? null;
  if (bid === null) {
    const id = await ctx.db.insert(
      "bids",
      seededProposalBidRow({
        tradePackageId: tradePackage._id,
        contractorId: contractor._id,
        subcontractorName: ORTIZ_COMPANY_NAME,
        baseBidAmount: ORTIZ_CONTRACT_SUM_CENTS / 100,
        lineItems: [
          {
            item: ORTIZ_BID_LINE_ITEM,
            unit: "LS",
            quantity: 1,
            unitCost: ORTIZ_CONTRACT_SUM_CENTS / 100,
            totalCost: ORTIZ_CONTRACT_SUM_CENTS / 100,
          },
        ],
        identifiedExclusions: [],
        valueEngineeringAlternates: [],
        longLeadEquipmentWeeks: 0,
        leadTimePenalty: 0,
        coiComplianceStatus: "compliant",
        coiPenalty: 0,
        leveledTotalCost: ORTIZ_CONTRACT_SUM_CENTS / 100,
        isAwarded: true,
        receivedAt: now - DAY_MS,
      }),
    );
    bid = await ctx.db.get(id);
    created.bid = true;
  } else if (bid.isAwarded !== true) {
    await ctx.db.patch(bid._id, { isAwarded: true });
    bid = await ctx.db.get(bid._id);
  }
  if (bid === null) throw new Error("The Ortiz Plumbing bid could not be created.");

  let agreement = await findAgreement(ctx, projectId);
  if (agreement === null) {
    const gcUser = await demoGcUser(ctx);
    const terms = defaultAgreementTerms({
      projectState: "CA",
      projectRetainageBps: ORTIZ_RETAINAGE_BPS,
      companyDefaultRetainageBps: null,
      contractSumCents: ORTIZ_CONTRACT_SUM_CENTS,
    });
    const id = await ctx.db.insert("agreements", {
      projectId,
      tradePackageId: tradePackage._id,
      bidId: bid._id,
      contractorId: contractor._id,
      agreementNumber: ORTIZ_AGREEMENT_NUMBER,
      documentTitle: "Residential subcontract agreement — plumbing",
      subcontractorName: ORTIZ_COMPANY_NAME,
      subcontractorEmail: ORTIZ_CONTACT_EMAIL,
      generalContractorName: project.generalContractorName?.trim() || "Bayview Remodeling",
      projectTitle: project.title,
      projectLocation: project.location,
      csiDivision: ORTIZ_CSI_DIVISION,
      tradeName: ORTIZ_TRADE_NAME,
      contractSum: ORTIZ_CONTRACT_SUM_CENTS / 100,
      contractSumCents: ORTIZ_CONTRACT_SUM_CENTS,
      baseBidCents: ORTIZ_CONTRACT_SUM_CENTS,
      acceptedAlternates: [],
      declinedAlternates: [],
      veDeducts: [],
      excludedScopeNotes: ORTIZ_EXCLUDED_SCOPE_NOTES,
      sov: {
        status: "approved",
        approvedAt: now,
        ...(gcUser !== null ? { approvedByUserId: gcUser._id } : {}),
        approvedByName: DEMO_SOV_APPROVER,
      },
      retainagePercent: ORTIZ_RETAINAGE_BPS / 100,
      liquidatedDamagesDaily: 0,
      lienWaiverGate: {
        enabled: true,
        enabledAt: now,
        ...(gcUser !== null ? { enabledByUserId: gcUser._id } : {}),
        enabledByName: DEMO_SOV_APPROVER,
        requirePriorUnconditional: false,
      },
      terms,
      scopeSummary: SCOPE_SUMMARY,
      mandatoryInclusions: MANDATORY_INCLUSIONS,
      status: "executed",
      contractText: "",
      executedAt: now,
      createdAt: now,
    });
    agreement = await ctx.db.get(id);
    created.agreement = true;
    if (agreement === null) throw new Error("The Ortiz Plumbing agreement could not be created.");
    await refreshAgreementDocument(ctx, agreement._id, terms);
    await ctx.db.insert("auditLogs", {
      projectId,
      tradePackageId: tradePackage._id,
      agreementId: agreement._id,
      eventType: "contract_awarded",
      title: `Subcontract executed: ${ORTIZ_AGREEMENT_NUMBER}`,
      description: `${ORTIZ_COMPANY_NAME} was awarded ${ORTIZ_TRADE_NAME} on ${project.title} for ${formatCents(
        ORTIZ_CONTRACT_SUM_CENTS,
      )}: milestones Rough-in, Fixtures set and Final, 5% retainage and the lien-waiver gate on.`,
      actor: DEMO_SOV_APPROVER,
      timestamp: now,
    });
  }
  if (agreement === null) throw new Error("The Ortiz Plumbing agreement could not be created.");

  const rows = await ensureOrtizSovAndMilestones(ctx, agreement, bid);
  created.sovLines = rows.createdLines;
  created.milestones = rows.createdMilestones;

  return {
    tradePackageId: tradePackage._id,
    contractorId: contractor._id,
    bidId: bid._id,
    agreementId: agreement._id,
    agreementNumber: agreement.agreementNumber,
    status: agreement.status,
    contractSumCents: agreement.contractSumCents ?? ORTIZ_CONTRACT_SUM_CENTS,
    retainageBps: agreement.terms?.retainageBps ?? null,
    lienWaiverGateEnabled: agreement.lienWaiverGate?.enabled === true,
    sovLinesCents: rows.lines.reduce((sum, line) => sum + line.scheduledValueCents, 0),
    milestoneCents: rows.milestones.map((m) => m.amountCents),
    created,
  };
}
