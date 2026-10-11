/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture, type FixtureUser } from "../lib/tenancyFixtures";
import { insertTestSession } from "../lib/testIdentity";
import { approvedCentsFor } from "./reviewMath";

const modules = import.meta.glob("/convex/**/*.ts");

// Submitting schedules the AI review and the review schedules the pay agent; fake timers hold both.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

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

const OVERRIDE_REASON = "Super verified 1,240 LF of slab conduit installed through Oct 25";

async function setup() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  const { agreementId, projectId } = f.gcA.project;
  const extra = await t.run(async (ctx) => {
    await ctx.db.patch(projectId, { billingDay: 25, startDate: "2026-10-01", retainageBps: 500, state: "CA" });
    await ctx.db.patch(agreementId, {
      contractSum: 172_400,
      contractSumCents: 17_240_000,
      retainagePercent: 5,
      excludedScopeNotes: ["Seismic bracing of conduit and equipment"],
    });
    const sov: Id<"scheduleOfValues">[] = [];
    for (const [i, [description, cents]] of SOV.entries()) {
      sov.push(await ctx.db.insert("scheduleOfValues", { agreementId, lineNo: i + 1, description, scheduledValueCents: cents, excludedScope: false }));
    }
    const lakeshore = await ctx.db.insert("companies", { name: "Lakeshore Mechanical", kind: "sub", isDemo: false, createdAt: Date.now() });
    const lakeUser = await ctx.db.insert("users", { email: "pat@lakeshore.test", emailVerificationTime: Date.now() });
    await ctx.db.insert("userProfiles", { userId: lakeUser, role: "sub", displayName: "Pat", actorType: "human", companyId: lakeshore, createdAt: Date.now() });
    await ctx.db.insert("companyMembers", { companyId: lakeshore, userId: lakeUser, role: "admin", status: "active", createdAt: Date.now() });
    const lakeContractor = await ctx.db.insert("contractors", {
      tradePackageId: f.gcA.project.tradePackageId,
      companyName: "Lakeshore Mechanical",
      contactEmail: "bids@lakeshore.invalid",
      licenseNumber: "0",
      licenseStatus: "Unverified",
      sourceUrl: "https://example.invalid",
      rfqStatus: "bid_received",
      linkedCompanyId: lakeshore,
    });
    await ctx.db.insert("projectMembers", { projectId, companyId: lakeshore, partyRole: "sub", contractorId: lakeContractor, status: "active", createdAt: Date.now() });
    return { sov, lakeUser, session: await insertTestSession(ctx, lakeUser) };
  });
  const lakeshore = t.withIdentity({ subject: `${extra.lakeUser}|${extra.session}`, email: "pat@lakeshore.test" });
  return { t, f, agreementId, sov: extra.sov, lakeshore };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function entry(sovLineId: Id<"scheduleOfValues">, workThisPeriodCents: number, storedCents = 0, note?: string) {
  return { sovLineId, workThisPeriodCents, storedCents, ...(note ? { note } : {}) };
}

const v1Entries = (sov: Id<"scheduleOfValues">[]) => [
  entry(sov[0], 800_000),
  entry(sov[1], 480_010),
  entry(sov[2], 1_400_000),
  entry(sov[4], 0, 1_800_000, "Switchboard delivered, stored in locked conex on site"),
];

async function submit(s: Setup, entries = v1Entries(s.sov)) {
  const kim = s.f.sub.admin.as;
  const { payAppId } = await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
  await kim.mutation(api.payApps.g703.submitPayApp, { payAppId, lines: entries });
  return payAppId;
}

/** Stores a review as the reviewer would: line 3 recommended at 40% to date (12,600.00), others as requested. */
async function storeReview(s: Setup, payAppId: Id<"payApplications">) {
  await s.t.run(async (ctx) => {
    const p = (await ctx.db.get(payAppId))!;
    const lines = p.lines.map((l) => {
      const line3 = l.sovLineId === s.sov[2];
      return {
        sovLineId: l.sovLineId,
        verdict: line3 ? ("overbilled" as const) : ("ok" as const),
        recommendedPctToDate: line3 ? 0.4 : l.pctCompleteToDate / 100,
        approvedCents: line3 ? 1_260_000 : l.requestedCents,
        reason: line3 ? "Line 3 claims 44.44% while the milestones support 40%." : "Within the milestones.",
      };
    });
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
}

const overrideLine3 = (s: Setup, reason?: string) => [{ sovLineId: s.sov[2], action: "override" as const, amountCents: 1_261_250, reason }];

describe("GC per-line decisions", () => {
  test("an override needs a reason; with one, pay app 1 is approved as noted with exact G702 figures", async () => {
    const s = await setup();
    const payAppId = await submit(s);
    await storeReview(s, payAppId);
    const dana = s.f.gcA.admin.as;

    await expect(dana.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve", lines: overrideLine3(s, "  ") })).rejects.toThrow(
      /A reason is required for an override/,
    );
    await expect(
      dana.mutation(api.payApps.decisions.decidePayApp, {
        payAppId,
        decision: "approve",
        lines: [{ sovLineId: s.sov[2], action: "override", amountCents: 1_400_001, reason: "x" }],
      }),
    ).rejects.toThrow(/cannot exceed \$14,000\.00/);

    const res = await dana.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve", lines: overrideLine3(s, OVERRIDE_REASON) });
    expect(res).toMatchObject({ status: "approved_as_noted", approvedTotalCents: 4_341_260, currentPaymentDueCents: 4_124_196 });

    const row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(row.status).toBe("approved_as_noted");
    expect(row.finalApproval).toMatchObject({ totalCents: 4_341_260, approvedBy: s.f.gcA.admin.userId });
    expect(row.gcDecision!.decidedBy).toBe(s.f.gcA.admin.userId);
    const decided = new Map(row.gcDecision!.lines.map((l) => [l.sovLineId, l]));
    expect(decided.get(s.sov[2])).toMatchObject({ action: "override", recommendedCents: 1_260_000, approvedCents: 1_261_250, reason: OVERRIDE_REASON });
    for (const [i, cents] of [[0, 800_000], [1, 480_010], [4, 1_800_000]] as const) {
      expect(decided.get(s.sov[i])).toMatchObject({ action: "accept", recommendedCents: cents, approvedCents: cents });
    }
    expect(row.g703!.approved).toMatchObject({ completedAndStoredCents: 4_341_260, retainageCents: 217_064, earnedLessRetainageCents: 4_124_196, currentPaymentDueCents: 4_124_196 });

    // The approved total flows to the pending capture/payout pair.
    const proposals = await s.t.run(async (ctx) => ctx.db.query("agentProposals").collect());
    expect(proposals.map((p) => [p.status, p.editedAmountCents])).toEqual([
      ["pending", 4_341_260],
      ["pending", 4_341_260],
    ]);
    await expect(dana.mutation(api.payApps.proposals.editProposal, { proposalId: proposals[1]._id, amountCents: 100 })).rejects.toThrow(
      /only be edited before the GC decides/,
    );
    await expect(dana.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve" })).rejects.toThrow(/only reviewed/);

    const audit = await s.t.run(async (ctx) => ctx.db.query("auditLogs").collect());
    expect(audit.some((a) => a.eventType === "pay_app_approved_as_noted" && a.actor.includes("dana@bayview.test"))).toBe(true);
  });

  test("the sub sees the approved-as-noted result, the reason and a notification, with no AI internals", async () => {
    const s = await setup();
    const payAppId = await submit(s);
    await storeReview(s, payAppId);
    await s.f.gcA.admin.as.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve", lines: overrideLine3(s, OVERRIDE_REASON) });

    const view = await s.f.sub.admin.as.query(api.payApps.g703.getPayApp, { payAppId });
    expect(view.status).toBe("approved_as_noted");
    expect(view.lines[2]).toMatchObject({ workThisPeriodCents: 1_261_250, requestedWorkCents: 1_400_000 });
    expect(view.summary).toMatchObject({ completedAndStoredCents: 4_341_260, retainageCents: 217_064, currentPaymentDueCents: 4_124_196 });
    expect(view.decision!.lines.find((l) => l.lineNo === 3)).toMatchObject({ action: "override", approvedCents: 1_261_250, reason: OVERRIDE_REASON, recommendedCents: null });
    expect(view.decision!.lines.every((l) => l.recommendedCents === null)).toBe(true);
    expect(view.review).toBeNull();
    expect(view.excludedScopeNotes).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("milestones support");

    const gcView = await s.f.gcA.admin.as.query(api.payApps.g703.getPayApp, { payAppId });
    expect(gcView.review!.lines.find((l) => l.lineNo === 3)).toMatchObject({ verdict: "overbilled", recommendedPctToDate: 0.4, approvedCents: 1_260_000 });
    expect(gcView.excludedScopeNotes).toEqual(["Seismic bracing of conduit and equipment"]);

    const notes = await s.t.run(async (ctx) => ctx.db.query("notifications").collect());
    const subNotes = notes.filter((n) => n.companyId === s.f.sub.companyId);
    expect(subNotes).toHaveLength(1);
    expect(subNotes[0]).toMatchObject({ kind: "pay_app_approved", title: "Pay app #1 approved as noted", link: `#/pay-apps/${payAppId}` });
  });

  test("accepting every line gives plain Approved, and the approved amounts carry into the next application's D", async () => {
    const s = await setup();
    const payAppId = await submit(s);
    await storeReview(s, payAppId);
    const res = await s.f.gcA.admin.as.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve" });
    expect(res).toMatchObject({ status: "approved", approvedTotalCents: 4_340_010 });
    const row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(row.gcDecision!.lines.every((l) => l.action === "accept")).toBe(true);
    expect(row.g703!.approved!.completedAndStoredCents).toBe(4_340_010);

    const { payAppId: app2 } = await s.f.sub.admin.as.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    const next = await s.f.sub.admin.as.query(api.payApps.g703.getPayApp, { payAppId: app2 });
    expect(next.applicationNo).toBe(2);
    expect(next.lines.map((l) => l.previousWorkCents)).toEqual([800_000, 480_010, 1_260_000, 0, 0, 0, 0, 0]);
    expect(next.lines[4]).toMatchObject({ previousStoredCents: 1_800_000 });
  });

  test("a revision request sends lines back; the sub revises and resubmits; both versions stay readable", async () => {
    const s = await setup();
    const kim = s.f.sub.admin.as;
    const dana = s.f.gcA.admin.as;
    const payAppId = await submit(s, [...v1Entries(s.sov), entry(s.sov[5], 950_000)]);
    await storeReview(s, payAppId);
    const fixtures = "Fixtures delivered, not installed – bill as stored materials";

    await expect(
      dana.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "request_revision", lines: [{ sovLineId: s.sov[5], action: "revise" }] }),
    ).rejects.toThrow(/A reason is required for each line/);
    await expect(dana.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "request_revision" })).rejects.toThrow(/Choose at least one line/);
    await dana.mutation(api.payApps.decisions.decidePayApp, {
      payAppId,
      decision: "request_revision",
      lines: [{ sovLineId: s.sov[5], action: "revise", reason: fixtures }],
    });
    const v1Row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(v1Row.status).toBe("revision_requested");
    expect(v1Row.g703!.approved!.completedAndStoredCents).toBe(0);
    expect((await s.t.run(async (ctx) => ctx.db.query("agentProposals").collect())).every((p) => p.status === "rejected")).toBe(true);

    const sent = await kim.query(api.payApps.g703.getPayApp, { payAppId });
    expect(sent).toMatchObject({ status: "revision_requested", canRevise: true, editable: false });
    expect(sent.revisionRequest!.lines.find((l) => l.lineNo === 6)).toMatchObject({ action: "revise", reason: fixtures });
    const subNote = (await s.t.run(async (ctx) => ctx.db.query("notifications").collect())).find((n) => n.companyId === s.f.sub.companyId);
    expect(subNote).toMatchObject({ kind: "pay_app_revision_requested", title: "Revision requested on Pay app #1" });
    // Nobody else can start another application while this one is open.
    expect((await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId })).payAppId).toBe(payAppId);
    await expect(dana.mutation(api.payApps.decisions.revisePayApp, { payAppId })).rejects.toThrow(/Not found/);

    expect(await kim.mutation(api.payApps.decisions.revisePayApp, { payAppId })).toEqual({ payAppId, version: 2 });
    await expect(kim.mutation(api.payApps.decisions.revisePayApp, { payAppId })).rejects.toThrow(/Only a pay app the GC sent back/);
    const draft = await kim.query(api.payApps.g703.getPayApp, { payAppId });
    expect(draft).toMatchObject({ status: "draft", editable: true, version: 2 });
    expect(draft.revisionRequest!.lines.find((l) => l.lineNo === 6)!.reason).toBe(fixtures);
    await kim.mutation(api.payApps.g703.submitPayApp, { payAppId, lines: [entry(s.sov[5], 0, 950_000, "Fixtures stored in the tenant space")] });

    const row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(row).toMatchObject({ status: "submitted", version: 2, applicationNo: 1 });
    expect(row.versions).toHaveLength(1);
    expect(row.versions![0]).toMatchObject({ version: 1, submittedAt: v1Row.submittedAt, requestedTotalCents: v1Row.requestedTotalCents });
    expect(row.versions![0].lines).toEqual(v1Row.g703!.lines);
    expect(row.versions![0].decision!.outcome).toBe("revision_requested");

    await storeReview(s, payAppId);
    const gcView = await dana.query(api.payApps.g703.getPayApp, { payAppId });
    expect(gcView.version).toBe(2);
    expect(gcView.versions.map((v) => [v.version, v.current, v.outcome])).toEqual([
      [1, false, "revision_requested"],
      [2, true, null],
    ]);
    expect(gcView.versions[1].changes).toEqual([
      { sovLineId: s.sov[5], lineNo: 6, field: "E", from: 950_000, to: 0 },
      { sovLineId: s.sov[5], lineNo: 6, field: "F", from: 0, to: 950_000 },
      { sovLineId: s.sov[5], lineNo: 6, field: "note", from: "", to: "Fixtures stored in the tenant space" },
    ]);
    expect(gcView.versions[0].lines.find((l) => l.lineNo === 6)).toMatchObject({ workThisPeriodCents: 950_000, storedCents: 0 });

    expect(await dana.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve" })).toMatchObject({ status: "approved" });
    // Only the one pay app counts toward D: the next application starts from version 2's approved amounts.
    const { payAppId: app2 } = await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    const next = await kim.query(api.payApps.g703.getPayApp, { payAppId: app2 });
    expect(next.applicationNo).toBe(2);
    expect(next.lines[5]).toMatchObject({ previousWorkCents: 0, previousStoredCents: 950_000 });
  });

  test("rejection needs a reason, ends the pay app and counts nothing toward D", async () => {
    const s = await setup();
    const payAppId = await submit(s);
    const dana = s.f.gcA.admin.as;
    await expect(dana.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "reject", reason: " " })).rejects.toThrow(
      /A reason is required to reject a pay app/,
    );
    await dana.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "reject", reason: "Billing period already covered by app #1" });
    const row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(row).toMatchObject({ status: "rejected", rejectionReason: "Billing period already covered by app #1" });
    expect(row.g703!.approved!.currentPaymentDueCents).toBe(0);
    const subView = await s.f.sub.admin.as.query(api.payApps.g703.getPayApp, { payAppId });
    expect(subView).toMatchObject({ status: "rejected", rejectionReason: "Billing period already covered by app #1", canRevise: false });
    await expect(dana.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve" })).rejects.toThrow(/only reviewed/);

    const { payAppId: again } = await s.f.sub.admin.as.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    const next = await s.f.sub.admin.as.query(api.payApps.g703.getPayApp, { payAppId: again });
    expect(next.applicationNo).toBe(1);
    expect(next.lines.every((l) => l.previousWorkCents === 0 && l.previousStoredCents === 0)).toBe(true);
    const note = (await s.t.run(async (ctx) => ctx.db.query("notifications").collect())).find((n) => n.companyId === s.f.sub.companyId);
    expect(note).toMatchObject({ kind: "pay_app_rejected", title: "Pay app #1 rejected" });
  });

  test("only the project's GC decides; the sub, another sub, another GC company, the owner and Demo get Not found", async () => {
    const s = await setup();
    const payAppId = await submit(s);
    await storeReview(s, payAppId);
    const outsiders: FixtureUser["as"][] = [s.f.sub.admin.as, s.lakeshore, s.f.gcB.admin.as, s.f.owner.admin.as, s.f.demo.gc.as, s.f.noCompany.as];
    for (const who of outsiders) {
      for (const decision of ["approve", "request_revision", "reject"] as const) {
        await expect(who.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision, reason: "x" })).rejects.toThrow(/Not found/);
      }
    }
    for (const who of [s.lakeshore, s.f.gcB.admin.as, s.f.owner.admin.as, s.f.demo.gc.as, s.f.gcA.admin.as]) {
      await expect(who.mutation(api.payApps.decisions.revisePayApp, { payAppId })).rejects.toThrow(/Not found/);
    }
    await expect(s.t.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve" })).rejects.toThrow();
    // The GC member (not only the admin) may decide.
    expect(await s.f.gcA.member.as.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve" })).toMatchObject({ status: "approved" });
    expect((await s.t.run(async (ctx) => ctx.db.get(payAppId)))!.status).toBe("approved");
  });

  test("a GC cannot decide a sub's unsubmitted draft", async () => {
    const s = await setup();
    const { payAppId } = await s.f.sub.admin.as.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    await expect(s.f.gcA.admin.as.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "reject", reason: "x" })).rejects.toThrow(/Not found/);
  });
});

describe("review runs are bound to the submitted version", () => {
  const TRACE = {
    runId: "late-run",
    csiDivision: "26",
    contractorName: "Eastbay Electric",
    provider: "Offline rules engine",
    model: "none",
    rawPrompt: "",
    systemPrompt: "",
    rawResponse: "",
    parsedOutput: null,
    metrics: null,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const reviewWithTotal = (approvedTotalCents: number) => ({
    engine: "Offline rules engine",
    provider: "Offline rules engine",
    model: "none",
    lines: [],
    flags: { lienWaiverMissing: false, licenseIssue: false, notes: `total ${approvedTotalCents}` },
    approvedTotalCents,
    reviewedAt: Date.now(),
  });

  test("a v1 review that finishes after the GC sent v1 back and the sub resubmitted v2 never overwrites v2's review", async () => {
    const s = await setup();
    const kim = s.f.sub.admin.as;
    const dana = s.f.gcA.admin.as;
    const payAppId = await submit(s);
    const runV1 = await s.t.mutation(internal.payApps.review.beginReview, { payAppId, rerun: false });
    expect(runV1).toMatch(/^v1:/);

    // While v1's model call is still running, the GC sends it back and the sub revises and resubmits.
    await dana.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "request_revision", reason: "Bill line 5 as installed work" });
    await kim.mutation(api.payApps.decisions.revisePayApp, { payAppId });
    await kim.mutation(api.payApps.g703.submitPayApp, { payAppId, lines: [entry(s.sov[4], 1_800_000, 0, "Switchboard set and energized")] });

    // v1's late result arrives before v2's review starts: refused, v2 stays submitted.
    expect(await s.t.mutation(internal.payApps.review.storeReview, { payAppId, reviewRunId: runV1!, review: reviewWithTotal(111), trace: TRACE })).toEqual({
      stored: false,
    });
    expect((await s.t.run(async (ctx) => ctx.db.get(payAppId)))!).toMatchObject({ status: "submitted", version: 2 });

    const runV2 = await s.t.mutation(internal.payApps.review.beginReview, { payAppId, rerun: false });
    expect(runV2).toMatch(/^v2:/);
    expect(await s.t.query(internal.payApps.review.loadReviewInputs, { payAppId, reviewRunId: runV1! })).toBeNull();

    // v1's late result arrives while v2 is under review: refused, and its abandon does not reset v2.
    expect(await s.t.mutation(internal.payApps.review.storeReview, { payAppId, reviewRunId: runV1!, review: reviewWithTotal(111), trace: TRACE })).toEqual({
      stored: false,
    });
    await s.t.mutation(internal.payApps.review.abandonReview, { payAppId, reviewRunId: runV1! });
    let row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(row.status).toBe("under_review");
    expect(row.review).toBeUndefined();

    expect(await s.t.mutation(internal.payApps.review.storeReview, { payAppId, reviewRunId: runV2!, review: reviewWithTotal(222), trace: TRACE })).toEqual({
      stored: true,
    });
    // A v1 result arriving after v2 was reviewed is refused as well.
    expect(await s.t.mutation(internal.payApps.review.storeReview, { payAppId, reviewRunId: runV1!, review: reviewWithTotal(111), trace: TRACE })).toEqual({
      stored: false,
    });
    row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(row).toMatchObject({ status: "reviewed", version: 2 });
    expect(row.review!.approvedTotalCents).toBe(222);
    expect(row.reviewRunId).toBeUndefined();
  });

  test("the scheduled v2 review stores v2's lines although the v1 run never finished", async () => {
    const s = await setup();
    const kim = s.f.sub.admin.as;
    const payAppId = await submit(s);
    const runV1 = await s.t.mutation(internal.payApps.review.beginReview, { payAppId, rerun: false });
    await s.f.gcA.admin.as.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "request_revision", reason: "Bill line 5 only" });
    await kim.mutation(api.payApps.decisions.revisePayApp, { payAppId });
    await kim.mutation(api.payApps.g703.submitPayApp, {
      payAppId,
      lines: v1Entries(s.sov).map((e) => (e.sovLineId === s.sov[4] ? e : { ...e, workThisPeriodCents: 0 })),
    });
    const res = await s.t.action(internal.payApps.review.reviewPayApp, { payAppId });
    expect(res).toMatchObject({ reviewed: true });
    await s.t.mutation(internal.payApps.review.abandonReview, { payAppId, reviewRunId: runV1! });
    const row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(row.status).toBe("reviewed");
    const billed = row.review!.lines.filter((l) => l.approvedCents > 0).map((l) => l.sovLineId);
    expect(billed).toEqual([s.sov[4]]);
  });
});

describe("AI review of a G703 pay app", () => {
  test("worked example: the rules review keeps lines 1, 2 and 4-8 as requested; the line 3 override reaches the exact figures; app 2 is plain Approved", async () => {
    const s = await setup();
    const dana = s.f.gcA.admin.as;
    const kim = s.f.sub.admin.as;
    const payAppId = await submit(s);
    await s.t.action(internal.payApps.review.reviewPayApp, { payAppId });
    const row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    const requested = new Map(row.lines.map((l) => [l.sovLineId as string, l.requestedCents]));
    const byLine = new Map(row.review!.lines.map((l) => [l.sovLineId as string, l]));
    for (const i of [0, 1, 3, 4, 5, 6, 7]) {
      expect(byLine.get(s.sov[i])!.verdict, `line ${i + 1}`).toBe("ok");
      expect(byLine.get(s.sov[i])!.approvedCents, `line ${i + 1}`).toBe(requested.get(s.sov[i]) ?? 0);
    }
    const line3 = byLine.get(s.sov[2])!;
    expect(line3.verdict).not.toBe("ok");
    expect(line3.approvedCents).toBeLessThan(1_400_000);

    const res = await dana.mutation(api.payApps.decisions.decidePayApp, { payAppId, decision: "approve", lines: overrideLine3(s, OVERRIDE_REASON) });
    expect(res).toMatchObject({ status: "approved_as_noted", approvedTotalCents: 4_341_260, currentPaymentDueCents: 4_124_196 });
    const approved = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(approved.g703!.approved).toMatchObject({ completedAndStoredCents: 4_341_260, retainageCents: 217_064, currentPaymentDueCents: 4_124_196 });

    const line9 = await s.t.run(async (ctx) =>
      ctx.db.insert("scheduleOfValues", {
        agreementId: s.agreementId,
        lineNo: 9,
        description: "CO #1 – Add 6 dedicated 20A circuits for dental chairs",
        scheduledValueCents: 875_000,
        excludedScope: false,
      }),
    );
    const { payAppId: app2 } = await kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    await kim.mutation(api.payApps.g703.submitPayApp, {
      payAppId: app2,
      lines: [
        entry(s.sov[1], 159_990),
        entry(s.sov[2], 945_000),
        entry(s.sov[3], 1_910_000),
        entry(s.sov[4], 1_500_000, 600_000),
        entry(s.sov[5], 0, 950_000, "Fixtures stored in the tenant space"),
        entry(line9, 437_500),
      ],
    });
    await s.t.action(internal.payApps.review.reviewPayApp, { payAppId: app2 });
    const row2 = (await s.t.run(async (ctx) => ctx.db.get(app2)))!;
    const requested2 = new Map(row2.lines.map((l) => [l.sovLineId as string, l.requestedCents]));
    for (const l of row2.review!.lines) {
      expect(l.verdict, l.sovLineId).toBe("ok");
      expect(l.approvedCents, l.sovLineId).toBe(requested2.get(l.sovLineId) ?? 0);
    }
    expect(row2.review!.approvedTotalCents).toBe(4_702_490);
    expect(await dana.mutation(api.payApps.decisions.decidePayApp, { payAppId: app2, decision: "approve" })).toMatchObject({
      status: "approved",
      currentPaymentDueCents: 4_467_366,
    });
  });

  test("offline review gives every line a verdict, computes dollars from the percent, and sees excluded-scope notes", async () => {
    const s = await setup();
    const payAppId = await submit(s, [
      ...v1Entries(s.sov),
      entry(s.sov[3], 100_000, 0, "Seismic bracing hung on branch conduit at level 1"),
    ]);
    await s.t.action(internal.payApps.review.reviewPayApp, { payAppId });
    const row = (await s.t.run(async (ctx) => ctx.db.get(payAppId)))!;
    expect(row.status).toBe("reviewed");
    expect(row.review!.provider).toBe("Offline rules engine");
    expect(row.review!.lines).toHaveLength(8);
    const sov = await s.t.run(async (ctx) => Promise.all(s.sov.map((id) => ctx.db.get(id))));
    for (const l of row.review!.lines) {
      expect(Object.keys(l).sort()).toEqual(["approvedCents", "reason", "recommendedPctToDate", "sovLineId", "verdict"]);
      const s0 = sov.find((x) => x!._id === l.sovLineId)!;
      const requested = row.lines.find((x) => x.sovLineId === l.sovLineId)?.requestedCents ?? 0;
      const expected =
        l.verdict === "excluded_scope"
          ? 0
          : l.verdict === "ok"
            ? requested
            : approvedCentsFor({
              scheduledValueCents: s0.scheduledValueCents,
              recommendedPctToDate: l.recommendedPctToDate,
              previouslyBilledCents: 0,
              pendingRequestedCents: 0,
              requestedCents: requested,
            });
      expect(l.approvedCents).toBe(expected);
    }
    const line4 = row.review!.lines.find((l) => l.sovLineId === s.sov[3])!;
    expect(line4).toMatchObject({ verdict: "excluded_scope", approvedCents: 0 });
    expect(line4.reason).toContain("Seismic bracing of conduit and equipment");
    const trace = await s.t.run(async (ctx) =>
      ctx.db
        .query("agentTraces")
        .withIndex("by_caseId", (q) => q.eq("caseId", payAppId))
        .first(),
    );
    expect(trace!.rawPrompt).toContain("Seismic bracing of conduit and equipment");
    expect(trace!.rawPrompt).not.toContain("gpt-4o");
  });
});
