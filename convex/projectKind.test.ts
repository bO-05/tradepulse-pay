/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { buildTenancyFixture, type TenancyFixture } from "./lib/tenancyFixtures";

const modules = import.meta.glob("/convex/**/*.ts");

type T = TestConvex<typeof schema>;

/**
 * One pay app and one prime change order on gcA's project, so every list query has a row to
 * return. Neither carries projectKind: the kind is read from the project, never copied.
 */
async function seedActivity(t: T, fx: TenancyFixture) {
  return await t.run(async (ctx) => {
    const agreement = (await ctx.db.get(fx.gcA.project.agreementId))!;
    const payAppId = await ctx.db.insert("payApplications", {
      agreementId: agreement._id,
      contractorId: agreement.contractorId,
      subUserId: fx.sub.admin.userId,
      periodLabel: "Period 1",
      lines: [],
      requestedTotalCents: 0,
      notes: "",
      lienWaiver: false,
      status: "submitted",
      submittedBy: { userId: fx.sub.admin.userId, actorType: "human" },
      createdAt: Date.now(),
    });
    const changeOrderId = await ctx.db.insert("changeOrders", {
      projectId: fx.gcA.project.projectId,
      scope: "prime",
      number: 1,
      title: "Kind probe",
      description: "Proves the change-order view carries the job kind.",
      amountCents: 1_000,
      status: "submitted",
      createdAt: Date.now(),
    });
    return { payAppId, changeOrderId };
  });
}

/**
 * Reads projectKind from every job-scoped view model the mission's contract names, plus the
 * agreement summary. Every function is called through its real public query, so a missing return
 * validator field fails here.
 */
async function projectKindSurfaces(t: T, fx: TenancyFixture) {
  const { payAppId, changeOrderId } = await seedActivity(t, fx);
  const projectId = fx.gcA.project.projectId;
  const agreementId = fx.gcA.project.agreementId;

  const gc = fx.gcA.admin.as;
  const sub = fx.sub.admin.as;

  const payApp = await gc.query(api.payApps.g703.getPayApp, { payAppId });
  const subAgreements = await sub.query(api.payApps.g703.mySubPayAppAgreements, {});
  const worklist = await gc.query(api.payApps.g703.gcBillingWorklist, {});
  const ownerPayApps = await gc.query(api.billing.ownerPayApps.listOwnerPayApps, { projectId });
  const billingProjects = await gc.query(api.billing.ownerPayApps.ownerBillingProjects, {});
  const projectChangeOrders = await gc.query(api.billing.changeOrders.listForProject, { projectId });
  const agreementChangeOrders = await gc.query(api.billing.changeOrders.listForAgreement, { agreementId });
  const changeOrderProjects = await gc.query(api.billing.changeOrders.myChangeOrderProjects, {});
  const changeOrder = await gc.query(api.billing.changeOrders.getChangeOrder, { changeOrderId });
  const retainage = await gc.query(api.billing.retainage.projectRetainage, {});
  const subOverview = await sub.query(api.portal.subOverview, {});
  const subPortal = await sub.query(api.portal.mySubPortal, {});
  const ownerOverviewGc = await gc.query(api.portal.ownerOverview, {});
  const ownerOverviewOwner = await fx.owner.admin.as.query(api.portal.ownerOverview, {});
  const agreementSummary = await sub.query(api.portal.getAgreementSummary, { agreementId });
  const project = await gc.query(api.projects.getProject, { projectId });
  const projects = await gc.query(api.projects.listProjects, {});

  return {
    "g703.getPayApp": payApp?.projectKind,
    "g703.mySubPayAppAgreements": subAgreements.find((a) => a.agreementId === agreementId)?.projectKind,
    "g703.gcBillingWorklist": worklist.rows.find((r) => r.agreementId === agreementId)?.projectKind,
    "ownerPayApps.listOwnerPayApps": ownerPayApps.projectKind,
    "ownerPayApps.ownerBillingProjects": billingProjects.find((p) => p._id === projectId)?.projectKind,
    "changeOrders.listForProject": projectChangeOrders.projectKind,
    "changeOrders.listForAgreement": agreementChangeOrders?.projectKind,
    "changeOrders.myChangeOrderProjects": changeOrderProjects.find((p) => p._id === projectId)?.projectKind,
    "changeOrders.getChangeOrder": changeOrder?.projectKind,
    "retainage.projectRetainage": retainage.projects.find((p) => p.projectId === projectId)?.projectKind,
    "portal.subOverview": subOverview.agreements.find((a) => a._id === agreementId)?.projectKind,
    "portal.subOverview.milestoneFunding": subOverview.milestoneFunding[0]?.projectKind,
    "portal.mySubPortal": subPortal.agreements.find((a) => a._id === agreementId)?.projectKind,
    "portal.ownerOverview.gc": ownerOverviewGc.find((p) => p._id === projectId)?.projectKind,
    "portal.ownerOverview.owner": ownerOverviewOwner.find((p) => p._id === projectId)?.projectKind,
    "portal.getAgreementSummary": agreementSummary?.projectKind,
    "projects.getProject": project?.projectKind,
    "projects.listProjects": projects.find((p) => p._id === projectId)?.projectKind,
  };
}

describe("projectKind on job-scoped queries", () => {
  test("a project with projectKind unset reads commercial everywhere and never throws", async () => {
    const t = convexTest(schema, modules);
    const fx = await buildTenancyFixture(t);

    const stored = await t.run(async (ctx) => (await ctx.db.get(fx.gcA.project.projectId))?.projectKind);
    // Convex may read an absent optional as undefined or null; either way the field is unset.
    expect(stored ?? null).toBeNull();

    const surfaces = await projectKindSurfaces(t, fx);
    for (const [surface, kind] of Object.entries(surfaces)) {
      expect(kind, `${surface} must default an unset projectKind to commercial`).toBe("commercial");
    }
  });

  test("a residential project reads residential from every job-scoped query", async () => {
    const t = convexTest(schema, modules);
    const fx = await buildTenancyFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(fx.gcA.project.projectId, { projectKind: "residential" });
    });

    const surfaces = await projectKindSurfaces(t, fx);
    for (const [surface, kind] of Object.entries(surfaces)) {
      expect(kind, `${surface} must report the stored residential kind`).toBe("residential");
    }
  });

  test("an unset project on another GC's books does not change the caller's kind", async () => {
    const t = convexTest(schema, modules);
    const fx = await buildTenancyFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(fx.gcA.project.projectId, { projectKind: "residential" });
    });

    // gcB's project is untouched; both GCs query the same function and get their own kind.
    const gcBProjects = await fx.gcB.admin.as.query(api.projects.listProjects, {});
    expect(gcBProjects.find((p) => p._id === fx.gcB.project.projectId)?.projectKind).toBe("commercial");
    const gcAProjects = await fx.gcA.admin.as.query(api.projects.listProjects, {});
    expect(gcAProjects.find((p) => p._id === fx.gcA.project.projectId)?.projectKind).toBe("residential");
  });
});
