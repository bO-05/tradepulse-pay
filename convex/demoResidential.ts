import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { attachProjectToDemo, ensureDemoCompanies } from "./lib/demoTenancy";
import { projectKindOf } from "./lib/projectKind";

/**
 * The residential reference job.
 *
 * The R7 audit's largest usefulness gap was that the residential positioning lived in copy
 * only: the seeded walkthrough is a commercial tower with no prime contract value, so
 * "New owner pay app" stayed disabled and nothing on screen read as a homeowner job. This
 * adds a second, ordinary project to the Demo company with a prime value, a 10% retainage
 * hold and a monthly billing day, so a homeowner draw can be created end to end.
 *
 * Additive and idempotent. It never patches the commercial walkthrough, and it does not set
 * `isDemoProject` because the demo reset and the demo-project lookup both key off that flag.
 */
export const RESIDENTIAL_REFERENCE_TITLE = "Lopez Kitchen Remodel";

const PRIME_LINES = [
  { lineNo: 1, description: "Demolition, rough-in and permits", scheduledValueCents: 2_160_000 },
  { lineNo: 2, description: "Cabinetry, countertops and backsplash", scheduledValueCents: 3_460_000 },
  { lineNo: 3, description: "Electrical, plumbing and appliance set", scheduledValueCents: 1_730_000 },
  { lineNo: 4, description: "Paint, punch list and closeout", scheduledValueCents: 1_300_000 },
] as const;

export type ResidentialReferenceSummary = {
  projectId: Id<"projects">;
  created: boolean;
  title: string | null;
  projectKind: "residential" | "commercial";
  contractValueCents: number | null;
  retainageBps: number | null;
  primeLineCount: number;
  primeLinesCents: number;
};

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
    // A re-seed keeps the job residential even if an older database was created before the field
    // existed. Only this reference row is patched; its money rows are never rewritten.
    if (existing.projectKind !== "residential") await ctx.db.patch(projectId, { projectKind: "residential" });
    await attachProjectToDemo(ctx, projectId, demoIds);
  } else {
    const company = await ctx.db.get(demoIds.gc);
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
      generalContractorName: company?.name ?? "TradePulse Demo GC",
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
    // The prime schedule of values, so the homeowner draw opens with real lines instead of an
    // empty G702. The four lines sum to the $86,500 prime value.
    const now = Date.now();
    for (const line of PRIME_LINES) {
      await ctx.db.insert("primeLines", { projectId, ...line, createdAt: now });
    }
  }

  const lines = await ctx.db
    .query("primeLines")
    .withIndex("by_projectId_and_lineNo", (q) => q.eq("projectId", projectId))
    .collect();
  const project = await ctx.db.get(projectId);
  return {
    projectId,
    created,
    title: project?.title ?? null,
    projectKind: projectKindOf(project),
    contractValueCents: project?.contractValueCents ?? null,
    retainageBps: project?.retainageBps ?? null,
    primeLineCount: lines.length,
    primeLinesCents: lines.reduce((sum, line) => sum + line.scheduledValueCents, 0),
  };
}

/** CLI / scheduler entry point. The demo seed calls the same rows function directly. */
export const ensureResidentialReference = internalMutation({
  args: {},
  handler: async (ctx) => await ensureResidentialReferenceRows(ctx),
});
