/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { buildTenancyFixture } from "./tenancyFixtures";
import { attributeDemoPlugs } from "./demoPlugs";
import { approveDemoSovs, DEMO_SOV_APPROVER } from "./demoBilling";

const modules = import.meta.glob("/convex/**/*.ts");

describe("Demo seed exclusions stay the bidder's", () => {
  test("seed-attributed rows tagged gc are re-tagged bidder and listed in bids.exclusions; real GC plugs and other companies are untouched", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const actor = { userId: f.demo.gc.userId, name: "Demo GC" };
    const receivedAt = await t.run(async (ctx) => (await ctx.db.get(f.demo.project.bidId))!.receivedAt!);
    const seeded = {
      description: "Fire alarm monitoring",
      costImpactCents: 1_500_000,
      severity: "major",
      source: "gc" as const,
      plugEnteredByUserId: f.demo.gc.userId,
      plugEnteredByName: "Demo GC",
      plugEnteredAt: receivedAt,
    };
    const gcEntered = { ...seeded, description: "Temporary power", plugEnteredAt: receivedAt + 60_000 };
    await t.run(async (ctx) => {
      await ctx.db.patch(f.demo.project.bidId, { identifiedExclusions: [seeded, gcEntered], exclusions: undefined });
      await ctx.db.patch(f.gcA.project.bidId, { identifiedExclusions: [seeded], exclusions: undefined });
    });

    expect(await t.run((ctx) => attributeDemoPlugs(ctx, f.demo.companyIds.gc, actor))).toBe(1);
    expect(await t.run((ctx) => attributeDemoPlugs(ctx, f.demo.companyIds.gc, actor))).toBe(0);
    expect(await t.run((ctx) => attributeDemoPlugs(ctx, f.gcA.companyId, actor))).toBe(0);

    const demoBid = (await t.run(async (ctx) => await ctx.db.get(f.demo.project.bidId)))!;
    expect(demoBid.identifiedExclusions[0]).toMatchObject({ source: "bidder", plugEnteredAt: receivedAt, costImpactCents: 1_500_000 });
    expect(demoBid.identifiedExclusions[1]).toMatchObject({ source: "gc", description: "Temporary power" });
    expect(demoBid.exclusions).toEqual(["Fire alarm monitoring"]);
    const realBid = (await t.run(async (ctx) => await ctx.db.get(f.gcA.project.bidId)))!;
    expect(realBid.identifiedExclusions[0].source).toBe("gc");
    expect(realBid.exclusions).toBeUndefined();
  });
});

describe("Demo seed SOVs", () => {
  test("executed Demo agreements get an approved SOV linked to their milestones; real companies are untouched", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    await t.run(async (ctx) => {
      for (const id of [f.demo.project.agreementId, f.gcA.project.agreementId]) await ctx.db.patch(id, { sov: { status: "draft" } });
    });
    expect(await t.run((ctx) => approveDemoSovs(ctx, f.demo.companyIds.gc, f.demo.gc.userId))).toBe(1);
    expect(await t.run((ctx) => approveDemoSovs(ctx, f.demo.companyIds.gc, f.demo.gc.userId))).toBe(0);
    expect(await t.run((ctx) => approveDemoSovs(ctx, f.gcA.companyId, f.gcA.admin.userId))).toBe(0);

    const state = await t.run(async (ctx) => {
      const demo = (await ctx.db.get(f.demo.project.agreementId))!;
      const real = (await ctx.db.get(f.gcA.project.agreementId))!;
      const lines = await ctx.db
        .query("scheduleOfValues")
        .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", demo._id))
        .collect();
      const milestones = await ctx.db
        .query("milestones")
        .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", demo._id))
        .collect();
      return { demo, real, lines, milestones };
    });
    expect(state.demo.sov).toMatchObject({ status: "approved", approvedByName: DEMO_SOV_APPROVER });
    expect(state.real.sov?.status).toBe("draft");
    expect(state.lines.reduce((s, l) => s + l.scheduledValueCents, 0)).toBe(4_000_000);
    expect(state.milestones.length).toBeGreaterThan(0);
    const lineIds = new Set(state.lines.map((l) => l._id));
    for (const m of state.milestones) {
      expect(m.sovLineIds.length).toBeGreaterThan(0);
      expect(m.sovLineIds.every((id) => lineIds.has(id))).toBe(true);
    }
  });
});
