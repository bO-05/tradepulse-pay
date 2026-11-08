/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { signInAs } from "./lib/testIdentity";

const modules = import.meta.glob("/convex/**/*.ts");

describe("residential reference job", () => {
  test("the demo seed creates the job, so a fresh database is not missing it", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });

    const found = await t.run(async (ctx) => {
      const projects = await ctx.db.query("projects").collect();
      const project = projects.find((p) => p.title === "Lopez Kitchen Remodel");
      if (project === undefined) return null;
      const lines = await ctx.db
        .query("primeLines")
        .withIndex("by_projectId_and_lineNo", (q) => q.eq("projectId", project._id))
        .collect();
      return {
        contractValueCents: project.contractValueCents ?? null,
        retainageBps: project.retainageBps ?? null,
        lineCount: lines.length,
        linesCents: lines.reduce((sum, l) => sum + l.scheduledValueCents, 0),
      };
    });
    expect(found).toEqual({
      contractValueCents: 8_650_000,
      retainageBps: 1_000,
      lineCount: 4,
      // Prime lines are $77,500; the Ortiz trade line is the remaining $9,000 of the $86,500.
      linesCents: 7_750_000,
    });
  });

  test("seeds Lopez as residential and a re-seed keeps the kind", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });

    const first = await t.mutation(internal.demoResidential.ensureResidentialReference, {});
    expect(first.title).toBe("Lopez Kitchen Remodel");
    expect(first.projectKind).toBe("residential");
    expect(first.created).toBe(false);

    const seeded = await t.run(async (ctx) => (await ctx.db.get(first.projectId))?.projectKind);
    expect(seeded).toBe("residential");

    // A database that predates the field (or was mis-marked) is repaired by the re-seed, and the
    // money rows are not rewritten.
    await t.run(async (ctx) => {
      await ctx.db.patch(first.projectId, { projectKind: "commercial" });
    });
    const second = await t.mutation(internal.demoResidential.ensureResidentialReference, {});
    expect(second.projectId).toBe(first.projectId);
    expect(second.created).toBe(false);
    expect(second.projectKind).toBe("residential");
    expect(second.primeLineCount).toBe(first.primeLineCount);
    expect(second.primeLinesCents).toBe(first.primeLinesCents);

    const stored = await t.run(async (ctx) => (await ctx.db.get(first.projectId))?.projectKind);
    expect(stored).toBe("residential");
  });

  test("creates one prime-valued residential project that the GC and the owner can bill", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });

    const first = await t.mutation(internal.demoResidential.ensureResidentialReference, {});
    const second = await t.mutation(internal.demoResidential.ensureResidentialReference, {});
    // The demo seed run above already creates the job, so the explicit call is a no-op.
    expect(first.created).toBe(false);
    expect(second.created).toBe(false);
    expect(second.projectId).toBe(first.projectId);
    expect(first.contractValueCents).toBe(8_650_000);
    expect(first.retainageBps).toBe(1_000);
    expect(first.primeLineCount).toBe(4);
    expect(first.primeLinesCents).toBe(7_750_000);
    expect(second.primeLinesCents).toBe(7_750_000);

    const project = await t.run(async (ctx) => {
      const doc = await ctx.db.get(first.projectId as Id<"projects">);
      if (doc === null) return null;
      return {
        title: doc.title,
        projectType: doc.projectType,
        contractValueCents: doc.contractValueCents ?? null,
        retainageBps: doc.retainageBps ?? null,
        billingDay: doc.billingDay ?? null,
        isDemoProject: doc.isDemoProject,
      };
    });
    expect(project?.title).toBe("Lopez Kitchen Remodel");
    expect(project?.projectType).toBe("Residential kitchen remodel");
    expect(project?.contractValueCents).toBe(8_650_000);
    expect(project?.retainageBps).toBe(1_000);
    expect(project?.billingDay).toBe(15);
    // The demo reset and the demo-project lookup both key off this flag; the residential job must
    // not look like the walkthrough project.
    expect(project?.isDemoProject).toBe(false);

    const gc = (await signInAs(t, "gc", { email: "residential-gc@test.tradepulse" })).as;
    const owner = (await signInAs(t, "owner", { email: "residential-owner@test.tradepulse" })).as;

    const forGc = await gc.query(api.projects.listProjects, {});
    const forOwner = await owner.query(api.projects.listProjects, {});
    expect(forGc.some((p) => p._id === first.projectId)).toBe(true);
    expect(forOwner.some((p) => p._id === first.projectId)).toBe(true);

    const billing = await gc.query(api.billing.ownerPayApps.listOwnerPayApps, { projectId: first.projectId });
    const create = billing.create as { allowed: boolean; reason: string | null };
    expect(create.allowed).toBe(true);
    expect(create.reason).toBeNull();
    expect(billing.projectTitle).toBe("Lopez Kitchen Remodel");

    const primeLines = await t.run(async (ctx) =>
      await ctx.db
        .query("primeLines")
        .withIndex("by_projectId_and_lineNo", (q) => q.eq("projectId", first.projectId as Id<"projects">))
        .collect(),
    );
    expect(primeLines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4]);
    expect(primeLines.reduce((sum, l) => sum + l.scheduledValueCents, 0)).toBe(7_750_000);
    // Line 3 no longer includes the plumbing scope Ortiz bills separately.
    expect(primeLines.find((l) => l.lineNo === 3)).toMatchObject({
      description: "Electrical and appliance set",
      scheduledValueCents: 830_000,
    });

    const opened = await gc.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: first.projectId });
    const app = await t.run(async (ctx) => await ctx.db.get(opened.ownerPayAppId));
    // Four GC lines + the Ortiz trade line; the scheduled values still total the prime contract.
    expect(app?.lines).toHaveLength(5);
    expect(app?.retainageBps).toBe(1_000);
    expect(app?.lines.reduce((sum, l) => sum + l.scheduledValueCents, 0)).toBe(8_650_000);
    expect(app?.lines.find((l) => l.kind === "trade")).toMatchObject({
      kind: "trade",
      scheduledValueCents: 900_000,
    });
  });
});
