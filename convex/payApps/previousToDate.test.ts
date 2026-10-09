/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { finalizeReview } from "./reviewMath";

const modules = import.meta.glob("/convex/**/*.ts");

// Submitting schedules the AI review; fake timers keep it from running mid-test.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const LINE_VALUE = 100_000;

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

const claim = (s: S, label: string, thisPeriod: number, toDate: number, requestedCents: number) => ({
  agreementId: s.agreement._id,
  periodLabel: label,
  lines: [{ sovLineId: s.line._id, pctCompleteThisPeriod: thisPeriod, pctCompleteToDate: toDate, requestedCents }],
  notes: "",
  lienWaiver: true,
});

async function formLine(s: S) {
  const form = await s.sub1.as.query(api.payApps.submit.payAppFormContext, { agreementId: s.agreement._id });
  return form!.sovLines.find((l) => l._id === s.line._id)!;
}

async function reviewLine(s: S, payAppId: Id<"payApplications">) {
  const inputs = await s.t.query(internal.payApps.review.loadReviewInputs, { payAppId });
  return { context: inputs!.context, line: inputs!.context.lines.find((l) => l.sovLineId === s.line._id)! };
}

/** The state approveProposal leaves after the GC edits the payout down to `approvedCents`. */
async function approveEditedDown(s: S, payAppId: Id<"payApplications">, approvedCents: number) {
  await s.t.run(async (ctx) =>
    ctx.db.patch(payAppId, {
      status: "approved",
      finalApproval: {
        totalCents: approvedCents,
        lines: [{ sovLineId: s.line._id, approvedCents }],
        approvedBy: s.gc.userId,
        approvedAt: Date.now(),
      },
    }),
  );
}

describe("previous % to date comes from approved billing only", () => {
  test("an honest pay app after an overbilled one the GC edited down is accepted at the true percent", async () => {
    const s = await setup();
    const overbilled = await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, claim(s, "Agent 30%", 30, 30, 30_000));

    // Pending: the 30% claim reserves value but is not a baseline.
    expect(await formLine(s)).toMatchObject({
      previouslyBilledCents: 0,
      previousPctToDate: 0,
      pendingRequestedCents: 30_000,
      remainingCents: 70_000,
    });

    await approveEditedDown(s, overbilled, 12_000);
    expect(await formLine(s)).toMatchObject({
      previouslyBilledCents: 12_000,
      previousPctToDate: 12,
      pendingRequestedCents: 0,
      remainingCents: 88_000,
    });

    // True progress is 20% to date: 8% this period on top of the 12% approved.
    const honest = await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, claim(s, "Honest 20%", 8, 20, 8_000));
    const { context, line } = await reviewLine(s, honest);
    expect(line).toMatchObject({
      previouslyBilledCents: 12_000,
      previousPctToDate: 0.12,
      pendingRequestedCents: 0,
      claimedPctToDate: 0.2,
      requestedCents: 8_000,
    });
    const review = finalizeReview(context, {
      lines: [{ sovLineId: s.line._id, verdict: "ok", recommendedPctToDate: 0.2, reason: "matches progress" }],
      lienWaiverMissing: false,
      licenseIssue: false,
      notes: "",
    });
    expect(review.lines[0].approvedCents).toBe(8_000);
  });

  test("a rejected request does not move the baseline", async () => {
    const s = await setup();
    const first = await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, claim(s, "Claim 40%", 40, 40, 40_000));
    await s.gc.as.mutation(api.payApps.proposals.rejectPayApp, { payAppId: first, reason: "not supported" });

    expect(await formLine(s)).toMatchObject({
      previouslyBilledCents: 0,
      previousPctToDate: 0,
      pendingRequestedCents: 0,
      remainingCents: LINE_VALUE,
    });
    const next = await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, claim(s, "Honest 10%", 10, 10, 10_000));
    const { line } = await reviewLine(s, next);
    expect(line).toMatchObject({ previouslyBilledCents: 0, previousPctToDate: 0, pendingRequestedCents: 0 });
  });

  test("an earlier pending request is passed to the review as pending and reduces the approved cents", async () => {
    const s = await setup();
    await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, claim(s, "Open 10%", 10, 10, 10_000));
    const second = await s.sub1.as.mutation(api.payApps.submit.submitPayApplication, claim(s, "Next 25%", 15, 25, 15_000));
    const { context, line } = await reviewLine(s, second);
    expect(line).toMatchObject({ previouslyBilledCents: 0, previousPctToDate: 0, pendingRequestedCents: 10_000 });
    const review = finalizeReview(context, {
      lines: [{ sovLineId: s.line._id, verdict: "ok", recommendedPctToDate: 0.25, reason: "matches progress" }],
      lienWaiverMissing: false,
      licenseIssue: false,
      notes: "",
    });
    expect(review.lines[0].approvedCents).toBe(15_000);
  });
});
