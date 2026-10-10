/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture } from "../lib/tenancyFixtures";
import { ensureSovAndMilestones } from "../payments/sov";
import { clearPayPalTokenCache } from "../payments/paypalClient";

const modules = import.meta.glob("/convex/**/*.ts");

const SOV = [
  ["Mobilization & general conditions", 800_000],
  ["Temporary power & lighting", 640_000],
  ["Underground & slab conduit rough-in", 3_150_000],
  ["Branch wiring rough-in", 3_820_000],
  ["Switchboard & panelboards", 4_200_000],
  ["Lighting fixtures & controls", 2_860_000],
  ["Devices & trim-out", 1_270_000],
  ["Testing, closeout & as-builts", 500_000],
] as const;

const PAYEE = "kim-payouts@eastbay.test";

type Call = { method: string; path: string; body: unknown };

function fakePayPal() {
  const calls: Call[] = [];
  let n = 0;
  const batches = new Map<string, { receiver: string; value: string; sender: string }>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21AAfaketoken", expires_in: 32400 });
    const text = req.method === "GET" ? "" : await req.text();
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: url.pathname, body });
    if (req.method === "POST" && /\/v2\/payments\/authorizations\/[^/]+\/capture$/.test(url.pathname)) {
      return json(201, { id: `CAP-${++n}`, status: "COMPLETED", amount: { currency_code: "USD", value: body.amount.value } });
    }
    if (req.method === "POST" && url.pathname === "/v1/payments/payouts") {
      const id = `BATCH-${++n}`;
      batches.set(id, { receiver: body.items[0].receiver, value: body.items[0].amount.value, sender: body.sender_batch_header.sender_batch_id });
      return json(201, { batch_header: { payout_batch_id: id, batch_status: "PENDING" } });
    }
    const get = url.pathname.match(/^\/v1\/payments\/payouts\/([^/]+)$/);
    if (req.method === "GET" && get) {
      const b = batches.get(get[1])!;
      return json(200, {
        batch_header: { payout_batch_id: get[1], batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: b.sender } },
        items: [{ payout_item_id: `ITEM-${get[1]}`, transaction_status: "SUCCESS", payout_item: { receiver: b.receiver, amount: { value: b.value, currency: "USD" } } }],
      });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND" });
  });
  const posts = (re: RegExp) => calls.filter((c) => c.method === "POST" && re.test(c.path));
  return { fetchImpl, calls, posts, batches };
}

let fake: ReturnType<typeof fakePayPal>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-client");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret-value");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  fake = fakePayPal();
  vi.stubGlobal("fetch", fake.fetchImpl);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearPayPalTokenCache();
});

async function setup(opts: { confirmPayee?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  const { agreementId, projectId, contractorId } = f.gcA.project;
  const sov = await t.run(async (ctx) => {
    await ctx.db.patch(projectId, { billingDay: 25, startDate: "2026-11-02", retainageBps: 500, state: "CA" });
    await ctx.db.patch(agreementId, { contractSum: 172_400, contractSumCents: 17_240_000, retainagePercent: 5 });
    const ids: Id<"scheduleOfValues">[] = [];
    for (const [i, [description, cents]] of SOV.entries()) {
      ids.push(await ctx.db.insert("scheduleOfValues", { agreementId, lineNo: i + 1, description, scheduledValueCents: cents, excludedScope: false }));
    }
    await ctx.db.patch(f.sub.companyId, { payoutPaypalEmail: PAYEE });
    const vendorId = await ctx.db.insert("vendors", {
      companyId: f.gcA.companyId,
      name: "Eastbay Electric",
      trades: ["26 00 00"],
      contactName: "Kim",
      email: "kim@eastbay.test",
      linkedCompanyId: f.sub.companyId,
      status: "active",
      createdAt: Date.now(),
      ...(opts.confirmPayee === false ? {} : { payoutEmailConfirmed: { email: PAYEE, confirmedByUserId: f.gcA.admin.userId, confirmedAt: Date.now() } }),
    });
    await ctx.db.patch(contractorId, { vendorId });
    return ids;
  });
  return { t, f, agreementId, projectId, sov };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function fundTranche(s: Setup, trancheId: Id<"milestones">, cents: number) {
  await s.t.run(async (ctx) => {
    await ctx.db.patch(trancheId, { status: "funded" });
    await ctx.db.insert("payments", {
      agreementId: s.agreementId,
      milestoneId: trancheId,
      kind: "funding",
      status: "authorized",
      paypalOrderId: `ORDER-${trancheId}`,
      paypalAuthorizationId: `AUTH-${trancheId}`,
      authorizationExpiresAt: Date.now() + 29 * 86_400_000,
      honorPeriodEndsAt: Date.now() + 3 * 86_400_000,
      grossCents: cents,
      retainageCents: 0,
      netCents: cents,
      idempotencyKey: `fund_${trancheId}_1`,
      createdAt: Date.now(),
    });
  });
}

async function addTranches(s: Setup) {
  const dana = s.f.gcA.admin.as;
  const t1 = await dana.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: "Rough-in", amountCents: 6_000_000 });
  const t2 = await dana.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: "Gear & fixtures", amountCents: 7_000_000 });
  return { t1: t1.trancheId, t2: t2.trancheId };
}

const entry = (sovLineId: Id<"scheduleOfValues">, workThisPeriodCents: number, storedCents = 0) => ({ sovLineId, workThisPeriodCents, storedCents });

/** Pay app 1 of the worked example, reviewed (line 3 recommended at 12,600.00) with a pending agent pair. */
async function reviewedPayApp1(s: Setup) {
  const kim = s.f.sub.admin.as;
  const { payAppId } = await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
  await kim.mutation(api.payApps.g703.submitPayApp, {
    payAppId,
    lines: [entry(s.sov[0], 800_000), entry(s.sov[1], 480_010), entry(s.sov[2], 1_400_000), entry(s.sov[4], 0, 1_800_000)],
  });
  await s.t.run(async (ctx) => {
    const p = (await ctx.db.get(payAppId))!;
    const lines = p.lines.map((l) => ({
      sovLineId: l.sovLineId,
      verdict: l.sovLineId === s.sov[2] ? ("overbilled" as const) : ("ok" as const),
      recommendedPctToDate: l.sovLineId === s.sov[2] ? 0.4 : l.pctCompleteToDate / 100,
      approvedCents: l.sovLineId === s.sov[2] ? 1_260_000 : l.requestedCents,
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
    for (const kind of ["capture", "payout"] as const) {
      await ctx.db.insert("agentProposals", {
        payAppId,
        agreementId: p.agreementId,
        kind,
        amountCents: 4_340_010,
        rationale: "Pay the reviewed amount.",
        flags: [],
        status: "pending",
        source: "agent",
        agentRunId: "run-1",
        createdAt: Date.now(),
      });
    }
  });
  return payAppId;
}

async function approvePayApp1(s: Setup, payAppId: Id<"payApplications">) {
  await s.f.gcA.admin.as.mutation(api.payApps.decisions.decidePayApp, {
    payAppId,
    decision: "approve",
    lines: [{ sovLineId: s.sov[2], action: "override", amountCents: 1_261_250, reason: "Super verified 1,240 LF installed" }],
  });
}

async function paymentRows(s: Setup) {
  return await s.t.run(async (ctx) => {
    const payments = await ctx.db.query("payments").collect();
    return {
      payouts: payments.filter((p) => p.kind === "payout"),
      ledger: await ctx.db.query("retainageLedger").collect(),
      milestones: await ctx.db
        .query("milestones")
        .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", s.agreementId))
        .collect(),
    };
  });
}

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const data = (e as { data?: { message?: string } }).data;
    return String(data?.message ?? (e as Error).message);
  }
  throw new Error("expected the call to fail");
}

describe("funding tranches", () => {
  test("real agreements get no generated milestones; demo agreements keep them, dated from the project start", async () => {
    const s = await setup();
    const demoAgreement = s.f.demo.project.agreementId;
    const counts = await s.t.run(async (ctx) => {
      await ctx.db.patch(s.f.demo.project.projectId, { startDate: "2026-11-02" });
      await ensureSovAndMilestones(ctx, s.agreementId);
      await ensureSovAndMilestones(ctx, demoAgreement);
      const real = await ctx.db
        .query("milestones")
        .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", s.agreementId))
        .collect();
      const demo = await ctx.db
        .query("milestones")
        .withIndex("by_agreementId_and_order", (q) => q.eq("agreementId", demoAgreement))
        .collect();
      return { real: real.length, demoDates: demo.map((m) => m.plannedDate) };
    });
    expect(counts.real).toBe(0);
    expect(counts.demoDates).toHaveLength(4);
    for (const d of counts.demoDates) expect(d).toBeGreaterThanOrEqual(Date.parse("2026-11-02T00:00:00Z"));
  });

  test("tranches are capped at the contract sum to date, editable until funded, and dated no earlier than the start", async () => {
    const s = await setup();
    const dana = s.f.gcA.admin.as;
    const { t1, t2 } = await addTranches(s);
    expect(
      await errorOf(dana.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: "Trim & closeout", amountCents: 4_240_001 })),
    ).toBe("Tranches total $172,400.01, more than the contract sum to date $172,400.00");
    const t3 = await dana.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: "Trim & closeout", amountCents: 4_240_000 });
    expect(t3.warning).toBeNull();

    await dana.mutation(api.billing.tranches.updateTranche, { trancheId: t3.trancheId, amountCents: 4_000_000 });
    const extra = await dana.mutation(api.billing.tranches.createTranche, {
      agreementId: s.agreementId,
      name: "Extra",
      amountCents: 240_000,
      plannedDate: "2026-10-23",
    });
    expect(extra.warning).toBe("The planned date Oct 23, 2026 is before the project start Nov 2, 2026.");
    await dana.mutation(api.billing.tranches.deleteTranche, { trancheId: extra.trancheId });
    await dana.mutation(api.billing.tranches.updateTranche, { trancheId: t3.trancheId, amountCents: 4_240_000, name: "Trim, test & closeout" });
    await dana.mutation(api.billing.tranches.moveTranche, { trancheId: t3.trancheId, direction: "up" });

    const list = (await dana.query(api.billing.tranches.listTranches, { agreementId: s.agreementId }))!;
    expect(list.tranches.map((x) => [x.name, x.amountCents])).toEqual([
      ["Rough-in", 6_000_000],
      ["Trim, test & closeout", 4_240_000],
      ["Gear & fixtures", 7_000_000],
    ]);
    expect(list.trancheTotalCents).toBe(17_240_000);
    expect(list.contractSumToDateCents).toBe(17_240_000);
    expect(list.tranches.every((x) => x.plannedDate === Date.parse("2026-11-02T00:00:00Z"))).toBe(true);

    await fundTranche(s, t1, 6_000_000);
    expect(await errorOf(dana.mutation(api.billing.tranches.updateTranche, { trancheId: t1, amountCents: 5_000_000 }))).toMatch(/funded; its name, amount/);
    expect(await errorOf(dana.mutation(api.billing.tranches.updateTranche, { trancheId: t1, name: "Renamed" }))).toMatch(/locked/);
    expect(await errorOf(dana.mutation(api.billing.tranches.deleteTranche, { trancheId: t1 }))).toMatch(/locked/);
    expect((await dana.query(api.billing.tranches.listTranches, { agreementId: s.agreementId }))!.tranches[0].locked).toBe(true);

    // A change order line raises the contract sum to date by $8,750.00.
    await s.t.run(async (ctx) => {
      await ctx.db.insert("scheduleOfValues", { agreementId: s.agreementId, lineNo: 9, description: "CO #1", scheduledValueCents: 875_000, excludedScope: false });
    });
    expect(
      await errorOf(dana.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: "CO #1", amountCents: 875_001 })),
    ).toBe("Tranches total $181,150.01, more than the contract sum to date $181,150.00");
    await dana.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: "CO #1", amountCents: 875_000 });
    expect(t2).toBeDefined();
  });

  test("the sub, the owner and another GC cannot edit; the sub reads its tranches and the owner a status-only view", async () => {
    const s = await setup();
    const { t1 } = await addTranches(s);
    for (const caller of [s.f.sub.admin.as, s.f.owner.admin.as, s.f.gcB.admin.as]) {
      expect(await errorOf(caller.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: "X", amountCents: 100 }))).toBe("Not found.");
      expect(await errorOf(caller.mutation(api.billing.tranches.updateTranche, { trancheId: t1, amountCents: 100 }))).toBe("Not found.");
      expect(await errorOf(caller.mutation(api.billing.tranches.deleteTranche, { trancheId: t1 }))).toBe("Not found.");
      expect(await errorOf(caller.mutation(api.billing.tranches.moveTranche, { trancheId: t1, direction: "down" }))).toBe("Not found.");
    }
    const sub = (await s.f.sub.admin.as.query(api.billing.tranches.listTranches, { agreementId: s.agreementId }))!;
    expect(sub.canEdit).toBe(false);
    expect(sub.tranches).toHaveLength(2);
    expect(await s.f.gcB.admin.as.query(api.billing.tranches.listTranches, { agreementId: s.agreementId })).toBeNull();
    expect(await errorOf(s.f.owner.admin.as.query(api.billing.tranches.listTranches, { agreementId: s.agreementId }))).toBe("Not found.");
    const owner = await s.f.owner.admin.as.query(api.billing.tranches.ownerProjectTranches, { projectId: s.projectId });
    expect(owner).toEqual([
      {
        trade: "26 00 00 Electrical",
        tranches: [
          expect.objectContaining({ name: "Rough-in", amountCents: 6_000_000, status: "planned", funded: false }),
          expect.objectContaining({ name: "Gear & fixtures", amountCents: 7_000_000, status: "planned", funded: false }),
        ],
      },
    ]);
    expect(await errorOf(s.f.gcB.admin.as.query(api.billing.tranches.ownerProjectTranches, { projectId: s.projectId }))).toBe("Not found.");
  });
});

describe("canPay", () => {
  test("an unapproved pay app is blocked with exactly one reason, and no path pays it", async () => {
    const s = await setup();
    const { t1 } = await addTranches(s);
    await fundTranche(s, t1, 6_000_000);
    const payAppId = await reviewedPayApp1(s);
    const dana = s.f.gcA.admin.as;
    const gate = await dana.query(api.billing.canPay.canPay, { payAppId });
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toEqual([{ code: "NOT_APPROVED", message: "Pay app is not approved" }]);

    expect(await errorOf(dana.action(api.billing.pay.payPayApp, { payAppId }))).toBe("Payment blocked: Pay app is not approved");
    const proposals = await s.t.run(async (ctx) => ctx.db.query("agentProposals").collect());
    const payout = proposals.find((p) => p.kind === "payout")!;
    expect(await errorOf(dana.mutation(api.payApps.proposals.approveProposal, { proposalId: payout._id }))).toBe(
      "Payment blocked: Pay app is not approved",
    );
    expect(
      await errorOf(dana.action(api.payments.release.releaseAndPay, { milestoneId: t1, amountCents: 100_000, requestKey: "legacy-key-1" })),
    ).toMatch(/An approved pay app is required/);
    expect((await paymentRows(s)).payouts).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  test("every unmet condition is listed at once; the payee and funding blockers clear when met", async () => {
    const s = await setup({ confirmPayee: false });
    const payAppId = await reviewedPayApp1(s);
    await approvePayApp1(s, payAppId);
    const dana = s.f.gcA.admin.as;
    let gate = await dana.query(api.billing.canPay.canPay, { payAppId });
    expect(gate.reasons).toEqual([
      { code: "NO_PAYEE", message: "No confirmed payee: payee change pending GC confirmation" },
      { code: "NOT_FUNDED", message: "No funded tranche (available $0.00)" },
    ]);
    expect(gate.figures).toEqual({ grossCents: 4_341_260, retainageCents: 217_064, netCents: 4_124_196 });

    const { t1 } = await addTranches(s);
    await fundTranche(s, t1, 6_000_000);
    await s.t.run(async (ctx) => {
      const vendor = (await ctx.db.query("vendors").collect()).find((v) => v.linkedCompanyId === s.f.sub.companyId)!;
      await ctx.db.patch(vendor._id, { payoutEmailConfirmed: { email: PAYEE, confirmedByUserId: s.f.gcA.admin.userId, confirmedAt: Date.now() } });
    });
    gate = await dana.query(api.billing.canPay.canPay, { payAppId });
    expect(gate.ok).toBe(true);
    expect(gate.tranche).toMatchObject({ trancheId: t1, name: "Rough-in", availableCents: 6_000_000 });
    expect(gate.payeeEmail).toBe(PAYEE);

    // Changing the payout email clears the confirmation and blocks again.
    await s.f.sub.admin.as.mutation(api.payee.setPayoutEmail, { email: "kim-new@eastbay.test" });
    gate = await dana.query(api.billing.canPay.canPay, { payAppId });
    expect(gate.reasons.map((r) => r.message)).toEqual(["No confirmed payee: payee change pending GC confirmation"]);
  });

  test("only the GC company's members can read canPay or pay; everyone else is refused and nothing moves", async () => {
    const s = await setup();
    const { t1 } = await addTranches(s);
    await fundTranche(s, t1, 6_000_000);
    const payAppId = await reviewedPayApp1(s);
    await approvePayApp1(s, payAppId);
    expect((await s.f.sub.admin.as.query(api.billing.canPay.canPay, { payAppId })).ok).toBe(true);
    for (const caller of [s.f.owner.admin.as, s.f.gcB.admin.as]) {
      expect(await errorOf(caller.query(api.billing.canPay.canPay, { payAppId }))).toBe("Not found.");
    }
    for (const caller of [s.f.sub.admin.as, s.f.owner.admin.as, s.f.gcB.admin.as, s.f.demo.gc.as]) {
      expect(await errorOf(caller.action(api.billing.pay.payPayApp, { payAppId }))).toMatch(/Not found/);
    }
    expect((await paymentRows(s)).payouts).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  test("paying approved pay app 1 captures the approved gross and pays the confirmed payee the net, once", async () => {
    const s = await setup();
    const { t1 } = await addTranches(s);
    await fundTranche(s, t1, 6_000_000);
    const payAppId = await reviewedPayApp1(s);
    await approvePayApp1(s, payAppId);
    const dana = s.f.gcA.admin.as;
    const out = await dana.action(api.billing.pay.payPayApp, { payAppId });
    expect(out.state).toBe("pending");

    const captures = fake.posts(/\/capture$/);
    expect(captures).toHaveLength(1);
    expect(captures[0].path).toBe(`/v2/payments/authorizations/AUTH-${t1}/capture`);
    expect(captures[0].body).toMatchObject({ amount: { currency_code: "USD", value: "43412.60" }, final_capture: false });
    const payouts = fake.posts(/^\/v1\/payments\/payouts$/);
    expect(payouts).toHaveLength(1);
    expect((payouts[0].body as { items: { receiver: string; amount: { value: string } }[] }).items[0]).toMatchObject({
      receiver: PAYEE,
      amount: { value: "41241.96" },
    });

    let rows = await paymentRows(s);
    expect(rows.payouts).toHaveLength(1);
    expect(rows.payouts[0]).toMatchObject({ payAppId, grossCents: 4_341_260, retainageCents: 217_064, netCents: 4_124_196, receiverEmail: PAYEE });
    expect(rows.ledger.map((l) => l.deltaCents)).toEqual([217_064]);
    const proposals = await s.t.run(async (ctx) => ctx.db.query("agentProposals").collect());
    expect(proposals.filter((p) => p.source === "agent").every((p) => p.status === "cancelled")).toBe(true);

    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const app = await s.t.run(async (ctx) => ctx.db.get(payAppId));
    expect(app!.status).toBe("paid");
    const gate = await dana.query(api.billing.canPay.canPay, { payAppId });
    expect(gate.reasons).toEqual([{ code: "ALREADY_PAID", message: "Already paid" }]);

    const again = await dana.action(api.billing.pay.payPayApp, { payAppId });
    expect(again.state).toBe("already_processed");
    expect(fake.posts(/\/capture$/)).toHaveLength(1);
    expect(fake.batches.size).toBe(1);

    const panel = (await s.f.sub.admin.as.query(api.billing.canPay.paymentPanel, { payAppId }))!;
    expect(panel.payment).toMatchObject({ status: "success", netCents: 4_124_196, retainageCents: 217_064, trancheName: "Rough-in" });
    expect(panel.totalRetainageHeldCents).toBe(217_064);
    rows = await paymentRows(s);
    expect(rows.payouts).toHaveLength(1);

    const ledger = (await s.f.sub.admin.as.query(api.payments.ledger.getAgreementLedger, { agreementId: s.agreementId }))!;
    expect(ledger.retainageLedger).toHaveLength(1);
    expect(ledger.retainageLedger[0]).toMatchObject({ deltaCents: 217_064, payAppId });
    expect(ledger.retainageLedger[0].reason).toMatch(/^Pay app #1: retainage withheld from \$43,412\.60 approved/);

    const retainage = await dana.query(api.billing.retainage.projectRetainage, {});
    expect(retainage.projects).toHaveLength(1);
    expect(retainage.projects[0].subHeldCents).toBe(217_064);
    expect(retainage.projects[0].agreements[0]).toMatchObject({ heldCents: 217_064, entries: [{ payAppId, applicationNo: 1, deltaCents: 217_064 }] });
    expect(retainage.projects[0].prime.heldCents).toBeNull();
    for (const caller of [s.f.sub.admin.as, s.f.owner.admin.as]) {
      expect(await errorOf(caller.query(api.billing.retainage.projectRetainage, {}))).toMatch(/Forbidden|Not found/);
    }
    for (const caller of [s.f.gcB.admin.as, s.f.demo.gc.as]) {
      const seen = await caller.query(api.billing.retainage.projectRetainage, {});
      expect(JSON.stringify(seen)).not.toContain(s.agreementId);
    }
  });

  test("a later pay app larger than any funded tranche's remainder is blocked with the amounts", async () => {
    const s = await setup();
    const { t1, t2 } = await addTranches(s);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(t1, { status: "in_progress" });
      const user = s.f.gcA.admin.userId;
      await ctx.db.insert("payments", {
        agreementId: s.agreementId,
        milestoneId: t1,
        kind: "funding",
        status: "partially_captured",
        paypalAuthorizationId: "AUTH-T1",
        grossCents: 6_000_000,
        capturedCents: 4_341_260,
        retainageCents: 0,
        netCents: 6_000_000,
        idempotencyKey: "fund_t1_1",
        createdAt: Date.now(),
      });
      await ctx.db.insert("payApplications", {
        agreementId: s.agreementId,
        subUserId: s.f.sub.admin.userId,
        periodLabel: "Nov 2026",
        lines: [],
        requestedTotalCents: 4_702_490,
        notes: "",
        lienWaiver: true,
        status: "approved",
        submittedBy: { userId: s.f.sub.admin.userId, actorType: "human" },
        finalApproval: { totalCents: 4_702_490, lines: [], approvedBy: user, approvedAt: Date.now() },
        createdAt: Date.now(),
      });
    });
    const payAppId = (await s.t.run(async (ctx) => ctx.db.query("payApplications").first()))!._id;
    const dana = s.f.gcA.admin.as;
    expect((await dana.query(api.billing.canPay.canPay, { payAppId })).reasons).toEqual([
      { code: "NOT_FUNDED", message: "No funded tranche covers $47,024.90 (available $16,587.40)" },
    ]);
    await fundTranche(s, t2, 7_000_000);
    const gate = await dana.query(api.billing.canPay.canPay, { payAppId });
    expect(gate.ok).toBe(true);
    expect(gate.tranche?.name).toBe("Gear & fixtures");
  });
});

describe("tranche capacity", () => {
  test("an agreement holds at most 50 tranches: the 51st is refused, the cap counts all 50 and every order position is unique", async () => {
    const s = await setup();
    const dana = s.f.gcA.admin.as;
    for (let i = 0; i < 50; i++) {
      await dana.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: `T${i + 1}`, amountCents: 100 });
    }
    expect(await errorOf(dana.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: "T51", amountCents: 100 }))).toBe(
      "An agreement can have at most 50 funding tranches. Combine or delete a tranche before adding another.",
    );
    const list = (await dana.query(api.billing.tranches.listTranches, { agreementId: s.agreementId }))!;
    expect(list.tranches).toHaveLength(50);
    expect(list.trancheTotalCents).toBe(5_000);
    expect(new Set(list.tranches.map((x) => x.order)).size).toBe(50);

    // Re-pricing the last tranche is checked against all 50, not a truncated read.
    const last = list.tranches[49]._id;
    expect(await errorOf(dana.mutation(api.billing.tranches.updateTranche, { trancheId: last, amountCents: 17_240_000 - 4_900 + 1 }))).toBe(
      "Tranches total $172,400.01, more than the contract sum to date $172,400.00",
    );
    await dana.mutation(api.billing.tranches.updateTranche, { trancheId: last, amountCents: 17_240_000 - 4_900 });
    await dana.mutation(api.billing.tranches.deleteTranche, { trancheId: list.tranches[0]._id });
    expect(await errorOf(dana.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: "Over", amountCents: 101 }))).toBe(
      "Tranches total $172,400.01, more than the contract sum to date $172,400.00",
    );
    await dana.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: "Fits", amountCents: 100 });
    const after = (await dana.query(api.billing.tranches.listTranches, { agreementId: s.agreementId }))!;
    expect(after.tranches).toHaveLength(50);
    expect(after.trancheTotalCents).toBe(17_240_000);
    expect(new Set(after.tranches.map((x) => x.order)).size).toBe(50);
  });

  test("an agreement already holding more than 50 tranches is refused everywhere instead of being read partially", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 51; i++) {
        await ctx.db.insert("milestones", { agreementId: s.agreementId, name: `L${i}`, order: i + 1, plannedDate: Date.now(), amountCents: 100, status: "planned", sovLineIds: [] });
      }
    });
    const dana = s.f.gcA.admin.as;
    const capacity = /more than 50 funding tranches/;
    expect(await errorOf(dana.mutation(api.billing.tranches.createTranche, { agreementId: s.agreementId, name: "X", amountCents: 100 }))).toMatch(capacity);
    expect(await errorOf(dana.query(api.billing.tranches.listTranches, { agreementId: s.agreementId }))).toMatch(capacity);
  });
});

/** A G703 pay app on sov[0] and sov[1] with the given per-line retainage, reviewed as requested and approved. */
async function approvedMixedRatePayApp(s: Setup, bps: [number, number], work: [number, number]) {
  await s.t.run(async (ctx) => {
    await ctx.db.patch(s.sov[0], { retainageBps: bps[0] });
    await ctx.db.patch(s.sov[1], { retainageBps: bps[1] });
  });
  const kim = s.f.sub.admin.as;
  const { payAppId } = await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
  await kim.mutation(api.payApps.g703.submitPayApp, { payAppId, lines: [entry(s.sov[0], work[0]), entry(s.sov[1], work[1])] });
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
  await s.f.gcA.admin.as.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve" });
  return payAppId;
}

describe("payout figures follow the approved G702 when lines carry different retainage rates", () => {
  test("10% and 2.5% lines: the payout, the ledger entry and the Payment panel equal the G702 payment due and retainage", async () => {
    const s = await setup();
    const { t1 } = await addTranches(s);
    await fundTranche(s, t1, 6_000_000);
    const payAppId = await approvedMixedRatePayApp(s, [1_000, 250], [800_000, 480_010]);
    const app = await s.t.run(async (ctx) => (await ctx.db.get(payAppId))!);
    // 10% of 8,000.00 = 800.00; 2.5% of 4,800.10 = 120.0025 -> 120.00. A flat 5% split would withhold 640.01.
    expect(app.g703!.approved).toMatchObject({ retainageCents: 92_000, currentPaymentDueCents: 1_188_010 });
    const dana = s.f.gcA.admin.as;
    const figures = { grossCents: 1_280_010, retainageCents: 92_000, netCents: 1_188_010 };
    expect((await dana.query(api.billing.canPay.paymentPanel, { payAppId }))!.figures).toEqual(figures);

    await dana.action(api.billing.pay.payPayApp, { payAppId });
    expect(fake.posts(/\/capture$/)[0].body).toMatchObject({ amount: { value: "12800.10" } });
    expect((fake.posts(/^\/v1\/payments\/payouts$/)[0].body as { items: { amount: { value: string } }[] }).items[0].amount.value).toBe("11880.10");
    const rows = await paymentRows(s);
    expect(rows.payouts[0]).toMatchObject(figures);
    expect(rows.ledger.map((l) => l.deltaCents)).toEqual([92_000]);
    const panel = (await s.f.sub.admin.as.query(api.billing.canPay.paymentPanel, { payAppId }))!;
    expect(panel.payment).toMatchObject(figures);
    expect(panel.totalRetainageHeldCents).toBe(92_000);
  });

  test("when the G702 retainage goes down this period, the payout is the payment due and the ledger is debited, only from held retainage", async () => {
    const s = await setup();
    const { t1 } = await addTranches(s);
    await fundTranche(s, t1, 6_000_000);
    const payAppId = await approvedMixedRatePayApp(s, [1_000, 250], [800_000, 480_010]);
    // A credit line at a higher rate than the work it is billed with lowers the retainage to date by 120.00.
    await s.t.run(async (ctx) => {
      const p = (await ctx.db.get(payAppId))!;
      await ctx.db.patch(payAppId, { g703: { ...p.g703!, approved: { ...p.g703!.approved!, currentPaymentDueCents: 1_292_010 } } });
    });
    const dana = s.f.gcA.admin.as;
    const gate = await dana.query(api.billing.canPay.canPay, { payAppId });
    expect(gate.figures).toEqual({ grossCents: 1_280_010, retainageCents: -12_000, netCents: 1_292_010 });
    expect(gate.reasons).toEqual([
      { code: "RETAINAGE_SHORTFALL", message: "Not enough retainage held: the payment due releases $120.00 of retainage but $0.00 is held" },
    ]);
    expect(await errorOf(dana.action(api.billing.pay.payPayApp, { payAppId }))).toMatch(/Not enough retainage held/);
    expect(fake.calls).toHaveLength(0);

    await s.t.run(async (ctx) => {
      await ctx.db.insert("retainageLedger", { agreementId: s.agreementId, deltaCents: 50_000, reason: "Held from an earlier period", createdAt: Date.now() });
    });
    expect((await dana.query(api.billing.canPay.canPay, { payAppId })).ok).toBe(true);
    await dana.action(api.billing.pay.payPayApp, { payAppId });
    expect(fake.posts(/\/capture$/)[0].body).toMatchObject({ amount: { value: "12800.10" } });
    expect((fake.posts(/^\/v1\/payments\/payouts$/)[0].body as { items: { amount: { value: string } }[] }).items[0].amount.value).toBe("12920.10");
    const rows = await paymentRows(s);
    expect(rows.ledger.map((l) => l.deltaCents).sort((a, b) => a - b)).toEqual([-12_000, 50_000]);
    expect((await dana.query(api.billing.canPay.paymentPanel, { payAppId }))!.totalRetainageHeldCents).toBe(38_000);
  });
});
