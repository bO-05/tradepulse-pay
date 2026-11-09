/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { Doc } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

const LOPEZ_TITLE = "Lopez Kitchen Remodel";
const COMMERCIAL_SUB_KEYS = ["sub:rosendin", "sub:tdindustries", "sub:clarke-kent"] as const;
const COMMERCIAL_SUB_EMAILS = ["sub1@demo.tradepulse", "sub2@demo.tradepulse", "sub3@demo.tradepulse"];
const COMMERCIAL_SUB_NAMES = ["Rosendin Electric, Inc.", "TDIndustries, Inc.", "Clarke Kent Plumbing"];

function newTest() {
  return convexTest(schema, modules);
}

async function seed(t: ReturnType<typeof newTest>) {
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
}

async function lopezId(t: ReturnType<typeof newTest>): Promise<Id<"projects">> {
  return await t.run(async (ctx) => {
    const project = (await ctx.db.query("projects").collect()).find((p) => p.title === LOPEZ_TITLE);
    if (project === undefined) throw new Error("Lopez Kitchen Remodel was not seeded.");
    return project._id;
  });
}

type OrtizRows = {
  company: Doc<"companies"> | null;
  packages: Doc<"tradePackages">[];
  contractors: Doc<"contractors">[];
  bids: Doc<"bids">[];
  agreements: Doc<"agreements">[];
  sovLines: Doc<"scheduleOfValues">[];
  milestones: Doc<"milestones">[];
};

async function ortizRows(t: ReturnType<typeof newTest>, projectId: Id<"projects">): Promise<OrtizRows> {
  return await t.run(async (ctx) => {
    const companies = await ctx.db
      .query("companies")
      .withIndex("by_isDemo", (q) => q.eq("isDemo", true))
      .collect();
    const company = companies.find((c) => c.demoKey === "sub:ortiz") ?? null;
    const packages = (
      await ctx.db
        .query("tradePackages")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect()
    ).filter((p) => p.tradeName === "Plumbing");
    const contractors = [];
    for (const pkg of packages) {
      const rows = await ctx.db
        .query("contractors")
        .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
        .collect();
      contractors.push(...rows.filter((c) => c.companyName === "Ortiz Plumbing"));
    }
    const bids = [];
    for (const contractor of contractors) {
      const rows = await ctx.db
        .query("bids")
        .withIndex("by_contractor", (q) => q.eq("contractorId", contractor._id))
        .collect();
      bids.push(...rows);
    }
    const agreements = (await ctx.db.query("agreements").collect()).filter(
      (a) => a.projectId === projectId && a.agreementNumber === "SC-22-ORTIZ-0001",
    );
    const sovLines = [];
    const milestones = [];
    for (const agreement of agreements) {
      sovLines.push(
        ...(await ctx.db
          .query("scheduleOfValues")
          .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id))
          .collect()),
      );
      milestones.push(
        ...(await ctx.db
          .query("milestones")
          .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement._id))
          .collect()),
      );
    }
    return { company, packages, contractors, bids, agreements, sovLines, milestones };
  });
}

type CommercialSnapshot = {
  companies: string;
  contractors: string;
  bids: string;
  agreements: string;
  accounts: string;
  vendorPayees: string;
};

/** Every row of the three commercial demo subs, JSON-canonical so a re-seed cannot quietly rewrite them. */
async function commercialSnapshot(t: ReturnType<typeof newTest>): Promise<CommercialSnapshot> {
  return await t.run(async (ctx) => {
    const demoCompanies = await ctx.db
      .query("companies")
      .withIndex("by_isDemo", (q) => q.eq("isDemo", true))
      .collect();
    const companies = demoCompanies.filter((c) => c.demoKey !== undefined && (COMMERCIAL_SUB_KEYS as readonly string[]).includes(c.demoKey));
    const companyIds = new Set(companies.map((c) => c._id));
    const contractors = (await ctx.db.query("contractors").collect()).filter((c) => COMMERCIAL_SUB_NAMES.includes(c.companyName));
    const contractorIds = new Set(contractors.map((c) => c._id));
    const bids = (await ctx.db.query("bids").collect()).filter((b) => contractorIds.has(b.contractorId));
    const agreements = (await ctx.db.query("agreements").collect()).filter((a) => COMMERCIAL_SUB_NAMES.includes(a.subcontractorName));
    const users = (await ctx.db.query("users").collect()).filter((u) => u.email !== undefined && COMMERCIAL_SUB_EMAILS.includes(u.email));
    const userIds = new Set(users.map((u) => u._id));
    const profiles = (await ctx.db.query("userProfiles").collect()).filter((p) => userIds.has(p.userId));
    const vendors = (await ctx.db.query("vendors").collect()).filter(
      (v) => v.linkedCompanyId !== undefined && companyIds.has(v.linkedCompanyId),
    );
    const sort = <T extends { _id: string }>(rows: T[]) => [...rows].sort((a, b) => a._id.localeCompare(b._id));
    return {
      companies: JSON.stringify(sort(companies)),
      contractors: JSON.stringify(sort(contractors)),
      bids: JSON.stringify(sort(bids)),
      agreements: JSON.stringify(sort(agreements)),
      accounts: JSON.stringify({ users: sort(users), profiles: sort(profiles) }),
      vendorPayees: JSON.stringify(sort(vendors.map((v) => ({ ...v, payoutEmailConfirmed: v.payoutEmailConfirmed ?? null })))),
    };
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Ortiz Plumbing residential subcontract", () => {
  test("seeds one executed plumbing subcontract with three milestones, 5% retainage and the waiver gate on", async () => {
    const t = newTest();
    await seed(t);
    const state = await t.query(internal.demoResidential.residentialReferenceState, {});
    expect(state.found).toBe(true);
    if (!state.found) return;

    expect(state.project).toMatchObject({
      title: LOPEZ_TITLE,
      projectKind: "residential",
      generalContractorName: "Bayview Remodeling",
      ownerName: "Dana Lopez",
      contractValueCents: 8_650_000,
      billingDay: 15,
      isDemoProject: false,
    });
    expect(state.primeLines).toEqual([
      { lineNo: 1, description: "Demolition, rough-in and permits", scheduledValueCents: 2_160_000 },
      { lineNo: 2, description: "Cabinetry, countertops and backsplash", scheduledValueCents: 3_460_000 },
      { lineNo: 3, description: "Electrical and appliance set", scheduledValueCents: 830_000 },
      { lineNo: 4, description: "Paint, punch list and closeout", scheduledValueCents: 1_300_000 },
    ]);
    expect(state.primeLinesCents).toBe(7_750_000);
    // The owner sheet is the production composition: four GC lines plus the Ortiz trade line.
    expect(state.ownerSheet).toEqual({ lineCount: 5, scheduledValueCents: 8_650_000, gcLineCount: 4, tradeLineCount: 1 });

    expect(state.ortiz).not.toBeNull();
    if (state.ortiz === null) return;
    expect(state.ortiz.company).toMatchObject({
      name: "Ortiz Plumbing",
      demoKey: "sub:ortiz",
      kind: "sub",
      isDemo: true,
    });
    expect(state.ortiz.contractor).toMatchObject({ companyName: "Ortiz Plumbing" });
    expect(state.ortiz.tradePackage).toMatchObject({
      csiDivision: "22 00 00",
      tradeName: "Plumbing",
      status: "awarded",
    });
    expect(state.ortiz.bid).toMatchObject({
      subcontractorName: "Ortiz Plumbing",
      isAwarded: true,
      baseAmountCents: 900_000,
    });
    expect(state.ortiz.bid.lineItems).toEqual([
      { item: "Plumbing — rough-in, fixtures and final", totalCostCents: 900_000 },
    ]);
    expect(state.ortiz.agreement).toMatchObject({
      agreementNumber: "SC-22-ORTIZ-0001",
      status: "executed",
      contractSumCents: 900_000,
      retainageBps: 500,
      lienWaiverGateEnabled: true,
      requirePriorUnconditional: false,
      sovStatus: "approved",
    });
    expect(state.ortiz.agreement.executedAt).not.toBeNull();
    expect(state.ortiz.sovLines).toEqual([
      { lineNo: 1, description: "Rough-in", scheduledValueCents: 400_000 },
      { lineNo: 2, description: "Fixtures set", scheduledValueCents: 350_000 },
      { lineNo: 3, description: "Final", scheduledValueCents: 150_000 },
    ]);
    // Exactly three, in order, and not the generated four-way split.
    expect(state.ortiz.milestones.map((m) => [m.order, m.name, m.amountCents])).toEqual([
      [1, "Rough-in", 400_000],
      [2, "Fixtures set", 350_000],
      [3, "Final", 150_000],
    ]);
    expect(state.ortiz.milestones.filter((m) => ["Mobilization", "Trim-out", "Closeout"].includes(m.name))).toEqual([]);

    // Each milestone lists its own SOV line, which is what lets the review see Fixtures as unearned.
    const projectId = state.project.projectId;
    const rows = await ortizRows(t, projectId);
    expect(rows.packages).toHaveLength(1);
    expect(rows.contractors).toHaveLength(1);
    expect(rows.bids).toHaveLength(1);
    expect(rows.agreements).toHaveLength(1);
    expect(rows.sovLines).toHaveLength(3);
    expect(rows.milestones).toHaveLength(3);
    const lineIdByNo = new Map(rows.sovLines.map((l) => [l.lineNo, l._id]));
    for (const milestone of rows.milestones) {
      expect(milestone.sovLineIds).toEqual([lineIdByNo.get(milestone.order)]);
    }
  });

  test("the residential reference job invoices the homeowner at the reserved guest-checkout alias", async () => {
    vi.stubEnv("PAYPAL_SANDBOX_OWNER_EMAIL", "owner-sandbox@business.example.com");
    const t = newTest();
    await seed(t);
    const projectId = await lopezId(t);
    // The demo seed stores the sandbox PayPal login as the Demo Owner's billing email; invoices must
    // go to the alias instead, and resolving it must not rewrite the stored billing email.
    const demoOwner = await t.run(async (ctx) => {
      const companies = await ctx.db
        .query("companies")
        .withIndex("by_isDemo", (q) => q.eq("isDemo", true))
        .collect();
      return companies.find((c) => c.demoKey === "owner") ?? null;
    });
    expect(demoOwner).not.toBeNull();
    if (demoOwner === null) return;
    await t.run((ctx) => ctx.db.patch(demoOwner._id, { billingEmail: "owner-sandbox@business.example.com" }));

    const state = await t.query(internal.demoResidential.residentialReferenceState, {});
    expect(state.found).toBe(true);
    if (!state.found) return;
    expect(state.project).toMatchObject({ projectKind: "residential", isDemoProject: false });
    expect(state.ownerInvoice).toEqual({
      enabled: true,
      recipientEmail: `owner-${projectId}@example.com`,
      guestCheckoutAlias: true,
      ownerCompanyName: "Demo Owner",
    });
    expect((await t.run((ctx) => ctx.db.get(demoOwner._id)))?.billingEmail).toBe("owner-sandbox@business.example.com");
  });

  test("the commercial demo project keeps the guest-checkout alias", async () => {
    const t = newTest();
    await seed(t);
    const commercialId = await t.run(async (ctx) => {
      const companies = await ctx.db
        .query("companies")
        .withIndex("by_isDemo", (q) => q.eq("isDemo", true))
        .collect();
      const demoOwner = companies.find((c) => c.demoKey === "owner");
      const commercial = (await ctx.db.query("projects").collect()).find((p) => p.isDemoProject === true);
      if (demoOwner === undefined || commercial === undefined) throw new Error("The demo rows were not seeded.");
      await ctx.db.patch(demoOwner._id, { billingEmail: "owner@demo.tradepulse" });
      await ctx.db.patch(commercial._id, { ownerCompanyId: demoOwner._id });
      await ctx.db.insert("projectMembers", {
        projectId: commercial._id,
        companyId: demoOwner._id,
        partyRole: "owner",
        status: "active",
        createdAt: Date.now(),
      });
      return commercial._id;
    });

    const state = await t.query(internal.demoResidential.residentialReferenceState, {});
    expect(state.found).toBe(true);
    if (!state.found) return;
    expect(state.commercialDemoInvoice).toEqual({
      projectTitle: "The Domain Tower B - Commercial MEP",
      recipientEmail: `owner-${commercialId}@example.com`,
      guestCheckoutAlias: true,
    });
  });

  test("a re-seed duplicates nothing and leaves settled milestones alone", async () => {
    const t = newTest();
    await seed(t);
    const projectId = await lopezId(t);
    const before = await ortizRows(t, projectId);
    expect(before.agreements).toHaveLength(1);
    const agreementId = before.agreements[0]._id;
    const firstMilestone = before.milestones.find((m) => m.order === 1)!;

    // Pretend the Rough-in milestone settled; the seed must not touch it again.
    await t.run(async (ctx) => ctx.db.patch(firstMilestone._id, { status: "paid" }));

    const second = await t.mutation(internal.demoResidential.ensureResidentialReference, {});
    const third = await t.mutation(internal.demoResidential.ensureResidentialReference, {});
    await seed(t);

    const after = await ortizRows(t, projectId);
    expect(after.packages.map((p) => p._id)).toEqual(before.packages.map((p) => p._id));
    expect(after.contractors.map((c) => c._id)).toEqual(before.contractors.map((c) => c._id));
    expect(after.bids.map((b) => b._id)).toEqual(before.bids.map((b) => b._id));
    expect(after.agreements.map((a) => a._id)).toEqual(before.agreements.map((a) => a._id));
    expect(after.sovLines.map((l) => l._id)).toEqual(before.sovLines.map((l) => l._id));
    expect(after.milestones.map((m) => m._id)).toEqual(before.milestones.map((m) => m._id));
    expect(after.milestones.find((m) => m.order === 1)?.status).toBe("paid");

    expect(second.primeLinesWritten).toBe(0);
    expect(third.primeLinesWritten).toBe(0);
    expect(second.ortiz.created).toEqual({
      tradePackage: false,
      contractor: false,
      bid: false,
      agreement: false,
      sovLines: 0,
      milestones: 0,
    });
    expect(third.ortiz.agreementId).toBe(agreementId);
    expect(third.primeLinesCents).toBe(7_750_000);

    const state = await t.query(internal.demoResidential.residentialReferenceState, {});
    expect(state.found).toBe(true);
    if (!state.found) return;
    expect(state.ownerSheet.scheduledValueCents).toBe(8_650_000);
    expect(state.primeLinesCents).toBe(7_750_000);
  });

  test("the Ortiz seed does not touch Rosendin, TDIndustries or Clarke Kent", async () => {
    const t = newTest();
    await seed(t);
    const before = await commercialSnapshot(t);
    expect(JSON.parse(before.companies)).toHaveLength(3);
    expect(JSON.parse(before.contractors).length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(before.agreements).length).toBeGreaterThanOrEqual(1);

    await t.mutation(internal.demoResidential.ensureResidentialReference, {});
    await seed(t);

    expect(await commercialSnapshot(t)).toEqual(before);
  });

  test("the payee resolves SUB4, falls back to SUB3, and records which variable supplied the address", async () => {
    vi.stubEnv("PAYPAL_SANDBOX_SUB4_EMAIL", "ortiz-sandbox@personal.example.com");
    vi.stubEnv("PAYPAL_SANDBOX_SUB3_EMAIL", "sub3-sandbox@personal.example.com");
    const t = newTest();
    await seed(t);
    await t.run(async (ctx) => {
      for (const email of ["gc@demo.tradepulse", "sub4@demo.tradepulse"]) {
        await ctx.db.insert("users", { email, emailVerificationTime: Date.now() });
      }
    });
    await t.mutation(internal.demoAccounts.linkDemoProfilesInternal, {});

    let state = await t.query(internal.demoResidential.residentialReferenceState, {});
    expect(state.found).toBe(true);
    if (!state.found || state.ortiz === null || state.ortiz.company === null) throw new Error("Ortiz is not seeded.");
    expect(state.ortiz.company.payoutPaypalEmail).toBe("ortiz-sandbox@personal.example.com");
    expect(state.ortiz.company.payoutEmailSourceEnv).toBe("PAYPAL_SANDBOX_SUB4_EMAIL");
    expect(state.ortiz.account.email).toBe("sub4@demo.tradepulse");
    expect(state.ortiz.account.exists).toBe(true);
    expect(state.ortiz.account.role).toBe("sub");

    // Without SUB4, the documented fallback pays the existing sandbox SUB3 account.
    vi.stubEnv("PAYPAL_SANDBOX_SUB4_EMAIL", "");
    await t.mutation(internal.demoAccounts.linkDemoProfilesInternal, {});
    state = await t.query(internal.demoResidential.residentialReferenceState, {});
    if (!state.found || state.ortiz === null || state.ortiz.company === null) throw new Error("Ortiz is not seeded.");
    expect(state.ortiz.company.payoutPaypalEmail).toBe("sub3-sandbox@personal.example.com");
    expect(state.ortiz.company.payoutEmailSourceEnv).toBe("PAYPAL_SANDBOX_SUB3_EMAIL");
  });

  test("no SUB4 or SUB3 payee means no invented address", async () => {
    const t = newTest();
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { email: "gc@demo.tradepulse", emailVerificationTime: Date.now() });
    });
    await t.mutation(internal.demoAccounts.linkDemoProfilesInternal, {});

    const state = await t.query(internal.demoResidential.residentialReferenceState, {});
    expect(state.found).toBe(true);
    if (!state.found || state.ortiz === null || state.ortiz.company === null) throw new Error("Ortiz is not seeded.");
    expect(state.ortiz.company.payoutPaypalEmail).toBeNull();
    expect(state.ortiz.company.payoutEmailSourceEnv).toBeNull();
  });

  test("the sub4 account links to the Ortiz contractor and the Lopez project", async () => {
    vi.stubEnv("PAYPAL_SANDBOX_SUB3_EMAIL", "sub3-sandbox@personal.example.com");
    const t = newTest();
    await seed(t);
    const projectId = await lopezId(t);
    await t.run(async (ctx) => {
      for (const email of ["gc@demo.tradepulse", "sub4@demo.tradepulse"]) {
        await ctx.db.insert("users", { email, emailVerificationTime: Date.now() });
      }
    });
    await t.mutation(internal.demoAccounts.linkDemoProfilesInternal, {});

    const rows = await ortizRows(t, projectId);
    expect(rows.contractors).toHaveLength(1);
    expect(rows.company).not.toBeNull();
    if (rows.company === null) throw new Error("Ortiz company missing.");
    const contractorId = rows.contractors[0]._id;

    const linked = await t.run(async (ctx) => {
      const user = (await ctx.db.query("users").collect()).find((u) => u.email === "sub4@demo.tradepulse")!;
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .unique();
      const members = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_company_and_status", (q) => q.eq("projectId", projectId).eq("companyId", rows.company!._id))
        .collect();
      return { profile, members };
    });
    expect(linked.profile).toMatchObject({
      role: "sub",
      contractorId,
      companyId: rows.company._id,
      // The profile keeps the sandbox address that actually resolves, including the fallback.
      paypalEmail: "sub3-sandbox@personal.example.com",
    });
    expect(linked.members).toHaveLength(1);
    expect(linked.members[0]).toMatchObject({ partyRole: "sub", contractorId, status: "active" });
  });

  test("a stale prime line 3 is reconciled and the next seed writes nothing", async () => {
    const t = newTest();
    await seed(t);
    const projectId = await lopezId(t);
    await t.run(async (ctx) => {
      const line = await ctx.db
        .query("primeLines")
        .withIndex("by_projectId_and_lineNo", (q) => q.eq("projectId", projectId).eq("lineNo", 3))
        .unique();
      await ctx.db.patch(line!._id, {
        description: "Electrical, plumbing and appliance set",
        scheduledValueCents: 1_730_000,
      });
    });

    const repaired = await t.mutation(internal.demoResidential.ensureResidentialReference, {});
    expect(repaired.primeLinesWritten).toBe(1);
    expect(repaired.primeLinesCents).toBe(7_750_000);
    const lines = await t.run(async (ctx) =>
      await ctx.db
        .query("primeLines")
        .withIndex("by_projectId_and_lineNo", (q) => q.eq("projectId", projectId))
        .collect(),
    );
    expect(lines.find((l) => l.lineNo === 3)).toMatchObject({
      description: "Electrical and appliance set",
      scheduledValueCents: 830_000,
    });

    const again = await t.mutation(internal.demoResidential.ensureResidentialReference, {});
    expect(again.primeLinesWritten).toBe(0);
  });

  test("a re-seed restores the residential GC display name", async () => {
    const t = newTest();
    await seed(t);
    const projectId = await lopezId(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(projectId, { generalContractorName: "Demo GC (TradePulse Pay demo)" });
    });
    await t.mutation(internal.demoResidential.ensureResidentialReference, {});
    const project = await t.run(async (ctx) => await ctx.db.get(projectId));
    expect(project?.generalContractorName).toBe("Bayview Remodeling");
  });
});
