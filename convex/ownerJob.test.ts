/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";

const modules = import.meta.glob("/convex/**/*.ts");

type Status = "draft" | "submitted_to_owner" | "changes_requested" | "approved" | "approved_invoiced" | "paid";

function figures(completedAndStoredCents: number, retainageCents: number, currentPaymentDueCents: number, balanceToFinishInclRetainageCents: number) {
  return {
    originalContractSumCents: 5_000_000,
    netChangeOrdersCents: 0,
    contractSumToDateCents: 5_000_000,
    completedAndStoredCents,
    retainageCents,
    retainageWorkCents: retainageCents,
    retainageStoredCents: 0,
    earnedLessRetainageCents: completedAndStoredCents - retainageCents,
    previousCertificatesCents: 0,
    currentPaymentDueCents,
    balanceToFinishInclRetainageCents,
  };
}

async function addOwnerApp(
  t: ReturnType<typeof convexTest>,
  projectId: Id<"projects">,
  userId: Id<"users">,
  opts: {
    applicationNo: number;
    status: Status;
    completed: number;
    retainage: number;
    due: number;
    balance: number;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("ownerPayApps", {
      projectId,
      applicationNo: opts.applicationNo,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      status: opts.status,
      lines: [],
      retainageBps: 500,
      figures: figures(opts.completed, opts.retainage, opts.due, opts.balance),
      pendingSubPayApps: 0,
      history: [],
      createdBy: userId,
      createdAt: Date.now() + opts.applicationNo,
      updatedAt: Date.now() + opts.applicationNo,
      ...(opts.status === "submitted_to_owner" ? { submittedAt: Date.now() } : {}),
      ...(opts.status === "paid" ? { paidAt: Date.now() } : {}),
    }),
  );
}

describe("Owner job so far", () => {
  test("uses the latest approved owner pay app for progress while naming a submitted app that needs review", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(f.gcA.project.projectId, {
        contractValueCents: 5_000_000,
        retainageBps: 500,
        startDate: "2026-09-01",
        substantialCompletionDate: "2027-02-01",
      });
    });
    await addOwnerApp(t, f.gcA.project.projectId, f.gcA.admin.userId, {
      applicationNo: 1,
      status: "paid",
      completed: 1_000_000,
      retainage: 50_000,
      due: 950_000,
      balance: 4_000_000,
    });
    await addOwnerApp(t, f.gcA.project.projectId, f.gcA.admin.userId, {
      applicationNo: 2,
      status: "approved",
      completed: 2_000_000,
      retainage: 100_000,
      due: 950_000,
      balance: 3_000_000,
    });
    await addOwnerApp(t, f.gcA.project.projectId, f.gcA.admin.userId, {
      applicationNo: 3,
      status: "submitted_to_owner",
      completed: 3_000_000,
      retainage: 150_000,
      due: 950_000,
      balance: 2_000_000,
    });
    await addOwnerApp(t, f.gcA.project.projectId, f.gcA.admin.userId, {
      applicationNo: 4,
      status: "draft",
      completed: 4_000_000,
      retainage: 200_000,
      due: 950_000,
      balance: 1_000_000,
    });

    const overview = await f.owner.admin.as.query(api.portal.ownerOverview, {});
    const project = overview.find((p) => p._id === f.gcA.project.projectId);
    expect(project?.ownerJob).toMatchObject({
      basis: "approved",
      latestApplicationNo: 3,
      latestStatus: "submitted_to_owner",
      approvedApplicationNo: 2,
      paymentDueCents: 950_000,
      contractSumToDateCents: 5_000_000,
      completedAndStoredCents: 2_000_000,
      completionBps: 4_000,
      paidToDateCents: 950_000,
      paidApplicationCount: 1,
      retainageHeldCents: 100_000,
      balanceToFinishCents: 3_000_000,
      startDate: "2026-09-01",
      substantialCompletionDate: "2027-02-01",
    });
    expect(project?.primeRetainageHeldCents).toBe(100_000);
  });

  test("adds paid change orders to paid-to-date and leaves a submitted change order visible as open", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(f.gcA.project.projectId, { contractValueCents: 5_000_000 });
      const base = { projectId: f.gcA.project.projectId, scope: "prime" as const, createdAt: Date.now() };
      await ctx.db.insert("changeOrders", {
        ...base,
        number: 1,
        title: "Owner-paid direct change",
        description: "A paid prime change order.",
        amountCents: 185_000,
        status: "paid",
        paidAt: Date.now(),
      });
      await ctx.db.insert("changeOrders", {
        ...base,
        number: 2,
        title: "Approved change",
        description: "An approved prime change order.",
        amountCents: 50_000,
        status: "approved",
      });
      await ctx.db.insert("changeOrders", {
        ...base,
        number: 3,
        title: "Submitted change",
        description: "Waiting for the owner.",
        amountCents: 25_000,
        status: "submitted",
      });
    });

    const overview = await f.owner.admin.as.query(api.portal.ownerOverview, {});
    const job = overview.find((p) => p._id === f.gcA.project.projectId)?.ownerJob;
    expect(job).toMatchObject({
      basis: "none",
      paidToDateCents: 185_000,
      paidOwnerPayAppsCents: 0,
      paidChangeOrdersCents: 185_000,
      changeOrdersApprovedCents: 235_000,
      openChangeOrders: 1,
      contractSumToDateCents: 5_235_000,
      completedAndStoredCents: null,
      completionBps: null,
    });
  });

  test("hides an empty summary on a project with no prime value or activity", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const overview = await f.owner.admin.as.query(api.portal.ownerOverview, {});
    expect(overview.find((p) => p._id === f.gcA.project.projectId)).toMatchObject({ partyRole: "owner", ownerJob: null });
  });

  test("a GC never receives the owner job summary", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const overview = await f.gcA.admin.as.query(api.portal.ownerOverview, {});
    expect(overview.find((p) => p._id === f.gcA.project.projectId)).toMatchObject({ partyRole: "gc", ownerJob: null });
  });
});
