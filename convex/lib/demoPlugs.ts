import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Demo leveling plugs are seeded data, so they get the same "Entered by <GC>" attribution a real
 * GC plug carries, credited to the Demo GC user, while the seeded exclusion rows themselves stay the
 * bidder's (tagged `source: "bidder"` and listed in `bids.exclusions`). Only plugs without
 * attribution and rows without a source are touched, so the backfill is idempotent and never
 * overwrites a plug or row a Demo user entered.
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

/**
 * Seeded proposal exclusions are the bidder's own (`source: "bidder"`); only their leveling plug
 * amount is credited to the Demo GC. Rows that already carry a source keep it.
 */
export function attributeDemoExclusions<E extends Exclusion>(exclusions: E[], actor: DemoPlugActor, at: number): { next: E[]; changed: boolean } {
  let changed = false;
  const next = exclusions.map((e) => {
    let row = e;
    if (row.source === undefined) {
      changed = true;
      row = { ...row, source: "bidder" as const };
    }
    const amount = typeof row.costImpactCents === "number" ? row.costImpactCents : 0;
    if (amount <= 0 || row.plugEnteredAt !== undefined) return row;
    changed = true;
    return { ...row, plugEnteredByUserId: actor.userId, plugEnteredByName: actor.name, plugEnteredAt: at };
  });
  return { next, changed };
}

/**
 * Seed attribution is stamped with the bid's own received time, which no real leveling write uses
 * (those stamp the time of the GC's edit). Earlier seeds wrote that synthetic attribution without a
 * source, so the ownership backfill read those proposal rows as GC-owned; they are the bidder's.
 */
function hasSeedAttribution(bid: Doc<"bids">, e: Exclusion, actor: DemoPlugActor): boolean {
  return e.plugEnteredByUserId === actor.userId && e.plugEnteredAt === (bid.receivedAt ?? bid._creationTime);
}

const sameScope = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function attributed(bid: Doc<"bids">, actor: DemoPlugActor): Pick<Doc<"bids">, "identifiedExclusions" | "exclusions"> | null {
  const retagged = bid.identifiedExclusions.map((e) =>
    e.source === "gc" && hasSeedAttribution(bid, e, actor) ? { ...e, source: "bidder" as const } : e,
  );
  let changed = retagged.some((e, i) => e !== bid.identifiedExclusions[i]);
  const result = attributeDemoExclusions(retagged, actor, bid.receivedAt ?? bid._creationTime);
  changed = changed || result.changed;
  const list = [...(bid.exclusions ?? [])];
  for (const e of result.next) {
    if (e.source === "bidder" && !list.some((d) => sameScope(d, e.description))) list.push(e.description.trim());
  }
  const listChanged = list.length !== (bid.exclusions?.length ?? 0);
  if (!changed && !listChanged) return null;
  return { identifiedExclusions: result.next, exclusions: list };
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
      await ctx.db.patch(bid._id, next);
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
