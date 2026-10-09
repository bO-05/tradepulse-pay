/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture, type FixtureUser } from "./lib/tenancyFixtures";
import { projectSetupArgs } from "./lib/projectSetupFixture";
import type { AgreementTerms } from "./lib/agreementTerms";
import { projectPlace } from "./lib/agreementDocument";
import { retainagePercentFor } from "./payments/payoutMath";

const modules = import.meta.glob("./**/*.ts");

const BANNED = [/texas/i, /austin/i, /TX /i, /crane/i, /hoisting/i, /generated autonomously/i, /tradepulse pro\b/i, /A401/i, /AIA Document/i, /official AIA/i];

async function awardedAgreement(
  t: ReturnType<typeof convexTest>,
  gc: FixtureUser,
  setup: Record<string, unknown>,
  opts: { subCompanyId?: Id<"companies">; bidder?: string; amount?: number } = {},
) {
  const projectId = (await gc.as.mutation(api.projects.createProject, projectSetupArgs(setup))) as Id<"projects">;
  const amount = opts.amount ?? 172_400;
  const ids = await t.run(async (ctx) => {
    const tradePackageId = await ctx.db.insert("tradePackages", {
      projectId,
      csiDivision: "26 00 00",
      tradeName: "Electrical",
      budgetEstimate: 180_000,
      agentMailbox: "fixture@example.invalid",
      agentMailboxId: "fixture",
      scopeSummary: "Tenant improvement electrical: panels, branch circuits, lighting and controls.",
      mandatoryInclusions: ["Temporary power", "Fire alarm rough-in"],
      bidDeadline: "2026-12-01",
      status: "leveling",
    });
    const contractorId = await ctx.db.insert("contractors", {
      tradePackageId,
      companyName: opts.bidder ?? "Eastbay Electric",
      contactEmail: "bids@eastbay.example",
      licenseNumber: "1098765",
      licenseStatus: "Active & Verified",
      sourceUrl: "https://example.invalid",
      rfqStatus: "bid_received",
      linkedCompanyId: opts.subCompanyId,
    });
    if (opts.subCompanyId) {
      await ctx.db.insert("projectMembers", {
        projectId,
        companyId: opts.subCompanyId,
        partyRole: "sub",
        contractorId,
        status: "active",
        createdAt: Date.now(),
      });
    }
    const bidId = await ctx.db.insert("bids", {
      tradePackageId,
      contractorId,
      subcontractorName: opts.bidder ?? "Eastbay Electric",
      baseBidAmount: amount,
      lineItems: [],
      identifiedExclusions: [],
      longLeadEquipmentWeeks: 4,
      leadTimePenalty: 0,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      leveledTotalCost: amount,
      isAwarded: false,
      receivedAt: Date.now(),
    });
    return { tradePackageId, bidId };
  });
  const result = (await gc.as.mutation(api.agreements.generateAgreement, ids)) as Doc<"agreements">;
  return { projectId, agreementId: result._id };
}

const CA_PROJECT = {
  title: "Harbor Point Dental Office TI",
  ownerName: "Harbor Point Dental LLC",
  address: { line1: "455 Embarcadero W", city: "Oakland", zip: "94607" },
  state: "CA",
  contractValueCents: 124_000_000,
  retainageBps: 500,
};

const AZ_PROJECT = {
  title: "Camelback Medical Suite 210",
  ownerName: "Camelback Medical Partners",
  address: { line1: "2201 E Camelback Rd", city: "Phoenix", zip: "85016" },
  state: "AZ",
  contractValueCents: 61_250_000,
  retainageBps: 1000,
};

function edited(base: AgreementTerms): AgreementTerms {
  return {
    ...base,
    retainageReductionBpsAt50: 250,
    paymentTerms: { type: "pay_when_paid", days: 10 },
    liquidatedDamagesCentsPerDay: 25_000,
    insurance: { ...base.insurance, umbrellaCents: 200_000_000 },
    warrantyMonths: 24,
  };
}

async function load(t: ReturnType<typeof convexTest>, id: Id<"agreements">) {
  return (await t.run((ctx) => ctx.db.get(id)))!;
}

describe("agreement terms default from the project and company", () => {
  test("a CA award stores 5% retainage, CA governing state and cents limits; the text uses Oakland / Alameda County", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { agreementId } = await awardedAgreement(t, f.gcA.admin, CA_PROJECT, { subCompanyId: f.sub.companyId });
    const a = await load(t, agreementId);
    expect(a.terms).toEqual({
      retainageBps: 500,
      paymentTerms: { type: "net", days: 30 },
      insurance: {
        glEachOccurrenceCents: 100_000_000,
        glAggregateCents: 200_000_000,
        autoCents: 100_000_000,
        umbrellaCents: 500_000_000,
        workersComp: true,
        additionalInsured: true,
      },
      warrantyMonths: 12,
      governingState: "CA",
    });
    expect(a.retainagePercent).toBe(5);
    expect(a.agreementNumber).not.toMatch(/A401/);
    const text = a.contractText;
    expect(text).toContain("AIA-style");
    expect(text).toContain("455 Embarcadero W, Oakland, CA 94607");
    expect(text).toContain("Owner: Harbor Point Dental LLC");
    expect(text).toContain("Oakland, Alameda County, California");
    expect(text).toContain("governed by the law of the State of California");
    expect(text).toContain("$172,400.00");
    expect(text).toContain("Retainage withheld from each progress payment: 5%.");
    expect(text).toContain("net 30 days");
    expect(text).not.toContain("Active & Verified");
    expect(text).toContain("1098765 (license record on file; no registry lookup)");
    for (const re of BANNED) expect(text, String(re)).not.toMatch(re);
  });

  test("an AZ award names Arizona and Maricopa County", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { agreementId } = await awardedAgreement(t, f.gcB.admin, AZ_PROJECT, { bidder: "Desert Electric" });
    const a = await load(t, agreementId);
    expect(a.terms!.governingState).toBe("AZ");
    expect(a.terms!.retainageBps).toBe(1000);
    expect(a.contractText).toContain("Phoenix, Maricopa County, Arizona");
    expect(a.contractText).toContain("State of Arizona");
    for (const re of BANNED) expect(a.contractText, String(re)).not.toMatch(re);
  });

  test("a CSLB lookup result is shown on the license line", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { agreementId } = await awardedAgreement(t, f.gcA.admin, CA_PROJECT);
    const a0 = await load(t, agreementId);
    await t.run(async (ctx) => {
      await ctx.db.insert("licenseChecks", {
        contractorId: a0.contractorId,
        licenseNumber: "1098765",
        state: "CA",
        status: "active",
        rawSummary: "Active",
        checkedAt: Date.UTC(2026, 9, 8),
        phase: "done",
      });
    });
    await f.gcA.admin.as.mutation(api.agreementTerms.updateAgreementTerms, { agreementId, terms: a0.terms! });
    expect((await load(t, agreementId)).contractText).toContain("1098765 (CSLB lookup: active, Oct 8, 2026)");
  });
});

describe("GC edits terms before execution", () => {
  test("edits persist, mirror into the payout retainage fields and appear in the subcontract text", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { agreementId } = await awardedAgreement(t, f.gcA.admin, CA_PROJECT);
    const before = await load(t, agreementId);
    await f.gcA.admin.as.mutation(api.agreementTerms.updateAgreementTerms, { agreementId, terms: edited(before.terms!) });
    const a = await load(t, agreementId);
    expect(a.terms).toMatchObject({
      paymentTerms: { type: "pay_when_paid", days: 10 },
      liquidatedDamagesCentsPerDay: 25_000,
      warrantyMonths: 24,
      retainageReductionBpsAt50: 250,
      insurance: { umbrellaCents: 200_000_000 },
    });
    expect(a.liquidatedDamagesDaily).toBe(250);
    expect(retainagePercentFor(a)).toBe(5);
    expect(a.contractText).toContain("Retainage withheld from each progress payment: 5%, reduced to 2.5% at 50% complete.");
    expect(a.contractText).toContain("pay-when-paid, 10 days");
    expect(a.contractText).toContain("$250.00 per day");
    expect(a.contractText).toContain("Umbrella / excess liability: $2,000,000.00");
    expect(a.contractText).toContain("24 months from Substantial Completion");

    const view = await f.gcA.admin.as.query(api.agreementTerms.getAgreementTerms, { agreementId });
    expect(view.canEdit).toBe(true);
    expect(view.terms.paymentTerms).toEqual({ type: "pay_when_paid", days: 10 });
  });

  test("invalid values are rejected and nothing is saved", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { agreementId } = await awardedAgreement(t, f.gcA.admin, CA_PROJECT);
    const before = await load(t, agreementId);
    const base = before.terms!;
    const cases: [AgreementTerms, RegExp][] = [
      [{ ...base, retainageBps: 700 }, /California caps retainage at 5%.*Cal\. Civ\. Code §8811.*not legal advice/],
      [{ ...base, warrantyMonths: -1 }, /Warranty must be/],
      [{ ...base, paymentTerms: { type: "net", days: 0 } }, /Payment days must be/],
      [{ ...base, insurance: { ...base.insurance, glAggregateCents: 50_000_000 } }, /aggregate can't be lower/],
      [{ ...base, retainageReductionBpsAt50: 600 }, /can't be higher than the retainage/],
      [{ ...base, governingState: "ZZ" }, /governing state/],
    ];
    for (const [terms, message] of cases) {
      await expect(f.gcA.admin.as.mutation(api.agreementTerms.updateAgreementTerms, { agreementId, terms })).rejects.toThrow(message);
    }
    const after = await load(t, agreementId);
    expect(after.terms).toEqual(before.terms);
    expect(after.contractText).toBe(before.contractText);
  });
});

describe("terms lock and party rules", () => {
  test("terms are locked after execution for every caller", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { agreementId } = await awardedAgreement(t, f.gcA.admin, CA_PROJECT);
    await f.gcA.admin.as.mutation(api.agreements.executeAgreement, { agreementId });
    const before = await load(t, agreementId);
    await expect(
      f.gcA.admin.as.mutation(api.agreementTerms.updateAgreementTerms, { agreementId, terms: edited(before.terms!) }),
    ).rejects.toThrow("Terms are locked after execution.");
    const view = await f.gcA.admin.as.query(api.agreementTerms.getAgreementTerms, { agreementId });
    expect(view).toMatchObject({ locked: true, canEdit: false });
    expect((await load(t, agreementId)).terms).toEqual(before.terms);
  });

  test("only the project's GC can edit; the sub reads, the owner and another GC get Not found", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { projectId, agreementId } = await awardedAgreement(t, f.gcA.admin, CA_PROJECT, { subCompanyId: f.sub.companyId });
    await t.run(async (ctx) => {
      await ctx.db.insert("projectMembers", { projectId, companyId: f.owner.companyId, partyRole: "owner", status: "active", createdAt: Date.now() });
    });
    const before = await load(t, agreementId);
    const terms = edited(before.terms!);
    for (const caller of [f.sub.admin, f.owner.admin, f.gcB.admin, f.demo.gc]) {
      await expect(caller.as.mutation(api.agreementTerms.updateAgreementTerms, { agreementId, terms })).rejects.toThrow(/Not found/);
    }
    await expect(t.mutation(api.agreementTerms.updateAgreementTerms, { agreementId, terms })).rejects.toThrow(/Not authenticated/);
    expect((await load(t, agreementId)).terms).toEqual(before.terms);

    const subView = await f.sub.admin.as.query(api.agreementTerms.getAgreementTerms, { agreementId });
    expect(subView).toMatchObject({ canEdit: false, locked: false });
    expect(subView.terms.retainageBps).toBe(500);
    for (const caller of [f.owner.admin, f.gcB.admin, f.demo.gc]) {
      await expect(caller.as.query(api.agreementTerms.getAgreementTerms, { agreementId })).rejects.toThrow(/Not found/);
    }
  });
});

describe("execution revalidates against the current project", () => {
  async function editProject(gc: FixtureUser, projectId: Id<"projects">, setup: Record<string, unknown>) {
    await gc.as.mutation(api.projects.updateProject, { projectId, ...projectSetupArgs(setup) });
  }

  test("an AZ draft whose project is corrected to CA cannot be executed with its 10% terms", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { projectId, agreementId } = await awardedAgreement(t, f.gcA.admin, AZ_PROJECT);
    await editProject(f.gcA.admin, projectId, { ...AZ_PROJECT, address: { line1: "455 Embarcadero W", city: "Oakland", zip: "94607" }, state: "CA", retainageBps: 500 });
    await expect(f.gcA.admin.as.mutation(api.agreements.executeAgreement, { agreementId })).rejects.toThrow(
      /California caps retainage at 5%.*Edit the agreement terms before executing/,
    );
    const a = await load(t, agreementId);
    expect(a.status).toBe("generated");
    expect(a.terms!.retainageBps).toBe(1000);
  });

  test("lowering a CA project's prime retainage below the draft's rate blocks execution until the terms are edited", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { projectId, agreementId } = await awardedAgreement(t, f.gcA.admin, CA_PROJECT);
    await editProject(f.gcA.admin, projectId, { ...CA_PROJECT, retainageBps: 300 });
    await expect(f.gcA.admin.as.mutation(api.agreements.executeAgreement, { agreementId })).rejects.toThrow(/exceed the prime contract's 3%/);
    expect((await load(t, agreementId)).status).toBe("generated");
    const before = await load(t, agreementId);
    await f.gcA.admin.as.mutation(api.agreementTerms.updateAgreementTerms, { agreementId, terms: { ...before.terms!, retainageBps: 300 } });
    await f.gcA.admin.as.mutation(api.agreements.executeAgreement, { agreementId });
    expect((await load(t, agreementId)).status).toBe("executed");
  });

  test("execution records the current project address, owner and venue; executed text stays fixed afterwards", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { projectId, agreementId } = await awardedAgreement(t, f.gcA.admin, CA_PROJECT);
    await editProject(f.gcA.admin, projectId, {
      ...CA_PROJECT,
      ownerName: "Harbor Point Dental Group Inc.",
      address: { line1: "1 Main St", city: "San Jose", zip: "95113" },
    });
    await f.gcA.admin.as.mutation(api.agreements.executeAgreement, { agreementId });
    const executed = await load(t, agreementId);
    expect(executed.status).toBe("executed");
    expect(executed.contractText).toContain("1 Main St, San Jose, CA 95113");
    expect(executed.contractText).toContain("Owner: Harbor Point Dental Group Inc.");
    expect(executed.contractText).toContain("San Jose, Santa Clara County, California");
    expect(executed.contractText).not.toContain("Embarcadero");

    await editProject(f.gcA.admin, projectId, { ...CA_PROJECT, ownerName: "Someone Else LLC" });
    await f.gcA.admin.as.mutation(api.agreements.executeAgreement, { agreementId });
    expect((await load(t, agreementId)).contractText).toBe(executed.contractText);
  });

  test("an AZ draft at 5% whose project is corrected to CA / Oakland executes under California law and Alameda venue", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { projectId, agreementId } = await awardedAgreement(t, f.gcA.admin, { ...AZ_PROJECT, retainageBps: 500 });
    expect((await load(t, agreementId)).terms!.governingState).toBe("AZ");
    await editProject(f.gcA.admin, projectId, { ...CA_PROJECT, title: AZ_PROJECT.title });

    const view = await f.gcA.admin.as.query(api.agreementTerms.getAgreementTerms, { agreementId });
    expect(view.terms.governingState).toBe("CA");

    await f.gcA.admin.as.mutation(api.agreements.executeAgreement, { agreementId });
    const a = await load(t, agreementId);
    expect(a.status).toBe("executed");
    expect(a.terms!.governingState).toBe("CA");
    expect(a.contractText).toContain("governed by the law of the State of California");
    expect(a.contractText).toContain("Oakland, Alameda County, California");
    expect(a.contractText).not.toMatch(/Arizona|Maricopa/);
  });

  test("a governing state the GC chose is kept, while retainage is still checked against the project state", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { projectId, agreementId } = await awardedAgreement(t, f.gcA.admin, AZ_PROJECT);
    const draft = await load(t, agreementId);
    await f.gcA.admin.as.mutation(api.agreementTerms.updateAgreementTerms, {
      agreementId,
      terms: { ...draft.terms!, governingState: "NV" },
    });
    await editProject(f.gcA.admin, projectId, { ...CA_PROJECT, title: AZ_PROJECT.title });

    await expect(f.gcA.admin.as.mutation(api.agreements.executeAgreement, { agreementId })).rejects.toThrow(
      /California caps retainage at 5%.*Edit the agreement terms before executing/,
    );
    const view = await f.gcA.admin.as.query(api.agreementTerms.getAgreementTerms, { agreementId });
    expect(view.terms.governingState).toBe("NV");
    await f.gcA.admin.as.mutation(api.agreementTerms.updateAgreementTerms, {
      agreementId,
      terms: { ...view.terms, retainageBps: 500 },
    });
    await f.gcA.admin.as.mutation(api.agreements.executeAgreement, { agreementId });
    const a = await load(t, agreementId);
    expect(a.status).toBe("executed");
    expect(a.terms!.governingState).toBe("NV");
    expect(a.contractText).toContain("governed by the law of the State of Nevada");
    expect(a.contractText).toContain("Oakland, Alameda County, California");
  });
});

describe("drafts saved before governing-law provenance was recorded", () => {
  async function legacyDraft(t: ReturnType<typeof convexTest>, agreementId: Id<"agreements">, governingState: string) {
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(agreementId))!;
      await ctx.db.patch(agreementId, { terms: { ...a.terms!, governingState }, governingStateExplicit: undefined });
    });
    expect((await load(t, agreementId)).governingStateExplicit).toBeUndefined();
  }

  test("an AZ draft saved with Nevada law and no flag keeps Nevada through display and execution", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { agreementId } = await awardedAgreement(t, f.gcA.admin, { ...AZ_PROJECT, retainageBps: 500 });
    await legacyDraft(t, agreementId, "NV");

    const view = await f.gcA.admin.as.query(api.agreementTerms.getAgreementTerms, { agreementId });
    expect(view.terms.governingState).toBe("NV");
    await f.gcA.admin.as.mutation(api.agreements.executeAgreement, { agreementId });
    const a = await load(t, agreementId);
    expect(a.status).toBe("executed");
    expect(a.terms!.governingState).toBe("NV");
    expect(a.contractText).toContain("governed by the law of the State of Nevada");
    expect(a.contractText).not.toContain("governed by the law of the State of Arizona");
  });

  test("a legacy Nevada choice survives a project correction to CA; a legacy default follows the correction", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const nv = await awardedAgreement(t, f.gcA.admin, { ...AZ_PROJECT, retainageBps: 500 });
    await legacyDraft(t, nv.agreementId, "NV");
    const def = await awardedAgreement(t, f.gcA.admin, { ...AZ_PROJECT, retainageBps: 500 }, { bidder: "Valley Electric" });
    await legacyDraft(t, def.agreementId, "AZ");

    await f.gcA.admin.as.mutation(api.projects.updateProject, { projectId: nv.projectId, ...projectSetupArgs({ ...CA_PROJECT, title: AZ_PROJECT.title }) });
    await f.gcA.admin.as.mutation(api.projects.updateProject, { projectId: def.projectId, ...projectSetupArgs({ ...CA_PROJECT, title: AZ_PROJECT.title }) });

    expect((await f.gcA.admin.as.query(api.agreementTerms.getAgreementTerms, { agreementId: nv.agreementId })).terms.governingState).toBe("NV");
    expect((await f.gcA.admin.as.query(api.agreementTerms.getAgreementTerms, { agreementId: def.agreementId })).terms.governingState).toBe("CA");
    await f.gcA.admin.as.mutation(api.agreements.executeAgreement, { agreementId: nv.agreementId });
    const a = await load(t, nv.agreementId);
    expect(a.terms!.governingState).toBe("NV");
    expect(a.contractText).toContain("governed by the law of the State of Nevada");
    expect(a.contractText).toContain("Oakland, Alameda County, California");
  });

  test("the backfill flags unflagged drafts by comparing with the project state and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const nv = await awardedAgreement(t, f.gcA.admin, AZ_PROJECT);
    await legacyDraft(t, nv.agreementId, "NV");
    const def = await awardedAgreement(t, f.gcA.admin, AZ_PROJECT, { bidder: "Valley Electric" });
    await legacyDraft(t, def.agreementId, "AZ");

    const run = () => t.mutation(internal.agreementTerms.backfillGoverningStateExplicit, { paginationOpts: { numItems: 100, cursor: null } });
    const first = await run();
    expect(first.updated).toBeGreaterThanOrEqual(2);
    expect((await load(t, nv.agreementId)).governingStateExplicit).toBe(true);
    expect((await load(t, def.agreementId)).governingStateExplicit).toBe(false);
    expect((await run()).updated).toBe(0);
    expect((await load(t, nv.agreementId)).terms!.governingState).toBe("NV");
  });

  test("a newly generated draft is recorded as following the project state", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const { agreementId } = await awardedAgreement(t, f.gcA.admin, AZ_PROJECT);
    expect((await load(t, agreementId)).governingStateExplicit).toBe(false);
  });
});

describe("backfill", () => {
  test("legacy agreements get terms from their stored fields; executed text is kept", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const id = f.gcA.project.agreementId;
    const before = await load(t, id);
    expect(before.terms).toBeUndefined();
    const res = await t.mutation(internal.agreementTerms.backfillAgreementTerms, { paginationOpts: { numItems: 50, cursor: null } });
    expect(res.updated).toBeGreaterThan(0);
    const after = await load(t, id);
    expect(after.terms).toMatchObject({ retainageBps: 500, governingState: "CA" });
    expect(after.terms!.liquidatedDamagesCentsPerDay).toBeUndefined();
    expect(after.contractText).toBe(before.contractText);
    const again = await t.mutation(internal.agreementTerms.backfillAgreementTerms, { paginationOpts: { numItems: 50, cursor: null } });
    expect(again.updated).toBe(0);
  });
});

describe("legacy project locations", () => {
  test("street, city and state segments resolve to the city and state code", () => {
    const base = { title: "x", projectType: "x", estBudget: 1, targetCompletionWeeks: 1, specDocumentText: "", createdAt: 0 } as unknown as Doc<"projects">;
    expect(projectPlace({ ...base, location: "455 Embarcadero W, Oakland, CA 94607" })).toMatchObject({ city: "Oakland", state: "CA" });
    expect(projectPlace({ ...base, location: "Austin, TX" })).toMatchObject({ city: "Austin", state: "TX" });
    expect(projectPlace({ ...base, location: "2201 E Camelback Rd, Phoenix, Arizona" })).toMatchObject({ city: "Phoenix", state: "AZ" });
  });
});

describe("Demo company TX project", () => {
  test("the seeded demo agreement keeps 10% retainage and Texas governing law", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    const a = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
    expect(a.terms!.retainageBps).toBe(1000);
    expect(a.terms!.governingState).toBe("TX");
    expect(retainagePercentFor(a)).toBe(10);
    expect(a.contractText).toContain("State of Texas");
    expect(a.contractText).toContain("AIA-style");
  });
});
