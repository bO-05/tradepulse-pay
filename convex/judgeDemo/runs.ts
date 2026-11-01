import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import { normalizeAgentEmail, syncAgentProfilesForEmail } from "../lib/agentAccess";
import { requireRole } from "../lib/roles";
import { requireDemoCompany, requireProjectScope } from "../lib/projectScope";
import { approvePrime, insertDraftChangeOrder } from "../billing/changeOrders";
import { attachProjectToDemo, ensureDemoCompanies } from "../lib/demoTenancy";
import { recordPayApplication, payAppSovContext } from "../payApps/submit";
import { DEMO_SOV_APPROVER } from "../lib/demoBilling";
import { RETAINAGE_PERCENT } from "../terms";
import {
  DEMO_BILLING_AGENT_EMAIL,
  DEMO_CHANGE_ORDER,
  DEMO_CONTRACT_SUM,
  DEMO_EXCLUSION,
  DEMO_LINE_ITEMS,
  DEMO_PAY_APP_TEXT,
  DEMO_PROJECT_TITLE,
  demoAgreementNumber,
  demoPayAppLines,
} from "./scenario";
import { seededProposalBidRow } from "../lib/bidMoney";

/**
 * One-click TradePulse Pay judge demo, Demo company GC only (everyone else gets "Not found."). Each run creates a fresh, clearly labeled demo award for
 * sub1's contractor, which the GC then executes through the regular procurement mutation. Pay apps the
 * demo files are marked `judgeDemo` with the GC who ran it, so no surface presents them as filed by the
 * sub or its agent in person. Every later step (review, KERNEL check, proposals, approval, capture,
 * payout, change order) runs through the same public functions the app uses.
 */

const SUB1_EMAIL = "sub1@demo.tradepulse";
const OWNER_EMAIL = "owner@demo.tradepulse";
const GC_NAME = "Austin Commercial, LP";

export async function sub1Account(ctx: MutationCtx): Promise<{ userId: Id<"users">; contractorId: Id<"contractors"> }> {
  const user = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", SUB1_EMAIL))
    .first();
  const profile = user
    ? await ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .first()
    : null;
  if (user === null || profile?.contractorId === undefined) {
    throw new ConvexError({
      code: "DEMO_NOT_SEEDED",
      message: `The demo account ${SUB1_EMAIL} is missing or not linked to a contractor. Run demoAccounts:seedDemo first.`,
    });
  }
  return { userId: user._id, contractorId: profile.contractorId };
}

/** Makes sure the demo billing agent is authorized for the contractor; refuses to move a link from another contractor. */
async function ensureAgentLink(ctx: MutationCtx, contractorId: Id<"contractors">, gc: { userId: Id<"users">; email: string }) {
  const agentEmail = normalizeAgentEmail(DEMO_BILLING_AGENT_EMAIL);
  const active = await ctx.db
    .query("agentLinks")
    .withIndex("by_agentEmail_and_status", (q) => q.eq("agentEmail", agentEmail).eq("status", "active"))
    .first();
  if (active !== null) {
    if (active.contractorId !== contractorId) {
      throw new ConvexError({
        code: "CONFLICT",
        message: `${agentEmail} is authorized for another contractor. Revoke that link under Billing agents before running the demo.`,
      });
    }
    return { linkId: active._id, created: false };
  }
  const contractor = await ctx.db.get(contractorId);
  const demoCompanies = await ensureDemoCompanies(ctx);
  const linkId = await ctx.db.insert("agentLinks", {
    agentEmail,
    contractorId,
    contractorName: contractor?.companyName,
    gcCompanyId: demoCompanies.gc,
    subCompanyId: contractor?.linkedCompanyId,
    status: "active",
    createdBy: gc.userId,
    createdAt: Date.now(),
  });
  await syncAgentProfilesForEmail(ctx, agentEmail);
  await ctx.db.insert("auditLogs", {
    eventType: "agent_link_added",
    title: "Billing agent authorized",
    description: `${agentEmail} may act as billing agent for ${contractor?.companyName ?? "the contractor"} (authorized by the judge demo).`,
    actor: gc.email,
    timestamp: Date.now(),
  });
  return { linkId, created: true };
}

/** Starts a run: a demo project, trade package, awarded bid and a generated (not yet executed) agreement. */
export const startRun = mutation({
  args: {},
  handler: async (ctx) => {
    await requireDemoCompany(ctx, ["gc"]);
    const viewer = await requireRole(ctx, ["gc"]);
    const gcEmail = viewer.user.email ?? `user:${viewer.userId}`;
    const sub1 = await sub1Account(ctx);
    const contractor = await ctx.db.get(sub1.contractorId);
    if (contractor === null) throw new ConvexError({ code: "DEMO_NOT_SEEDED", message: "sub1's contractor record is missing." });
    const agentLink = await ensureAgentLink(ctx, sub1.contractorId, { userId: viewer.userId, email: gcEmail });

    const now = Date.now();
    const priorRuns = await ctx.db.query("judgeDemoRuns").take(1000);
    const agreementNumber = demoAgreementNumber(now, priorRuns.length + 1);
    const baseBid = DEMO_LINE_ITEMS.reduce((a, l) => a + l.totalCost, 0);
    const scope = "Div 26 distribution, feeders, grounding and closeout. Seismic bracing is excluded scope (by others).";

    const projectId = await ctx.db.insert("projects", {
      title: `${DEMO_PROJECT_TITLE} ${agreementNumber.slice(-11)}`,
      location: "Austin, TX",
      projectType: "Demo data for the one-click TradePulse Pay judge demo",
      estBudget: DEMO_CONTRACT_SUM,
      targetCompletionWeeks: 40,
      specDocumentText: "Demo project. Div 26 electrical; seismic bracing excluded from the electrical subcontract.",
      isDemoProject: false,
      generalContractorName: GC_NAME,
      createdAt: now,
    });
    const tradePackageId = await ctx.db.insert("tradePackages", {
      projectId,
      csiDivision: "26 00 00",
      tradeName: "Electrical & Lighting Systems",
      budgetEstimate: DEMO_CONTRACT_SUM,
      agentMailbox: "demo-judge@example.invalid",
      agentMailboxId: "demo-judge",
      scopeSummary: scope,
      mandatoryInclusions: ["Temporary power", "Testing and commissioning"],
      bidDeadline: new Date(now).toISOString().slice(0, 10),
      status: "awarded",
    });
    const bidId = await ctx.db.insert("bids", seededProposalBidRow({
      tradePackageId,
      contractorId: sub1.contractorId,
      subcontractorName: contractor.companyName,
      baseBidAmount: baseBid,
      lineItems: DEMO_LINE_ITEMS.map((l) => ({ item: l.item, unit: "LS", quantity: 1, unitCost: l.totalCost, totalCost: l.totalCost })),
      identifiedExclusions: [{ ...DEMO_EXCLUSION }],
      valueEngineeringAlternates: [],
      longLeadEquipmentWeeks: 6,
      leadTimePenalty: 0,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      leveledTotalCost: DEMO_CONTRACT_SUM,
      isAwarded: true,
      receivedAt: now,
    }));
    const agreementId = await ctx.db.insert("agreements", {
      projectId,
      tradePackageId,
      bidId,
      contractorId: sub1.contractorId,
      agreementNumber,
      documentTitle: "Subcontract agreement (judge demo data)",
      subcontractorName: contractor.companyName,
      generalContractorName: GC_NAME,
      projectTitle: DEMO_PROJECT_TITLE,
      projectLocation: "Austin, TX",
      csiDivision: "26 00 00",
      tradeName: "Electrical & Lighting Systems",
      contractSum: DEMO_CONTRACT_SUM,
      retainagePercent: RETAINAGE_PERCENT,
      liquidatedDamagesDaily: 0,
      scopeSummary: scope,
      mandatoryInclusions: ["Temporary power", "Testing and commissioning"],
      status: "generated",
      contractText: "Demo subcontract generated by the TradePulse Pay judge demo. Not a real contract.",
      // The judge demo's SOV is seeded as GC-approved; its lines are prefilled from the bid at execution.
      sov: { status: "approved", approvedAt: now, approvedByUserId: viewer.userId, approvedByName: DEMO_SOV_APPROVER },
      createdAt: now,
    });
    const runId = await ctx.db.insert("judgeDemoRuns", {
      startedBy: viewer.userId,
      gcEmail,
      projectId,
      agreementId,
      agreementNumber,
      createdAt: now,
    });
    await ctx.db.insert("auditLogs", {
      projectId,
      agreementId,
      eventType: "compliance_audit",
      title: "Judge demo started",
      description: `${agreementNumber}: demo award to ${contractor.companyName} ($${DEMO_CONTRACT_SUM.toLocaleString("en-US")}, seismic bracing excluded)${
        agentLink.created ? "; demo billing agent authorized" : ""
      }.`,
      actor: gcEmail,
      timestamp: now,
    });
    await attachProjectToDemo(ctx, projectId);
    return { runId, agreementId, agreementNumber };
  },
});

async function loadRun(ctx: MutationCtx, runId: Id<"judgeDemoRuns">, userId: Id<"users">): Promise<Doc<"judgeDemoRuns">> {
  const run = await ctx.db.get(runId);
  if (run === null || run.startedBy !== userId) throw new ConvexError({ code: "NOT_FOUND", message: "Judge demo run not found." });
  return run;
}

/**
 * Files one of the run's two pay apps as a stand-in: "honest" for sub1 (human), "agent" for the linked
 * billing agent. The row keeps the GC who filed it in `judgeDemo`, and the regular review is scheduled.
 */
export const fileDemoPayApp = mutation({
  args: { runId: v.id("judgeDemoRuns"), kind: v.union(v.literal("honest"), v.literal("agent")) },
  handler: async (ctx, args) => {
    await requireDemoCompany(ctx, ["gc"]);
    const viewer = await requireRole(ctx, ["gc"]);
    const run = await loadRun(ctx, args.runId, viewer.userId);
    const existing = args.kind === "honest" ? run.honestPayAppId : run.agentPayAppId;
    if (existing !== undefined) return existing;
    const agreement = await ctx.db.get(run.agreementId);
    if (agreement === null || agreement.status !== "executed") {
      throw new ConvexError({ code: "INVALID_STATE", message: "Execute the demo agreement before filing pay applications." });
    }
    const sub1 = await sub1Account(ctx);
    const sov = await payAppSovContext(ctx, agreement._id);
    const text = DEMO_PAY_APP_TEXT[args.kind];
    const lines = demoPayAppLines(args.kind, sov);
    const judgeDemo = { runId: run._id, filedBy: run.gcEmail };

    let who: Parameters<typeof recordPayApplication>[3];
    if (args.kind === "honest") {
      who = {
        submittedBy: { userId: sub1.userId, actorType: "human" },
        subUserId: sub1.userId,
        actor: run.gcEmail,
        auditFields: {},
        judgeDemo,
        auditNote: `(filed by the judge demo for ${SUB1_EMAIL})`,
      };
    } else {
      const agentEmail = normalizeAgentEmail(DEMO_BILLING_AGENT_EMAIL);
      const link = await ctx.db
        .query("agentLinks")
        .withIndex("by_agentEmail_and_status", (q) => q.eq("agentEmail", agentEmail).eq("status", "active"))
        .first();
      if (link === null || link.contractorId !== agreement.contractorId) {
        throw new ConvexError({
          code: "AGENT_NOT_LINKED",
          message: `${agentEmail} is not an authorized billing agent for ${agreement.subcontractorName}. Link it under Billing agents.`,
        });
      }
      // The agent's users row exists once it has signed in with AgentID; it carries the verified owner.
      const agentUser = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", agentEmail))
        .first();
      const agentId = agentUser?.actorType === "agent" ? agentUser : null;
      who = {
        submittedBy: {
          userId: agentId?._id ?? sub1.userId,
          actorType: "agent",
          agentEmail,
          ...(agentId?.ownerEmail ? { ownerEmail: agentId.ownerEmail } : {}),
          ...(agentId?.ownerName ? { ownerName: agentId.ownerName } : {}),
        },
        subUserId: agentId?._id ?? sub1.userId,
        actor: run.gcEmail,
        auditFields: { agentEmail, ...(agentId?.agentSub ? { agentSub: agentId.agentSub } : {}), ...(agentId?.ownerEmail ? { ownerEmail: agentId.ownerEmail } : {}) },
        judgeDemo,
        auditNote: `(filed by the judge demo as a stand-in for ${agentEmail})`,
      };
    }
    const payAppId = await recordPayApplication(ctx, agreement, { ...text, lines }, who);
    await ctx.db.patch(run._id, args.kind === "honest" ? { honestPayAppId: payAppId } : { agentPayAppId: payAppId });
    return payAppId;
  },
});

/**
 * The run's prime change order, drafted and submitted through the regular path and approved as a
 * stand-in for the demo owner (the row records that the judge demo approved it). The GC then invoices
 * it with the regular "Invoice now" action. Idempotent per run.
 */
export const prepareDemoChangeOrder = mutation({
  args: { runId: v.id("judgeDemoRuns") },
  handler: async (ctx, args) => {
    await requireDemoCompany(ctx, ["gc"]);
    const viewer = await requireRole(ctx, ["gc"]);
    const run = await loadRun(ctx, args.runId, viewer.userId);
    if (run.changeOrderId !== undefined) return run.changeOrderId;
    const access = await requireProjectScope(ctx, run.projectId, { roles: ["gc"], write: true });
    const owner = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", OWNER_EMAIL))
      .first();
    if (owner === null) {
      throw new ConvexError({ code: "DEMO_NOT_SEEDED", message: `The demo account ${OWNER_EMAIL} is missing. Run demoAccounts:seedDemo first.` });
    }
    const changeOrderId = await insertDraftChangeOrder(ctx, access, { agreement: null }, { scope: "prime", ...DEMO_CHANGE_ORDER });
    const agreement = await ctx.db.get(run.agreementId);
    const now = Date.now();
    // Billed through the demo agreement so its ledger and the dashboard count the invoice as before.
    await ctx.db.patch(changeOrderId, { status: "submitted", submittedAt: now, ...(agreement ? { agreementId: agreement._id } : {}) });
    const co = (await ctx.db.get(changeOrderId))!;
    await approvePrime(ctx, access, co, { approvedBy: owner._id, judgeDemo: { runId: run._id, approvedFor: OWNER_EMAIL } });
    await ctx.db.patch(run._id, { changeOrderId });
    return changeOrderId;
  },
});

/** The GC's latest run (or a given one) with the ids the demo page needs. */
export const getRun = query({
  args: { runId: v.optional(v.id("judgeDemoRuns")) },
  handler: async (ctx, args) => {
    await requireDemoCompany(ctx, ["gc"]);
    const viewer = await requireRole(ctx, ["gc"]);
    const run = args.runId
      ? await ctx.db.get(args.runId)
      : await ctx.db
          .query("judgeDemoRuns")
          .withIndex("by_startedBy", (q) => q.eq("startedBy", viewer.userId))
          .order("desc")
          .first();
    if (run === null || run.startedBy !== viewer.userId) return null;
    const agreement = await ctx.db.get(run.agreementId);
    return {
      _id: run._id,
      agreementId: run.agreementId,
      agreementNumber: run.agreementNumber,
      agreementStatus: agreement?.status ?? "missing",
      contractorId: agreement?.contractorId ?? null,
      honestPayAppId: run.honestPayAppId ?? null,
      agentPayAppId: run.agentPayAppId ?? null,
      projectId: run.projectId,
      changeOrderId: run.changeOrderId ?? null,
      createdAt: run.createdAt,
    };
  },
});
