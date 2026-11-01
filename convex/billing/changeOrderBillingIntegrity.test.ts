/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture } from "../lib/tenancyFixtures";
import { insertTestSession } from "../lib/testIdentity";
import { clearPayPalTokenCache } from "../payments/paypalClient";
import { CO_CAPACITY } from "../payments/changeOrderMath";

/**
 * Change orders and owner billing integrity: the deductive floor on prime COs, numbering and
 * aggregation within the documented change-order capacity, invoice cancellation leaving approved
 * scope in the contract, one billing path per prime CO, owner drafts refreshing approved sub work,
 * and change-order PDFs reporting the contract sum at approval.
 */

const modules = import.meta.glob("/convex/**/*.ts");
const OWNER_BILLING_EMAIL = "ap@harborpoint.test";
const SOV = [800_000, 640_000, 3_150_000, 3_820_000, 4_200_000, 2_860_000, 1_270_000, 500_000];

type Call = { method: string; path: string; requestId?: string; body: any };

/** Fake Invoicing v2 keyed by PayPal-Request-Id, like the sandbox. */
function fakeInvoicing() {
  const calls: Call[] = [];
  const invoices = new Map<string, { id: string; status: string; body: any }>();
  const byRequestId = new Map<string, string>();
  let n = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21AAfaketoken", expires_in: 32400 });
    const text = req.method === "GET" ? "" : await req.text();
    const requestId = req.headers.get("paypal-request-id") ?? undefined;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: url.pathname, requestId, body });
    if (req.method === "POST" && url.pathname === "/v2/invoicing/invoices") {
      let id = requestId ? byRequestId.get(requestId) : undefined;
      if (!id) {
        id = `INV2-INT-${++n}`;
        invoices.set(id, { id, status: "DRAFT", body });
        if (requestId) byRequestId.set(requestId, id);
      }
      return json(201, { rel: "self", href: `https://api.sandbox.paypal.com/v2/invoicing/invoices/${id}`, method: "GET" });
    }
    const send = url.pathname.match(/^\/v2\/invoicing\/invoices\/([^/]+)\/send$/);
    if (req.method === "POST" && send) {
      invoices.get(send[1])!.status = "SENT";
      return json(200, { href: `https://www.sandbox.paypal.com/invoice/p/#${send[1]}`, rel: "payer-view", method: "GET" });
    }
    const get = url.pathname.match(/^\/v2\/invoicing\/invoices\/([^/]+)$/);
    if (req.method === "GET" && get) {
      const inv = invoices.get(get[1]);
      if (!inv) return json(404, { name: "RESOURCE_NOT_FOUND" });
      return json(200, {
        id: inv.id,
        status: inv.status,
        detail: { ...inv.body.detail, metadata: inv.status === "DRAFT" ? {} : { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${inv.id}` } },
        primary_recipients: inv.body.primary_recipients,
      });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  });
  const posts = (re: RegExp) => calls.filter((c) => c.method === "POST" && re.test(c.path));
  return { fetchImpl, calls, posts, invoices };
}

let fake: ReturnType<typeof fakeInvoicing>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret-value");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  fake = fakeInvoicing();
  vi.stubGlobal("fetch", fake.fetchImpl);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearPayPalTokenCache();
});

async function setup() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  const { agreementId, projectId } = f.gcA.project;
  const extra = await t.run(async (ctx) => {
    await ctx.db.patch(projectId, {
      billingDay: 25,
      startDate: "2026-10-01",
      retainageBps: 500,
      state: "CA",
      contractValueCents: 124_000_000,
      ownerCompanyId: f.owner.companyId,
    });
    await ctx.db.patch(f.owner.companyId, { billingEmail: OWNER_BILLING_EMAIL });
    await ctx.db.patch(agreementId, { contractSum: 172_400, contractSumCents: 17_240_000, retainagePercent: 5 });
    const sov: Id<"scheduleOfValues">[] = [];
    for (const [i, cents] of SOV.entries()) {
      sov.push(await ctx.db.insert("scheduleOfValues", { agreementId, lineNo: i + 1, description: `Line ${i + 1}`, scheduledValueCents: cents, excludedScope: false }));
    }
    // Lakeshore Mechanical: a plumbing award whose pay app is submitted but not yet approved.
    const ag = (await ctx.db.get(agreementId))!;
    const lakeshore = await ctx.db.insert("companies", { name: "Lakeshore Mechanical", kind: "sub", isDemo: false, createdAt: Date.now() });
    const rayId = await ctx.db.insert("users", { email: "ray@lakeshore.test", emailVerificationTime: Date.now() });
    await ctx.db.insert("userProfiles", { userId: rayId, role: "sub", displayName: "Ray", actorType: "human", companyId: lakeshore, createdAt: Date.now() });
    const contractor = await ctx.db.insert("contractors", {
      tradePackageId: ag.tradePackageId,
      companyName: "Lakeshore Mechanical",
      contactEmail: "bids@lakeshore.invalid",
      licenseNumber: "0",
      licenseStatus: "Unverified",
      sourceUrl: "https://example.invalid",
      rfqStatus: "bid_received",
      linkedCompanyId: lakeshore,
    });
    const plumbing = await ctx.db.insert("agreements", {
      ...Object.fromEntries(Object.entries(ag).filter(([k]) => !k.startsWith("_"))),
      contractorId: contractor,
      agreementNumber: "FX-PLUMB",
      subcontractorName: "Lakeshore Mechanical",
      csiDivision: "22 00 00",
      tradeName: "Plumbing",
      contractSum: 98_000,
      contractSumCents: 9_800_000,
    } as any);
    const plumbingLine = await ctx.db.insert("scheduleOfValues", { agreementId: plumbing, lineNo: 1, description: "Rough-in", scheduledValueCents: 9_800_000, excludedScope: false });
    const plumbingPayApp = await ctx.db.insert("payApplications", {
      agreementId: plumbing,
      subUserId: rayId,
      periodLabel: "Oct 2026",
      periodEnd: "2026-10-25",
      lines: [{ sovLineId: plumbingLine, pctCompleteThisPeriod: 10, pctCompleteToDate: 10, requestedCents: 980_000 }],
      requestedTotalCents: 980_000,
      notes: "",
      lienWaiver: true,
      status: "submitted",
      submittedBy: { userId: rayId, actorType: "human" },
      createdAt: Date.now(),
    } as any);
    return { sov, plumbingLine, plumbingPayApp, raySession: await insertTestSession(ctx, rayId) };
  });
  return {
    t,
    f,
    agreementId,
    projectId,
    ...extra,
    dana: f.gcA.admin.as,
    kim: f.sub.admin.as,
    mendez: f.owner.admin.as,
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function primeCo(s: Setup, title: string, amountCents: number, opts: { approve?: boolean } = {}) {
  const { changeOrderId } = await s.dana.mutation(api.billing.changeOrders.createChangeOrder, { scope: "prime", projectId: s.projectId, title, amountCents });
  await s.dana.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId });
  if (opts.approve !== false) await s.mendez.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId });
  return changeOrderId as Id<"changeOrders">;
}

async function subCo(s: Setup, title: string, amountCents: number) {
  const { changeOrderId } = await s.kim.mutation(api.billing.changeOrders.createChangeOrder, { scope: "subcontract", agreementId: s.agreementId, title, amountCents });
  await s.kim.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId });
  return changeOrderId as Id<"changeOrders">;
}

async function addGeneralConditions(s: Setup) {
  const { primeLineId } = await s.dana.mutation(api.billing.primeLines.addPrimeLine, {
    projectId: s.projectId,
    description: "General conditions",
    scheduledValueCents: 9_600_000,
  });
  return `gc:${primeLineId}`;
}

/** Owner pay app #1 with $51,412.60 of General conditions, approved and invoiced by the owner. */
async function approvedOwnerPayApp1(s: Setup) {
  const gcKey = await addGeneralConditions(s);
  const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
  await s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [{ key: gcKey, workThisPeriodCents: 5_141_260 }] });
  await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
  await s.mendez.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> });
  return { ownerPayAppId, gcKey };
}

async function approvePlumbingPayApp(s: Setup) {
  await s.t.run(async (ctx) => {
    await ctx.db.patch(s.plumbingPayApp, {
      status: "approved",
      finalApproval: {
        totalCents: 980_000,
        lines: [{ sovLineId: s.plumbingLine, approvedCents: 980_000 }],
        approvedBy: s.f.gcA.admin.userId,
        approvedAt: Date.now(),
      },
    });
  });
}

async function coRow(s: Setup, id: Id<"changeOrders">) {
  return (await s.t.run(async (ctx) => await ctx.db.get(id)))!;
}

async function coPdfData(s: Setup, id: Id<"changeOrders">) {
  const out = await s.t.query(internal.documents.store.renderInput, { kind: "change_order_pdf", relatedId: id });
  return (out!.loaded.input as { data: { previousContractSumCents: number; newContractSumCents: number } }).data;
}

describe("deductive prime change orders respect the contract-sum floor", () => {
  test("a deduction that would make the prime contract negative is refused before it changes anything", async () => {
    const s = await setup();
    const id = await primeCo(s, "Delete the whole TI", -200_000_000, { approve: false });
    const before = await coRow(s, id);
    await expect(s.mendez.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: id })).rejects.toThrow(
      /-\$760,000\.00.*\$0\.00/,
    );
    expect(await coRow(s, id)).toEqual(before);
    const gc = await s.dana.query(api.billing.changeOrders.listForProject, { projectId: s.projectId });
    expect(gc.prime!.contractSum!.toDateCents).toBe(124_000_000);
  });

  test("a deduction below the owner's approved completed and stored billing is refused and names both figures", async () => {
    const s = await setup();
    await approvedOwnerPayApp1(s);
    // $1,240,000.00 − $1,190,000.00 = $50,000.00, below the $51,412.60 the owner approved.
    const id = await primeCo(s, "Delete most of the scope", -119_000_000, { approve: false });
    await expect(s.mendez.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: id })).rejects.toThrow(
      /\$50,000\.00.*\$51,412\.60/,
    );
    expect((await coRow(s, id)).status).toBe("submitted");
    // A smaller deduction that stays above the billed amount is approved.
    const ok = await primeCo(s, "Delete 2 exterior fixtures", -120_000, { approve: false });
    await expect(s.mendez.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: ok })).resolves.toMatchObject({ status: "approved" });
  });

  test("after a credit-only owner pay app certifies a negative amount, a deduction below $0.00 is still refused", async () => {
    const s = await setup();
    const credit = await primeCo(s, "Delete 2 exterior fixtures", -120_000);
    const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    const pcoKey = (await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId })).lines.find((l) => l.kind === "change_order")!.key;
    await s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [{ key: pcoKey, workThisPeriodCents: -120_000 }] });
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    await s.mendez.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> });
    const approved = await s.t.run(async (ctx) => await ctx.db.get(ownerPayAppId as Id<"ownerPayApps">));
    expect(approved!.figures.completedAndStoredCents).toBe(-120_000);
    expect((await coRow(s, credit)).status).toBe("approved");

    // $1,238,800.00 − $1,239,300.00 = −$500.00.
    const id = await primeCo(s, "Delete the rest of the scope", -123_930_000, { approve: false });
    const before = await coRow(s, id);
    await expect(s.mendez.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: id })).rejects.toThrow(/-\$500\.00.*\$0\.00/);
    expect(await coRow(s, id)).toEqual(before);
    const gc = await s.dana.query(api.billing.changeOrders.listForProject, { projectId: s.projectId });
    expect(gc.prime!.contractSum!.toDateCents).toBe(123_880_000);
    // Down to exactly $0.00 is allowed.
    const toZero = await primeCo(s, "Delete all remaining scope", -123_880_000, { approve: false });
    await expect(s.mendez.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: toZero })).resolves.toMatchObject({ status: "approved" });
  });
});

describe(`change-order numbering and aggregation within the ${CO_CAPACITY}-per-contract capacity`, () => {
  async function seedPrime(s: Setup, count: number, status: "approved" | "rejected", amountCents = 100) {
    await s.t.run(async (ctx) => {
      for (let n = 1; n <= count; n++) {
        await ctx.db.insert("changeOrders", {
          projectId: s.projectId,
          scope: "prime",
          number: n,
          title: `Seeded ${n}`,
          description: "",
          amountCents,
          status,
          requestedByParty: "gc",
          createdAt: Date.now(),
          ...(status === "approved" ? { approvedAt: Date.now() + n } : {}),
        });
      }
    });
  }

  test("numbers come from the highest existing number, even when it is beyond the listed rows", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("changeOrders", { projectId: s.projectId, scope: "prime", number: 7, title: "Old", description: "", amountCents: 100, status: "rejected", createdAt: Date.now() });
    });
    const a = await s.dana.mutation(api.billing.changeOrders.createChangeOrder, { scope: "prime", projectId: s.projectId, title: "A", amountCents: 100 });
    const b = await s.dana.mutation(api.billing.changeOrders.createChangeOrder, { scope: "prime", projectId: s.projectId, title: "B", amountCents: 100 });
    expect([(await coRow(s, a.changeOrderId)).number, (await coRow(s, b.changeOrderId)).number]).toEqual([8, 9]);
  });

  test(`the ${CO_CAPACITY}th CO is the last one: creation beyond it is refused with the capacity, never numbered twice`, async () => {
    const s = await setup();
    await seedPrime(s, CO_CAPACITY - 1, "approved");
    const last = await s.dana.mutation(api.billing.changeOrders.createChangeOrder, { scope: "prime", projectId: s.projectId, title: "Last", amountCents: 100 });
    expect((await coRow(s, last.changeOrderId)).number).toBe(CO_CAPACITY);
    await expect(
      s.dana.mutation(api.billing.changeOrders.createChangeOrder, { scope: "prime", projectId: s.projectId, title: "One too many", amountCents: 100 }),
    ).rejects.toThrow(new RegExp(`at most ${CO_CAPACITY} change orders`));
    // Every approved CO counts in the prime contract sum.
    const gc = await s.dana.query(api.billing.changeOrders.listForProject, { projectId: s.projectId });
    expect(gc.prime!.contractSum!.toDateCents).toBe(124_000_000 + (CO_CAPACITY - 1) * 100);
  });

  test("subcontract COs share the same capacity per agreement", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let n = 1; n <= CO_CAPACITY; n++) {
        await ctx.db.insert("changeOrders", { agreementId: s.agreementId, projectId: s.projectId, scope: "subcontract", number: n, title: `S${n}`, description: "", amountCents: 100, status: "rejected", createdAt: Date.now() });
      }
    });
    await expect(
      s.kim.mutation(api.billing.changeOrders.createChangeOrder, { scope: "subcontract", agreementId: s.agreementId, title: "Too many", amountCents: 100 }),
    ).rejects.toThrow(new RegExp(`at most ${CO_CAPACITY} change orders`));
  });

  test("a contract holding more COs than the capacity is refused explicitly instead of summed partially", async () => {
    const s = await setup();
    await seedPrime(s, CO_CAPACITY + 1, "approved");
    await expect(s.dana.query(api.billing.changeOrders.listForProject, { projectId: s.projectId })).rejects.toThrow(/CO_CAPACITY|at most/);
  });
});

describe("cancelling a change-order invoice leaves the approved scope in the contract", () => {
  test("PCO #1 stays in the prime contract sum and the owner roll-up after its PayPal invoice is cancelled", async () => {
    const s = await setup();
    const id = await primeCo(s, "Owner-requested outlets", 997_500);
    await s.dana.action(api.payments.invoices.sendChangeOrderInvoice, { changeOrderId: id });
    const invoiceId = (await coRow(s, id)).paypalInvoiceId!;
    await s.t.mutation(internal.payments.changeOrderDb.applyInvoiceStatus, { paypalInvoiceId: invoiceId, paypalInvoiceStatus: "CANCELLED" });

    const gc = await s.dana.query(api.billing.changeOrders.listForProject, { projectId: s.projectId });
    expect(gc.prime!.contractSum).toMatchObject({ additionsCents: 997_500, toDateCents: 124_997_500 });
    expect(gc.prime!.changeOrders[0]).toMatchObject({ paypalInvoiceStatus: "CANCELLED", canEdit: false });

    const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    const app = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
    expect(app.figures).toMatchObject({ netChangeOrdersCents: 997_500, contractSumToDateCents: 124_997_500 });
    // With the invoice cancelled nothing was billed, so the CO can be billed on the owner pay app.
    expect(app.lines.find((l) => l.kind === "change_order")).toMatchObject({ scheduledValueCents: 997_500 });
  });
});

describe("a prime CO is billed through one path only", () => {
  test("a CO invoiced with Invoice now is left off owner pay apps and shown as invoiced directly", async () => {
    const s = await setup();
    const id = await primeCo(s, "Owner-requested outlets", 997_500);
    await s.dana.action(api.payments.invoices.sendChangeOrderInvoice, { changeOrderId: id });
    const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    const app = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
    expect(app.lines.some((l) => l.kind === "change_order")).toBe(false);
    expect(app.figures.currentPaymentDueCents).toBe(0);
    expect(app.directlyInvoicedChangeOrders).toEqual([expect.objectContaining({ label: "PCO #1", amountCents: 997_500 })]);
    // The contract itself still includes the approved CO.
    const gc = await s.dana.query(api.billing.changeOrders.listForProject, { projectId: s.projectId });
    expect(gc.prime!.contractSum!.toDateCents).toBe(124_997_500);
  });

  test("a CO invoiced with Invoice now stays in the owner G702 contract sum, its PDF and balance to finish", async () => {
    const s = await setup();
    const gcLine = await addGeneralConditions(s);
    const id = await primeCo(s, "Owner-requested outlets", 997_500);
    await s.dana.action(api.payments.invoices.sendChangeOrderInvoice, { changeOrderId: id });
    const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    await s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [{ key: gcLine, workThisPeriodCents: 5_141_260 }] });
    const app = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
    expect(app.lines.some((l) => l.kind === "change_order")).toBe(false);
    expect(app.figures).toMatchObject({
      originalContractSumCents: 124_000_000,
      netChangeOrdersCents: 997_500,
      contractSumToDateCents: 124_997_500,
      completedAndStoredCents: 5_141_260,
    });
    expect(app.figures.balanceToFinishInclRetainageCents).toBe(124_997_500 - app.figures.earnedLessRetainageCents);
    // Not billable again on the owner pay app.
    await expect(
      s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [{ key: `pco:${id}`, workThisPeriodCents: 997_500 }] }),
    ).rejects.toThrow(/Only GC lines/);
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });

    const out = await s.t.query(internal.documents.store.renderInput, { kind: "owner_pay_app_pdf", relatedId: ownerPayAppId });
    const figures = (out!.loaded.input as { data: { figures: Record<string, number> } }).data.figures;
    expect(figures).toMatchObject({ netChangeOrdersCents: 997_500, contractSumToDateCents: 124_997_500 });
  });

  test("once a CO is on a submitted owner pay app, Invoice now is unavailable and refused", async () => {
    const s = await setup();
    const id = await primeCo(s, "Owner-requested outlets", 997_500);
    const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    // A draft alone does not reserve the CO.
    let row = (await s.dana.query(api.billing.changeOrders.listForProject, { projectId: s.projectId })).prime!.changeOrders[0];
    expect(row.invoice).toMatchObject({ show: true, enabled: true });

    const pcoKey = (await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId })).lines.find((l) => l.kind === "change_order")!.key;
    await s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [{ key: pcoKey, workThisPeriodCents: 997_500 }] });
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });

    row = (await s.dana.query(api.billing.changeOrders.listForProject, { projectId: s.projectId })).prime!.changeOrders[0];
    expect(row.invoice.enabled).toBe(false);
    expect(row.invoice.reason).toMatch(/owner pay app #1/);
    await expect(s.dana.action(api.payments.invoices.sendChangeOrderInvoice, { changeOrderId: id })).rejects.toThrow(/owner pay app #1/);
    expect(fake.posts(/^\/v2\/invoicing\/invoices$/)).toHaveLength(0);
  });
});

describe("owner pay app drafts pick up newly approved sub work", () => {
  test("approving a sub pay app after the draft was created shows the changed figures and blocks a stale submit until refreshed", async () => {
    const s = await setup();
    const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    expect((await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId })).refresh).toBeNull();

    await approvePlumbingPayApp(s);
    const stale = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
    expect(stale.figures.currentPaymentDueCents).toBe(0);
    expect(stale.refresh).toMatchObject({
      currentPaymentDue: { fromCents: 0, toCents: 931_000 },
      pendingSubPayApps: { from: 1, to: 0 },
    });
    expect(stale.refresh!.lines).toEqual([
      expect.objectContaining({ description: expect.stringMatching(/^Plumbing/), fromToDateCents: 0, toToDateCents: 980_000 }),
    ]);
    // Nothing for the GC to type: the stale figures cannot be submitted.
    await expect(s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId })).rejects.toThrow(/\$0\.00 → \$9,310\.00/);
    expect((await s.t.run(async (ctx) => await ctx.db.get(ownerPayAppId as Id<"ownerPayApps">)))!.status).toBe("draft");

    await s.dana.mutation(api.billing.ownerPayApps.refreshOwnerPayApp, { ownerPayAppId });
    const fresh = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
    expect(fresh.refresh).toBeNull();
    expect(fresh.figures.currentPaymentDueCents).toBe(931_000);
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    expect((await s.mendez.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId })).figures.currentPaymentDueCents).toBe(931_000);
  });

  test("after the owner requests changes, the GC can refresh a trade-only owner pay app and resubmit", async () => {
    const s = await setup();
    const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    await s.mendez.mutation(api.billing.ownerPayApps.requestOwnerPayAppChanges, { ownerPayAppId, comment: "Include the approved plumbing work." });
    await approvePlumbingPayApp(s);
    expect((await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId })).refresh).not.toBeNull();
    await s.dana.mutation(api.billing.ownerPayApps.refreshOwnerPayApp, { ownerPayAppId });
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    expect((await s.mendez.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId })).figures.currentPaymentDueCents).toBe(931_000);
  });

  test("only the project GC can refresh, and only while the owner pay app is editable", async () => {
    const s = await setup();
    const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    for (const outsider of [s.kim, s.mendez, s.f.gcB.admin.as, s.f.demo.gc.as]) {
      await expect(outsider.mutation(api.billing.ownerPayApps.refreshOwnerPayApp, { ownerPayAppId })).rejects.toThrow(/Not found/);
    }
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    await expect(s.dana.mutation(api.billing.ownerPayApps.refreshOwnerPayApp, { ownerPayAppId })).rejects.toThrow(/can no longer be edited/);
  });
});

describe("change-order PDFs report the contract sum at approval", () => {
  test("subcontract: #2 −$1,200.00 approved before #1 +$8,750.00 gives #1 $171,200.00 → $179,950.00, and #2 never changes", async () => {
    const s = await setup();
    const co1 = await subCo(s, "Add 6 duplex receptacles", 875_000);
    const co2 = await subCo(s, "Delete 2 exterior fixtures", -120_000);
    await s.dana.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: co2 });
    const co2Before = await coPdfData(s, co2);
    expect(co2Before).toMatchObject({ previousContractSumCents: 17_240_000, newContractSumCents: 17_120_000 });
    vi.advanceTimersByTime(1000);
    await s.dana.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: co1 });
    expect(await coPdfData(s, co1)).toMatchObject({ previousContractSumCents: 17_120_000, newContractSumCents: 17_995_000 });
    expect(await coPdfData(s, co2)).toEqual(co2Before);
    expect(await coRow(s, co1)).toMatchObject({ contractSumBeforeCents: 17_120_000, contractSumAfterCents: 17_995_000 });
  });

  test("prime: approval order, not PCO number, sets the before and after sums", async () => {
    const s = await setup();
    const p1 = await primeCo(s, "Outlets", 997_500, { approve: false });
    const p2 = await primeCo(s, "Delete fixtures", -120_000);
    vi.advanceTimersByTime(1000);
    await s.mendez.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: p1 });
    expect(await coPdfData(s, p2)).toMatchObject({ previousContractSumCents: 124_000_000, newContractSumCents: 123_880_000 });
    expect(await coPdfData(s, p1)).toMatchObject({ previousContractSumCents: 123_880_000, newContractSumCents: 124_877_500 });
  });

  test("the backfill snapshots existing approved COs in approval order", async () => {
    const s = await setup();
    const ids = await s.t.run(async (ctx) => {
      const base = { agreementId: s.agreementId, projectId: s.projectId, scope: "subcontract" as const, description: "", requestedByParty: "sub" as const, createdAt: 1 };
      const a = await ctx.db.insert("changeOrders", { ...base, number: 1, title: "A", amountCents: 875_000, status: "approved", approvedAt: 2_000 });
      const b = await ctx.db.insert("changeOrders", { ...base, number: 2, title: "B", amountCents: -120_000, status: "approved", approvedAt: 1_000 });
      const pending = await ctx.db.insert("changeOrders", { ...base, number: 3, title: "C", amountCents: 5_000, status: "submitted" });
      return { a, b, pending };
    });
    const out = await s.t.mutation(internal.billing.changeOrders.backfillChangeOrderSumSnapshots, {});
    expect(out.patched).toBe(2);
    expect(await coRow(s, ids.b)).toMatchObject({ contractSumBeforeCents: 17_240_000, contractSumAfterCents: 17_120_000 });
    expect(await coRow(s, ids.a)).toMatchObject({ contractSumBeforeCents: 17_120_000, contractSumAfterCents: 17_995_000 });
    expect((await coRow(s, ids.pending)).contractSumBeforeCents).toBeUndefined();
    // Idempotent.
    expect((await s.t.mutation(internal.billing.changeOrders.backfillChangeOrderSumSnapshots, {})).patched).toBe(0);
  });
});
