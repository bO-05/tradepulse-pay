import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { findDemoContractorId } from "../demoAccounts";
import { syncAgentProfilesForEmail } from "./agentAccess";
import { findDemoGcCompanyId } from "./demoTenancy";

/**
 * A demo reseed deletes and recreates contractors and agreements, so active billing-agent links would
 * point at ids that no longer exist and the agent would lose access. Take a snapshot before the reseed
 * (while the old contractor names are still readable) and remap afterwards by contractor name.
 * Links are never deleted here; one whose contractor has no match stays as it was.
 */

export type AgentLinkSnapshot = { linkId: Id<"agentLinks">; contractorName: string | null }[];

/** Only the Demo GC company's links are snapshotted; other companies' links are never remapped. */
export async function snapshotActiveAgentLinks(ctx: MutationCtx): Promise<AgentLinkSnapshot> {
  const demoGcId = await findDemoGcCompanyId(ctx);
  if (demoGcId === null) return [];
  const links = await ctx.db
    .query("agentLinks")
    .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", demoGcId))
    .take(500);
  const snapshot: AgentLinkSnapshot = [];
  for (const link of links) {
    if (link.status !== "active") continue;
    const contractor = await ctx.db.get(link.contractorId);
    snapshot.push({ linkId: link._id, contractorName: contractor?.companyName ?? null });
  }
  return snapshot;
}

export async function remapAgentLinks(
  ctx: MutationCtx,
  snapshot: AgentLinkSnapshot,
): Promise<{ remapped: number; agreementCleared: number; unmatched: number }> {
  let remapped = 0;
  let agreementCleared = 0;
  let unmatched = 0;
  for (const snap of snapshot) {
    const link = await ctx.db.get(snap.linkId);
    if (link === null || link.status !== "active") continue;
    const contractorExists = (await ctx.db.get(link.contractorId)) !== null;
    let contractorId = link.contractorId;
    if (!contractorExists) {
      const match = snap.contractorName ? await findDemoContractorId(ctx, snap.contractorName) : undefined;
      if (match === undefined) {
        unmatched++;
        continue;
      }
      contractorId = match;
    }
    const agreementGone = link.agreementId !== undefined && (await ctx.db.get(link.agreementId)) === null;
    if (contractorId === link.contractorId && !agreementGone) continue;
    await ctx.db.patch(link._id, {
      contractorId,
      ...(snap.contractorName ? { contractorName: snap.contractorName } : {}),
      ...(agreementGone ? { agreementId: undefined } : {}),
    });
    if (contractorId !== link.contractorId) remapped++;
    if (agreementGone) agreementCleared++;
    await syncAgentProfilesForEmail(ctx, link.agentEmail);
  }
  return { remapped, agreementCleared, unmatched };
}
