import type { TestConvex } from "convex-test";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type schema from "../schema";
import { ensureDemoCompanies } from "./demoTenancy";
import type { Role } from "./roles";

type T = TestConvex<typeof schema>;

async function ensureProjectMember(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  companyId: Id<"companies">,
  partyRole: Role,
  contractorId?: Id<"contractors">,
): Promise<void> {
  const rows = await ctx.db
    .query("projectMembers")
    .withIndex("by_project_company", (q) => q.eq("projectId", projectId).eq("companyId", companyId))
    .take(5);
  if (rows.length > 0) return;
  await ctx.db.insert("projectMembers", { projectId, companyId, partyRole, contractorId, status: "active", createdAt: Date.now() });
}

/**
 * Legacy single-tenant tests: every project without a company belongs to the Demo GC, the Demo
 * owner is a member of every Demo GC project, and each sub company is a member of the Demo GC
 * projects where one of its linked contractors bids or holds an agreement. Projects of other
 * companies (tenancy fixtures) are never touched.
 */
export async function syncLegacyTestTenancy(ctx: MutationCtx): Promise<void> {
  const ids = await ensureDemoCompanies(ctx);
  for (const project of await ctx.db.query("projects").collect()) {
    if (project.gcCompanyId === undefined) await ctx.db.patch(project._id, { gcCompanyId: ids.gc });
    else if (project.gcCompanyId !== ids.gc) continue;
    await ensureProjectMember(ctx, project._id, ids.owner, "owner");

    const contractorIds = new Set<Id<"contractors">>();
    const agreements = await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    for (const a of agreements) contractorIds.add(a.contractorId);
    const packages = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    for (const pkg of packages) {
      for (const id of pkg.invitedContractorIds ?? []) contractorIds.add(id);
      const bidders = await ctx.db
        .query("contractors")
        .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
        .collect();
      for (const c of bidders) contractorIds.add(c._id);
    }
    for (const contractorId of contractorIds) {
      const contractor = await ctx.db.get(contractorId);
      if (contractor?.linkedCompanyId === undefined) continue;
      await ensureProjectMember(ctx, project._id, contractor.linkedCompanyId, "sub", contractorId);
    }
  }
}

async function joinCompanyFor(
  ctx: MutationCtx,
  userId: Id<"users">,
  role: Role,
  contractorId: Id<"contractors"> | undefined,
): Promise<Id<"companies">> {
  const ids = await ensureDemoCompanies(ctx);
  let companyId: Id<"companies">;
  if (role === "gc") companyId = ids.gc;
  else if (role === "owner") companyId = ids.owner;
  else {
    const contractor = contractorId === undefined ? null : await ctx.db.get(contractorId);
    if (contractor?.linkedCompanyId !== undefined) {
      companyId = contractor.linkedCompanyId;
    } else {
      companyId = await ctx.db.insert("companies", {
        name: contractor?.companyName ?? "Test sub company",
        kind: "sub",
        isDemo: false,
        createdAt: Date.now(),
      });
      if (contractor !== null) await ctx.db.patch(contractor._id, { linkedCompanyId: companyId });
    }
  }
  await ctx.db.insert("companyMembers", { companyId, userId, role: "admin", status: "active", createdAt: Date.now() });
  return companyId;
}

/**
 * Test-only helper: inserts a verified users row (+ userProfiles row when `role` is set) and
 * returns an accessor whose identity matches what Convex Auth issues (subject =
 * "<userId>|<sessionId>"). The user joins the Demo company of its role (subs: the company linked
 * to `contractorId`, created on first use), and each call through `as` first runs
 * syncLegacyTestTenancy so legacy tests keep their single-tenant data visible.
 * Isolation tests use buildTenancyFixture instead.
 */
export async function signInAs(
  t: T,
  role: Role | null,
  opts: { email?: string; contractorId?: Id<"contractors">; paypalEmail?: string } = {},
) {
  const email = opts.email ?? `${role ?? "norole"}-${Math.random().toString(36).slice(2, 8)}@test.tradepulse`;
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email, emailVerificationTime: Date.now() });
    if (role !== null) {
      const companyId = await joinCompanyFor(ctx, id, role, opts.contractorId);
      await ctx.db.insert("userProfiles", {
        userId: id,
        role,
        displayName: `Test ${role}`,
        contractorId: opts.contractorId,
        paypalEmail: opts.paypalEmail,
        companyId,
        actorType: "human",
        createdAt: Date.now(),
      });
    }
    await syncLegacyTestTenancy(ctx);
    return id;
  });
  const inner = t.withIdentity({ subject: `${userId}|test-session`, email });
  const sync = () => t.run(syncLegacyTestTenancy);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyCall = (...args: any[]) => Promise<any>;
  const wrap = (call: AnyCall): AnyCall => async (...args) => {
    await sync();
    return await call(...args);
  };
  const as: typeof inner = {
    ...inner,
    query: wrap(inner.query as AnyCall) as typeof inner.query,
    mutation: wrap(inner.mutation as AnyCall) as typeof inner.mutation,
    action: wrap(inner.action as AnyCall) as typeof inner.action,
    fetch: wrap(inner.fetch as AnyCall) as typeof inner.fetch,
  };
  return { userId, as };
}

/** Convenience for legacy tests that exercise GC-only procurement mutations. */
export async function asGc(t: T) {
  return (await signInAs(t, "gc", { email: "gc@test.tradepulse" })).as;
}

export type GcTest = Awaited<ReturnType<typeof asGc>>;
