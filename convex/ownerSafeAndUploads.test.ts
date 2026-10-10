/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture, type TenancyFixture } from "./lib/tenancyFixtures";

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in tests");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function errorData(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p;
  } catch (err) {
    return ((err as { data?: unknown }).data ?? { message: (err as Error).message }) as { code?: string; message?: string };
  }
  throw new Error("expected the call to fail");
}

/** Bayview's subcontract carries a bid/leveling contract text, an SOV line, and one invoiced plus one draft change order. */
async function ownerFixture() {
  const t = convexTest(schema, modules);
  const fx = await buildTenancyFixture(t);
  const a = fx.gcA.project;
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(a.agreementId, {
      contractSum: 41_234,
      contractText: "Base Bid: $41,234.00. Baseline Leveled Cost: $43,210.00.",
    });
    await ctx.db.insert("scheduleOfValues", {
      agreementId: a.agreementId,
      lineNo: 1,
      description: "Rough-in",
      scheduledValueCents: 4_123_400,
      excludedScope: false,
    });
    await ctx.db.insert("changeOrders", {
      agreementId: a.agreementId,
      projectId: a.projectId,
      scope: "prime",
      number: 1,
      description: "Owner-requested outlets",
      amountCents: 77_700,
      status: "invoiced",
      createdAt: now,
    });
    await ctx.db.insert("changeOrders", {
      projectId: a.projectId,
      scope: "prime",
      number: 2,
      description: "GC working draft",
      amountCents: 88_800,
      status: "draft",
      createdAt: now,
    });
    await ctx.db.insert("changeOrders", {
      agreementId: a.agreementId,
      projectId: a.projectId,
      scope: "subcontract",
      number: 1,
      title: "Subcontract-only change",
      description: "Between the GC and the sub",
      amountCents: 66_600,
      status: "approved",
      requestedByParty: "sub",
      createdAt: now,
    });
  });
  return { t, fx, a };
}

const SUB_AMOUNTS = [/41[,]?234/, /4123400/, /43[,]?210/, /Base Bid/, /Leveled/, /Eastbay/, /88800/, /66600/, /Subcontract-only/];

function expectNoSubcontractData(value: unknown, label: string) {
  const text = JSON.stringify(value);
  for (const pattern of SUB_AMOUNTS) expect(text, `${label} leaks ${pattern}`).not.toMatch(pattern);
}

describe("owners get owner-safe projections only", () => {
  test("dashboard, pay summary, agreements, overview and portal return no subcontract data to the owner", async () => {
    const { fx, a } = await ownerFixture();
    const owner = fx.owner.admin.as;

    for (const args of [{}, { projectId: a.projectId as string }]) {
      const dash = await owner.query(api.dashboard.queries.getDashboardData, args);
      expect(dash.agreements).toEqual([]);
      expect(dash.payments).toEqual([]);
      expect(dash.payApps).toEqual([]);
      expect(dash.retainage).toEqual([]);
      expect(dash.milestones).toEqual([]);
      expect(dash.changeOrders.map((c) => c.amountCents)).toEqual([77_700]);
      expect(dash.totals.contractSumCents).toBe(0);
      expect(dash.totals.changeOrdersInvoicedCents).toBe(77_700);
      expect(dash.readOnly).toBe(true);
      expectNoSubcontractData(dash, "getDashboardData");

      const pay = await owner.query(api.dashboard.payAgent.getPaySummary, args);
      expect(pay.agreements).toEqual([]);
      expect(pay.subcontractors).toEqual([]);
      expectNoSubcontractData(pay, "getPaySummary");
    }

    expect(await owner.query(api.agreements.listAgreements, { projectId: a.projectId })).toEqual([]);
    const overview = await owner.query(api.people.projectOverview, { projectId: a.projectId });
    expect(overview!.agreements).toEqual([]);
    expect(overview!.changeOrders.map((c) => c.amountCents)).toEqual([77_700]);
    expectNoSubcontractData(overview, "projectOverview");

    const portal = await owner.query(api.portal.ownerOverview, {});
    expect(portal).toHaveLength(1);
    expect(portal[0].agreements).toEqual([]);
    expect(portal[0].changeOrders.map((c) => c.amountCents)).toEqual([77_700]);
    expectNoSubcontractData(portal, "ownerOverview");

    const cos = await owner.query(api.billing.changeOrders.listForProject, { projectId: a.projectId });
    expect(cos.agreements).toEqual([]);
    expect(cos.prime!.canCreate).toBe(false);
    expect(cos.prime!.changeOrders.map((c) => c.amountCents)).toEqual([77_700]);
    expectNoSubcontractData(cos, "listForProject");
  });

  test("owner reads of subcontract records by id read Not found", async () => {
    const { fx, a } = await ownerFixture();
    const owner = fx.owner.admin.as;
    const notFound = { code: "NOT_FOUND", message: "Not found." };
    expect(await errorData(owner.query(api.bids.listByPackage, { tradePackageId: a.tradePackageId }))).toEqual(notFound);
    expect(await errorData(owner.query(api.contractors.listByPackage, { tradePackageId: a.tradePackageId }))).toEqual(notFound);
    expect(await owner.query(api.rfq.listConversations, { tradePackageId: a.tradePackageId }).catch((e) => e.data)).toEqual(notFound);
  });

  test("owner subcontract detail reads answer Not found for project and missing ids alike", async () => {
    const { t, fx, a } = await ownerFixture();
    const owner = fx.owner.admin.as;
    const notFound = { code: "NOT_FOUND", message: "Not found." };
    const payAppId = await t.run(async (ctx) =>
      ctx.db.insert("payApplications", {
        agreementId: a.agreementId,
        contractorId: a.contractorId,
        subUserId: fx.sub.admin.userId,
        periodLabel: "Owner probe",
        lines: [],
        requestedTotalCents: 0,
        notes: "",
        lienWaiver: true,
        status: "submitted",
        submittedBy: { userId: fx.sub.admin.userId, actorType: "human" },
        createdAt: Date.now(),
      }),
    );
    const missingAgreement = await t.run(async (ctx) => {
      const { _id, _creationTime, ...copy } = (await ctx.db.get(a.agreementId))!;
      const id = await ctx.db.insert("agreements", copy);
      await ctx.db.delete(id);
      return id;
    });
    for (const agreementId of [a.agreementId as string, missingAgreement as string, "not-an-id"]) {
      expect(await errorData(owner.query(api.payments.ledger.getAgreementLedger, { agreementId })), agreementId).toEqual(notFound);
      expect(await errorData(owner.query(api.portal.getAgreementSummary, { agreementId })), agreementId).toEqual(notFound);
      expect(await errorData(owner.query(api.payApps.submit.payAppFormContext, { agreementId })), agreementId).toEqual(notFound);
      expect(await errorData(owner.query(api.payApps.review.listAgreementPayApps, { agreementId })), agreementId).toEqual(notFound);
    }
    expect(await errorData(owner.query(api.payApps.proposals.getAgentTrace, { payAppId }))).toEqual(notFound);
    // Other companies' callers keep the blank answer.
    expect(await fx.gcB.admin.as.query(api.payments.ledger.getAgreementLedger, { agreementId: a.agreementId })).toBeNull();
    expect(await fx.gcB.admin.as.query(api.portal.getAgreementSummary, { agreementId: a.agreementId })).toBeNull();
  });

  test("the GC and the sub still see their subcontract data", async () => {
    const { fx, a } = await ownerFixture();
    const dash = await fx.gcA.admin.as.query(api.dashboard.queries.getDashboardData, {});
    expect(dash.agreements.map((r) => r.contractSumCents)).toEqual([4_123_400]);
    // The GC also sees its own draft prime CO, which has no agreement.
    expect(dash.changeOrders.map((c) => c.amountCents).sort()).toEqual([66_600, 77_700, 88_800]);
    expect(await fx.gcA.admin.as.query(api.payments.ledger.getAgreementLedger, { agreementId: a.agreementId })).not.toBeNull();
    expect(await fx.sub.admin.as.query(api.payments.ledger.getAgreementLedger, { agreementId: a.agreementId })).not.toBeNull();
    const subOverview = await fx.sub.admin.as.query(api.people.projectOverview, { projectId: a.projectId });
    expect(subOverview!.agreements).toHaveLength(1);
    // Another GC's owner-less project stays invisible to this owner.
    expect(await fx.owner.admin.as.query(api.people.projectOverview, { projectId: fx.gcB.project.projectId })).toBeNull();
  });
});

async function upload(t: T, body: string): Promise<Id<"_storage">> {
  return await t.run(async (ctx) => await ctx.storage.store(new Blob([body], { type: "application/pdf" })));
}

function saveArgs(projectId: Id<"projects">, uploadIntentId: Id<"uploadIntents">, storageId: string) {
  return {
    projectId,
    uploadIntentId,
    storageId,
    fileName: "drawing.pdf",
    fileType: "spec",
    fileSize: 1,
    uploadedBy: "ignored",
    contentType: "application/pdf",
  };
}

async function fileCount(t: T, fx: TenancyFixture) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("projectFiles").collect()).filter((f) => f.projectId === fx.gcB.project.projectId).length,
  );
}

describe("saveFileRecord binds uploads to the uploader and project", () => {
  test("a GC saves its own fresh upload; the same intent cannot be reused", async () => {
    const t = convexTest(schema, modules);
    const fx = await buildTenancyFixture(t);
    const dana = fx.gcA.admin.as;
    const projectId = fx.gcA.project.projectId;
    const { uploadIntentId, uploadUrl } = await dana.mutation(api.files.generateUploadUrl, { projectId });
    expect(uploadUrl).toBeTruthy();
    const storageId = await upload(t, "%PDF-1.4 bayview drawing");
    const fileId = await dana.mutation(api.files.saveFileRecord, saveArgs(projectId, uploadIntentId, storageId));
    expect(fileId).toBeTruthy();
    const again = await upload(t, "%PDF-1.4 second");
    expect((await errorData(dana.mutation(api.files.saveFileRecord, saveArgs(projectId, uploadIntentId, again)))).code).toBe("INVALID_UPLOAD");
  });

  test("another company cannot attach a Bayview storage id to its own project, download it, or delete it", async () => {
    const t = convexTest(schema, modules);
    const fx = await buildTenancyFixture(t);
    const dana = fx.gcA.admin.as;
    const sonoran = fx.gcB.admin.as;
    const bayviewProject = fx.gcA.project.projectId;
    const sonoranProject = fx.gcB.project.projectId;

    const own = await dana.mutation(api.files.generateUploadUrl, { projectId: bayviewProject });
    const intent = await sonoran.mutation(api.files.generateUploadUrl, { projectId: sonoranProject });
    // Uploaded after Sonoran's intent exists, and already filed on Bayview.
    const bayviewStorage = await upload(t, "%PDF-1.4 bayview confidential");
    await dana.mutation(api.files.saveFileRecord, saveArgs(bayviewProject, own.uploadIntentId, bayviewStorage));

    const alias = await errorData(sonoran.mutation(api.files.saveFileRecord, saveArgs(sonoranProject, intent.uploadIntentId, bayviewStorage)));
    expect(alias.code).toBe("INVALID_UPLOAD");
    expect(await fileCount(t, fx)).toBe(0);

    // A storage object that predates the caller's intent is refused even when nobody filed it yet.
    const orphan = await upload(t, "%PDF-1.4 someone else's unsaved upload");
    const late = await sonoran.mutation(api.files.generateUploadUrl, { projectId: sonoranProject });
    expect((await errorData(sonoran.mutation(api.files.saveFileRecord, saveArgs(sonoranProject, late.uploadIntentId, orphan)))).code).toBe(
      "INVALID_UPLOAD",
    );

    // Dana's intent cannot be used by Sonoran, nor for a different project by Dana.
    const danaIntent = await dana.mutation(api.files.generateUploadUrl, { projectId: bayviewProject });
    const fresh = await upload(t, "%PDF-1.4 fresh");
    expect((await errorData(sonoran.mutation(api.files.saveFileRecord, saveArgs(sonoranProject, danaIntent.uploadIntentId, fresh)))).code).toBe(
      "INVALID_UPLOAD",
    );
    expect(await fileCount(t, fx)).toBe(0);

    // Bayview's bytes stay intact and readable by Bayview only.
    expect(await t.run(async (ctx) => (await ctx.storage.get(bayviewStorage)) !== null)).toBe(true);
    const files = await dana.query(api.files.listFilesByProject, { projectId: bayviewProject });
    const path = files.find((f) => f.storageId === bayviewStorage)!.downloadPath!;
    expect((await dana.fetch(path, { method: "GET" })).status).toBe(200);
    expect((await sonoran.fetch(path, { method: "GET" })).status).toBe(404);
  });

  test("deleting one of two records that share a legacy storage object keeps the bytes for the other", async () => {
    const t = convexTest(schema, modules);
    const fx = await buildTenancyFixture(t);
    const storageId = await upload(t, "%PDF-1.4 shared legacy");
    const [first] = await t.run(async (ctx) => {
      const row = (projectId: Id<"projects">) =>
        ctx.db.insert("projectFiles", {
          projectId,
          storageId,
          fileName: "legacy.pdf",
          fileType: "spec",
          fileSize: 1,
          uploadedBy: "legacy",
          uploadedAt: Date.now(),
        });
      return [await row(fx.gcB.project.projectId), await row(fx.gcA.project.projectId)];
    });
    await fx.gcB.admin.as.mutation(api.files.deleteFile, { fileId: first });
    expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(true);
  });
});
