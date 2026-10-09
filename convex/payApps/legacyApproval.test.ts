/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";

const modules = import.meta.glob("/convex/**/*.ts");

// Submitting schedules the AI review; fake timers keep it from running mid-test.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const LINE_VALUE = 10_000;

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  const agreement = await t.run(async (ctx) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_demo", (q) => q.eq("isDemoProject", true))
      .first();
    return (await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project!._id))
      .first())!;
  });
  await gc.as.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  await gc.as.mutation(api.billing.sov.approveSov, { agreementId: agreement._id });
  const line = await t.run(async (ctx) => {
    const first = (await ctx.db
      .query("scheduleOfValues")
      .withIndex("by_agreementId_and_lineNo", (q) => q.eq("agreementId", agreement._id))
      .first())!;
    await ctx.db.patch(first._id, { scheduledValueCents: LINE_VALUE, excludedScope: false });
    return (await ctx.db.get(first._id))!;
  });
  const sub1 = await signInAs(t, "sub", { email: "sub1@test.tradepulse", contractorId: agreement.contractorId! });
  return { t, gc, sub1, agreement, line };
}

type S = Awaited<ReturnType<typeof setup>>;

/**
 * A pay app approved before final approvals were stored: a review recommendation, an approved
 * payout/capture pair (optionally GC-edited) and no finalApproval.
 */
async function insertLegacyApproval(
  s: S,
  opts: {
    requestedCents: number;
    recommendedCents: number;
    approvedCents?: number;
    status?: "approved" | "paid";
    withProposal?: boolean;
    createdAt?: number;
  },
) {
  return await s.t.run(async (ctx) => {
    const now = opts.createdAt ?? Date.now();
    const payAppId = await ctx.db.insert("payApplications", {
      agreementId: s.agreement._id,
      contractorId: s.agreement.contractorId,
      subUserId: s.sub1.userId,
      periodLabel: "Legacy approved",
      lines: [{ sovLineId: s.line._id, pctCompleteThisPeriod: 50, pctCompleteToDate: 50, requestedCents: opts.requestedCents }],
      requestedTotalCents: opts.requestedCents,
      notes: "",
      lienWaiver: true,
      status: opts.status ?? "approved",
      submittedBy: { userId: s.sub1.userId, actorType: "human" },
      review: {
        engine: "Offline rules engine",
        provider: "Offline rules engine",
        model: "none",
        lines: [{ sovLineId: s.line._id, verdict: "front_loaded", recommendedPctToDate: 20, approvedCents: opts.recommendedCents, reason: "test" }],
        flags: { lienWaiverMissing: false, licenseIssue: false, notes: "" },
        approvedTotalCents: opts.recommendedCents,
        reviewedAt: now,
      },
      createdAt: now,
    });
    if (opts.withProposal !== false) {
      for (const kind of ["capture", "payout"] as const) {
        await ctx.db.insert("agentProposals", {
          payAppId,
          agreementId: s.agreement._id,
          kind,
          amountCents: opts.recommendedCents,
          ...(opts.approvedCents !== undefined ? { editedAmountCents: opts.approvedCents } : {}),
          rationale: "legacy",
          flags: [],
          status: "executed",
          decidedBy: s.gc.userId,
          decidedAt: now + 1,
          agentRunId: "legacy-run",
          createdAt: now,
        });
      }
    }
    return payAppId;
  });
}

const lineArgs = (s: S, cents: number) => ({
  agreementId: s.agreement._id,
  periodLabel: `Next ${cents}`,
  lines: [{ sovLineId: s.line._id, pctCompleteThisPeriod: 10, pctCompleteToDate: 60, requestedCents: cents }],
  notes: "",
  lienWaiver: true,
});

async function errorText(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return JSON.stringify((e as { data?: unknown }).data ?? String(e));
  }
  return "no error";
}

describe("approvals recorded before final per-line approvals existed", () => {
  test("upward GC edit: the rebuilt final amount, not the recommendation, limits later billing", async () => {
    const s = await setup();
    await insertLegacyApproval(s, { requestedCents: LINE_VALUE, recommendedCents: 2_000, approvedCents: 5_000 });
    // The recommendation would leave 8,000; the GC approved 5,000, so only 5,000 remains.
    expect(await errorText(s.sub1.as.mutation(api.payApps.submit.submitPayApplication, lineArgs(s, 5_001)))).toMatch(
      /exceeds the remaining scheduled value of \$50\.00/,
    );
    const nextId = await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, lineArgs(s, 5_000));

    const inputs = await s.t.query(internal.payApps.review.loadReviewInputs, { payAppId: nextId });
    expect(inputs!.context.lines.find((l) => l.sovLineId === s.line._id)!.previouslyBilledCents).toBe(5_000);
    expect(inputs!.context.priorPayApps.find((p) => p.periodLabel === "Legacy approved")!.approvedTotalCents).toBe(5_000);

    const ledger = await s.gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: s.agreement._id });
    expect(ledger!.totals.billedCents).toBe(5_000);
    expect(ledger!.billingAttention).toEqual([]);
    const rec = await s.t.query(internal.payments.reconcile.ledgerReconciliation, { agreementId: s.agreement._id });
    expect(rec!.totals.billedCents).toBe(5_000);
    expect(rec!.rawSums.billedCents).toBe(5_000);
    expect(rec!.needsAttention).toEqual([]);
  });

  test("downward GC edit on a paid app: the smaller final amount frees the rest of the line", async () => {
    const s = await setup();
    const legacyId = await insertLegacyApproval(s, { requestedCents: LINE_VALUE, recommendedCents: 8_000, approvedCents: 3_000, status: "paid" });
    expect(await errorText(s.sub1.as.mutation(api.payApps.submit.submitPayApplication, lineArgs(s, 7_001)))).toMatch(
      /exceeds the remaining scheduled value of \$70\.00/,
    );
    await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, lineArgs(s, 7_000));
    const ledger = await s.gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: s.agreement._id });
    expect(ledger!.totals.billedCents).toBe(3_000);
    // Reads never write the rebuilt allocation back or touch the stored recommendation.
    const row = await s.t.run(async (ctx) => ctx.db.get(legacyId));
    expect(row!.finalApproval).toBeUndefined();
    expect(row!.review!.approvedTotalCents).toBe(8_000);
  });

  test("an unedited legacy approval rebuilds to the proposal amount", async () => {
    const s = await setup();
    await insertLegacyApproval(s, { requestedCents: 6_000, recommendedCents: 4_000 });
    const ctx = await s.sub1.as.query(api.payApps.submit.payAppFormContext, { agreementId: s.agreement._id });
    expect(ctx!.sovLines.find((l) => l._id === s.line._id)!.remainingCents).toBe(6_000);
  });

  test("without a recorded GC decision, submission and review refuse and the ledger and reconciliation flag the row", async () => {
    const s = await setup();
    const legacyId = await insertLegacyApproval(s, { requestedCents: 4_000, recommendedCents: 2_000, withProposal: false });
    const pendingId = await s.t.run(async (ctx) =>
      ctx.db.insert("payApplications", {
        agreementId: s.agreement._id,
        contractorId: s.agreement.contractorId,
        subUserId: s.sub1.userId,
        periodLabel: "Pending review",
        lines: [{ sovLineId: s.line._id, pctCompleteThisPeriod: 1, pctCompleteToDate: 60, requestedCents: 100 }],
        requestedTotalCents: 100,
        notes: "",
        lienWaiver: true,
        status: "submitted",
        submittedBy: { userId: s.sub1.userId, actorType: "human" },
        createdAt: Date.now() + 10,
      }),
    );

    expect(await errorText(s.sub1.as.mutation(api.payApps.submit.submitPayApplication, lineArgs(s, 100)))).toMatch(
      /APPROVAL_UNRESOLVED.*Legacy approved.*no approved capture or payout proposal is recorded/,
    );
    await expect(s.t.query(internal.payApps.review.loadReviewInputs, { payAppId: pendingId })).rejects.toThrow(/cannot be rebuilt/);

    const ledger = await s.gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: s.agreement._id });
    expect(ledger!.totals.billedCents).toBe(0);
    expect(ledger!.billingAttention).toHaveLength(1);
    expect(ledger!.billingAttention[0]).toMatch(/Legacy approved/);

    const rec = await s.t.query(internal.payments.reconcile.ledgerReconciliation, { agreementId: s.agreement._id });
    expect(rec!.needsAttention).toEqual([expect.objectContaining({ payAppId: legacyId, periodLabel: "Legacy approved" })]);
    expect(rec!.mismatches.some((m) => m.includes(legacyId) && m.includes("needs attention"))).toBe(true);
  });

  test("a GC decision larger than the lines can bill fails closed instead of guessing a split", async () => {
    const s = await setup();
    await insertLegacyApproval(s, { requestedCents: 4_000, recommendedCents: 2_000, approvedCents: 4_001 });
    expect(await errorText(s.sub1.as.mutation(api.payApps.submit.submitPayApplication, lineArgs(s, 100)))).toMatch(
      /cannot be split across its lines/,
    );
  });
});

describe("ledger billing reads complete history", () => {
  test("500 withdrawn/rejected applications do not hide approved application 501 from ledger or reconciliation", async () => {
    const s = await setup();
    const base = Date.now() - 1_000_000;
    await s.t.run(async (ctx) => {
      const row = (i: number, status: Doc<"payApplications">["status"]) => ({
        agreementId: s.agreement._id,
        contractorId: s.agreement.contractorId,
        subUserId: s.sub1.userId,
        periodLabel: `History ${i}`,
        lines: [{ sovLineId: s.line._id, pctCompleteThisPeriod: 1, pctCompleteToDate: 1, requestedCents: LINE_VALUE }],
        requestedTotalCents: LINE_VALUE,
        notes: "",
        lienWaiver: true,
        status,
        submittedBy: { userId: s.sub1.userId, actorType: "human" as const },
        createdAt: base + i,
      });
      for (let i = 0; i < 500; i++) await ctx.db.insert("payApplications", row(i, i % 2 === 0 ? "withdrawn" : "rejected"));
      await ctx.db.insert("payApplications", {
        ...row(500, "approved"),
        periodLabel: "Approved #501",
        finalApproval: {
          totalCents: 7_500,
          lines: [{ sovLineId: s.line._id as Id<"scheduleOfValues">, approvedCents: 7_500 }],
          approvedBy: s.gc.userId,
          approvedAt: base + 500,
        },
      });
    });
    const ledger = await s.gc.as.query(api.payments.ledger.getAgreementLedger, { agreementId: s.agreement._id });
    expect(ledger!.totals.billedCents).toBe(7_500);
    const rec = await s.t.query(internal.payments.reconcile.ledgerReconciliation, { agreementId: s.agreement._id });
    expect(rec!.totals.billedCents).toBe(7_500);
    expect(rec!.rawSums.billedCents).toBe(7_500);
  });
});
