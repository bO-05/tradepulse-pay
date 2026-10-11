import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isPlaceholderEmail } from "./vendorRules";
import { searchTextPatch } from "./vendorSearch";

/**
 * A GC company keeps one vendor row per sub: per normalized email and per linked company. These
 * helpers fold a duplicate row into the row that stays, repointing everything that stores its id.
 */

export type VendorMergeCounts = {
  vendorsMerged: number;
  contractorsRepointed: number;
  projectMembersRepointed: number;
  invitesRepointed: number;
  notificationsRepointed: number;
};

export function emptyMergeCounts(): VendorMergeCounts {
  return { vendorsMerged: 0, contractorsRepointed: 0, projectMembersRepointed: 0, invitesRepointed: 0, notificationsRepointed: 0 };
}

export function addMergeCounts(into: VendorMergeCounts, from: VendorMergeCounts): void {
  into.vendorsMerged += from.vendorsMerged;
  into.contractorsRepointed += from.contractorsRepointed;
  into.projectMembersRepointed += from.projectMembersRepointed;
  into.invitesRepointed += from.invitesRepointed;
  into.notificationsRepointed += from.notificationsRepointed;
}

type Confirmation = NonNullable<Doc<"vendors">["payoutEmailConfirmed"]>;

/** Prefers the confirmation matching the linked company's current payout email, then the newest. */
function pickConfirmation(rows: Doc<"vendors">[], currentPayoutEmail: string | null): Confirmation | undefined {
  const all = rows.map((r) => r.payoutEmailConfirmed).filter((c): c is Confirmation => c !== undefined);
  const matching = currentPayoutEmail === null ? [] : all.filter((c) => c.email === currentPayoutEmail);
  const pool = matching.length > 0 ? matching : all;
  return pool.sort((a, b) => b.confirmedAt - a.confirmedAt)[0];
}

/**
 * Folds `dup` into `keep` (same GC company) and marks `dup` merged into it: contractors, project members,
 * invites and GC notification links that pointed at `dup` are repointed at `keep` where the bounded
 * scans reach them. Returns the updated `keep`.
 */
export async function mergeVendorInto(
  ctx: MutationCtx,
  keep: Doc<"vendors">,
  dup: Doc<"vendors">,
  counts: VendorMergeCounts = emptyMergeCounts(),
): Promise<Doc<"vendors">> {
  if (keep._id === dup._id) return keep;
  if (keep.companyId !== dup.companyId) throw new Error("mergeVendorInto: vendors belong to different GC companies");
  if (keep.linkedCompanyId !== undefined && dup.linkedCompanyId !== undefined && keep.linkedCompanyId !== dup.linkedCompanyId) {
    throw new Error("mergeVendorInto: vendors are linked to different companies");
  }
  if (keep.status === "merged" || dup.status === "merged") throw new Error("mergeVendorInto: a merged vendor row cannot be merged again");
  const gcCompanyId = keep.companyId;
  const linkedCompanyId = keep.linkedCompanyId ?? dup.linkedCompanyId;
  const linked = linkedCompanyId === undefined ? null : await ctx.db.get(linkedCompanyId);
  const confirmation = pickConfirmation([keep, dup], linked?.payoutPaypalEmail ?? null);

  const patch: Partial<Doc<"vendors">> = {};
  const trades = [...new Set([...keep.trades, ...dup.trades])];
  if (trades.length !== keep.trades.length) patch.trades = trades;
  if (keep.linkedCompanyId === undefined && linkedCompanyId !== undefined) patch.linkedCompanyId = linkedCompanyId;
  if (confirmation !== undefined && confirmation !== keep.payoutEmailConfirmed) patch.payoutEmailConfirmed = confirmation;
  if (keep.status !== "active" && dup.status === "active") patch.status = "active";
  if (keep.contactName.trim() === "" && dup.contactName.trim() !== "") patch.contactName = dup.contactName;
  if (keep.phone === undefined && dup.phone !== undefined) patch.phone = dup.phone;
  if (keep.licenseNumber === undefined && dup.licenseNumber !== undefined) patch.licenseNumber = dup.licenseNumber;
  if (keep.licenseState === undefined && dup.licenseState !== undefined) patch.licenseState = dup.licenseState;
  if (patch.trades !== undefined || patch.contactName !== undefined) Object.assign(patch, searchTextPatch(keep, patch));
  if (Object.keys(patch).length > 0) await ctx.db.patch(keep._id, patch);

  const contractors = await ctx.db
    .query("contractors")
    .withIndex("by_vendorId", (q) => q.eq("vendorId", dup._id))
    .take(1000);
  for (const c of contractors) {
    await ctx.db.patch(c._id, { vendorId: keep._id });
    counts.contractorsRepointed++;
  }

  const projects = await ctx.db
    .query("projects")
    .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", gcCompanyId))
    .take(1000);
  for (const project of projects) {
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
      .take(500);
    for (const m of members) {
      if (m.vendorId !== dup._id) continue;
      await ctx.db.patch(m._id, { vendorId: keep._id });
      counts.projectMembersRepointed++;
    }
  }

  const invites = await ctx.db
    .query("invites")
    .withIndex("by_inviterCompanyId", (q) => q.eq("inviterCompanyId", gcCompanyId))
    .take(2000);
  for (const invite of invites) {
    if (invite.vendorId !== dup._id) continue;
    await ctx.db.patch(invite._id, { vendorId: keep._id });
    counts.invitesRepointed++;
  }

  const oldLink = `#/vendors/${dup._id}`;
  const members = await ctx.db
    .query("companyMembers")
    .withIndex("by_companyId", (q) => q.eq("companyId", gcCompanyId))
    .take(500);
  for (const member of members) {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_companyId_and_createdAt", (q) => q.eq("userId", member.userId).eq("companyId", gcCompanyId))
      .take(1000);
    for (const n of rows) {
      if (n.link !== oldLink) continue;
      await ctx.db.patch(n._id, { link: `#/vendors/${keep._id}` });
      counts.notificationsRepointed++;
    }
  }

  // Kept as a tombstone: references outside the bounded scans above still resolve through liveVendor.
  await ctx.db.patch(dup._id, {
    status: "merged",
    mergedIntoVendorId: keep._id,
    linkedCompanyId: undefined,
    payoutEmailConfirmed: undefined,
    searchText: undefined,
  });
  counts.vendorsMerged++;
  return (await ctx.db.get(keep._id))!;
}

/** Merges two rows for the same sub, keeping the older one. */
export async function mergeVendorPair(
  ctx: MutationCtx,
  a: Doc<"vendors">,
  b: Doc<"vendors">,
  counts?: VendorMergeCounts,
): Promise<Doc<"vendors">> {
  const [keep, dup] = a._creationTime <= b._creationTime ? [a, b] : [b, a];
  return await mergeVendorInto(ctx, keep, dup, counts);
}

export const MERGE_SCAN_LIMIT = 4000;

/**
 * Groups one GC company's live vendor rows into complete duplicate groups (union-find): rows sharing a
 * linked company always join; rows sharing a real email join unless that would put two different
 * linked companies in one group. Groups are returned oldest row first; singletons are omitted.
 */
export function duplicateVendorGroups(rows: readonly Doc<"vendors">[]): Doc<"vendors">[][] {
  const sorted = [...rows].sort((a, b) => a._creationTime - b._creationTime);
  const parent = sorted.map((_, i) => i);
  const linkOf = sorted.map((r) => r.linkedCompanyId);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (linkOf[ra] !== undefined && linkOf[rb] !== undefined && linkOf[ra] !== linkOf[rb]) return;
    const [root, child] = ra < rb ? [ra, rb] : [rb, ra];
    parent[child] = root;
    linkOf[root] = linkOf[root] ?? linkOf[child];
  };
  const bucket = (key: (r: Doc<"vendors">) => string | null) => {
    const firstByKey = new Map<string, number>();
    sorted.forEach((r, i) => {
      const k = key(r);
      if (k === null) return;
      const first = firstByKey.get(k);
      if (first === undefined) firstByKey.set(k, i);
      else union(first, i);
    });
  };
  // Linked-company edges first: they can never conflict, and an email edge is then judged by the full group.
  bucket((r) => r.linkedCompanyId ?? null);
  bucket((r) => {
    const email = r.email.trim().toLowerCase();
    return email === "" || isPlaceholderEmail(email) ? null : email;
  });
  const groups = new Map<number, Doc<"vendors">[]>();
  sorted.forEach((r, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

/**
 * Merges every complete duplicate group of one GC company into its oldest row. Idempotent: merged rows
 * are tombstones that the next run no longer sees. `truncated` reports a directory beyond the scan limit.
 */
export async function mergeDuplicateVendorsForCompany(
  ctx: MutationCtx,
  gcCompanyId: Id<"companies">,
): Promise<VendorMergeCounts & { truncated: boolean }> {
  const counts = emptyMergeCounts();
  const rows = await ctx.db
    .query("vendors")
    .withIndex("by_companyId", (q) => q.eq("companyId", gcCompanyId))
    .take(MERGE_SCAN_LIMIT);
  for (const group of duplicateVendorGroups(rows.filter((r) => r.status !== "merged"))) {
    let keep = group[0];
    for (const dup of group.slice(1)) keep = await mergeVendorInto(ctx, keep, dup, counts);
  }
  return { ...counts, truncated: rows.length === MERGE_SCAN_LIMIT };
}
