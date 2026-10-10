/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture } from "../lib/tenancyFixtures";
import { insertTestSession } from "../lib/testIdentity";
import { clearPayPalTokenCache } from "../payments/paypalClient";
import { INVOICE_AUTH_FLOW_MESSAGE } from "../payments/invoiceSendError";

const modules = import.meta.glob("/convex/**/*.ts");
const NOT_FOUND = /Not found/;
const OWNER_BILLING_EMAIL = "ap@harborpoint.test";

const SOV = [800_000, 640_000, 3_150_000, 3_820_000, 4_200_000, 2_860_000, 1_270_000, 500_000];

type Call = { method: string; path: string; requestId?: string; body: any };

/** Fake Invoicing v2 keyed by PayPal-Request-Id, like the sandbox. */
function fakeInvoicing() {
  const calls: Call[] = [];
  const invoices = new Map<string, { id: string; status: string; body: any }>();
  const byRequestId = new Map<string, string>();
  let n = 0;
  const state = { authFlowSends: 0 };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
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
        id = `INV2-OPA-${++n}`;
        invoices.set(id, { id, status: "DRAFT", body });
        if (requestId) byRequestId.set(requestId, id);
      }
      return json(201, { rel: "self", href: `https://api.sandbox.paypal.com/v2/invoicing/invoices/${id}`, method: "GET" });
    }
    const send = url.pathname.match(/^\/v2\/invoicing\/invoices\/([^/]+)\/send$/);
    if (req.method === "POST" && send) {
      if (state.authFlowSends > 0) {
        state.authFlowSends -= 1;
        return json(
          422,
          { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTH_FLOW_REQUIRED" }], debug_id: "dbg-opa-authflow" },
          { "paypal-debug-id": "dbg-opa-authflow" },
        );
      }
      invoices.get(send[1])!.status = "SENT";
      return json(200, { href: `https://www.sandbox.paypal.com/invoice/p/#${send[1]}`, rel: "payer-view", method: "GET" });
    }
    const pay = url.pathname.match(/^\/v2\/invoicing\/invoices\/([^/]+)\/payments$/);
    if (req.method === "POST" && pay) {
      invoices.get(pay[1])!.status = "MARKED_AS_PAID";
      return json(200, { payment_id: "EXTR-1" });
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
  return { fetchImpl, calls, posts, invoices, state };
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
    await ctx.db.patch(projectId, { billingDay: 25, startDate: "2026-10-01", retainageBps: 500, state: "CA", contractValueCents: 124_000_000, ownerCompanyId: f.owner.companyId });
    await ctx.db.patch(f.owner.companyId, { billingEmail: OWNER_BILLING_EMAIL });
    await ctx.db.patch(agreementId, { contractSum: 172_400, contractSumCents: 17_240_000, retainagePercent: 5 });
    const sov: Id<"scheduleOfValues">[] = [];
    for (const [i, cents] of SOV.entries()) {
      sov.push(await ctx.db.insert("scheduleOfValues", { agreementId, lineNo: i + 1, description: `Line ${i + 1}`, scheduledValueCents: cents, excludedScope: false }));
    }
    // Lakeshore Mechanical: its own plumbing award with a pay app submitted but not approved.
    const ag = (await ctx.db.get(agreementId))!;
    const lakeshore = await ctx.db.insert("companies", { name: "Lakeshore Mechanical", kind: "sub", isDemo: false, createdAt: Date.now() });
    const rayId = await ctx.db.insert("users", { email: "ray@lakeshore.test", emailVerificationTime: Date.now() });
    await ctx.db.insert("userProfiles", { userId: rayId, role: "sub", displayName: "Ray", actorType: "human", companyId: lakeshore, createdAt: Date.now() });
    await ctx.db.insert("companyMembers", { companyId: lakeshore, userId: rayId, role: "admin", status: "active", createdAt: Date.now() });
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
    await ctx.db.insert("projectMembers", { projectId, companyId: lakeshore, partyRole: "sub", contractorId: contractor, status: "active", createdAt: Date.now() });
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
    await ctx.db.insert("payApplications", {
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
    // A second owner, on the Sonoran project, for owner-versus-owner denials.
    const sonoranOwner = await ctx.db.insert("companies", { name: "Camelback Holdings", kind: "owner", isDemo: false, createdAt: Date.now() });
    const ownerB = await ctx.db.insert("users", { email: "owner@camelback.test", emailVerificationTime: Date.now() });
    await ctx.db.insert("userProfiles", { userId: ownerB, role: "owner", displayName: "Camelback owner", actorType: "human", companyId: sonoranOwner, createdAt: Date.now() });
    await ctx.db.insert("companyMembers", { companyId: sonoranOwner, userId: ownerB, role: "admin", status: "active", createdAt: Date.now() });
    await ctx.db.insert("projectMembers", { projectId: f.gcB.project.projectId, companyId: sonoranOwner, partyRole: "owner", status: "active", createdAt: Date.now() });
    return { sov, rayId, raySession: await insertTestSession(ctx, rayId), ownerB, ownerBSession: await insertTestSession(ctx, ownerB) };
  });
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
    demo: f.demo.gc.as,
    ray: t.withIdentity({ subject: `${extra.rayId}|${extra.raySession}`, email: "ray@lakeshore.test" }),
    camelback: t.withIdentity({ subject: `${extra.ownerB}|${extra.ownerBSession}`, email: "owner@camelback.test" }),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const entry = (sovLineId: Id<"scheduleOfValues">, workThisPeriodCents: number, storedCents = 0) => ({ sovLineId, workThisPeriodCents, storedCents });

/** Pay app 1 of the worked example, approved by the GC at $43,412.60 (line 3 overridden to $12,612.50). */
async function approvedPayApp1(s: Setup) {
  const { payAppId } = await s.kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
  await s.kim.mutation(api.payApps.g703.submitPayApp, {
    payAppId,
    lines: [entry(s.sov[0], 800_000), entry(s.sov[1], 480_010), entry(s.sov[2], 1_400_000), entry(s.sov[4], 0, 1_800_000)],
  });
  await s.t.run(async (ctx) => {
    const p = (await ctx.db.get(payAppId))!;
    const lines = p.lines.map((l) => ({
      sovLineId: l.sovLineId,
      verdict: "ok" as const,
      recommendedPctToDate: l.pctCompleteToDate / 100,
      approvedCents: l.requestedCents,
      reason: "Fixture review.",
    }));
    await ctx.db.patch(payAppId, {
      status: "reviewed",
      review: {
        engine: "Offline rules engine",
        provider: "Offline rules engine",
        model: "none",
        lines,
        flags: { lienWaiverMissing: false, licenseIssue: false, notes: "" },
        approvedTotalCents: lines.reduce((a, l) => a + l.approvedCents, 0),
        reviewedAt: Date.now(),
      },
    });
  });
  await s.dana.mutation(api.payApps.decisions.decidePayApp, {
    payAppId,
    decision: "approve",
    lines: [{ sovLineId: s.sov[2], action: "override", amountCents: 1_261_250, reason: "Super verified 1,240 LF installed" }],
  });
  return payAppId;
}

async function addGcLines(s: Setup) {
  const ids: Record<string, string> = {};
  for (const [description, cents] of [["General conditions", 9_600_000], ["GC fee", 6_000_000], ["Insurance", 1_500_000]] as const) {
    ids[description] = (await s.dana.mutation(api.billing.primeLines.addPrimeLine, { projectId: s.projectId, description, scheduledValueCents: cents })).primeLineId;
  }
  return ids;
}

/** Owner pay app 1 with General conditions $8,000.00 this period. */
async function ownerPayApp1(s: Setup) {
  await approvedPayApp1(s);
  const gc = await addGcLines(s);
  const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
  await s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [{ key: `gc:${gc["General conditions"]}`, workThisPeriodCents: 800_000 }] });
  return { ownerPayAppId, gc };
}

async function notificationTitles(s: Setup, companyId: Id<"companies">) {
  return await s.t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.companyId === companyId).map((n) => n.title));
}

describe("owner pay app roll-up", () => {
  test("pay app 1 rolls up as the Electrical trade line; GC lines start at 0.00; the unapproved Lakeshore pay app is noted", async () => {
    const s = await setup();
    await approvedPayApp1(s);
    await addGcLines(s);
    const list = await s.dana.query(api.billing.ownerPayApps.listOwnerPayApps, { projectId: s.projectId });
    expect(list.create).toMatchObject({ allowed: true, nextPeriodEnd: "2026-10-25" });
    const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    const app = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
    expect(app.periodEnd).toBe("2026-10-25");
    const electrical = app.lines.find((l) => l.description === "Electrical (26 00 00) – Eastbay Electric")!;
    expect(electrical).toMatchObject({ scheduledValueCents: 17_240_000, workThisPeriodCents: 2_541_260, storedCents: 1_800_000, totalCents: 4_341_260 });
    const plumbing = app.lines.find((l) => l.description.startsWith("Plumbing (22 00 00)"))!;
    expect(plumbing.totalCents).toBe(0);
    expect(app.pendingNote).toBe("1 sub pay app not yet approved");
    expect(app.lines.filter((l) => l.kind === "gc").map((l) => [l.description, l.workThisPeriodCents])).toEqual([
      ["General conditions", 0],
      ["GC fee", 0],
      ["Insurance", 0],
    ]);
    expect(app.lines.every((l) => !/plug|excluded/i.test(l.description))).toBe(true);
  });

  test("totals are exact to the cent, retainage per prime line, and a GC amount above its balance is refused", async () => {
    const s = await setup();
    const { ownerPayAppId, gc } = await ownerPayApp1(s);
    const app = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
    expect(app.figures).toMatchObject({
      originalContractSumCents: 124_000_000,
      netChangeOrdersCents: 0,
      contractSumToDateCents: 124_000_000,
      completedAndStoredCents: 5_141_260,
      retainageCents: 257_063,
      earnedLessRetainageCents: 4_884_197,
      previousCertificatesCents: 0,
      currentPaymentDueCents: 4_884_197,
      balanceToFinishInclRetainageCents: 119_115_803,
    });
    const electrical = app.lines.find((l) => l.kind === "trade" && l.totalCents > 0)!;
    expect(electrical.retainageCents).toBe(217_063);
    expect(electrical.subRetainageCents).toBe(217_064);
    expect(app.lines.find((l) => l.description === "General conditions")!.retainageCents).toBe(40_000);
    const row = await s.t.run(async (ctx) => await ctx.db.get(ownerPayAppId as Id<"ownerPayApps">));
    expect(row!.figures.currentPaymentDueCents).toBe(4_884_197);
    await expect(
      s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [{ key: `gc:${gc.Insurance}`, workThisPeriodCents: 1_500_001 }] }),
    ).rejects.toThrow(/at most \$15,000.00 remains/);
    await expect(
      s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [{ key: electrical.key, workThisPeriodCents: 1 }] }),
    ).rejects.toThrow(/trade lines/);
  });

  test("submit notifies the owner; owner sees prime lines only; request changes needs a comment; resubmit", async () => {
    const s = await setup();
    const { ownerPayAppId } = await ownerPayApp1(s);
    await expect(s.mendez.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId })).rejects.toThrow(NOT_FOUND);
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    expect(await notificationTitles(s, s.f.owner.companyId)).toContain("Owner pay app #1 ready – $48,841.97");
    expect(await notificationTitles(s, s.f.sub.companyId)).not.toContain("Owner pay app #1 ready – $48,841.97");
    const gcView = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
    expect(gcView).toMatchObject({ status: "submitted_to_owner", controls: { edit: false, submit: false } });
    await expect(s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [] })).rejects.toThrow(/can no longer be edited/);

    const owner = await s.mendez.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
    expect(owner.controls).toMatchObject({ approve: true, requestChanges: true, edit: false });
    expect(owner.pendingNote).toBeNull();
    expect(owner.lines.filter((l) => l.description.startsWith("Electrical"))).toHaveLength(1);
    expect(owner.lines.every((l) => l.subRetainageCents === null && l.agreementId === null)).toBe(true);
    expect(JSON.stringify(owner)).not.toMatch(/Super verified|verdict|override/i);

    await expect(s.mendez.mutation(api.billing.ownerPayApps.requestOwnerPayAppChanges, { ownerPayAppId, comment: "  " })).rejects.toThrow(/Enter a comment/);
    await s.mendez.mutation(api.billing.ownerPayApps.requestOwnerPayAppChanges, { ownerPayAppId, comment: "Attach the insurance certificate." });
    expect((await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId })).status).toBe("changes_requested");
    expect(await notificationTitles(s, s.f.gcA.companyId)).toContain("Owner requested changes to owner pay app #1");
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    const history = (await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId })).history.map((h) => h.status);
    expect(history).toEqual(["draft", "submitted_to_owner", "changes_requested", "submitted_to_owner"]);
  });

  test("owner approval invoices $48,841.97 to the owner billing email once; refresh and the webhook mark it paid", async () => {
    const s = await setup();
    const { ownerPayAppId } = await ownerPayApp1(s);
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    await expect(s.dana.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> })).rejects.toThrow(NOT_FOUND);

    const first = await s.mendez.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> });
    expect(first).toMatchObject({ status: "approved_invoiced", alreadyInvoiced: false });
    const again = await s.mendez.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> });
    expect(again).toMatchObject({ status: "approved_invoiced", alreadyInvoiced: true, paypalInvoiceId: first.paypalInvoiceId });
    const creates = fake.posts(/^\/v2\/invoicing\/invoices$/);
    expect(creates).toHaveLength(1);
    expect(creates[0].requestId).toBe(`opa_${ownerPayAppId}_create`);
    expect(creates[0].body.primary_recipients[0].billing_info.email_address).toBe(OWNER_BILLING_EMAIL);
    expect(creates[0].body.items[0]).toMatchObject({ name: "Harbor Point Dental Office TI – Application #1", unit_amount: { value: "48841.97" } });
    expect(fake.posts(/\/send$/)[0].requestId).toBe(`opa_${ownerPayAppId}_send`);

    const view = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
    expect(view).toMatchObject({ status: "approved_invoiced", paypalInvoiceId: first.paypalInvoiceId, recipientEmail: OWNER_BILLING_EMAIL });
    expect(view.payerViewUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/invoice\/p\/#/);
    expect(await notificationTitles(s, s.f.gcA.companyId)).toContain("Owner approved owner pay app #1 – $48,841.97");
    expect((await s.dana.query(api.billing.ownerPayApps.listOwnerPayApps, { projectId: s.projectId })).primeRetainageHeldCents).toBe(257_063);

    // Before payment, refresh leaves it invoiced.
    const before = await s.dana.action(api.billing.ownerInvoices.refreshOwnerPayAppStatus, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> });
    expect(before).toMatchObject({ status: "approved_invoiced", paypalInvoiceStatus: "SENT", changed: false });

    const event = { id: "WH-OPA-1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: first.paypalInvoiceId, status: "PAID" } } };
    expect(await s.t.mutation(internal.payments.webhookDb.processVerifiedEvent, { event })).toMatchObject({ duplicate: false, changed: true });
    const replay = await s.t.mutation(internal.payments.webhookDb.processVerifiedEvent, { event });
    expect(replay).toMatchObject({ duplicate: true, changed: false });
    expect((await s.mendez.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId })).status).toBe("paid");
    expect((await notificationTitles(s, s.f.gcA.companyId)).filter((t) => t.startsWith("Owner paid"))).toHaveLength(2); // one per Bayview member
  });

  test("AUTH_FLOW_REQUIRED on send shows the clear message, keeps the app approved and not sent, and the GC retry reuses the draft invoice", async () => {
    const s = await setup();
    const { ownerPayAppId } = await ownerPayApp1(s);
    const id = ownerPayAppId as Id<"ownerPayApps">;
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    fake.state.authFlowSends = 2;
    await expect(s.mendez.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: id })).rejects.toThrow(INVOICE_AUTH_FLOW_MESSAGE);
    await expect(s.dana.action(api.billing.ownerInvoices.sendOwnerPayAppInvoice, { ownerPayAppId: id })).rejects.toThrow(INVOICE_AUTH_FLOW_MESSAGE);
    const failed = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId });
    expect(failed).toMatchObject({ status: "approved", paypalInvoiceId: "INV2-OPA-1", error: INVOICE_AUTH_FLOW_MESSAGE });
    expect(failed.payerViewUrl ?? null).toBeNull();
    expect(fake.invoices.get("INV2-OPA-1")!.status).toBe("DRAFT");
    const sendAudits = await s.t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).filter((a) => a.operation === "paypal.invoices.send"));
    expect(sendAudits.map((a) => a.paypalDebugId)).toEqual(["dbg-opa-authflow", "dbg-opa-authflow"]);

    const retry = await s.dana.action(api.billing.ownerInvoices.sendOwnerPayAppInvoice, { ownerPayAppId: id });
    expect(retry).toMatchObject({ status: "approved_invoiced", paypalInvoiceId: "INV2-OPA-1", alreadyInvoiced: false });
    expect(fake.posts(/^\/v2\/invoicing\/invoices$/)).toHaveLength(1);
    expect(fake.invoices.size).toBe(1);
  });

  test("the sandbox record-payment fallback moves it to Paid through refresh", async () => {
    const s = await setup();
    const { ownerPayAppId } = await ownerPayApp1(s);
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    await s.mendez.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> });
    const out = await s.t.action(internal.billing.ownerInvoices.recordOwnerInvoicePaymentInternal, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> });
    expect(out).toMatchObject({ status: "paid", paypalInvoiceStatus: "MARKED_AS_PAID", changed: true });
    expect(fake.posts(/\/payments$/)[0]).toMatchObject({ requestId: `opa_${ownerPayAppId}_payment`, body: { amount: { value: "48841.97" } } });
  });

  test("an approved prime CO flows into owner pay app 2; previous certificates carry over", async () => {
    const s = await setup();
    const { ownerPayAppId } = await ownerPayApp1(s);
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    await expect(s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId })).rejects.toThrow(/still open/);
    await s.mendez.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> });
    const { changeOrderId } = await s.dana.mutation(api.billing.changeOrders.createChangeOrder, {
      scope: "prime",
      projectId: s.projectId,
      title: "Dental chair circuits incl. GC markup",
      amountCents: 997_500,
    });
    await s.dana.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId });
    await s.mendez.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId });

    const { ownerPayAppId: second } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    const app2 = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId: second });
    expect(app2.applicationNo).toBe(2);
    expect(app2.periodEnd).toBe("2026-11-25");
    expect(app2.figures).toMatchObject({
      originalContractSumCents: 124_000_000,
      netChangeOrdersCents: 997_500,
      contractSumToDateCents: 124_997_500,
      previousCertificatesCents: 4_884_197,
    });
    expect(app2.lines.find((l) => l.kind === "change_order")).toMatchObject({ description: "PCO #1 – Dental chair circuits incl. GC markup", scheduledValueCents: 997_500 });
    const gcLine = app2.lines.find((l) => l.description === "General conditions")!;
    expect(gcLine).toMatchObject({ previousWorkCents: 800_000, workThisPeriodCents: 0 });

    // The GC dashboard counts the prime CO, which has no agreement.
    const dash = await s.dana.query(api.dashboard.queries.getDashboardData, {});
    expect(JSON.stringify(dash)).toContain("Dental chair circuits incl. GC markup");

    for (const outsider of [s.camelback, s.kim, s.priya, s.ray, s.demo]) {
      for (const id of [ownerPayAppId, second]) {
        await expect(outsider.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId: id })).rejects.toThrow(NOT_FOUND);
      }
      await expect(outsider.query(api.billing.ownerPayApps.listOwnerPayApps, { projectId: s.projectId })).rejects.toThrow(NOT_FOUND);
    }
  });
});

describe("deductive prime change orders on the owner pay app", () => {
  test("a -$1,200.00 prime CO credit is enterable and lowers the payment due with its retainage", async () => {
    const s = await setup();
    const { ownerPayAppId, gc } = await ownerPayApp1(s);
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    await s.mendez.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> });
    const { changeOrderId } = await s.dana.mutation(api.billing.changeOrders.createChangeOrder, {
      scope: "prime",
      projectId: s.projectId,
      title: "Delete 2 exterior fixtures",
      amountCents: -120_000,
    });
    await s.dana.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId });
    await s.mendez.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId });

    const { ownerPayAppId: second } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    const app2 = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId: second });
    const credit = app2.lines.find((l) => l.kind === "change_order")!;
    expect(credit).toMatchObject({ scheduledValueCents: -120_000, remainingCents: -120_000 });
    const gcKey = `gc:${gc["General conditions"]}`;

    const workOnly = await s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId: second, entries: [{ key: gcKey, workThisPeriodCents: 200_000 }] });
    await expect(
      s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId: second, entries: [{ key: credit.key, workThisPeriodCents: -120_001 }] }),
    ).rejects.toThrow(/remains to deduct/);
    const withCredit = await s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, {
      ownerPayAppId: second,
      entries: [
        { key: gcKey, workThisPeriodCents: 200_000 },
        { key: credit.key, workThisPeriodCents: -120_000 },
      ],
    });
    // The credit less its 5% retainage (6,000) comes off the payment due.
    expect(workOnly.currentPaymentDueCents - withCredit.currentPaymentDueCents).toBe(114_000);
    const saved = await s.dana.query(api.billing.ownerPayApps.getOwnerPayApp, { ownerPayAppId: second });
    expect(saved.lines.find((l) => l.key === credit.key)).toMatchObject({ workThisPeriodCents: -120_000, totalCents: -120_000, remainingCents: -120_000 });
    expect(saved.figures.currentPaymentDueCents).toBe(withCredit.currentPaymentDueCents);
  });
});

describe("owner billing isolation", () => {
  test("only the project GC writes, only its owner approves, and outsiders get Not found", async () => {
    const s = await setup();
    const { ownerPayAppId, gc } = await ownerPayApp1(s);
    const id = ownerPayAppId as Id<"ownerPayApps">;
    for (const outsider of [s.camelback, s.kim, s.priya, s.ray, s.demo, s.mendez]) {
      await expect(outsider.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId })).rejects.toThrow(NOT_FOUND);
      await expect(outsider.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [] })).rejects.toThrow(NOT_FOUND);
      await expect(outsider.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId })).rejects.toThrow(NOT_FOUND);
      await expect(outsider.mutation(api.billing.ownerPayApps.deleteOwnerPayApp, { ownerPayAppId })).rejects.toThrow(NOT_FOUND);
      await expect(outsider.mutation(api.billing.primeLines.addPrimeLine, { projectId: s.projectId, description: "Forged", scheduledValueCents: 1 })).rejects.toThrow(NOT_FOUND);
      await expect(outsider.mutation(api.billing.primeLines.deletePrimeLine, { primeLineId: gc.Insurance })).rejects.toThrow(NOT_FOUND);
      await expect(outsider.query(api.billing.primeLines.listPrimeLines, { projectId: s.projectId })).rejects.toThrow(NOT_FOUND);
    }
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    for (const outsider of [s.camelback, s.kim, s.priya, s.ray, s.demo, s.dana]) {
      await expect(outsider.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: id })).rejects.toThrow(NOT_FOUND);
      await expect(outsider.mutation(api.billing.ownerPayApps.requestOwnerPayAppChanges, { ownerPayAppId, comment: "x" })).rejects.toThrow(NOT_FOUND);
    }
    for (const outsider of [s.camelback, s.kim, s.priya, s.ray, s.demo]) {
      await expect(outsider.action(api.billing.ownerInvoices.refreshOwnerPayAppStatus, { ownerPayAppId: id })).rejects.toThrow(NOT_FOUND);
      await expect(outsider.action(api.billing.ownerInvoices.sendOwnerPayAppInvoice, { ownerPayAppId: id })).rejects.toThrow(NOT_FOUND);
    }
    const projects = await s.camelback.query(api.billing.ownerPayApps.ownerBillingProjects, {});
    expect(projects.map((p) => p.title)).not.toContain("Harbor Point Dental Office TI");
    expect((await s.mendez.query(api.billing.ownerPayApps.ownerBillingProjects, {})).map((p) => p.title)).toEqual(["Harbor Point Dental Office TI"]);
    await expect(s.kim.query(api.billing.ownerPayApps.ownerBillingProjects, {})).rejects.toThrow();
    expect(fake.posts(/invoicing/)).toHaveLength(0);
  });

  test("the owner cannot approve a sub pay app", async () => {
    const s = await setup();
    const { payAppId } = await s.kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    await expect(s.mendez.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve", lines: [] })).rejects.toThrow();
    expect((await s.t.run(async (ctx) => await ctx.db.get(payAppId)))!.status).toBe("draft");
  });

  test("the retainage view shows prime retainage held by the owner next to the sub figure", async () => {
    const s = await setup();
    const { ownerPayAppId } = await ownerPayApp1(s);
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    await s.mendez.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> });
    const view = await s.dana.query(api.billing.retainage.projectRetainage, {});
    const project = view.projects.find((p: any) => p.projectId === s.projectId)!;
    expect(project.prime).toMatchObject({ heldCents: 257_063, applicationNo: 1 });
    expect(project.prime.tradeLines[0]).toMatchObject({ ownerRetainageCents: 217_063, subRetainageCents: 217_064 });
    expect(project.prime.roundingNote).toMatch(/\$0\.01/);
  });

  test("a project billed to the owner on GC lines alone still appears in the retainage view", async () => {
    const s = await setup();
    const gc = await addGcLines(s);
    const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    await s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [{ key: `gc:${gc["GC fee"]}`, workThisPeriodCents: 300_050 }] });
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    await s.mendez.action(api.billing.ownerInvoices.approveOwnerPayApp, { ownerPayAppId: ownerPayAppId as Id<"ownerPayApps"> });
    // With no live subcontract the project is reached only through its owner pay apps.
    await s.t.run(async (ctx) => {
      for (const a of await ctx.db.query("agreements").collect()) {
        if (a.projectId === s.projectId) await ctx.db.patch(a._id, { status: "superseded" });
      }
    });
    const view = await s.dana.query(api.billing.retainage.projectRetainage, {});
    const project = view.projects.find((p: any) => p.projectId === s.projectId)!;
    expect(project).toMatchObject({ subHeldCents: 0, agreements: [], prime: { heldCents: 15_003, applicationNo: 1 } });
    expect((await s.priya.query(api.billing.retainage.projectRetainage, {})).projects.map((p: any) => p.projectId)).not.toContain(s.projectId);
  });
});
