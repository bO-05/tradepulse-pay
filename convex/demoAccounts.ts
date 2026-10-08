import { createAccount, modifyAccountCredentials } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Role } from "./lib/roles";
import { attachProjectToDemo, ensureDemoAccounts, ensureDemoCompanies, repairDemoContractorRefs } from "./lib/demoTenancy";

/** Shared, publicly documented password for the demo accounts (README "Demo accounts"). */
export const DEMO_PASSWORD = "TradePulseDemo!2026";

type DemoAccount = {
  email: string;
  role: Role;
  displayName: string;
  /** Exact contractor companyName in the seeded demo project. */
  contractorName?: string;
  /** Convex env var holding the sandbox PayPal email. Values are never committed. */
  paypalEmailEnv?: string;
};

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { email: "gc@demo.tradepulse", role: "gc", displayName: "Demo GC (Austin Commercial, LP)" },
  {
    email: "sub1@demo.tradepulse",
    role: "sub",
    displayName: "Demo Sub 1 (Rosendin Electric)",
    contractorName: "Rosendin Electric, Inc.",
    paypalEmailEnv: "PAYPAL_SANDBOX_SUB1_EMAIL",
  },
  {
    email: "sub2@demo.tradepulse",
    role: "sub",
    displayName: "Demo Sub 2 (TDIndustries)",
    contractorName: "TDIndustries, Inc.",
    paypalEmailEnv: "PAYPAL_SANDBOX_SUB2_EMAIL",
  },
  {
    email: "sub3@demo.tradepulse",
    role: "sub",
    displayName: "Demo Sub 3 (Clarke Kent Plumbing)",
    contractorName: "Clarke Kent Plumbing",
    paypalEmailEnv: "PAYPAL_SANDBOX_SUB3_EMAIL",
  },
  {
    email: "owner@demo.tradepulse",
    role: "owner",
    displayName: "Demo Owner (Domain Tower B)",
    paypalEmailEnv: "PAYPAL_SANDBOX_OWNER_EMAIL",
  },
];

export async function findDemoContractorId(ctx: MutationCtx, companyName: string): Promise<Id<"contractors"> | undefined> {
  const demoProject = await ctx.db
    .query("projects")
    .withIndex("by_demo", (q) => q.eq("isDemoProject", true))
    .first();
  if (!demoProject) return undefined;
  const packages = await ctx.db
    .query("tradePackages")
    .withIndex("by_project", (q) => q.eq("projectId", demoProject._id))
    .collect();
  for (const pkg of packages) {
    const contractors = await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
      .collect();
    const match = contractors.find((c) => c.companyName === companyName);
    if (match) return match._id;
  }
  return undefined;
}

/**
 * Upserts userProfiles for every demo account that already has a users row.
 * Re-run after any demo-project reseed, because reseeding recreates contractors
 * with new ids.
 */
export async function linkDemoProfiles(ctx: MutationCtx) {
  const results: Array<{ email: string; role: Role; linked: boolean; contractorLinked: boolean; hasPaypalEmail: boolean }> = [];
  for (const account of DEMO_ACCOUNTS) {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", account.email))
      .first();
    if (!user) {
      results.push({ email: account.email, role: account.role, linked: false, contractorLinked: false, hasPaypalEmail: false });
      continue;
    }
    const contractorId = account.contractorName ? await findDemoContractorId(ctx, account.contractorName) : undefined;
    const paypalEmail = account.paypalEmailEnv ? process.env[account.paypalEmailEnv]?.trim() || undefined : undefined;
    const fields = {
      userId: user._id,
      role: account.role,
      displayName: account.displayName,
      contractorId,
      paypalEmail,
      actorType: "human" as const,
    };
    const existing = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (existing) {
      await ctx.db.replace(existing._id, { ...fields, companyId: existing.companyId, createdAt: existing.createdAt });
    } else {
      await ctx.db.insert("userProfiles", { ...fields, createdAt: Date.now() });
    }
    results.push({
      email: account.email,
      role: account.role,
      linked: true,
      contractorLinked: contractorId !== undefined,
      hasPaypalEmail: paypalEmail !== undefined,
    });
  }
  const companyIds = await ensureDemoCompanies(ctx);
  await ensureDemoAccounts(ctx, companyIds);
  const demoProjects = await ctx.db
    .query("projects")
    .withIndex("by_demo", (q) => q.eq("isDemoProject", true))
    .take(10);
  for (const p of demoProjects) await attachProjectToDemo(ctx, p._id, companyIds);
  await repairDemoContractorRefs(ctx, companyIds);
  return results;
}

export const linkDemoProfilesInternal = internalMutation({
  args: {},
  handler: async (ctx) => await linkDemoProfiles(ctx),
});

export const passwordAccountExists = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", args.email))
      .unique();
    return account !== null;
  },
});

/**
 * Idempotent demo setup for CLI use:
 *   npx convex run demoAccounts:seedDemo '{}'
 * Seeds the demo project if missing (never wipes), creates or resets the demo
 * password accounts, and links their role profiles.
 */
export const seedDemo = internalAction({
  args: { force: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    project: string;
    accounts: Array<{ email: string; created: boolean }>;
    profiles: Awaited<ReturnType<typeof linkDemoProfiles>>;
  }> => {
    const project: { status: string } = await ctx.runMutation(internal.projects.seedInitialDataInternal, { force: args.force ?? false });
    const accounts: Array<{ email: string; created: boolean }> = [];
    for (const account of DEMO_ACCOUNTS) {
      const exists = await ctx.runQuery(internal.demoAccounts.passwordAccountExists, { email: account.email });
      if (exists) {
        await modifyAccountCredentials(ctx, {
          provider: "password",
          account: { id: account.email, secret: DEMO_PASSWORD },
        });
      } else {
        await createAccount(ctx, {
          provider: "password",
          account: { id: account.email, secret: DEMO_PASSWORD },
          profile: { email: account.email, name: account.displayName },
        });
      }
      accounts.push({ email: account.email, created: !exists });
    }
    const profiles = await ctx.runMutation(internal.demoAccounts.linkDemoProfilesInternal, {});
    return { project: project.status, accounts, profiles };
  },
});
