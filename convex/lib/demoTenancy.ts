import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Role } from "./roles";
import { findActiveMembership } from "./tenancy";

/**
 * The seeded Demo companies (isDemo: true). Seeds and migrations find them by `demoKey` through
 * the by_isDemo index, never by name, and only ever touch rows that belong to them.
 */
export type DemoCompanyKey = "gc" | "sub:rosendin" | "sub:tdindustries" | "sub:clarke-kent" | "owner";

export const DEMO_COMPANIES: readonly { key: DemoCompanyKey; name: string; kind: Role }[] = [
  { key: "gc", name: "Demo GC (TradePulse Pay demo)", kind: "gc" },
  { key: "sub:rosendin", name: "Rosendin Electric (demo)", kind: "sub" },
  { key: "sub:tdindustries", name: "TDIndustries (demo)", kind: "sub" },
  { key: "sub:clarke-kent", name: "Clarke Kent Plumbing (demo)", kind: "sub" },
  { key: "owner", name: "Demo Owner", kind: "owner" },
];

/** Demo password accounts and the Demo company each one belongs to (see DEMO_ACCOUNTS). */
export const DEMO_ACCOUNT_COMPANY: Readonly<Record<string, DemoCompanyKey>> = {
  "gc@demo.tradepulse": "gc",
  "sub1@demo.tradepulse": "sub:rosendin",
  "sub2@demo.tradepulse": "sub:tdindustries",
  "sub3@demo.tradepulse": "sub:clarke-kent",
  "owner@demo.tradepulse": "owner",
};

export const DEMO_EMAIL_DOMAIN = "@demo.tradepulse";

export type DemoTenancyCounts = {
  companiesCreated: number;
  membersCreated: number;
  usersVerified: number;
  profilesUpdated: number;
  contractorsLinked: number;
  projectsAttached: number;
  projectsArchived: number;
  projectMembersCreated: number;
  agentLinksUpdated: number;
  contractorRefsRepaired: number;
};

export function emptyCounts(): DemoTenancyCounts {
  return {
    companiesCreated: 0,
    membersCreated: 0,
    usersVerified: 0,
    profilesUpdated: 0,
    contractorsLinked: 0,
    projectsAttached: 0,
    projectsArchived: 0,
    projectMembersCreated: 0,
    agentLinksUpdated: 0,
    contractorRefsRepaired: 0,
  };
}

export type DemoCompanyIds = Record<DemoCompanyKey, Id<"companies">>;

export async function ensureDemoCompanies(
  ctx: MutationCtx,
  counts: DemoTenancyCounts = emptyCounts(),
): Promise<DemoCompanyIds> {
  const existing = await ctx.db
    .query("companies")
    .withIndex("by_isDemo", (q) => q.eq("isDemo", true))
    .take(100);
  const ids: Partial<DemoCompanyIds> = {};
  for (const def of DEMO_COMPANIES) {
    const found = existing.find((c) => c.demoKey === def.key);
    if (found) {
      ids[def.key] = found._id;
      continue;
    }
    ids[def.key] = await ctx.db.insert("companies", {
      name: def.name,
      kind: def.kind,
      isDemo: true,
      demoKey: def.key,
      createdAt: Date.now(),
    });
    counts.companiesCreated++;
  }
  return ids as DemoCompanyIds;
}

/** The Demo GC company's id, or null before the Demo companies exist. Read-only. */
export async function findDemoGcCompanyId(ctx: QueryCtx): Promise<Id<"companies"> | null> {
  const demo = await ctx.db
    .query("companies")
    .withIndex("by_isDemo", (q) => q.eq("isDemo", true))
    .take(100);
  return demo.find((c) => c.demoKey === "gc")?._id ?? null;
}

/** Adds an active admin membership unless the user already belongs to a company (one per user). */
async function ensureMembership(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  userId: Id<"users">,
  counts: DemoTenancyCounts,
): Promise<boolean> {
  const active = await findActiveMembership(ctx, userId);
  if (active !== null) return active.companyId === companyId;
  await ctx.db.insert("companyMembers", { companyId, userId, role: "admin", status: "active", createdAt: Date.now() });
  counts.membersCreated++;
  return true;
}

async function ensureProjectMember(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  companyId: Id<"companies">,
  partyRole: Role,
  counts: DemoTenancyCounts,
  contractorId?: Id<"contractors">,
): Promise<void> {
  const rows = await ctx.db
    .query("projectMembers")
    .withIndex("by_project_company", (q) => q.eq("projectId", projectId).eq("companyId", companyId))
    .take(5);
  // A removed row stays removed: re-running the seed must not undo a deliberate removal.
  if (rows.length > 0) return;
  await ctx.db.insert("projectMembers", {
    projectId,
    companyId,
    partyRole,
    contractorId,
    status: "active",
    createdAt: Date.now(),
  });
  counts.projectMembersCreated++;
}

/**
 * Demo accounts: membership in their Demo company, email marked verified, profile.companyId set,
 * and the demo sub's contractor record linked to its company. Accounts that do not exist yet
 * are skipped (demoAccounts:seedDemo creates them and calls this again).
 */
export async function ensureDemoAccounts(
  ctx: MutationCtx,
  ids: DemoCompanyIds,
  counts: DemoTenancyCounts = emptyCounts(),
): Promise<void> {
  for (const [email, key] of Object.entries(DEMO_ACCOUNT_COMPANY)) {
    const users = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .take(5);
    for (const user of users) {
      if (user.actorType === "agent") continue;
      const companyId = ids[key];
      const isMember = await ensureMembership(ctx, companyId, user._id, counts);
      if (user.emailVerificationTime === undefined) {
        await ctx.db.patch(user._id, { emailVerificationTime: Date.now() });
        counts.usersVerified++;
      }
      await markPasswordAccountVerified(ctx, user._id, email);
      if (!isMember) continue;
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .unique();
      if (profile === null) continue;
      if (profile.companyId !== companyId) {
        await ctx.db.patch(profile._id, { companyId });
        counts.profilesUpdated++;
      }
      if (key.startsWith("sub:") && profile.contractorId !== undefined) {
        const contractor = await ctx.db.get(profile.contractorId);
        if (contractor !== null && contractor.linkedCompanyId === undefined) {
          await ctx.db.patch(contractor._id, { linkedCompanyId: companyId });
          counts.contractorsLinked++;
        }
      }
    }
  }
}

function isDemoCompanyId(ids: DemoCompanyIds, id: Id<"companies"> | undefined): boolean {
  return id !== undefined && (Object.values(ids) as Id<"companies">[]).includes(id);
}

/**
 * Attaches a project to the Demo GC company (only when it has no company yet) and gives the
 * Demo owner and the demo sub companies of its bidders/agreements project membership. Projects
 * of other companies are left untouched. Returns whether the project is now in the Demo company.
 */
export async function attachProjectToDemo(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  ids?: DemoCompanyIds,
  counts: DemoTenancyCounts = emptyCounts(),
): Promise<boolean> {
  const companyIds = ids ?? (await ensureDemoCompanies(ctx, counts));
  const project = await ctx.db.get(projectId);
  if (project === null) return false;
  if (project.gcCompanyId === undefined) {
    await ctx.db.patch(projectId, { gcCompanyId: companyIds.gc });
    counts.projectsAttached++;
  } else if (project.gcCompanyId !== companyIds.gc) {
    return false;
  }

  await ensureProjectMember(ctx, projectId, companyIds.owner, "owner", counts);

  const contractorIds = new Set<Id<"contractors">>();
  const agreements = await ctx.db
    .query("agreements")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(500);
  for (const a of agreements) contractorIds.add(a.contractorId);
  const packages = await ctx.db
    .query("tradePackages")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(200);
  for (const pkg of packages) {
    for (const id of pkg.invitedContractorIds ?? []) contractorIds.add(id);
    const bidders = await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
      .take(500);
    for (const c of bidders) contractorIds.add(c._id);
  }
  for (const contractorId of contractorIds) {
    const contractor = await ctx.db.get(contractorId);
    const subCompanyId = contractor?.linkedCompanyId;
    if (subCompanyId === undefined || !isDemoCompanyId(companyIds, subCompanyId)) continue;
    await ensureProjectMember(ctx, projectId, subCompanyId, "sub", counts, contractorId);
  }
  return true;
}

/** Leftover worker/validator fixtures from Phase 1; archived (never deleted) inside the Demo company. */
const JUNK_TITLE_PATTERNS: readonly RegExp[] = [
  /\but-r\d+-/i,
  /\bUTER\d+\b/,
  /^Procurement scenario · (ut-|w-|worker-)/i,
  // A Phase-1 UX walkthrough created this project; the Phase-2 fixture of the same name belongs to a real company.
  /^Harbor Point Dental Office TI$/,
];
export const PAY_APP_REVIEW_SCENARIO_TITLE = "Demo · Pay-app review scenario";

export function isJunkProjectTitle(title: string): boolean {
  return JUNK_TITLE_PATTERNS.some((re) => re.test(title));
}

/**
 * Archives junk projects of the Demo company and every duplicate pay-app review scenario except
 * the oldest. Only projects never archived or restored before (archived undefined) are changed.
 */
export async function archiveDemoJunk(
  ctx: MutationCtx,
  ids: DemoCompanyIds,
  counts: DemoTenancyCounts = emptyCounts(),
): Promise<string[]> {
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", ids.gc))
    .take(2000);
  const reviewScenarios = projects
    .filter((p) => p.title === PAY_APP_REVIEW_SCENARIO_TITLE)
    .sort((a, b) => a._creationTime - b._creationTime);
  const keepReview = reviewScenarios[0]?._id;
  const archived: string[] = [];
  for (const p of projects) {
    if (p.archived !== undefined) continue;
    const duplicateReview = p.title === PAY_APP_REVIEW_SCENARIO_TITLE && p._id !== keepReview;
    if (!duplicateReview && !isJunkProjectTitle(p.title)) continue;
    await ctx.db.patch(p._id, { archived: true });
    counts.projectsArchived++;
    archived.push(p.title);
  }
  return archived;
}

/**
 * A demo reseed deletes and recreates the demo bidders, which leaves agreements of other Demo-company
 * projects (review scenarios, judge demo runs) pointing at contractors that no longer exist. Points
 * them, their bids, pay applications and package invitations at the current contractor of the same
 * demo sub company. Only Demo-company projects and demo-linked contractors are considered.
 */
export async function repairDemoContractorRefs(
  ctx: MutationCtx,
  ids: DemoCompanyIds,
  counts: DemoTenancyCounts = emptyCounts(),
): Promise<void> {
  const replacementByName = new Map<string, Id<"contractors">>();
  for (const key of ["sub:rosendin", "sub:tdindustries", "sub:clarke-kent"] as const) {
    const linked = await ctx.db
      .query("contractors")
      .withIndex("by_linkedCompanyId", (q) => q.eq("linkedCompanyId", ids[key]))
      .take(50);
    for (const c of linked) if (!replacementByName.has(c.companyName)) replacementByName.set(c.companyName, c._id);
  }
  if (replacementByName.size === 0) return;

  const projects = await ctx.db
    .query("projects")
    .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", ids.gc))
    .take(2000);
  const remap = new Map<Id<"contractors">, Id<"contractors">>();
  const missing = async (id: Id<"contractors">) => (await ctx.db.get(id)) === null;

  for (const project of projects) {
    const agreements = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(500);
    for (const a of agreements) {
      const replacement = replacementByName.get(a.subcontractorName);
      if (replacement === undefined || a.contractorId === replacement || !(await missing(a.contractorId))) continue;
      remap.set(a.contractorId, replacement);
      await ctx.db.patch(a._id, { contractorId: replacement });
      counts.contractorRefsRepaired++;
      const bid = await ctx.db.get(a.bidId);
      if (bid !== null && bid.contractorId !== replacement && (await missing(bid.contractorId))) {
        await ctx.db.patch(bid._id, { contractorId: replacement });
        counts.contractorRefsRepaired++;
      }
      const payApps = await ctx.db
        .query("payApplications")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", a._id))
        .take(500);
      for (const pa of payApps) {
        if (pa.contractorId === replacement) continue;
        await ctx.db.patch(pa._id, { contractorId: replacement });
        counts.contractorRefsRepaired++;
      }
    }
  }
  if (remap.size === 0) return;
  for (const project of projects) {
    const packages = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(200);
    for (const pkg of packages) {
      const invited = pkg.invitedContractorIds ?? [];
      if (!invited.some((id) => remap.has(id))) continue;
      await ctx.db.patch(pkg._id, { invitedContractorIds: invited.map((id) => remap.get(id) ?? id) });
      counts.contractorRefsRepaired++;
      const bids = await ctx.db
        .query("bids")
        .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
        .take(200);
      for (const b of bids) {
        const replacement = remap.get(b.contractorId);
        if (replacement === undefined) continue;
        await ctx.db.patch(b._id, { contractorId: replacement });
        counts.contractorRefsRepaired++;
      }
    }
  }
}

/** Existing agent links belong to the Demo GC; their sub company follows the linked contractor. */
async function attachAgentLinks(ctx: MutationCtx, ids: DemoCompanyIds, counts: DemoTenancyCounts): Promise<void> {
  const links = await ctx.db.query("agentLinks").take(1000);
  for (const link of links) {
    const patch: Partial<Doc<"agentLinks">> = {};
    if (link.gcCompanyId === undefined) patch.gcCompanyId = ids.gc;
    if (link.subCompanyId === undefined && (link.gcCompanyId ?? patch.gcCompanyId) === ids.gc) {
      const contractor = await ctx.db.get(link.contractorId);
      if (contractor?.linkedCompanyId !== undefined) patch.subCompanyId = contractor.linkedCompanyId;
    }
    if (Object.keys(patch).length === 0) continue;
    await ctx.db.patch(link._id, patch);
    counts.agentLinksUpdated++;
  }
  const agentProfiles = await ctx.db
    .query("userProfiles")
    .withIndex("by_role", (q) => q.eq("role", "sub"))
    .take(1000);
  for (const profile of agentProfiles) {
    if (profile.actorType !== "agent" || profile.contractorId === undefined || profile.companyId !== undefined) continue;
    const contractor = await ctx.db.get(profile.contractorId);
    if (contractor?.linkedCompanyId === undefined || !isDemoCompanyId(ids, contractor.linkedCompanyId)) continue;
    await ctx.db.patch(profile._id, { companyId: contractor.linkedCompanyId });
    counts.profilesUpdated++;
  }
}

/**
 * Idempotent: creates the Demo companies, attaches every project without a company to the
 * Demo GC, backfills memberships, verifies demo users and archives junk. Deletes nothing; a
 * second run reports all-zero counts.
 */
export async function ensureDemoTenancy(
  ctx: MutationCtx,
): Promise<{ counts: DemoTenancyCounts; archivedTitles: string[]; companyIds: DemoCompanyIds }> {
  const counts = emptyCounts();
  const companyIds = await ensureDemoCompanies(ctx, counts);
  await ensureDemoAccounts(ctx, companyIds, counts);
  const unowned = await ctx.db
    .query("projects")
    .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", undefined))
    .take(2000);
  const demoOwned = await ctx.db
    .query("projects")
    .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", companyIds.gc))
    .take(2000);
  for (const p of [...unowned, ...demoOwned]) await attachProjectToDemo(ctx, p._id, companyIds, counts);
  const repairedBefore = counts.contractorRefsRepaired;
  await repairDemoContractorRefs(ctx, companyIds, counts);
  if (counts.contractorRefsRepaired > repairedBefore) {
    // Repaired agreements can bring a demo sub onto a project for the first time.
    for (const p of [...unowned, ...demoOwned]) await attachProjectToDemo(ctx, p._id, companyIds, counts);
  }
  const archivedTitles = await archiveDemoJunk(ctx, companyIds, counts);
  await attachAgentLinks(ctx, companyIds, counts);
  return { counts, archivedTitles, companyIds };
}

/**
 * Convex Auth's Password provider asks for an email code whenever `authAccounts.emailVerified` is
 * unset, regardless of `users.emailVerificationTime`. Seeded accounts (whose addresses receive no
 * mail) are marked verified on the account row too, so they sign in without a code.
 */
export async function markPasswordAccountVerified(ctx: MutationCtx, userId: Id<"users">, email: string): Promise<boolean> {
  const account = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", email))
    .unique();
  if (account === null || account.userId !== userId || account.emailVerified === email) return false;
  await ctx.db.patch(account._id, { emailVerified: email });
  return true;
}
