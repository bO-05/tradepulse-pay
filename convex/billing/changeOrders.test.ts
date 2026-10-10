/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture } from "../lib/tenancyFixtures";
import { insertTestSession } from "../lib/testIdentity";

const modules = import.meta.glob("/convex/**/*.ts");
type T = TestConvex<typeof schema>;

const NOT_FOUND = /Not found/;

const fetchSpy = vi.fn(async () => {
  throw new Error("network disabled in tests");
});
beforeEach(() => {
  vi.useFakeTimers();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SOV = [800_000, 640_000, 3_150_000, 3_820_000, 4_200_000, 2_860_000, 1_270_000, 500_000];

async function setup() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  const { agreementId, projectId } = f.gcA.project;
  const extra = await t.run(async (ctx) => {
    await ctx.db.patch(projectId, { billingDay: 25, startDate: "2026-10-01", retainageBps: 500, state: "CA", contractValueCents: 124_000_000 });
    await ctx.db.patch(agreementId, { contractSum: 172_400, contractSumCents: 17_240_000, retainagePercent: 5 });
    const sov: Id<"scheduleOfValues">[] = [];
    for (const [i, cents] of SOV.entries()) {
      sov.push(
        await ctx.db.insert("scheduleOfValues", {
          agreementId,
          lineNo: i + 1,
          description: `Line ${i + 1}`,
          scheduledValueCents: cents,
          excludedScope: false,
        }),
      );
    }
    // A second sub on the same project (Ray, Lakeshore) for sub-versus-sub denials.
    const lakeshore = await ctx.db.insert("companies", { name: "Lakeshore Mechanical", kind: "sub", isDemo: false, createdAt: Date.now() });
    const rayId = await ctx.db.insert("users", { email: "ray@lakeshore.test", emailVerificationTime: Date.now() });
    await ctx.db.insert("userProfiles", { userId: rayId, role: "sub", displayName: "Ray", actorType: "human", companyId: lakeshore, createdAt: Date.now() });
    await ctx.db.insert("companyMembers", { companyId: lakeshore, userId: rayId, role: "admin", status: "active", createdAt: Date.now() });
    const contractor = await ctx.db.insert("contractors", {
      tradePackageId: f.gcA.project.tradePackageId,
      companyName: "Lakeshore Mechanical",
      contactEmail: "bids@lakeshore.invalid",
      licenseNumber: "0",
      licenseStatus: "Unverified",
      sourceUrl: "https://example.invalid",
      rfqStatus: "bid_received",
      linkedCompanyId: lakeshore,
    });
    await ctx.db.insert("projectMembers", { projectId, companyId: lakeshore, partyRole: "sub", contractorId: contractor, status: "active", createdAt: Date.now() });
    const session = await insertTestSession(ctx, rayId);
    return { sov, rayId, session };
  });
  const ray = t.withIdentity({ subject: `${extra.rayId}|${extra.session}`, email: "ray@lakeshore.test" });
  return {
    t,
    f,
    agreementId,
    projectId,
    sov: extra.sov,
    dana: f.gcA.admin.as,
    kim: f.sub.admin.as,
    mendez: f.owner.admin.as,
    priya: f.gcB.admin.as,
    ray,
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function subCo(s: Setup, title: string, amountCents: number, by: "kim" | "dana" = "kim") {
  const caller = by === "kim" ? s.kim : s.dana;
  const { changeOrderId } = await caller.mutation(api.billing.changeOrders.createChangeOrder, {
    scope: "subcontract",
    agreementId: s.agreementId,
    title,
    amountCents,
  });
  return changeOrderId;
}

async function approvedSubCo(s: Setup, title: string, amountCents: number) {
  const id = await subCo(s, title, amountCents);
  await s.kim.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId: id });
  return { id, result: await s.dana.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: id }) };
}

/** An approved pay app that billed $90,437.50 against the original lines. */
async function billPayApp1(s: Setup) {
  const { payAppId } = await s.kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
  const approved = [800_000, 640_000, 3_150_000, 3_820_000, 633_750];
  await s.kim.mutation(api.payApps.g703.saveDraft, {
    payAppId,
    lines: approved.map((cents, i) => ({ sovLineId: s.sov[i], workThisPeriodCents: cents, storedCents: 0 })),
  });
  await s.kim.mutation(api.payApps.g703.submitPayApp, { payAppId });
  await s.t.run(async (ctx) => {
    await ctx.db.patch(payAppId, {
      status: "approved",
      finalApproval: {
        totalCents: 9_043_750,
        lines: approved.map((cents, i) => ({ sovLineId: s.sov[i], approvedCents: cents })),
        approvedBy: s.f.gcA.admin.userId,
        approvedAt: Date.now(),
      },
    });
  });
  return payAppId;
}

async function coRows(t: T) {
  return await t.run(async (ctx) => JSON.stringify([await ctx.db.query("changeOrders").collect(), await ctx.db.query("scheduleOfValues").collect()]));
}

async function notificationTitles(t: T, companyId: Id<"companies">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("notifications").collect()).filter((n) => n.companyId === companyId).map((n) => n.title),
  );
}

describe("subcontract change orders", () => {
  test("the worked example: CO #1 +$8,750.00 adds SOV line 9 and makes the contract sum to date $181,150.00", async () => {
    const s = await setup();
    const id = await subCo(s, "Add 6 duplex receptacles", 875_000);
    let list = await s.kim.query(api.billing.changeOrders.listForAgreement, { agreementId: s.agreementId });
    expect(list!.changeOrders[0]).toMatchObject({ label: "CO #1", status: "draft", canEdit: true, canSubmit: true });
    // The GC does not see the sub's draft.
    expect((await s.dana.query(api.billing.changeOrders.listForAgreement, { agreementId: s.agreementId }))!.changeOrders).toEqual([]);

    await s.kim.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId: id });
    expect(await notificationTitles(s.t, s.f.gcA.companyId)).toContain("Change order CO #1 submitted – $8,750.00");
    const view = await s.dana.query(api.billing.changeOrders.getChangeOrder, { changeOrderId: id });
    expect(view.canApprove).toBe(true);
    expect(view.approvalPreview!.message).toBe("Adds SOV line 9 for $8,750.00; contract sum to date becomes $181,150.00");

    const result = await s.dana.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: id });
    expect(result).toMatchObject({ status: "approved", lineNo: 9, contractSumToDateCents: 18_115_000 });
    expect(await notificationTitles(s.t, s.f.sub.companyId)).toContain("Change order CO #1 approved");

    const sov = await s.kim.query(api.billing.sov.getSov, { agreementId: s.agreementId });
    expect(sov).toMatchObject({ originalContractSumCents: 17_240_000, netChangeOrdersCents: 875_000, contractSumToDateCents: 18_115_000 });
    list = await s.kim.query(api.billing.changeOrders.listForAgreement, { agreementId: s.agreementId });
    expect(list!.contractSum).toMatchObject({ originalCents: 17_240_000, toDateCents: 18_115_000 });
    expect(list!.changeOrders[0]).toMatchObject({ status: "approved", sovLineNo: 9, canEdit: false });
  });

  test("the next pay app carries the CO line and the G702 shows the net change", async () => {
    const s = await setup();
    await approvedSubCo(s, "Add 6 duplex receptacles", 875_000);
    const { payAppId } = await s.kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    const view = await s.kim.query(api.payApps.g703.getPayApp, { payAppId });
    const line = view.lines.find((l) => l.lineNo === 9)!;
    expect(line).toMatchObject({ description: "CO #1 – Add 6 duplex receptacles", scheduledValueCents: 875_000 });
    expect(view.summary).toMatchObject({ originalContractSumCents: 17_240_000, netChangeOrdersCents: 875_000, contractSumToDateCents: 18_115_000 });
    expect(view.changeOrders).toEqual([expect.objectContaining({ label: "CO #1", amountCents: 875_000, thisPeriod: true })]);
  });

  test("a deductive CO lowers the sum; one below the amount already billed is refused", async () => {
    const s = await setup();
    await approvedSubCo(s, "Add 6 duplex receptacles", 875_000);
    const co2 = await approvedSubCo(s, "Delete 2 exterior fixtures", -120_000);
    expect(co2.result).toMatchObject({ lineNo: 10, contractSumToDateCents: 17_995_000 });
    await billPayApp1(s);

    const id = await subCo(s, "Remove switchboard scope", -9_000_000);
    await s.kim.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId: id });
    const preview = (await s.dana.query(api.billing.changeOrders.getChangeOrder, { changeOrderId: id })).approvalPreview!;
    expect(preview.floorProblem).toContain("$89,950.00");
    expect(preview.floorProblem).toContain("$90,437.50");
    const before = await coRows(s.t);
    await expect(s.dana.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: id })).rejects.toThrow(/DEDUCTIVE_FLOOR|\$90,437\.50/);
    expect(await coRows(s.t)).toBe(before);
  });

  test("the GC rejects with a required reason; the sub sees it", async () => {
    const s = await setup();
    const id = await subCo(s, "Upsize feeders", 300_000);
    await s.kim.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId: id });
    await expect(s.dana.mutation(api.billing.changeOrders.rejectChangeOrder, { changeOrderId: id, reason: "  " })).rejects.toThrow(/reason/);
    await s.dana.mutation(api.billing.changeOrders.rejectChangeOrder, { changeOrderId: id, reason: "Covered by base scope" });
    const row = (await s.kim.query(api.billing.changeOrders.listForAgreement, { agreementId: s.agreementId }))!.changeOrders[0];
    expect(row).toMatchObject({ status: "rejected", rejectionReason: "Covered by base scope", canEdit: false });
    const sov = await s.kim.query(api.billing.sov.getSov, { agreementId: s.agreementId });
    expect(sov.contractSumToDateCents).toBe(17_240_000);
  });

  test("decided COs are immutable; submitted ones can be withdrawn by the requester only", async () => {
    const s = await setup();
    const { id } = await approvedSubCo(s, "Add 6 duplex receptacles", 875_000);
    const before = await coRows(s.t);
    for (const call of [
      s.kim.mutation(api.billing.changeOrders.updateChangeOrder, { changeOrderId: id, amountCents: 1 }),
      s.kim.mutation(api.billing.changeOrders.deleteChangeOrder, { changeOrderId: id }),
      s.dana.mutation(api.billing.changeOrders.rejectChangeOrder, { changeOrderId: id, reason: "Changed my mind" }),
    ]) {
      await expect(call).rejects.toThrow(/cannot be (edited|changed)/);
    }
    expect(await coRows(s.t)).toBe(before);

    const second = await subCo(s, "Second", 10_000);
    await s.kim.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId: second });
    await expect(s.dana.mutation(api.billing.changeOrders.withdrawChangeOrder, { changeOrderId: second })).rejects.toThrow(NOT_FOUND);
    expect(await s.kim.mutation(api.billing.changeOrders.withdrawChangeOrder, { changeOrderId: second })).toEqual({ status: "draft" });
    await s.kim.mutation(api.billing.changeOrders.deleteChangeOrder, { changeOrderId: second });
    // Numbering continues per agreement.
    expect((await subCo(s, "Third", 10_000, "dana")) !== second).toBe(true);
    const labels = (await s.dana.query(api.billing.changeOrders.listForAgreement, { agreementId: s.agreementId }))!.changeOrders.map((c) => c.label);
    expect(labels).toEqual(["CO #1", "CO #2"]);
  });

  test("a GC-drafted subcontract CO is decided by the GC once submitted, never by the sub", async () => {
    const s = await setup();
    const id = await subCo(s, "GC-requested change", 50_000, "dana");
    await s.dana.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId: id });
    await expect(s.kim.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: id })).rejects.toThrow(NOT_FOUND);
    expect(await s.dana.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: id })).toMatchObject({ status: "approved" });
  });
});

describe("prime change orders", () => {
  test("PCO #1 $9,975.00 approved by the owner makes the prime contract sum $1,249,975.00", async () => {
    const s = await setup();
    const { changeOrderId } = await s.dana.mutation(api.billing.changeOrders.createChangeOrder, {
      scope: "prime",
      projectId: s.projectId,
      title: "Owner-requested outlets",
      amountCents: 997_500,
    });
    expect((await s.mendez.query(api.billing.changeOrders.listForProject, { projectId: s.projectId })).prime!.changeOrders).toEqual([]);
    await s.dana.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId });
    expect(await notificationTitles(s.t, s.f.owner.companyId)).toContain("Change order awaiting your approval");

    await expect(s.dana.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId })).rejects.toThrow(NOT_FOUND);
    const owner = await s.mendez.query(api.billing.changeOrders.listForProject, { projectId: s.projectId });
    expect(owner.agreements).toEqual([]);
    expect(owner.prime!.changeOrders[0]).toMatchObject({ label: "PCO #1", canApprove: true, canReject: true });
    expect(owner.prime!.changeOrders[0].invoice.show).toBe(false);

    await s.mendez.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId });
    const gc = await s.dana.query(api.billing.changeOrders.listForProject, { projectId: s.projectId });
    expect(gc.prime!.contractSum).toMatchObject({ originalCents: 124_000_000, toDateCents: 124_997_500 });
    expect(gc.prime!.changeOrders[0]).toMatchObject({ status: "approved", canEdit: false });
    expect(await notificationTitles(s.t, s.f.gcA.companyId)).toContain("Change order PCO #1 approved");
    // Prime COs never add a line to a subcontract SOV.
    expect((await s.dana.query(api.billing.sov.getSov, { agreementId: s.agreementId })).contractSumToDateCents).toBe(17_240_000);
  });

  test("the owner rejects with a reason", async () => {
    const s = await setup();
    const { changeOrderId } = await s.dana.mutation(api.billing.changeOrders.createChangeOrder, {
      scope: "prime",
      projectId: s.projectId,
      title: "Lobby upgrade",
      amountCents: 50_000,
    });
    await s.dana.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId });
    await s.mendez.mutation(api.billing.changeOrders.rejectChangeOrder, { changeOrderId, reason: "Over budget" });
    const row = (await s.dana.query(api.billing.changeOrders.listForProject, { projectId: s.projectId })).prime!.changeOrders[0];
    expect(row).toMatchObject({ status: "rejected", rejectionReason: "Over budget" });
    expect(row.invoice.show).toBe(false);
  });
});

describe("VAL-ISO-008: change orders are company-scoped and owner-limited", () => {
  test("foreign and wrong-role calls are Not found and change nothing", async () => {
    const s = await setup();
    const sub = await subCo(s, "Add 6 duplex receptacles", 875_000);
    await s.kim.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId: sub });
    const { changeOrderId: prime } = await s.dana.mutation(api.billing.changeOrders.createChangeOrder, {
      scope: "prime",
      projectId: s.projectId,
      title: "Owner change",
      amountCents: 997_500,
    });
    await s.dana.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId: prime });
    const before = await coRows(s.t);

    const priyaCalls = [
      s.priya.query(api.billing.changeOrders.listForProject, { projectId: s.projectId }),
      s.priya.query(api.billing.changeOrders.getChangeOrder, { changeOrderId: sub }),
      s.priya.query(api.billing.changeOrders.getChangeOrder, { changeOrderId: prime }),
      s.priya.mutation(api.billing.changeOrders.createChangeOrder, { scope: "prime", projectId: s.projectId, title: "Forged", amountCents: 1 }),
      s.priya.mutation(api.billing.changeOrders.createChangeOrder, { scope: "subcontract", agreementId: s.agreementId, title: "Forged", amountCents: 1 }),
      s.priya.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: sub }),
      s.priya.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: prime }),
      s.priya.action(api.payments.invoices.sendChangeOrderInvoice, { changeOrderId: prime }),
    ];
    for (const call of priyaCalls) await expect(call).rejects.toThrow(NOT_FOUND);
    expect(await s.priya.query(api.billing.changeOrders.listForAgreement, { agreementId: s.agreementId })).toBeNull();

    for (const call of [
      s.ray.query(api.billing.changeOrders.getChangeOrder, { changeOrderId: sub }),
      s.ray.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: sub }),
      s.ray.query(api.billing.changeOrders.getChangeOrder, { changeOrderId: prime }),
      s.kim.query(api.billing.changeOrders.getChangeOrder, { changeOrderId: prime }),
      s.mendez.query(api.billing.changeOrders.getChangeOrder, { changeOrderId: sub }),
      s.mendez.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: sub }),
      s.mendez.mutation(api.billing.changeOrders.rejectChangeOrder, { changeOrderId: sub, reason: "No" }),
      s.mendez.mutation(api.billing.changeOrders.createChangeOrder, { scope: "prime", projectId: s.projectId, title: "Forged", amountCents: 1 }),
      s.kim.mutation(api.billing.changeOrders.createChangeOrder, { scope: "prime", projectId: s.projectId, title: "Forged", amountCents: 1 }),
    ]) {
      await expect(call).rejects.toThrow(NOT_FOUND);
    }
    expect(await s.ray.query(api.billing.changeOrders.listForAgreement, { agreementId: s.agreementId })).toBeNull();
    expect((await s.ray.query(api.billing.changeOrders.listForProject, { projectId: s.projectId })).agreements).toEqual([]);
    expect(await coRows(s.t)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();

    const owner = await s.mendez.query(api.billing.changeOrders.listForProject, { projectId: s.projectId });
    expect(owner.projectTitle).toBe("Harbor Point Dental Office TI");
    expect(owner.agreements).toEqual([]);
    expect(owner.prime!.changeOrders.map((c) => c.scope)).toEqual(["prime"]);
  });
});
