/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { api } from "./_generated/api";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";
import { withSession } from "./lib/testIdentity";

/** The backend sequence the GC Quick start wizard drives, in the same order. */

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const fx = await buildTenancyFixture(t);
  return { t, fx };
}

const PROJECT = {
  title: "Harbor Point Dental Office TI",
  ownerName: "Harbor Point Dental LLC",
  address: { line1: "455 Embarcadero W", city: "Oakland", state: "CA", zip: "94607" },
  state: "CA",
  contractValueCents: 124_000_000,
  retainageBps: 500,
  billingDay: 25,
  startDate: "2026-10-01",
  substantialCompletionDate: "2027-05-28",
};

const SOV = [
  { description: "Rough-in", scheduledValueCents: 2_200_000 },
  { description: "Trim-out", scheduledValueCents: 1_950_000 },
  { description: "Closeout", scheduledValueCents: 825_000 },
];
const SUB_EMAIL = "nora@eastbay-electric.example";

describe("GC Quick start backend sequence", () => {
  test("one job, one sub, an SOV, an executed subcontract, and a pending sub invite", async () => {
    const { t, fx } = await setup();
    const asGc = fx.gcA.admin.as;

    const projectId = await asGc.mutation(api.projects.createProject, PROJECT);
    const tradePackageId = await asGc.mutation(api.tradePackages.createTradePackage, {
      projectId,
      csiDivision: "26 00 00",
      tradeName: "Electrical",
      budgetEstimate: PROJECT.contractValueCents / 100,
      scopeSummary: "Electrical scope for Harbor Point Dental Office TI.",
      mandatoryInclusions: [],
      bidDeadline: "2026-11-19",
    });
    const added = await asGc.mutation(api.contractors.createVendorBidder, {
      tradePackageId,
      name: "Eastbay Electric",
      trades: ["26 00 00"],
      contactName: "Nora Patel",
      email: SUB_EMAIL,
      phone: "(510) 555-0142",
      licenseNumber: "C10-123456",
    });

    const totalCents = SOV.reduce((sum, line) => sum + line.scheduledValueCents, 0);
    const bid = await asGc.mutation(api.bids.submitDirectBid, {
      tradePackageId,
      contractorId: added.contractorId,
      subcontractorName: "Eastbay Electric",
      baseAmountCents: totalCents,
      lineItems: SOV.map((line) => ({
        item: line.description,
        unit: "LS",
        quantity: 1,
        unitCostCents: line.scheduledValueCents,
        totalCostCents: line.scheduledValueCents,
      })),
    });

    const agreement = await asGc.mutation(api.agreements.generateAgreement, { bidId: bid.bidId, tradePackageId });
    expect(agreement).not.toBeNull();
    await asGc.mutation(api.billing.sov.importSovLines, {
      agreementId: agreement!._id,
      rows: SOV.map((line) => ({ ...line, csiCode: "26 00 00" })),
    });
    await asGc.mutation(api.billing.sov.approveSov, { agreementId: agreement!._id });
    await asGc.mutation(api.agreements.executeAgreement, { agreementId: agreement!._id });
    const invite = await fx.gcA.admin.as.action(api.invites.create, {
      kind: "sub",
      email: SUB_EMAIL,
      projectId,
      vendorId: added.vendorId,
      sendEmail: false,
    });

    const savedAgreement = await t.run((ctx) => ctx.db.get(agreement!._id));
    expect(savedAgreement).toMatchObject({
      status: "executed",
      contractSumCents: totalCents,
      retainagePercent: 5,
      sov: { status: "approved" },
    });
    const lines = await t.run(async (ctx) =>
      await ctx.db.query("scheduleOfValues").withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement!._id)).collect(),
    );
    expect(lines).toHaveLength(3);
    expect(lines.reduce((sum, line) => sum + line.scheduledValueCents, 0)).toBe(totalCents);
    const milestones = await t.run(async (ctx) =>
      await ctx.db.query("milestones").withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", agreement!._id)).collect(),
    );
    // Real (non-demo) projects use GC-defined funding tranches, not the demo's generated milestones.
    expect(milestones).toHaveLength(0);

    const savedPackage = await t.run((ctx) => ctx.db.get(tradePackageId));
    expect(savedPackage?.status).toBe("awarded");
    const savedBid = await t.run((ctx) => ctx.db.get(bid.bidId));
    expect(savedBid?.isAwarded).toBe(true);

    const savedInvite = await t.run((ctx) => ctx.db.get(invite.inviteId));
    expect(savedInvite).toMatchObject({
      kind: "sub",
      email: SUB_EMAIL,
      projectId,
      vendorId: added.vendorId,
      status: "pending",
      emailStatus: "not_sent",
    });
    expect(invite.link).toContain("#/invite/");

    const subUserId = await t.run((ctx) =>
      ctx.db.insert("users", { email: SUB_EMAIL, emailVerificationTime: Date.now() }),
    );
    const sub = await withSession(t, subUserId, SUB_EMAIL);
    const token = invite.link.match(/#\/invite\/([A-Za-z0-9_-]+)$/)?.[1];
    expect(token).toBeTruthy();
    const accepted = await sub.mutation(api.invites.accept, { token: token! });
    expect(accepted).toMatchObject({ kind: "sub", projectId, companyId: expect.any(String) });
    const membership = await t.run(async (ctx) =>
      await ctx.db
        .query("projectMembers")
        .withIndex("by_project_company_and_status", (q) =>
          q.eq("projectId", projectId).eq("companyId", accepted.companyId).eq("status", "active"),
        )
        .first(),
    );
    expect(membership).not.toBeNull();
    const linkedVendor = await t.run((ctx) => ctx.db.get(added.vendorId));
    expect(linkedVendor?.linkedCompanyId).toBe(accepted.companyId);
  }, 120_000);
});
