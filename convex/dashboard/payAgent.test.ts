/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";

const modules = import.meta.glob("/convex/**/*.ts");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  const agreement = await t.run(async (ctx) => (await ctx.db.query("agreements").first())!);
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  const sub1 = await signInAs(t, "sub", { email: "sub1@test.tradepulse", contractorId: agreement.contractorId! });
  const owner = await signInAs(t, "owner");
  await t.run(async (ctx) => {
    const now = Date.now();
    const payoutId = await ctx.db.insert("payments", {
      agreementId: agreement._id,
      kind: "payout",
      status: "success",
      grossCents: 123_456,
      retainageCents: 12_346,
      netCents: 111_110,
      idempotencyKey: "pay-agent-1",
      createdAt: now,
    });
    await ctx.db.insert("retainageLedger", { agreementId: agreement._id, paymentId: payoutId, deltaCents: 12_346, reason: "withheld", createdAt: now });
    await ctx.db.insert("retainageLedger", { agreementId: agreement._id, deltaCents: -1_000, reason: "released", createdAt: now });
  });
  return { t, gc, sub1, owner, agreement };
}

describe("pay agent ledger summary", () => {
  test("GC gets the ledger retainage balance and net paid for the agreement, formatted", async () => {
    const { gc, agreement } = await setup();
    const out = await gc.as.query(api.dashboard.payAgent.getPaySummary, {});
    const row = out.agreements.find((a) => a.agreementId === agreement._id)!;
    expect(row.totalsCents.retainageHeldCents).toBe(11_346);
    expect(row.formatted.retainageHeld).toBe("$113.46");
    expect(row.totalsCents.paidCents).toBe(111_110);
    expect(row.formatted.paid).toBe("$1,111.10");
    expect(row.subcontractor).toBe(agreement.subcontractorName);
    const sub = out.subcontractors.find((s) => s.subcontractor === agreement.subcontractorName)!;
    const sameSub = out.agreements.filter((a) => a.subcontractor === agreement.subcontractorName);
    expect(sub.agreementCount).toBe(sameSub.length);
    expect(sub.retainageHeldCents).toBe(sameSub.reduce((acc, a) => acc + a.totalsCents.retainageHeldCents, 0));
  });

  test("owner can read it; sub, no-role and signed-out callers are refused", async () => {
    const { t, owner, sub1 } = await setup();
    await expect(owner.as.query(api.dashboard.payAgent.getPaySummary, {})).resolves.toBeTruthy();
    const noRole = await signInAs(t, null);
    for (const caller of [sub1.as, noRole.as, t]) {
      await expect(caller.query(api.dashboard.payAgent.getPaySummary, {})).rejects.toThrow(/Forbidden|Not authenticated/);
    }
  });
});
