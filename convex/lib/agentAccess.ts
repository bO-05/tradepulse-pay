import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const AGENTID_PROVIDER_ID = "agentid";

/** id_token claims AgentID issues with the owner scopes. Ungranted claims are omitted. */
export type AgentIdClaims = {
  sub: string;
  email?: string | null;
  email_verified?: boolean | null;
  name?: string | null;
  preferred_username?: string | null;
  owner_sub?: string | null;
  owner_name?: string | null;
  owner_email?: string | null;
  owner_email_verified?: boolean | null;
  actor_type?: string | null;
};

export type AgentIdUserFields = {
  id: string;
  email?: string;
  name?: string;
  actorType: "agent";
  agentSub: string;
  ownerSub?: string;
  ownerName?: string;
  ownerEmail?: string;
};

function present(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function normalizeAgentEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Maps AgentID id_token claims onto `users` fields. Convex Auth spreads every
 * field except `id` into the users doc, and the schema only allows optional
 * strings, so absent or null claims are left out rather than stored as null.
 */
export function agentIdProfile(claims: AgentIdClaims): AgentIdUserFields {
  const fields: AgentIdUserFields = { id: claims.sub, actorType: "agent", agentSub: claims.sub };
  const email = present(claims.email);
  if (email !== undefined) fields.email = normalizeAgentEmail(email);
  const name = present(claims.name) ?? present(claims.preferred_username);
  if (name !== undefined) fields.name = name;
  const ownerSub = present(claims.owner_sub);
  if (ownerSub !== undefined) fields.ownerSub = ownerSub;
  const ownerName = present(claims.owner_name);
  if (ownerName !== undefined) fields.ownerName = ownerName;
  const ownerEmail = present(claims.owner_email);
  if (ownerEmail !== undefined) fields.ownerEmail = normalizeAgentEmail(ownerEmail);
  return fields;
}

/**
 * The active GC link for a signed-in AgentID agent, or null. The email only
 * counts when the user signed in through the AgentID provider, so the address
 * comes from AgentID's signed id_token and not from any other account type.
 */
export async function findActiveAgentLink(
  ctx: QueryCtx,
  user: Doc<"users">,
  opts: { duringAgentIdSignIn?: boolean } = {},
): Promise<Doc<"agentLinks"> | null> {
  if (user.actorType !== "agent" || !user.email) return null;
  // On a first sign-in Convex Auth runs the user callback before it inserts the
  // authAccounts row, so the provider is taken from the sign-in itself there.
  if (!opts.duringAgentIdSignIn) {
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id).eq("provider", AGENTID_PROVIDER_ID))
      .first();
    if (account === null) return null;
  }
  const email = normalizeAgentEmail(user.email);
  return await ctx.db
    .query("agentLinks")
    .withIndex("by_agentEmail_and_status", (q) => q.eq("agentEmail", email).eq("status", "active"))
    .first();
}

/**
 * Makes the agent's userProfiles row match its current link: a sub profile for
 * the linked contractor while a link is active, no profile otherwise. Access is
 * still decided per request from the link itself (see getViewer); this row
 * carries the agent and owner attribution.
 */
export async function syncAgentProfile(
  ctx: MutationCtx,
  userId: Id<"users">,
  opts: { duringAgentIdSignIn?: boolean } = {},
): Promise<"linked" | "unlinked"> {
  const user = await ctx.db.get(userId);
  if (user === null || user.actorType !== "agent") return "unlinked";
  const link = await findActiveAgentLink(ctx, user, opts);
  const existing = await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (link === null) {
    if (existing !== null) await ctx.db.delete(existing._id);
    return "unlinked";
  }
  const fields = {
    userId,
    role: "sub" as const,
    displayName: user.name ?? user.email ?? "Billing agent",
    contractorId: link.contractorId,
    actorType: "agent" as const,
    agentEmail: link.agentEmail,
    ownerEmail: user.ownerEmail,
    ownerName: user.ownerName,
  };
  if (existing !== null) {
    await ctx.db.replace(existing._id, { ...fields, createdAt: existing.createdAt });
  } else {
    await ctx.db.insert("userProfiles", { ...fields, createdAt: Date.now() });
  }
  return "linked";
}

/** Re-syncs every agent user whose email matches `agentEmail` (normally one). */
export async function syncAgentProfilesForEmail(ctx: MutationCtx, agentEmail: string): Promise<void> {
  const users = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", normalizeAgentEmail(agentEmail)))
    .take(10);
  for (const user of users) {
    if (user.actorType === "agent") await syncAgentProfile(ctx, user._id);
  }
}
