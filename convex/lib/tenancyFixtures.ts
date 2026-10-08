import type { TestConvex } from "convex-test";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type schema from "../schema";
import { ensureDemoCompanies, type DemoCompanyIds } from "./demoTenancy";
import type { Role } from "./roles";
import { insertTestSession } from "./testIdentity";

/**
 * Test-only fixture for cross-company isolation suites: two GC companies, a sub, an owner and the
 * Demo company, each with a verified admin, and one project per GC. Only gcA's project has the
 * sub (with an executed agreement) and the owner as members.
 */

type T = TestConvex<typeof schema>;
type Accessor = ReturnType<T["withIdentity"]>;

export type FixtureUser = { userId: Id<"users">; email: string; as: Accessor };

export type FixtureProject = {
  projectId: Id<"projects">;
  tradePackageId: Id<"tradePackages">;
  contractorId: Id<"contractors">;
  bidId: Id<"bids">;
  agreementId: Id<"agreements">;
};

export type TenancyFixture = {
  gcA: { companyId: Id<"companies">; admin: FixtureUser; member: FixtureUser; project: FixtureProject };
  gcB: { companyId: Id<"companies">; admin: FixtureUser; project: FixtureProject };
  sub: { companyId: Id<"companies">; admin: FixtureUser };
  owner: { companyId: Id<"companies">; admin: FixtureUser };
  demo: { companyIds: DemoCompanyIds; gc: FixtureUser; project: FixtureProject };
  /** Signed in, verified, but member of no company. */
  noCompany: FixtureUser;
};

function identity(t: T, userId: Id<"users">, sessionId: Id<"authSessions">, email: string): Accessor {
  return t.withIdentity({ subject: `${userId}|${sessionId}`, email });
}

async function insertUser(
  ctx: MutationCtx,
  email: string,
  opts: { companyId?: Id<"companies">; memberRole?: "admin" | "member"; role?: Role; verified?: boolean },
): Promise<Id<"users">> {
  const userId = await ctx.db.insert("users", {
    email,
    emailVerificationTime: opts.verified === false ? undefined : Date.now(),
  });
  if (opts.role !== undefined) {
    await ctx.db.insert("userProfiles", {
      userId,
      role: opts.role,
      displayName: email,
      actorType: "human",
      companyId: opts.companyId,
      createdAt: Date.now(),
    });
  }
  if (opts.companyId !== undefined) {
    await ctx.db.insert("companyMembers", {
      companyId: opts.companyId,
      userId,
      role: opts.memberRole ?? "admin",
      status: "active",
      createdAt: Date.now(),
    });
  }
  return userId;
}

async function insertCompany(ctx: MutationCtx, name: string, kind: Role): Promise<Id<"companies">> {
  return await ctx.db.insert("companies", { name, kind, isDemo: false, createdAt: Date.now() });
}

/** A project of `gcCompanyId` with one package, one bidder, its awarded bid and an executed agreement. */
export async function insertProjectFor(
  ctx: MutationCtx,
  gcCompanyId: Id<"companies">,
  opts: { title: string; subCompanyId?: Id<"companies">; bidderName?: string },
): Promise<FixtureProject> {
  const now = Date.now();
  const projectId = await ctx.db.insert("projects", {
    title: opts.title,
    location: "Oakland, CA",
    projectType: "Tenant improvement",
    estBudget: 100_000,
    targetCompletionWeeks: 20,
    specDocumentText: "Fixture project.",
    isDemoProject: false,
    gcCompanyId,
    createdAt: now,
  });
  const tradePackageId = await ctx.db.insert("tradePackages", {
    projectId,
    csiDivision: "26 00 00",
    tradeName: "Electrical",
    budgetEstimate: 50_000,
    agentMailbox: "fixture@example.invalid",
    agentMailboxId: "fixture",
    scopeSummary: "Electrical",
    mandatoryInclusions: [],
    bidDeadline: "2026-12-01",
    status: "awarded",
  });
  const bidderName = opts.bidderName ?? `${opts.title} Electric`;
  const contractorId = await ctx.db.insert("contractors", {
    tradePackageId,
    companyName: bidderName,
    contactEmail: "bids@example.invalid",
    licenseNumber: "0",
    licenseStatus: "Unverified",
    sourceUrl: "https://example.invalid",
    rfqStatus: "bid_received",
    linkedCompanyId: opts.subCompanyId,
  });
  const bidId = await ctx.db.insert("bids", {
    tradePackageId,
    contractorId,
    subcontractorName: bidderName,
    baseBidAmount: 40_000,
    lineItems: [],
    identifiedExclusions: [],
    longLeadEquipmentWeeks: 4,
    leadTimePenalty: 0,
    coiComplianceStatus: "compliant",
    coiPenalty: 0,
    leveledTotalCost: 40_000,
    isAwarded: true,
    receivedAt: now,
  });
  const agreementId = await ctx.db.insert("agreements", {
    projectId,
    tradePackageId,
    bidId,
    contractorId,
    agreementNumber: `FX-${opts.title}`,
    documentTitle: "Fixture subcontract",
    subcontractorName: bidderName,
    generalContractorName: "Fixture GC",
    projectTitle: opts.title,
    projectLocation: "Oakland, CA",
    csiDivision: "26 00 00",
    tradeName: "Electrical",
    contractSum: 40_000,
    retainagePercent: 5,
    liquidatedDamagesDaily: 0,
    scopeSummary: "Electrical",
    mandatoryInclusions: [],
    status: "executed",
    contractText: "Fixture.",
    executedAt: now,
    createdAt: now,
  });
  if (opts.subCompanyId !== undefined) {
    await ctx.db.insert("projectMembers", {
      projectId,
      companyId: opts.subCompanyId,
      partyRole: "sub",
      contractorId,
      status: "active",
      createdAt: now,
    });
  }
  return { projectId, tradePackageId, contractorId, bidId, agreementId };
}

export async function buildTenancyFixture(t: T): Promise<TenancyFixture> {
  const ids = await t.run(async (ctx) => {
    const gcA = await insertCompany(ctx, "Bayview Builders Inc.", "gc");
    const gcB = await insertCompany(ctx, "Sonoran Interiors GC", "gc");
    const sub = await insertCompany(ctx, "Eastbay Electric", "sub");
    const owner = await insertCompany(ctx, "Harbor Point Dental LLC", "owner");
    const demo = await ensureDemoCompanies(ctx);

    const users = {
      gcAAdmin: await insertUser(ctx, "dana@bayview.test", { companyId: gcA, role: "gc" }),
      gcAMember: await insertUser(ctx, "luis@bayview.test", { companyId: gcA, role: "gc", memberRole: "member" }),
      gcBAdmin: await insertUser(ctx, "admin@sonoran.test", { companyId: gcB, role: "gc" }),
      subAdmin: await insertUser(ctx, "kim@eastbay.test", { companyId: sub, role: "sub" }),
      ownerAdmin: await insertUser(ctx, "alicia@harborpoint.test", { companyId: owner, role: "owner" }),
      demoGc: await insertUser(ctx, "gc@demo.tradepulse", { companyId: demo.gc, role: "gc" }),
      noCompany: await insertUser(ctx, "nobody@nowhere.test", { role: "gc" }),
    };

    const projectA = await insertProjectFor(ctx, gcA, { title: "Harbor Point Dental Office TI", subCompanyId: sub, bidderName: "Eastbay Electric" });
    await ctx.db.insert("projectMembers", {
      projectId: projectA.projectId,
      companyId: owner,
      partyRole: "owner",
      status: "active",
      createdAt: Date.now(),
    });
    const projectB = await insertProjectFor(ctx, gcB, { title: "Camelback Suite 400" });
    const demoProject = await insertProjectFor(ctx, demo.gc, { title: "Demo fixture project" });
    return { gcA, gcB, sub, owner, demo, users, projectA, projectB, demoProject };
  });
  const sessions = await t.run(async (ctx) => {
    const out: Record<string, Id<"authSessions">> = {};
    for (const userId of Object.values(ids.users)) out[userId] = await insertTestSession(ctx, userId);
    return out;
  });
  const user = (userId: Id<"users">, email: string): FixtureUser => ({
    userId,
    email,
    as: identity(t, userId, sessions[userId], email),
  });
  return {
    gcA: {
      companyId: ids.gcA,
      admin: user(ids.users.gcAAdmin, "dana@bayview.test"),
      member: user(ids.users.gcAMember, "luis@bayview.test"),
      project: ids.projectA,
    },
    gcB: { companyId: ids.gcB, admin: user(ids.users.gcBAdmin, "admin@sonoran.test"), project: ids.projectB },
    sub: { companyId: ids.sub, admin: user(ids.users.subAdmin, "kim@eastbay.test") },
    owner: { companyId: ids.owner, admin: user(ids.users.ownerAdmin, "alicia@harborpoint.test") },
    demo: { companyIds: ids.demo, gc: user(ids.users.demoGc, "gc@demo.tradepulse"), project: ids.demoProject },
    noCompany: user(ids.users.noCompany, "nobody@nowhere.test"),
  };
}
