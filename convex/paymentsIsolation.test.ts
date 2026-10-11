/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";
import { api } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import schema from "./schema";
import { bidRowFromDollars } from "./lib/bidMoney";
import { buildTenancyFixture, type FixtureUser, type TenancyFixture } from "./lib/tenancyFixtures";
import { NO_PROJECT_OWNER_REASON, noOwnerEmailReason } from "./payments/changeOrderRecipient";
import { withSession } from "./lib/testIdentity";

/**
 * Cross-company isolation for the payments side (architecture §12): pay apps, funding, release,
 * payouts, retainage, change orders, the approval inbox, license checks, billing-agent links, the
 * dashboard and the Demo-only diagnostics. Another GC company, a user without a company, the Demo
 * company, the project's owner and another sub on the same project get exactly what a missing id
 * produces, nothing changes and no PayPal (or any other) request is made.
 */

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRef = FunctionReference<"query" | "mutation" | "action", "public", any, any>;
type Caller = Pick<T, "query" | "mutation" | "action">;
type Ctx = Parameters<Parameters<T["run"]>[0]>[0];

const TABLES = Object.keys(schema.tables) as (keyof typeof schema.tables)[];
const NOT_FOUND = JSON.stringify({ code: "NOT_FOUND", message: "Not found." });
const SECRET_REVIEW_NOTE = "Eastbay overbilled the rough-in line";

type Ids = {
  projectId: Id<"projects">;
  agreementId: Id<"agreements">;
  contractorId: Id<"contractors">;
  milestoneId: Id<"milestones">;
  fundingId: Id<"payments">;
  payoutId: Id<"payments">;
  retainageId: Id<"payments">;
  payAppId: Id<"payApplications">;
  proposalId: Id<"agentProposals">;
  changeOrderId: Id<"changeOrders">;
  orderId: string;
};

const fetchSpy = vi.fn(async () => {
  throw new Error("network disabled in tests");
});
beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function snapshot(t: T): Promise<string> {
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) out[table] = await ctx.db.query(table).collect();
    return JSON.stringify(out);
  });
}

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    return `RESOLVED:${JSON.stringify(await p)}`;
  } catch (err) {
    const data = (err as { data?: unknown }).data;
    if (data !== undefined) return typeof data === "string" ? data : JSON.stringify(data);
    return (err as Error).message;
  }
}

/** An id of `table` that no longer exists: a copy of `id` inserted and deleted again. */
async function ghost<N extends TableNames>(t: T, table: N, id: Id<N>): Promise<Id<N>> {
  return await t.run(async (ctx) => {
    const src = (await ctx.db.get(id))! as Doc<N>;
    const { _id, _creationTime, ...fields } = src as Doc<N> & { _id: unknown; _creationTime: unknown };
    void _id;
    void _creationTime;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const copy = await ctx.db.insert(table, fields as any);
    await ctx.db.delete(copy);
    return copy as Id<N>;
  });
}

async function insertMoney(ctx: Ctx, agreementId: Id<"agreements">, contractorId: Id<"contractors">, subUserId: Id<"users">, tag: string) {
  const now = Date.now();
  const sovId = await ctx.db.insert("scheduleOfValues", {
    agreementId,
    lineNo: 1,
    description: "Rough-in",
    scheduledValueCents: 4_000_000,
    excludedScope: false,
  });
  const milestoneId = await ctx.db.insert("milestones", {
    agreementId,
    name: "Rough-in complete",
    order: 1,
    plannedDate: now,
    amountCents: 4_000_000,
    status: "funded",
    sovLineIds: [sovId],
  });
  const fundingId = await ctx.db.insert("payments", {
    agreementId,
    milestoneId,
    kind: "funding",
    status: "authorized",
    paypalOrderId: `${tag}-ORDER-1`,
    paypalAuthorizationId: `${tag}-AUTH-1`,
    authorizationExpiresAt: now + 29 * 86_400_000,
    honorPeriodEndsAt: now + 3 * 86_400_000,
    grossCents: 4_000_000,
    retainageCents: 0,
    netCents: 4_000_000,
    idempotencyKey: `${tag}-funding`,
    createdAt: now,
  });
  const payoutId = await ctx.db.insert("payments", {
    agreementId,
    milestoneId,
    kind: "payout",
    status: "failed",
    paypalCaptureId: `${tag}-CAPTURE-1`,
    fundingPaymentId: fundingId,
    grossCents: 1_234_500,
    retainageCents: 61_725,
    netCents: 1_172_775,
    idempotencyKey: `${tag}-payout`,
    createdAt: now,
  });
  const retainageId = await ctx.db.insert("payments", {
    agreementId,
    kind: "retainage_release",
    status: "failed",
    grossCents: 61_725,
    retainageCents: 0,
    netCents: 61_725,
    idempotencyKey: `${tag}-retainage`,
    createdAt: now,
  });
  await ctx.db.insert("retainageLedger", { agreementId, paymentId: payoutId, deltaCents: 61_725, reason: "held", createdAt: now });
  const payAppId = await ctx.db.insert("payApplications", {
    agreementId,
    contractorId,
    subUserId,
    periodLabel: `${tag} October`,
    lines: [{ sovLineId: sovId, pctCompleteThisPeriod: 40, pctCompleteToDate: 40, requestedCents: 1_600_000 }],
    requestedTotalCents: 1_600_000,
    notes: "",
    lienWaiver: true,
    status: "reviewed",
    review: {
      engine: "Offline rules engine",
      provider: "Offline rules engine",
      model: "none",
      lines: [{ sovLineId: sovId, verdict: "overbilled", recommendedPctToDate: 30, approvedCents: 1_200_000, reason: SECRET_REVIEW_NOTE }],
      flags: { lienWaiverMissing: false, licenseIssue: true, notes: SECRET_REVIEW_NOTE },
      approvedTotalCents: 1_200_000,
      reviewedAt: now,
    },
    submittedBy: { userId: subUserId, actorType: "human" },
    createdAt: now,
  });
  const proposalId = await ctx.db.insert("agentProposals", {
    payAppId,
    agreementId,
    milestoneId,
    kind: "payout",
    amountCents: 1_200_000,
    rationale: "Fixture",
    flags: [],
    status: "pending",
    source: "agent",
    createdAt: now,
  });
  const projectId = (await ctx.db.get(agreementId))!.projectId;
  const changeOrderId = await ctx.db.insert("changeOrders", {
    agreementId,
    projectId,
    scope: "prime",
    number: 1,
    title: `${tag} added outlets`,
    description: `${tag} added outlets`,
    amountCents: 750_000,
    status: "invoiced",
    paypalInvoiceId: `${tag}-INV-1`,
    createdAt: now,
  });
  await ctx.db.insert("changeOrders", {
    agreementId,
    projectId,
    scope: "prime",
    number: 2,
    title: `${tag} draft change`,
    description: `${tag} draft change`,
    amountCents: 10_000,
    status: "draft",
    createdAt: now,
  });
  return { milestoneId, fundingId, payoutId, retainageId, payAppId, proposalId, changeOrderId, orderId: `${tag}-ORDER-1` };
}

/**
 * buildTenancyFixture plus Lakeshore (Ray) holding its own agreement on Bayview's project, money
 * history on Eastbay's Bayview agreement and on Sonoran's agreement, a Sonoran owner with a billing
 * email, and a billing-agent link Dana created for Eastbay.
 */
async function setup() {
  const t = convexTest(schema, modules);
  const fx = await buildTenancyFixture(t);
  const a = fx.gcA.project;
  const b = fx.gcB.project;
  const extra = await t.run(async (ctx) => {
    const now = Date.now();
    const lakeshore = await ctx.db.insert("companies", { name: "Lakeshore Mechanical", kind: "sub", isDemo: false, createdAt: now });
    const rayId = await ctx.db.insert("users", { email: "ray@lakeshore.test", name: "Ray Ortiz", emailVerificationTime: now });
    await ctx.db.insert("userProfiles", { userId: rayId, role: "sub", displayName: "Ray Ortiz", actorType: "human", companyId: lakeshore, createdAt: now });
    await ctx.db.insert("companyMembers", { companyId: lakeshore, userId: rayId, role: "admin", status: "active", createdAt: now });
    const rayContractor = await ctx.db.insert("contractors", {
      tradePackageId: a.tradePackageId,
      companyName: "Lakeshore Mechanical",
      contactEmail: "bids@lakeshore.invalid",
      licenseNumber: "1",
      licenseStatus: "Unverified",
      sourceUrl: "https://example.invalid",
      rfqStatus: "bid_received",
      linkedCompanyId: lakeshore,
    });
    const rayBid = await ctx.db.insert("bids", bidRowFromDollars({
      tradePackageId: a.tradePackageId,
      contractorId: rayContractor,
      subcontractorName: "Lakeshore Mechanical",
      baseBidAmount: 45_000,
      lineItems: [],
      identifiedExclusions: [],
      longLeadEquipmentWeeks: 4,
      leadTimePenalty: 0,
      coiComplianceStatus: "compliant",
      coiPenalty: 0,
      leveledTotalCost: 45_000,
      isAwarded: true,
      receivedAt: now,
    }));
    const eastbay = (await ctx.db.get(a.agreementId))!;
    const { _id, _creationTime, ...agreementFields } = eastbay;
    void _id;
    void _creationTime;
    const rayAgreement = await ctx.db.insert("agreements", {
      ...agreementFields,
      bidId: rayBid,
      contractorId: rayContractor,
      agreementNumber: "FX-LAKESHORE",
      subcontractorName: "Lakeshore Mechanical",
    });
    await ctx.db.insert("projectMembers", {
      projectId: a.projectId,
      companyId: lakeshore,
      partyRole: "sub",
      contractorId: rayContractor,
      status: "active",
      createdAt: now,
    });
    const mesa = await ctx.db.insert("companies", {
      name: "Mesa Owner Group",
      kind: "owner",
      isDemo: false,
      billingEmail: "ap@mesa-owner.test",
      createdAt: now,
    });
    await ctx.db.insert("projectMembers", { projectId: b.projectId, companyId: mesa, partyRole: "owner", status: "active", createdAt: now });

    const bayview = await insertMoney(ctx, a.agreementId, a.contractorId, fx.sub.admin.userId, "BAYVIEW");
    const sonoran = await insertMoney(ctx, b.agreementId, b.contractorId, fx.gcB.admin.userId, "SONORAN");
    await insertMoney(ctx, rayAgreement, rayContractor, rayId, "LAKESHORE");
    const linkId = await ctx.db.insert("agentLinks", {
      agentEmail: "boldlevel182@agentmail.to",
      contractorId: a.contractorId,
      gcCompanyId: fx.gcA.companyId,
      subCompanyId: fx.sub.companyId,
      status: "active",
      createdBy: fx.gcA.admin.userId,
      createdAt: now,
    });
    return { rayId, rayContractor, rayAgreement, bayview, sonoran, linkId };
  });
  const ray: FixtureUser = {
    userId: extra.rayId,
    email: "ray@lakeshore.test",
    as: await withSession(t, extra.rayId, "ray@lakeshore.test"),
  };
  const bayview: Ids = { projectId: a.projectId, agreementId: a.agreementId, contractorId: a.contractorId, ...extra.bayview };
  const missing: Ids = {
    projectId: await ghost(t, "projects", a.projectId),
    agreementId: await ghost(t, "agreements", a.agreementId),
    contractorId: await ghost(t, "contractors", a.contractorId),
    milestoneId: await ghost(t, "milestones", bayview.milestoneId),
    fundingId: await ghost(t, "payments", bayview.fundingId),
    payoutId: await ghost(t, "payments", bayview.payoutId),
    retainageId: await ghost(t, "payments", bayview.retainageId),
    payAppId: await ghost(t, "payApplications", bayview.payAppId),
    proposalId: await ghost(t, "agentProposals", bayview.proposalId),
    changeOrderId: await ghost(t, "changeOrders", bayview.changeOrderId),
    orderId: "NO-SUCH-ORDER",
  };
  return { t, fx, ray, bayview, missing, extra };
}

type Case = { name: string; kind: "query" | "mutation" | "action"; fn: AnyRef; args: (i: Ids) => Record<string, unknown> };
const q = (name: string, fn: AnyRef, args: Case["args"]): Case => ({ name, kind: "query", fn, args });
const m = (name: string, fn: AnyRef, args: Case["args"]): Case => ({ name, kind: "mutation", fn, args });
const a = (name: string, fn: AnyRef, args: Case["args"]): Case => ({ name, kind: "action", fn, args });

function call(caller: Caller, c: Case, ids: Ids): Promise<unknown> {
  if (c.kind === "query") return caller.query(c.fn as FunctionReference<"query", "public">, c.args(ids));
  if (c.kind === "mutation") return caller.mutation(c.fn as FunctionReference<"mutation", "public">, c.args(ids));
  return caller.action(c.fn as FunctionReference<"action", "public">, c.args(ids));
}

/** GC-of-the-project functions on a Bayview id. "(owner allowed)" ones also accept the project's owner. */
const GC_ONLY: Case[] = [
  a("payments/orders:createFundingOrder", api.payments.orders.createFundingOrder, (i) => ({ milestoneId: i.milestoneId })),
  a("payments/orders:authorizeFundingOrder", api.payments.orders.authorizeFundingOrder, (i) => ({ orderId: i.orderId })),
  a("payments/release:releaseAndPay", api.payments.release.releaseAndPay, (i) => ({
    milestoneId: i.milestoneId,
    amountCents: 100_000,
    requestKey: "forged-release-key-0001",
  })),
  a("payments/release:resumeRelease", api.payments.release.resumeRelease, (i) => ({ paymentId: i.payoutId })),
  a("payments/release:closeMilestone", api.payments.release.closeMilestone, (i) => ({ milestoneId: i.milestoneId })),
  a("payments/release:refreshCaptureStatus", api.payments.release.refreshCaptureStatus, (i) => ({ paymentId: i.payoutId })),
  a("payments/release:refreshPayoutStatus", api.payments.release.refreshPayoutStatus, (i) => ({ paymentId: i.payoutId })),
  a("payments/payoutRetry:retryPayout", api.payments.payoutRetry.retryPayout, (i) => ({ paymentId: i.payoutId })),
  a("payments/retainage:releaseRetainage", api.payments.retainage.releaseRetainage, (i) => ({ agreementId: i.agreementId })),
  a("payments/retainage:resumeRetainageRelease", api.payments.retainage.resumeRetainageRelease, (i) => ({ paymentId: i.retainageId })),
  m("billing/changeOrders:createChangeOrder (prime)", api.billing.changeOrders.createChangeOrder, (i) => ({
    scope: "prime",
    projectId: i.projectId,
    title: "Forged change order",
    amountCents: 100,
  })),
  q("billing/changeOrders:getChangeOrder (owner allowed)", api.billing.changeOrders.getChangeOrder, (i) => ({ changeOrderId: i.changeOrderId })),
  m("billing/changeOrders:approveChangeOrder (owner allowed)", api.billing.changeOrders.approveChangeOrder, (i) => ({ changeOrderId: i.changeOrderId })),
  m("billing/changeOrders:rejectChangeOrder (owner allowed)", api.billing.changeOrders.rejectChangeOrder, (i) => ({
    changeOrderId: i.changeOrderId,
    reason: "Forged",
  })),
  a("payments/invoices:sendChangeOrderInvoice", api.payments.invoices.sendChangeOrderInvoice, (i) => ({ changeOrderId: i.changeOrderId })),
  a("payments/invoices:refreshChangeOrderStatus (owner allowed)", api.payments.invoices.refreshChangeOrderStatus, (i) => ({
    changeOrderId: i.changeOrderId,
  })),
  a("payApps/review:rerunPayAppReview", api.payApps.review.rerunPayAppReview, (i) => ({ payAppId: i.payAppId })),
  m("payApps/proposals:approveProposal", api.payApps.proposals.approveProposal, (i) => ({ proposalId: i.proposalId })),
  m("payApps/proposals:editProposal", api.payApps.proposals.editProposal, (i) => ({ proposalId: i.proposalId, amountCents: 1 })),
  m("payApps/proposals:rejectProposal", api.payApps.proposals.rejectProposal, (i) => ({ proposalId: i.proposalId })),
  m("payApps/proposals:rejectPayApp", api.payApps.proposals.rejectPayApp, (i) => ({ payAppId: i.payAppId })),
  m("billing/tranches:createTranche", api.billing.tranches.createTranche, (i) => ({ agreementId: i.agreementId, name: "Forged", amountCents: 100 })),
  m("billing/tranches:updateTranche", api.billing.tranches.updateTranche, (i) => ({ trancheId: i.milestoneId, amountCents: 100 })),
  m("billing/tranches:deleteTranche", api.billing.tranches.deleteTranche, (i) => ({ trancheId: i.milestoneId })),
  m("billing/tranches:moveTranche", api.billing.tranches.moveTranche, (i) => ({ trancheId: i.milestoneId, direction: "down" })),
  a("billing/pay:payPayApp", api.billing.pay.payPayApp, (i) => ({ payAppId: i.payAppId })),
  q("billing/tranches:ownerProjectTranches (owner allowed)", api.billing.tranches.ownerProjectTranches, (i) => ({ projectId: i.projectId })),
  m("kernel/licenseChecks:requestLicenseCheck", api.kernel.licenseChecks.requestLicenseCheck, (i) => ({ contractorId: i.contractorId })),
  m("agentLinks:addAgentLink", api.agentLinks.addAgentLink, (i) => ({ agentEmail: "forged@agentmail.to", contractorId: i.contractorId })),
  q("dashboard/queries:getDashboardData (owner allowed)", api.dashboard.queries.getDashboardData, (i) => ({ projectId: i.projectId })),
  q("dashboard/payAgent:getPaySummary (owner allowed)", api.dashboard.payAgent.getPaySummary, (i) => ({ projectId: i.projectId })),
];

/** Reads that answer null or [] for an id the caller cannot see, exactly as for a missing id. */
const BLANK_READS: Case[] = [
  q("payments/ledger:getAgreementLedger", api.payments.ledger.getAgreementLedger, (i) => ({ agreementId: i.agreementId })),
  q("billing/changeOrders:listForAgreement", api.billing.changeOrders.listForAgreement, (i) => ({ agreementId: i.agreementId })),
  q("payApps/review:listAgreementPayApps", api.payApps.review.listAgreementPayApps, (i) => ({ agreementId: i.agreementId })),
  q("payApps/proposals:getAgentTrace", api.payApps.proposals.getAgentTrace, (i) => ({ payAppId: i.payAppId })),
  q("payApps/submit:payAppFormContext", api.payApps.submit.payAppFormContext, (i) => ({ agreementId: i.agreementId })),
  q("kernel/licenseChecks:getContractorLicense", api.kernel.licenseChecks.getContractorLicense, (i) => ({ contractorId: i.contractorId })),
  q("billing/canPay:paymentPanel", api.billing.canPay.paymentPanel, (i) => ({ payAppId: i.payAppId })),
  q("billing/tranches:listTranches", api.billing.tranches.listTranches, (i) => ({ agreementId: i.agreementId })),
];

/** Pay gate reads for the GC and the agreement's own sub; everyone else gets Not found. */
const PAY_GATE_READS: Case[] = [
  q("billing/canPay:canPay", api.billing.canPay.canPay, (i) => ({ payAppId: i.payAppId })),
];

/** Eastbay's own pay-app writes: only Eastbay's sub (or its billing agent) may make them. */
const EASTBAY_ONLY: Case[] = [
  m("payApps/submit:submitPayApplication", api.payApps.submit.submitPayApplication, (i) => ({
    agreementId: i.agreementId,
    periodLabel: "Forged",
    lines: [],
    notes: "",
    lienWaiver: true,
  })),
  m("payApps/submit:withdrawPayApplication", api.payApps.submit.withdrawPayApplication, (i) => ({ payAppId: i.payAppId })),
];

const OWNER_ALLOWED = new Set(GC_ONLY.filter((c) => c.name.includes("(owner allowed)")).map((c) => c.name));

function outsiders(fx: TenancyFixture): [string, Caller][] {
  return [
    ["other GC company (Sonoran)", fx.gcB.admin.as],
    ["no company", fx.noCompany.as],
    ["Demo company GC", fx.demo.gc.as],
  ];
}

describe("another company's payment ids read exactly like missing ids", () => {
  test.each([...GC_ONLY, ...EASTBAY_ONLY])("$name", async (c) => {
    const { t, fx, bayview, missing } = await setup();
    const before = await snapshot(t);
    for (const [label, caller] of outsiders(fx)) {
      expect(await outcome(call(caller, c, bayview)), `${c.name} as ${label}`).toBe(NOT_FOUND);
      expect(await outcome(call(caller, c, missing)), `${c.name} as ${label} (missing id)`).toBe(NOT_FOUND);
    }
    expect(await snapshot(t)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each(BLANK_READS)("$name", async (c) => {
    const { t, fx, bayview, missing } = await setup();
    const before = await snapshot(t);
    for (const [label, caller] of outsiders(fx)) {
      const forbidden = await outcome(call(caller, c, bayview));
      expect(forbidden, `${c.name} as ${label}`).toBe(await outcome(call(caller, c, missing)));
      expect(forbidden, `${c.name} as ${label}`).toMatch(/^RESOLVED:(null|\[\])$/);
    }
    expect(await snapshot(t)).toBe(before);
  });
});

describe("pay gate reads", () => {
  test.each(PAY_GATE_READS)("$name", async (c) => {
    const { t, fx, ray, bayview, missing } = await setup();
    const before = await snapshot(t);
    for (const [label, caller] of [...outsiders(fx), ["Lakeshore sub (Ray)", ray.as], ["owner (Harbor Point)", fx.owner.admin.as]] as [string, Caller][]) {
      expect(await outcome(call(caller, c, bayview)), `${c.name} as ${label}`).toBe(NOT_FOUND);
      expect(await outcome(call(caller, c, missing)), `${c.name} as ${label} (missing id)`).toBe(NOT_FOUND);
    }
    expect(await outcome(call(fx.gcA.admin.as, c, bayview))).toMatch(/^RESOLVED:/);
    expect(await outcome(call(fx.sub.admin.as, c, bayview))).toMatch(/^RESOLVED:/);
    expect(await snapshot(t)).toBe(before);
  });
});

describe("parties on the project outside the allowed roles get the same Not found", () => {
  test.each(GC_ONLY)("$name", async (c) => {
    const { t, fx, ray, bayview } = await setup();
    const before = await snapshot(t);
    const callers: [string, Caller][] = [
      ["Eastbay sub (Kim)", fx.sub.admin.as],
      ["Lakeshore sub (Ray)", ray.as],
    ];
    if (!OWNER_ALLOWED.has(c.name)) callers.push(["owner (Harbor Point)", fx.owner.admin.as]);
    for (const [label, caller] of callers) {
      const result = await outcome(call(caller, c, bayview));
      // The dashboards are company-wide reads; subs are refused by role before any project lookup.
      if (c.name.startsWith("dashboard/")) expect(result, `${c.name} as ${label}`).toMatch(/Not found|Forbidden/);
      else expect(result, `${c.name} as ${label}`).toBe(NOT_FOUND);
    }
    expect(await snapshot(t)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each(EASTBAY_ONLY)("$name", async (c) => {
    const { t, fx, ray, bayview } = await setup();
    const before = await snapshot(t);
    for (const [label, caller] of [
      ["Lakeshore sub (Ray)", ray.as],
      ["Bayview GC (Dana)", fx.gcA.admin.as],
      ["owner (Harbor Point)", fx.owner.admin.as],
    ] as [string, Caller][]) {
      expect(await outcome(call(caller, c, bayview)), `${c.name} as ${label}`).toBe(NOT_FOUND);
    }
    expect(await snapshot(t)).toBe(before);
  });

  test("Ray reads nothing of Eastbay's agreement, pay apps or license", async () => {
    const { fx, ray, bayview } = await setup();
    for (const c of BLANK_READS) {
      expect(await outcome(call(ray.as, c, bayview)), c.name).toMatch(/^RESOLVED:(null|\[\])$|Not found/);
    }
    const owner = fx.owner.admin.as;
    expect(await outcome(owner.query(api.payApps.submit.payAppFormContext, { agreementId: bayview.agreementId }))).toBe(NOT_FOUND);
    expect(await outcome(owner.query(api.payApps.proposals.getAgentTrace, { payAppId: bayview.payAppId }))).toBe(NOT_FOUND);
    expect(await outcome(owner.query(api.payApps.review.listAgreementPayApps, { agreementId: bayview.agreementId }))).toBe(NOT_FOUND);
  });
});

describe("the owning GC company still works (control)", () => {
  test("Dana reads Bayview's ledger, pay apps, change orders and inbox", async () => {
    const { fx, bayview } = await setup();
    const dana = fx.gcA.admin.as;
    const ledger = await dana.query(api.payments.ledger.getAgreementLedger, { agreementId: bayview.agreementId });
    expect(ledger).not.toBeNull();
    expect(await dana.query(api.payApps.review.listAgreementPayApps, { agreementId: bayview.agreementId })).toHaveLength(1);
    const cos = await dana.query(api.billing.changeOrders.listForProject, { projectId: bayview.projectId });
    // Bayview's and Lakeshore's fixture rows are both prime COs of the Harbor Point project.
    expect(cos.prime!.changeOrders.map((c) => c.status)).toEqual(["invoiced", "invoiced", "draft", "draft"]);
    const inbox = await dana.query(api.payApps.proposals.listInbox, {});
    expect(JSON.stringify(inbox)).toContain(bayview.payAppId);
    expect(JSON.stringify(inbox)).not.toContain("SONORAN");
  });

  test("Dana's write succeeds on her own proposal and the audit names her company", async () => {
    const { t, fx, bayview } = await setup();
    await fx.gcA.admin.as.mutation(api.payApps.proposals.rejectProposal, { proposalId: bayview.proposalId, reason: "Not yet" });
    const proposal = await t.run((ctx) => ctx.db.get(bayview.proposalId));
    expect(proposal?.status).toBe("rejected");
  });

  test("Sonoran's own ids work for Sonoran", async () => {
    const { fx, extra } = await setup();
    const priya = fx.gcB.admin.as;
    const ledger = await priya.query(api.payments.ledger.getAgreementLedger, { agreementId: fx.gcB.project.agreementId });
    expect(ledger).not.toBeNull();
    await priya.mutation(api.payApps.proposals.rejectProposal, { proposalId: extra.sonoran.proposalId, reason: "Not yet" });
  });
});

describe("company-wide lists never mix companies or vendors", () => {
  test("ledger agreement lists: each GC its own projects, each sub only its own agreements", async () => {
    const { fx, ray, extra } = await setup();
    const ids = async (c: Caller) => (await c.query(api.payments.ledger.listLedgerAgreements, {})).map((r) => r._id as string).sort();
    expect(await ids(fx.gcA.admin.as)).toEqual([fx.gcA.project.agreementId, extra.rayAgreement].sort());
    expect(await ids(fx.gcB.admin.as)).toEqual([fx.gcB.project.agreementId]);
    expect(await ids(fx.sub.admin.as)).toEqual([fx.gcA.project.agreementId]);
    expect(await ids(ray.as)).toEqual([extra.rayAgreement]);
    expect(await ids(fx.noCompany.as)).toEqual([]);
    expect(await ids(fx.demo.gc.as)).toEqual([fx.demo.project.agreementId]);
  });

  test("the approval inbox shows only the caller's projects", async () => {
    const { fx, bayview, extra } = await setup();
    const priyaInbox = JSON.stringify(await fx.gcB.admin.as.query(api.payApps.proposals.listInbox, {}));
    expect(priyaInbox).toContain(extra.sonoran.payAppId);
    expect(priyaInbox).not.toContain(bayview.payAppId);
    expect(priyaInbox).not.toContain("BAYVIEW");
    expect(JSON.stringify(await fx.demo.gc.as.query(api.payApps.proposals.listInbox, {}))).not.toMatch(/BAYVIEW|SONORAN/);
  });

  test("dashboard and pay summary for Priya carry no Bayview name or amount", async () => {
    const { fx } = await setup();
    for (const fn of [api.dashboard.queries.getDashboardData, api.dashboard.payAgent.getPaySummary]) {
      const text = JSON.stringify(await fx.gcB.admin.as.query(fn, {}));
      expect(text).toContain("Camelback Suite 400");
      expect(text).not.toMatch(/Harbor Point|Bayview|Eastbay|Lakeshore|BAYVIEW/);
    }
    for (const fn of [api.dashboard.queries.getDashboardData, api.dashboard.payAgent.getPaySummary]) {
      const text = JSON.stringify(await fx.noCompany.as.query(fn, {}));
      expect(text).not.toMatch(/Harbor Point|Camelback|Eastbay|Lakeshore/);
    }
  });
});

describe("the owner sees project summary and owner items only", () => {
  test("owner dashboard has only its invoiced change orders: no subcontract rows, pay apps, AI review internals or drafts", async () => {
    const { fx, bayview } = await setup();
    const data = await fx.owner.admin.as.query(api.dashboard.queries.getDashboardData, {});
    expect(data.readOnly).toBe(true);
    expect(data.agreements).toEqual([]);
    expect(data.payApps).toEqual([]);
    expect(data.payments).toEqual([]);
    expect(data.retainage).toEqual([]);
    expect(data.milestones).toEqual([]);
    expect(data.totals.contractSumCents).toBe(0);
    expect(data.changeOrders.length).toBeGreaterThan(0);
    expect(data.changeOrders.map((c) => c.status)).not.toContain("draft");
    expect(JSON.stringify(data)).not.toContain(SECRET_REVIEW_NOTE);
    expect(JSON.stringify(data)).not.toContain(bayview.payAppId);

    const dana = await fx.gcA.admin.as.query(api.dashboard.queries.getDashboardData, {});
    expect(dana.payApps.find((p) => p.payAppId === bayview.payAppId)).toMatchObject({ aiRecommendedCents: 1_200_000, overbilledLines: 1 });
  });

  test("the owner's change-order list hides drafts and offers no create", async () => {
    const { fx, bayview } = await setup();
    const list = await fx.owner.admin.as.query(api.billing.changeOrders.listForProject, { projectId: bayview.projectId });
    expect(list.agreements).toEqual([]);
    expect(list.prime!.canCreate).toBe(false);
    expect(list.prime!.changeOrders.map((c) => c.status)).toEqual(["invoiced", "invoiced"]);
    expect(list.prime!.changeOrders.every((c) => c.scope === "prime")).toBe(true);
    expect(await fx.owner.admin.as.query(api.billing.changeOrders.listForAgreement, { agreementId: bayview.agreementId })).toBeNull();
  });

  test("another project's owner sees nothing of Bayview", async () => {
    const { t, bayview } = await setup();
    const mesaUser = await t.run(async (ctx) => {
      const mesa = (await ctx.db.query("companies").collect()).find((c) => c.name === "Mesa Owner Group")!;
      const userId = await ctx.db.insert("users", { email: "pat@mesa-owner.test", emailVerificationTime: Date.now() });
      await ctx.db.insert("userProfiles", { userId, role: "owner", displayName: "Pat", actorType: "human", companyId: mesa._id, createdAt: Date.now() });
      await ctx.db.insert("companyMembers", { companyId: mesa._id, userId, role: "admin", status: "active", createdAt: Date.now() });
      return userId;
    });
    const pat = await withSession(t, mesaUser, "pat@mesa-owner.test");
    const text = JSON.stringify(await pat.query(api.dashboard.queries.getDashboardData, {}));
    expect(text).toContain("SONORAN added outlets");
    expect(text).not.toMatch(/Harbor Point|BAYVIEW|Camelback/);
    expect(await outcome(pat.query(api.billing.changeOrders.listForProject, { projectId: bayview.projectId }))).toBe(NOT_FOUND);
    expect(await outcome(pat.query(api.dashboard.queries.getDashboardData, { projectId: bayview.projectId }))).toBe(NOT_FOUND);
  });
});

describe("change-order invoices go to THAT project's owner", () => {
  test("each GC's invoicing recipient is the owner on its own project", async () => {
    const { t, fx } = await setup();
    // A member's sign-in email is never a fallback: without a billing email invoicing is disabled.
    const noEmail = await fx.gcA.admin.as.query(api.billing.changeOrders.listForProject, { projectId: fx.gcA.project.projectId });
    expect(noEmail!.invoicing).toEqual({ enabled: false, reason: noOwnerEmailReason("Harbor Point Dental LLC"), recipientEmail: null });
    await t.run((ctx) => ctx.db.patch(fx.owner.companyId, { billingEmail: "ap@harborpoint.test" }));
    const bay = await fx.gcA.admin.as.query(api.billing.changeOrders.listForProject, { projectId: fx.gcA.project.projectId });
    expect(bay!.invoicing).toEqual({ enabled: true, reason: null, recipientEmail: "ap@harborpoint.test" });
    expect(bay!.prime!.canCreate).toBe(true);
    const son = await fx.gcB.admin.as.query(api.billing.changeOrders.listForProject, { projectId: fx.gcB.project.projectId });
    expect(son!.invoicing).toEqual({ enabled: true, reason: null, recipientEmail: "ap@mesa-owner.test" });
  });

  test("a project without an owner disables Invoice now with the reason and sends nothing", async () => {
    const { t, fx } = await setup();
    const gc = fx.demo.gc.as;
    const projectId = fx.demo.project.projectId;
    const list = await gc.query(api.billing.changeOrders.listForProject, { projectId });
    expect(list.invoicing).toEqual({ enabled: false, reason: NO_PROJECT_OWNER_REASON, recipientEmail: null });
    const { changeOrderId } = await gc.mutation(api.billing.changeOrders.createChangeOrder, {
      scope: "prime",
      projectId,
      title: "Extra",
      amountCents: 100,
    });
    await gc.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId });
    const row = (await gc.query(api.billing.changeOrders.listForProject, { projectId })).prime!.changeOrders.find((c) => c._id === changeOrderId)!;
    expect(row.invoice).toEqual({ show: true, enabled: false, reason: NO_PROJECT_OWNER_REASON });
    const before = await snapshot(t);
    expect(await outcome(gc.action(api.payments.invoices.sendChangeOrderInvoice, { changeOrderId }))).toMatch(/NOT_INVOICEABLE|NO_OWNER_EMAIL/);
    expect(await snapshot(t)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("billing-agent links are scoped to the creating GC company", () => {
  test("Priya cannot list or revoke Dana's link; Dana can", async () => {
    const { t, fx, extra } = await setup();
    expect(await fx.gcB.admin.as.query(api.agentLinks.listAgentLinks, {})).toEqual([]);
    const before = await snapshot(t);
    for (const caller of [fx.gcB.admin.as, fx.demo.gc.as]) {
      expect(await outcome(caller.mutation(api.agentLinks.revokeAgentLink, { linkId: extra.linkId }))).toBe(NOT_FOUND);
    }
    expect(await snapshot(t)).toBe(before);
    const danaLinks = await fx.gcA.admin.as.query(api.agentLinks.listAgentLinks, {});
    expect(danaLinks.map((l) => l._id)).toEqual([extra.linkId]);
    await fx.gcA.admin.as.mutation(api.agentLinks.revokeAgentLink, { linkId: extra.linkId });
    expect((await t.run((ctx) => ctx.db.get(extra.linkId)))?.status).toBe("revoked");
  });

  test("linkable contractors are only the caller's own vendors", async () => {
    const { fx } = await setup();
    const names = async (c: Caller) => (await c.query(api.agentLinks.listLinkableContractors, {})).map((r) => r.companyName).sort();
    expect(await names(fx.gcA.admin.as)).toEqual(["Eastbay Electric", "Lakeshore Mechanical"]);
    expect(await names(fx.gcB.admin.as)).toEqual(["Camelback Suite 400 Electric"]);
  });

  test("a new link records the creating GC company and the vendor's company", async () => {
    const { t, fx } = await setup();
    const linkId = await fx.gcA.admin.as.mutation(api.agentLinks.addAgentLink, {
      agentEmail: "dullstreet57@agentmail.to",
      contractorId: fx.gcA.project.contractorId,
    });
    const row = await t.run((ctx) => ctx.db.get(linkId));
    expect(row).toMatchObject({ gcCompanyId: fx.gcA.companyId, subCompanyId: fx.sub.companyId });
  });
});

describe("Demo-only payment diagnostics", () => {
  test("sandbox top-up, review evals and the judge demo refuse every non-Demo company", async () => {
    const { t, fx } = await setup();
    const before = await snapshot(t);
    for (const caller of [fx.gcA.admin.as, fx.gcB.admin.as, fx.noCompany.as]) {
      expect(await outcome(caller.query(api.payments.sandboxTopUpDb.listTopUps, {}))).toBe(NOT_FOUND);
      expect(await outcome(caller.action(api.payments.sandboxTopUp.createTopUpOrder, { amountCents: 10_000 }))).toBe(NOT_FOUND);
      expect(await outcome(caller.action(api.payments.sandboxTopUp.captureTopUpOrder, { paypalOrderId: "X" }))).toBe(NOT_FOUND);
      expect(await outcome(caller.query(api.payApps.reviewEvals.getLatestPayAppReviewEvalRun, {}))).toBe(NOT_FOUND);
      expect(await outcome(caller.action(api.payApps.reviewEvals.executePayAppReviewEvalSuite, {}))).toBe(NOT_FOUND);
      expect(await outcome(caller.mutation(api.judgeDemo.runs.startRun, {}))).toBe(NOT_FOUND);
      expect(await outcome(caller.query(api.judgeDemo.runs.getRun, {}))).toBe(NOT_FOUND);
    }
    expect(await snapshot(t)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await outcome(fx.demo.gc.as.query(api.payments.sandboxTopUpDb.listTopUps, {}))).toMatch(/^RESOLVED:/);
    expect(await outcome(fx.demo.gc.as.query(api.payApps.reviewEvals.getLatestPayAppReviewEvalRun, {}))).toMatch(/^RESOLVED:/);
    expect(await outcome(fx.demo.gc.as.query(api.judgeDemo.runs.getRun, {}))).toMatch(/^RESOLVED:/);
  });
});

describe("/ai/studio proxy", () => {
  test("no token gets 401; a user without a company and a sub get 403; no model call", async () => {
    const { t, fx } = await setup();
    const post = (c: { fetch: T["fetch"] }) =>
      c.fetch("/ai/studio", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect((await post(t)).status).toBe(401);
    expect((await post(fx.noCompany.as)).status).toBe(403);
    expect((await post(fx.sub.admin.as)).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
