import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Demo leveling plugs are seeded data, so they get the same "Entered by <GC>" attribution a real
 * GC plug carries, credited to the Demo GC user. Only plugs without attribution are touched, so the
 * backfill is idempotent and never overwrites a plug a Demo user entered.
 */

export type DemoPlugActor = { userId: Id<"users">; name: string };

export async function demoGcPlugActor(ctx: MutationCtx, userId: Id<"users"> | null): Promise<DemoPlugActor | null> {
  if (userId === null) return null;
  const user = await ctx.db.get(userId);
  if (user === null) return null;
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  const name = user.name?.trim() || profile?.displayName?.trim() || user.email || "Demo GC";
  return { userId, name };
}

export const DEMO_GC_EMAIL = "gc@demo.tradepulse";

export async function findDemoGcPlugActor(ctx: MutationCtx): Promise<DemoPlugActor | null> {
  const user = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", DEMO_GC_EMAIL))
    .first();
  return await demoGcPlugActor(ctx, user?._id ?? null);
}

type Exclusion = Doc<"bids">["identifiedExclusions"][number];

export function attributeDemoExclusions<E extends Exclusion>(exclusions: E[], actor: DemoPlugActor, at: number): { next: E[]; changed: boolean } {
  let changed = false;
  const next = exclusions.map((e) => {
    const amount = typeof e.costImpactCents === "number" ? e.costImpactCents : 0;
    if (amount <= 0 || e.plugEnteredAt !== undefined) return e;
    changed = true;
    return { ...e, plugEnteredByUserId: actor.userId, plugEnteredByName: actor.name, plugEnteredAt: at };
  });
  return { next, changed };
}

function attributed(bid: Doc<"bids">, actor: DemoPlugActor): Doc<"bids">["identifiedExclusions"] | null {
  const { next, changed } = attributeDemoExclusions(bid.identifiedExclusions, actor, bid.receivedAt ?? bid._creationTime);
  return changed ? next : null;
}

/** Attributes unattributed plugs on one project's bids; the caller guarantees it is a Demo project. */
export async function attributeDemoPlugsForProject(ctx: MutationCtx, projectId: Id<"projects">, actor: DemoPlugActor): Promise<number> {
  let patched = 0;
  const packages = await ctx.db
    .query("tradePackages")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(200);
  for (const pkg of packages) {
    const bids = await ctx.db
      .query("bids")
      .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
      .take(500);
    for (const bid of bids) {
      const next = attributed(bid, actor);
      if (next === null) continue;
      await ctx.db.patch(bid._id, { identifiedExclusions: next });
      patched += 1;
    }
  }
  return patched;
}

/** Backfills every project of the Demo GC company, selected by company id. */
export async function attributeDemoPlugs(ctx: MutationCtx, demoGcCompanyId: Id<"companies">, actor: DemoPlugActor): Promise<number> {
  const company = await ctx.db.get(demoGcCompanyId);
  if (company === null || company.isDemo !== true) return 0;
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", demoGcCompanyId))
    .take(2000);
  let patched = 0;
  for (const p of projects) patched += await attributeDemoPlugsForProject(ctx, p._id, actor);
  return patched;
}
