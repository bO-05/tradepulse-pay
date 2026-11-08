import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { buildOwnerSheet } from "./billing/ownerRollup";
import { attachProjectToDemo, ensureDemoCompanies, findDemoGcCompanyId } from "./lib/demoTenancy";
import { ensureOrtizSubcontract, ORTIZ_COMPANY_NAME, type OrtizSubcontractSummary } from "./lib/ortizSubcontract";
import { projectKindOf } from "./lib/projectKind";
import { demoInvoiceEmailFor, invoiceRecipientForProject } from "./payments/changeOrderRecipient";

/**
 * The residential reference job.
 *
 * The R7 audit's largest usefulness gap was that the residential positioning lived in copy
 * only: the seeded walkthrough is a commercial tower with no prime contract value, so
 * "New owner pay app" stayed disabled and nothing on screen read as a homeowner job. This
 * adds a second, ordinary project to the Demo company with a prime value, a 10% retainage
 * hold and a monthly billing day, so a homeowner draw can be created end to end.
 *
 * The job carries one real subcontractor: Ortiz Plumbing, a plumbing trade package, an awarded
 * bid and an executed three-milestone subcontract (architecture §3.4). The prime schedule is
 * reconciled so the owner sheet totals the $86,500 prime contract: the four GC lines are
 * $77,500 and the Ortiz trade line is the remaining $9,000.
 *
 * Additive and idempotent. It never patches the commercial walkthrough, and it does not set
 * `isDemoProject` because the demo reset and the demo-project lookup both key off that flag.
 */
export const RESIDENTIAL_REFERENCE_TITLE = "Lopez Kitchen Remodel";
/** The residential GC's display name; the Demo company name is never shown on a homeowner job. */
export const RESIDENTIAL_GC_NAME = "Bayview Remodeling";
/** The Demo company account that operates the Ortiz Plumbing subcontractor seat. */
export const RESIDENTIAL_SUB_EMAIL = "sub4@demo.tradepulse";

/**
 * Line 3 used to be "Electrical, plumbing and appliance set" at $17,300, which included the
 * plumbing scope Ortiz now bills separately. Trimming it to $8,300 and renaming it makes the
 * owner sheet $77,500 prime + $9,000 trade = $86,500 instead of double-counting $9,000.
 */
const PRIME_LINES = [
  { lineNo: 1, description: "Demolition, rough-in and permits", scheduledValueCents: 2_160_000 },
  { lineNo: 2, description: "Cabinetry, countertops and backsplash", scheduledValueCents: 3_460_000 },
  { lineNo: 3, description: "Electrical and appliance set", scheduledValueCents: 830_000 },
  { lineNo: 4, description: "Paint, punch list and closeout", scheduledValueCents: 1_300_000 },
] as const;

export const RESIDENTIAL_PRIME_LINES_CENTS = PRIME_LINES.reduce((sum, line) => sum + line.scheduledValueCents, 0);

export type ResidentialReferenceSummary = {
  projectId: Id<"projects">;
  created: boolean;
  title: string | null;
  projectKind: "residential" | "commercial";
  generalContractorName: string | null;
  contractValueCents: number | null;
  retainageBps: number | null;
  billingDay: number | null;
  primeLineCount: number;
  primeLinesCents: number;
  primeLinesWritten: number;
  ortiz: OrtizSubcontractSummary;
};

/** Creates any missing prime line and reconciles the one the subcontract split changed. */
async function ensurePrimeLines(ctx: MutationCtx, projectId: Id<"projects">): Promise<{ count: number; cents: number; changed: number }> {
  const existing = await ctx.db
    .query("primeLines")
    .withIndex("by_projectId_and_lineNo", (q) => q.eq("projectId", projectId))
    .take(50);
  const byLineNo = new Map(existing.map((line) => [line.lineNo, line]));
  const now = Date.now();
  let changed = 0;
  for (const line of PRIME_LINES) {
    const row = byLineNo.get(line.lineNo);
    if (row === undefined) {
      await ctx.db.insert("primeLines", { projectId, ...line, createdAt: now });
      changed++;
      continue;
    }
    if (row.description === line.description && row.scheduledValueCents === line.scheduledValueCents) continue;
    await ctx.db.patch(row._id, { description: line.description, scheduledValueCents: line.scheduledValueCents, updatedAt: now });
    changed++;
  }
  const lines = await ctx.db
    .query("primeLines")
    .withIndex("by_projectId_and_lineNo", (q) => q.eq("projectId", projectId))
    .take(50);
  return { count: lines.length, cents: lines.reduce((sum, line) => sum + line.scheduledValueCents, 0), changed };
}

/** Called from the demo seed (`reseedAndRelink`), so a fresh database gets the job without a CLI run. */
export async function ensureResidentialReferenceRows(ctx: MutationCtx): Promise<ResidentialReferenceSummary> {
  const demoIds = await ensureDemoCompanies(ctx);
  const owned = await ctx.db
    .query("projects")
    .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", demoIds.gc))
    .take(2000);
  const existing = owned.find((p) => p.title === RESIDENTIAL_REFERENCE_TITLE);

  let projectId: Id<"projects">;
  let created = false;
  if (existing !== undefined) {
    projectId = existing._id;
    // A re-seed keeps the job residential and the homeowner-facing GC name current even on a
    // database created before either existed. Only this reference row is patched; its money rows
    // are never rewritten.
    const patch: Partial<Doc<"projects">> = {};
    if (existing.projectKind !== "residential") patch.projectKind = "residential";
    if (existing.generalContractorName !== RESIDENTIAL_GC_NAME) patch.generalContractorName = RESIDENTIAL_GC_NAME;
    if (Object.keys(patch).length > 0) await ctx.db.patch(projectId, patch);
    await attachProjectToDemo(ctx, projectId, demoIds);
  } else {
    projectId = await ctx.db.insert("projects", {
      title: RESIDENTIAL_REFERENCE_TITLE,
      location: "El Cerrito, CA",
      projectType: "Residential kitchen remodel",
      projectKind: "residential",
      estBudget: 86_500,
      targetCompletionWeeks: 8,
      specDocumentText: `RESIDENTIAL REMODEL SCOPE
Owner-occupied single-family kitchen: remove and replace cabinetry, countertops and backsplash,
relocate the range circuit, add two under-cabinet circuits, replace the sink and dishwasher,
patch and repaint the affected walls, and protect the occupied dwelling for the duration.
Work is performed in an occupied home: daily cleanup and dust control are part of the scope.`,
      isDemoProject: false,
      generalContractorName: RESIDENTIAL_GC_NAME,
      gcCompanyId: demoIds.gc,
      ownerName: "Dana Lopez",
      address: {
        line1: "1420 Elm Street",
        line2: "",
        city: "El Cerrito",
        state: "CA",
        zip: "94530",
      },
      state: "CA",
      contractValueCents: 8_650_000,
      retainageBps: 1_000,
      billingDay: 15,
      startDate: "2026-09-21",
      substantialCompletionDate: "2026-11-20",
      status: "active",
      createdAt: Date.now(),
    });
    created = true;
    await attachProjectToDemo(ctx, projectId, demoIds);
  }

  const prime = await ensurePrimeLines(ctx, projectId);
  // The Ortiz bidder is linked to the Demo sub company, so the project membership is added by a
  // second attach after the subcontract rows exist.
  const ortiz = await ensureOrtizSubcontract(ctx, projectId, demoIds);
  await attachProjectToDemo(ctx, projectId, demoIds);

  const project = await ctx.db.get(projectId);
  return {
    projectId,
    created,
    title: project?.title ?? null,
    projectKind: projectKindOf(project),
    generalContractorName: project?.generalContractorName ?? null,
    contractValueCents: project?.contractValueCents ?? null,
    retainageBps: project?.retainageBps ?? null,
    billingDay: project?.billingDay ?? null,
    primeLineCount: prime.count,
    primeLinesCents: prime.cents,
    primeLinesWritten: prime.changed,
    ortiz,
  };
}

/** CLI / scheduler entry point. The demo seed calls the same rows function directly. */
export const ensureResidentialReference = internalMutation({
  args: {},
  handler: async (ctx) => await ensureResidentialReferenceRows(ctx),
});

/**
 * Read-only proof of the residential reference state for operators and validators:
 *   npx convex run demoResidential:residentialReferenceState
 * The payee is reported by env var name plus the stored sandbox address; no value is invented.
 */
export const residentialReferenceState = internalQuery({
  args: {},
  handler: async (ctx) => {
    const demoGcId = await findDemoGcCompanyId(ctx);
    if (demoGcId === null) return { found: false as const };
    const owned = await ctx.db
      .query("projects")
      .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", demoGcId))
      .take(2000);
    const project = owned.find((p) => p.title === RESIDENTIAL_REFERENCE_TITLE);
    if (project === undefined) return { found: false as const };

    // The recipient the owner-billing and change-order paths will use (VAL-RES-011). On this
    // residential reference job it must be the reserved guest-checkout alias, not the sandbox
    // Owner login the demo seed stores as the Demo Owner's billing email.
    const ownerInvoice = await invoiceRecipientForProject(ctx, project._id);
    // The commercial demo path must keep resolving to the same alias: its project uses
    // `isDemoProject`, while the residential job is opted in by `projectKind`.
    const commercialDemo = owned.find((p) => p.isDemoProject === true) ?? null;
    const commercialInvoice = commercialDemo === null ? null : await invoiceRecipientForProject(ctx, commercialDemo._id);

    const primeLines = await ctx.db
      .query("primeLines")
      .withIndex("by_projectId_and_lineNo", (q) => q.eq("projectId", project._id))
      .take(50);
    const packages = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(200);
    const tradePackage = packages.find((p) => p.tradeName.trim().toLowerCase() === "plumbing") ?? null;
    const contractors =
      tradePackage === null
        ? []
        : await ctx.db
            .query("contractors")
            .withIndex("by_package", (q) => q.eq("tradePackageId", tradePackage._id))
            .take(500);
    const contractor = contractors.find((c) => c.companyName.trim().toLowerCase() === ORTIZ_COMPANY_NAME.toLowerCase()) ?? null;
    const bids =
      tradePackage === null || contractor === null
        ? []
        : await ctx.db
            .query("bids")
            .withIndex("by_package_and_contractor", (q) =>
              q.eq("tradePackageId", tradePackage._id).eq("contractorId", contractor._id),
            )
            .take(10);
    const agreements = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(200);
    const agreement = agreements.find((a) => a.subcontractorName === ORTIZ_COMPANY_NAME) ?? null;
    const sovLines =
      agreement === null
        ? []
        : await ctx.db
            .query("scheduleOfValues")
            .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id))
            .take(1000);
    const milestones =
      agreement === null
        ? []
        : await ctx.db
            .query("milestones")
            .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
            .take(100);
    const companies = await ctx.db
      .query("companies")
      .withIndex("by_isDemo", (q) => q.eq("isDemo", true))
      .take(100);
    const ortizCompany = companies.find((c) => c.demoKey === "sub:ortiz") ?? null;
    const accountUsers = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", RESIDENTIAL_SUB_EMAIL))
      .take(5);
    const account = accountUsers[0] ?? null;
    const profile =
      account === null
        ? null
        : await ctx.db
            .query("userProfiles")
            .withIndex("by_userId", (q) => q.eq("userId", account._id))
            .unique();

    // The owner sheet is the same composition the owner billing screens use, so its scheduled
    // total is proof that the prime lines and the Ortiz trade line do not double-count.
    const sheet = await buildOwnerSheet(ctx, project, { periodEnd: "9999-12-31", previous: null });

    return {
      found: true as const,
      project: {
        projectId: project._id,
        title: project.title,
        projectKind: projectKindOf(project),
        generalContractorName: project.generalContractorName ?? null,
        ownerName: project.ownerName ?? null,
        contractValueCents: project.contractValueCents ?? null,
        retainageBps: project.retainageBps ?? null,
        billingDay: project.billingDay ?? null,
        isDemoProject: project.isDemoProject,
        readOnlyReference: project.readOnlyReference === true,
      },
      ownerInvoice: ownerInvoice.ok
        ? {
            enabled: true as const,
            recipientEmail: ownerInvoice.email,
            guestCheckoutAlias: ownerInvoice.email === demoInvoiceEmailFor(project._id),
            ownerCompanyName: ownerInvoice.ownerCompanyName,
          }
        : {
            enabled: false as const,
            recipientEmail: null,
            guestCheckoutAlias: false,
            reason: ownerInvoice.reason,
          },
      commercialDemoInvoice:
        commercialDemo === null || commercialInvoice === null
          ? null
          : commercialInvoice.ok
            ? {
                projectTitle: commercialDemo.title,
                recipientEmail: commercialInvoice.email,
                guestCheckoutAlias: commercialInvoice.email === demoInvoiceEmailFor(commercialDemo._id),
              }
            : {
                projectTitle: commercialDemo.title,
                recipientEmail: null,
                guestCheckoutAlias: false,
                reason: commercialInvoice.reason,
              },
      primeLines: primeLines.map((line) => ({
        lineNo: line.lineNo,
        description: line.description,
        scheduledValueCents: line.scheduledValueCents,
      })),
      primeLinesCents: primeLines.reduce((sum, line) => sum + line.scheduledValueCents, 0),
      ownerSheet: {
        lineCount: sheet.lines.length,
        scheduledValueCents: sheet.lines.reduce((sum, line) => sum + line.scheduledValueCents, 0),
        gcLineCount: sheet.lines.filter((line) => line.kind === "gc").length,
        tradeLineCount: sheet.lines.filter((line) => line.kind === "trade").length,
      },
      ortiz:
        tradePackage === null || contractor === null || agreement === null
          ? null
          : {
              company:
                ortizCompany === null
                  ? null
                  : {
                      companyId: ortizCompany._id,
                      name: ortizCompany.name,
                      demoKey: ortizCompany.demoKey ?? null,
                      kind: ortizCompany.kind,
                      isDemo: ortizCompany.isDemo,
                      payoutPaypalEmail: ortizCompany.payoutPaypalEmail ?? null,
                      payoutEmailSourceEnv: ortizCompany.payoutEmailSourceEnv ?? null,
                    },
              contractor: {
                contractorId: contractor._id,
                companyName: contractor.companyName,
                linkedCompanyId: contractor.linkedCompanyId ?? null,
                contactEmail: contractor.contactEmail,
              },
              tradePackage: {
                tradePackageId: tradePackage._id,
                csiDivision: tradePackage.csiDivision,
                tradeName: tradePackage.tradeName,
                status: tradePackage.status,
              },
              bid: {
                bidId: bids[0]?._id ?? null,
                subcontractorName: bids[0]?.subcontractorName ?? null,
                isAwarded: bids[0]?.isAwarded ?? false,
                baseAmountCents: bids[0]?.baseAmountCents ?? null,
                lineItems: (bids[0]?.lineItems ?? []).map((line) => ({ item: line.item, totalCostCents: line.totalCostCents })),
              },
              agreement: {
                agreementId: agreement._id,
                agreementNumber: agreement.agreementNumber,
                status: agreement.status,
                contractSumCents: agreement.contractSumCents ?? null,
                retainageBps: agreement.terms?.retainageBps ?? null,
                lienWaiverGateEnabled: agreement.lienWaiverGate?.enabled === true,
                requirePriorUnconditional: agreement.lienWaiverGate?.requirePriorUnconditional ?? null,
                sovStatus: agreement.sov?.status ?? null,
                executedAt: agreement.executedAt ?? null,
              },
              sovLines: sovLines
                .sort((a, b) => a.lineNo - b.lineNo)
                .map((line) => ({ lineNo: line.lineNo, description: line.description, scheduledValueCents: line.scheduledValueCents })),
              milestones: milestones
                .sort((a, b) => a.order - b.order)
                .map((m) => ({ order: m.order, name: m.name, amountCents: m.amountCents, status: m.status })),
              account: {
                email: RESIDENTIAL_SUB_EMAIL,
                exists: account !== null,
                userId: account?._id ?? null,
                contractorId: profile?.contractorId ?? null,
                companyId: profile?.companyId ?? null,
                role: profile?.role ?? null,
              },
            },
    };
  },
});
