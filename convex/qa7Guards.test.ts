/// <reference types="vite/client" />
/**
 * QA7 independent verification harness (deterministic, no network).
 * Covers the guard fixes deployed to brainy-skunk-440; live HTTP runs are
 * executed separately by the portable QA harness (scripts/qa/) as well as the local raw harness.
 */
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { asGc, type GcTest } from "./lib/testIdentity";
import {
  sanitizeBidLevelingOutput,
  applyExplicitExclusionAmounts,
  applyUnpricedExclusionBenchmarks,
  augmentExclusionsWithDeterministicGaps,
  benchmarkExclusionAmount,
  normalizeExclusionSeverity,
  normalizeLeadWeeksFromText,
  detectCoiDeficiency,
  detectCoiAffirmativeCompliance,
} from "./llmRouter";

const modules = import.meta.glob("./**/*.ts");
type T = GcTest;

async function makeProject(t: T, title: string) {
  return await t.mutation(api.projects.createProject, {
    title,
    location: "Austin, TX",
    projectType: "Class-A Commercial Mixed-Use",
    estBudget: 2_500_000,
    targetCompletionWeeks: 52,
    specDocumentText: "QA7 verification specification text.",
    isDemoProject: false,
  });
}

async function makePackage(t: T, projectId: any, csi = "26 00 00", budget = 1_250_000) {
  return await t.mutation(api.tradePackages.createTradePackage, {
    projectId,
    csiDivision: csi,
    tradeName: `QA7 Division ${csi}`,
    budgetEstimate: budget,
    scopeSummary: "QA7 verification scope.",
    mandatoryInclusions: ["Code compliance"],
    bidDeadline: "2026-10-31",
  });
}

async function makeContractor(t: T, tradePackageId: any, name: string) {
  return await t.mutation(api.contractors.createContractor, {
    tradePackageId,
    companyName: name,
    contactEmail: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@qa7.test`,
    phone: "+1 (512) 555-0100",
    licenseNumber: `TX-QA7-${name.length}`,
    licenseStatus: "Active / Verified",
    sourceUrl: `https://qa7.test/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    rfqStatus: "invited",
  });
}

async function makeBid(t: T, packageId: any, contractorId: any, name: string, base = 1_100_000) {
  const res: any = await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: name,
    baseBidAmount: base,
  });
  return res.bidId;
}

async function insertConversation(t: T, packageId: any, contractorId: any, subject = "QA7 subject") {
  return await t.run(async (ctx) =>
    await ctx.db.insert("conversations", {
      tradePackageId: packageId,
      contractorId,
      threadId: `qa7-th-${Date.now()}-${Math.random()}`,
      inboundSubject: subject,
      inboundQuestion: "QA7 verification question?",
      autonomousReply: "QA7 verification reply.",
      confidenceScore: 0.9,
      status: "clarified",
      timestamp: Date.now(),
    })
  );
}

async function rawByPackage(t: T, table: any, packageId: any) {
  return await t.run(async (ctx) =>
    await ctx.db
      .query(table)
      .withIndex("by_package" as any, (q: any) => q.eq("tradePackageId", packageId))
      .collect()
  );
}

// ---------------------------------------------------------------- Item 1
test("QA7-1: createTradePackage rejects a nonexistent projectId and inserts nothing", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "QA7 Item1 Project");
  await t.run(async (ctx) => await ctx.db.delete(projectId));
  await expect(
    t.mutation(api.tradePackages.createTradePackage, {
      projectId,
      csiDivision: "28 00 00",
      tradeName: "QA7 Orphan Attempt",
      budgetEstimate: 100_000,
      scopeSummary: "Must be rejected.",
      mandatoryInclusions: ["None"],
      bidDeadline: "2026-10-31",
    })
  ).rejects.toThrow(/project not found/i);
  const all = await t.run(async (ctx) => await ctx.db.query("tradePackages").collect());
  expect(all.length).toBe(0);
});

// ---------------------------------------------------------------- Item 2
test("QA7-2a: deleteContractor refuses a contractor with a proposal and preserves bid + conversation", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "QA7 Item2a Project");
  const packageId = await makePackage(t, projectId);
  const contractorId = await makeContractor(t, packageId, "QA7 Bidder");
  const bidId = await makeBid(t, packageId, contractorId, "QA7 Bidder");
  const conversationId = await insertConversation(t, packageId, contractorId);

  await expect(t.mutation(api.contractors.deleteContractor, { contractorId })).rejects.toThrow(
    /proposal\(s\) on file/i
  );

  expect(await t.run(async (ctx) => await ctx.db.get(contractorId))).not.toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(bidId))).not.toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(conversationId))).not.toBeNull();
});

test("QA7-2b: deleteContractor refuses an executed subcontract and preserves bid + agreement + conversation", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "QA7 Item2b Project");
  const packageId = await makePackage(t, projectId);
  const contractorId = await makeContractor(t, packageId, "QA7 Executed");
  const bidId = await makeBid(t, packageId, contractorId, "QA7 Executed");
  const agreement: any = await t.mutation(api.agreements.generateAgreement, { bidId, tradePackageId: packageId });
  await t.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  const conversationId = await insertConversation(t, packageId, contractorId, "QA7 executed thread");

  await expect(t.mutation(api.contractors.deleteContractor, { contractorId })).rejects.toThrow(
    /executed subcontract/i
  );

  const stored: any = await t.run(async (ctx) => await ctx.db.get(agreement._id));
  expect(stored?.status).toBe("executed");
  expect(await t.run(async (ctx) => await ctx.db.get(bidId))).not.toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(conversationId))).not.toBeNull();
});

test("QA7-2c: deleteContractor succeeds when no bids exist and cascades its conversations only", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "QA7 Item2c Project");
  const packageId = await makePackage(t, projectId);
  const cleanId = await makeContractor(t, packageId, "QA7 Clean");
  const bidderId = await makeContractor(t, packageId, "QA7 Keep");
  const bidId = await makeBid(t, packageId, bidderId, "QA7 Keep");
  const cleanConvo = await insertConversation(t, packageId, cleanId, "QA7 clean thread");
  const keepConvo = await insertConversation(t, packageId, bidderId, "QA7 keep thread");

  const result: any = await t.mutation(api.contractors.deleteContractor, { contractorId: cleanId });
  expect(result.success).toBe(true);

  expect(await t.run(async (ctx) => await ctx.db.get(cleanId))).toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(cleanConvo))).toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(bidderId))).not.toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(bidId))).not.toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(keepConvo))).not.toBeNull();
});

// ---------------------------------------------------------------- Item 3
test("QA7-3a: deleteTradePackage refuses an executed subcontract and preserves children", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "QA7 Item3a Project");
  const packageId = await makePackage(t, projectId);
  const contractorId = await makeContractor(t, packageId, "QA7 Package Guard");
  const bidId = await makeBid(t, packageId, contractorId, "QA7 Package Guard");
  const agreement: any = await t.mutation(api.agreements.generateAgreement, { bidId, tradePackageId: packageId });
  await t.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });

  await expect(t.mutation(api.tradePackages.deleteTradePackage, { tradePackageId: packageId })).rejects.toThrow(
    /executed subcontract/i
  );

  expect(await t.run(async (ctx) => await ctx.db.get(packageId))).not.toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(bidId))).not.toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(agreement._id))).not.toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(contractorId))).not.toBeNull();
});

test("QA7-3b: deleteTradePackage cascades bids/agreements/contractors/conversations when no executed contract", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "QA7 Item3b Project");
  const packageId = await makePackage(t, projectId);
  const contractorId = await makeContractor(t, packageId, "QA7 Cascade");
  const bidId = await makeBid(t, packageId, contractorId, "QA7 Cascade");
  const agreement: any = await t.mutation(api.agreements.generateAgreement, { bidId, tradePackageId: packageId });
  const conversationId = await insertConversation(t, packageId, contractorId);

  const result: any = await t.mutation(api.tradePackages.deleteTradePackage, { tradePackageId: packageId });
  expect(result.success).toBe(true);

  expect(await t.run(async (ctx) => await ctx.db.get(packageId))).toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(bidId))).toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(agreement._id))).toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(contractorId))).toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(conversationId))).toBeNull();
});

// ---------------------------------------------------------------- Item 4
test("QA7-4: executed agreement cannot be superseded; same-bid regeneration rejects with immutability", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "QA7 Item4 Project");
  const packageId = await makePackage(t, projectId);
  const firstContractor = await makeContractor(t, packageId, "QA7 Winner");
  const secondContractor = await makeContractor(t, packageId, "QA7 Challenger");
  const firstBid = await makeBid(t, packageId, firstContractor, "QA7 Winner");
  const secondBid = await makeBid(t, packageId, secondContractor, "QA7 Challenger", 950_000);
  // Award the challenger, then re-award the winner and execute: the challenger
  // keeps a superseded agreement, which is the only publicly reachable state
  // that lets awardContract reach its executed-agreement guard.
  const secondAgreement: any = await t.mutation(api.agreements.generateAgreement, {
    bidId: secondBid,
    tradePackageId: packageId,
  });
  const firstAgreement: any = await t.mutation(api.agreements.generateAgreement, {
    bidId: firstBid,
    tradePackageId: packageId,
  });
  await t.mutation(api.agreements.executeAgreement, { agreementId: firstAgreement._id });

  await expect(
    t.mutation(api.agreements.generateAgreement, { bidId: secondBid, tradePackageId: packageId })
  ).rejects.toThrow(/executed subcontract/i);
  await expect(
    t.mutation(api.bids.awardContract, { bidId: secondBid, tradePackageId: packageId })
  ).rejects.toThrow(/executed subcontract/i);
  await expect(
    t.mutation(api.agreements.generateAgreement, { bidId: firstBid, tradePackageId: packageId })
  ).rejects.toThrow(/immutable/i);

  const agreements: any[] = await rawByPackage(t, "agreements", packageId);
  expect(agreements.filter((a: any) => a.status === "executed").length).toBe(1);
  expect(agreements.find((a: any) => a._id === secondAgreement._id)?.status).toBe("superseded");
  expect(await t.run(async (ctx) => ((await ctx.db.get(firstBid)) as any)?.isAwarded)).toBe(true);
  expect(await t.run(async (ctx) => ((await ctx.db.get(secondBid)) as any)?.isAwarded)).toBe(false);
});

// ---------------------------------------------------------------- Item 6
test("QA7-6: deadline monitor leaves zero-bid packages open, advances bid packages, and flags once", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "QA7 Item6 Project");
  const emptyPackage = await makePackage(t, projectId, "26 00 00");
  const bidPackage = await makePackage(t, projectId, "23 00 00");
  const contractorId = await makeContractor(t, bidPackage, "QA7 Cron Bidder");
  await makeBid(t, bidPackage, contractorId, "QA7 Cron Bidder");

  await t.run(async (ctx) => {
    await ctx.db.patch(emptyPackage, { bidDeadline: "2020-01-01", status: "rfqs_dispatched" });
    await ctx.db.patch(bidPackage, { bidDeadline: "2020-01-01", status: "rfqs_dispatched" });
  });

  // Internal scheduled cron: idempotent no-bids flag
  await t.mutation(internal.crons.monitorBidDeadlines, {});
  await t.mutation(internal.crons.monitorBidDeadlines, {});

  const emptyAfter = await t.run(async (ctx) => await ctx.db.get(emptyPackage));
  expect(emptyAfter?.status).toBe("rfqs_dispatched");
  const emptyLogs = await rawByPackage(t, "auditLogs", emptyPackage);
  expect(emptyLogs.filter((l: any) => l.title.startsWith("Deadline passed with no bids")).length).toBe(1);
  const bidAfter = await t.run(async (ctx) => await ctx.db.get(bidPackage));
  expect(bidAfter?.status).toBe("leveling");

  // Public manual trigger: same safety, no duplicate no-bids rows
  await t.run(async (ctx) => {
    await ctx.db.patch(emptyPackage, { bidDeadline: "2020-01-01", status: "rfqs_dispatched" });
    await ctx.db.patch(bidPackage, { bidDeadline: "2020-01-01", status: "rfqs_dispatched" });
  });
  const first: any = await t.mutation(api.crons.runDeadlineMonitorNow, { projectId });
  const second: any = await t.mutation(api.crons.runDeadlineMonitorNow, { projectId });
  expect(first.monitoredCount).toBe(2);
  expect(first.transitionedCount).toBe(1);
  // Second run: the bid package is already leveling, so nothing re-transitions.
  expect(second.transitionedCount).toBe(0);
  expect((await t.run(async (ctx) => await ctx.db.get(emptyPackage)))?.status).toBe("rfqs_dispatched");
  expect((await t.run(async (ctx) => await ctx.db.get(bidPackage)))?.status).toBe("leveling");
  const emptyLogs2 = await rawByPackage(t, "auditLogs", emptyPackage);
  expect(emptyLogs2.filter((l: any) => l.title.startsWith("Deadline passed with no bids")).length).toBe(1);
});

// ---------------------------------------------------------------- Item 7
test("QA7-7: deleteProject removes clashResolutions and every project child", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "QA7 Item7 Project");
  const packageId = await makePackage(t, projectId);
  const contractorId = await makeContractor(t, packageId, "QA7 Clash");
  const bidId = await makeBid(t, packageId, contractorId, "QA7 Clash");
  await t.mutation(api.agreements.generateAgreement, { bidId, tradePackageId: packageId });
  await insertConversation(t, packageId, contractorId, "QA7 clash thread");
  // A21-01: cross-trade credits require priced proposals on both sides.
  const hvacPackageId = await makePackage(t, projectId, "23 00 00", 1_200_000);
  const hvacContractorId = await makeContractor(t, hvacPackageId, "QA7 Clash HVAC");
  await makeBid(t, hvacPackageId, hvacContractorId, "QA7 Clash HVAC", 1_150_000);
  await t.mutation(api.coordination.deductDoubleBuyCredit, {
    projectId,
    clashId: "clash-vfd-01",
    tradePackageId: packageId,
    deductAmount: 1_500,
    description: "QA7 orphan probe",
  });
  expect(
    await t.run(async (ctx) =>
      await ctx.db.query("clashResolutions").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()
    )
  ).toHaveLength(1);

  const result: any = await t.mutation(api.projects.deleteProject, { projectId });
  expect(result.success).toBe(true);

  const remaining = await t.run(async (ctx) => ({
    clash: await ctx.db.query("clashResolutions").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect(),
    projects: await ctx.db.query("projects").withIndex("by_demo", (q) => q.eq("isDemoProject", false)).collect(),
    packages: await ctx.db.query("tradePackages").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect(),
    contractors: await ctx.db.query("contractors").collect(),
    bids: await ctx.db.query("bids").collect(),
    agreements: await ctx.db.query("agreements").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect(),
    conversations: await ctx.db.query("conversations").collect(),
    logs: await ctx.db.query("auditLogs").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect(),
  }));
  expect(remaining.clash).toHaveLength(0);
  expect(remaining.projects.some((p: any) => p._id === projectId)).toBe(false);
  expect(remaining.packages).toHaveLength(0);
  expect(remaining.contractors).toHaveLength(0);
  expect(remaining.bids).toHaveLength(0);
  expect(remaining.agreements).toHaveLength(0);
  expect(remaining.conversations).toHaveLength(0);
  expect(remaining.logs).toHaveLength(0);
});

// ---------------------------------------------------------------- Item 8
test("QA7-8: updateBidAdjustments validates inputs, rejects negatives, and recomputes exactly", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "QA7 Item8 Project");
  const packageId = await makePackage(t, projectId);
  const contractorId = await makeContractor(t, packageId, "QA7 Adjust");
  const bidId = await makeBid(t, packageId, contractorId, "QA7 Adjust", 1_000_000);

  await expect(
    t.mutation(api.bids.updateBidAdjustments, {
      bidId,
      identifiedExclusions: [],
      coiComplianceStatus: "totally-fine",
    })
  ).rejects.toThrow(/COI status/i);
  await expect(
    t.mutation(api.bids.updateBidAdjustments, {
      bidId,
      identifiedExclusions: [{ description: "Negative credit", costImpact: -50_000, severity: "critical" }],
    })
  ).rejects.toThrow(/zero or positive/i);
  await expect(
    t.mutation(api.bids.updateBidAdjustments, {
      bidId,
      identifiedExclusions: [],
      valueEngineeringAlternates: [{ description: "Negative deduct", costDeduct: -1, isAccepted: true }],
    })
  ).rejects.toThrow(/zero or positive/i);

  const result: any = await t.mutation(api.bids.updateBidAdjustments, {
    bidId,
    identifiedExclusions: [
      { description: "Crane hoisting", costImpact: 12_000, severity: "moderate" },
      { description: "Waived cleanup", costImpact: 5_000, severity: "minor", isWaived: true },
    ],
    valueEngineeringAlternates: [
      { description: "LED alternate", costDeduct: 3_000, isAccepted: true },
      { description: "Not taken", costDeduct: 1_000, isAccepted: false },
    ],
    leadTimePenalty: 2_500,
    coiPenalty: 1_500,
    coiComplianceStatus: "deficiency_detected",
    longLeadEquipmentWeeks: 14,
  });
  const expected = 1_000_000 + 12_000 + 2_500 + 1_500 - 3_000;
  expect(result.leveledTotalCost).toBe(expected);
  const stored: any = await t.run(async (ctx) => await ctx.db.get(bidId));
  expect(stored.leveledTotalCost).toBe(expected);
  expect(stored.coiComplianceStatus).toBe("deficiency_detected");
  expect(stored.baseBidAmount).toBe(1_000_000);
  expect(stored.revisionNumber).toBe(1);
});

// ------------------------------------------------- A6-05r / A6-54 (critical)
test("A6-05r: insertParsedBid derives the schedule penalty from weeks + division baseline and ignores any supplied dollar amount", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "A6 LeadTime Project");
  const packageId = await makePackage(t, projectId, "22 00 00", 3_000_000);
  const contractorId = await makeContractor(t, packageId, "A6 Plumbing Bidder");

  // The producer tries to understate the penalty as $0; the engine must recompute.
  await t.mutation(internal.bids.insertParsedBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "A6 Plumbing Bidder",
    baseBidAmount: 837_450,
    lineItems: [],
    identifiedExclusions: [],
    valueEngineeringAlternates: [],
    longLeadEquipmentWeeks: 17,
    leadTimePenalty: 0,
    coiComplianceStatus: "compliant",
    coiPenalty: 0,
    leveledTotalCost: 0,
  });
  const bids: any = await rawByPackage(t, "bids", packageId);
  expect(bids.length).toBe(1);
  expect(bids[0].leadTimeTargetWeeks).toBe(16);
  expect(bids[0].leadTimePenalty).toBe(6_000);
  expect(bids[0].leveledTotalCost).toBe(837_450 + 6_000);

  // An explicit GC target wins (17 wks vs a 12-wk target is 5 × $6,000).
  await t.mutation(internal.bids.insertParsedBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "A6 Plumbing Bidder",
    baseBidAmount: 837_450,
    lineItems: [],
    identifiedExclusions: [],
    valueEngineeringAlternates: [],
    longLeadEquipmentWeeks: 17,
    leadTimePenalty: 123,
    leadTimeTargetWeeks: 12,
    coiComplianceStatus: "compliant",
    coiPenalty: 0,
    leveledTotalCost: 0,
  });
  const bids2: any = await rawByPackage(t, "bids", packageId);
  expect(bids2[0].leadTimeTargetWeeks).toBe(12);
  expect(bids2[0].leadTimePenalty).toBe(30_000);
  expect(bids2[0].leveledTotalCost).toBe(837_450 + 30_000);
});

test("A6-05r: the extraction sanitizer recomputes penalties deterministically per division and drops model arithmetic", async () => {
  const input = {
    baseBidAmount: 500_000,
    longLeadEquipmentWeeks: 16,
    leadTimePenalty: 999_999, // adversarial model value must be ignored
    coiComplianceStatus: "compliant",
    coiPenalty: 0,
    identifiedExclusions: [],
  };
  const div26 = sanitizeBidLevelingOutput({ ...input }, { division: "26 00 00" });
  expect(div26.leadTimeTargetWeeks).toBe(12);
  expect(div26.leadTimePenalty).toBe(24_000);
  expect(div26.leveledTotalCost).toBe(524_000);

  const div26Again = sanitizeBidLevelingOutput({ ...input }, { division: "26 00 00" });
  expect(div26Again.leadTimePenalty).toBe(div26.leadTimePenalty);
  expect(div26Again.leveledTotalCost).toBe(div26.leveledTotalCost);

  const div22 = sanitizeBidLevelingOutput(
    { ...input, longLeadEquipmentWeeks: 17, leadTimePenalty: 0 },
    { division: "22 11 23" }
  );
  expect(div22.leadTimeTargetWeeks).toBe(16);
  expect(div22.leadTimePenalty).toBe(6_000);
  expect(div22.leveledTotalCost).toBe(506_000);
});

test("A6-54 class: stated exclusion amounts win over ASPE/RSMeans benchmarks", () => {
  const exclusions = [
    { description: "Rooftop crane pick and rigging to cooling tower deck excluded (GC crane required)", costImpact: 48_000 },
    { description: "UL 1479 floor and wall through-penetration rated firestopping excluded (by others)", costImpact: 22_000 },
    { description: "IBC Section 1613 engineered structural seismic bracing excluded (by others)", costImpact: 55_000 },
  ];
  const text =
    "Exclusions: crane rigging and hoisting excluded ($18,600); firestopping excluded ($9,950); seismic bracing excluded ($7,400).";
  const priced = applyExplicitExclusionAmounts(exclusions, text);
  expect(priced.map((e) => e.costImpact)).toEqual([18_600, 9_950, 7_400]);
  // Unpriced exclusions keep the benchmark values (and nothing is invented).
  const unpriced = applyExplicitExclusionAmounts(
    [{ description: "Crane rigging and hoisting excluded", costImpact: 48_000 }],
    "Crane rigging and hoisting excluded (by others)."
  );
  expect(unpriced[0].costImpact).toBe(48_000);
  expect(applyExplicitExclusionAmounts([], text)).toEqual([]);
});

test("A7CONV-A-01: an included booster pump is not priced as an exclusion just because 'excluded' appears elsewhere", async () => {
  const t = await asGc(convexTest(schema, modules));
  const res: any = await t.action(internal.llmRouter.executeReasoning, {
    taskType: "bid_leveling",
    division: "22 00 00",
    prompt: [
      "PROPOSAL",
      "Subcontractor: Cascade Mechanical Contractors LLC",
      "Base Bid Price: $613,777.13",
      "Scope: complete Division 22 plumbing scope including a triplex booster pump system with factory certified startup.",
      "Exclusions: crane rigging and hoisting excluded ($18,600); firestopping excluded ($9,950); seismic bracing excluded ($7,400).",
      "Lead time: 17 weeks.",
      "Insurance: umbrella liability endorsement excluded.",
    ].join("\n"),
  });
  const exclusions = res.parsedJson?.identifiedExclusions || [];
  const text = JSON.stringify(exclusions);
  // The included booster-pump scope must not be fabricated into an exclusion.
  expect(text).not.toMatch(/BOOSTER/i);
  // Stated amounts still win over benchmarks.
  const impacts = exclusions.map((e: any) => e.costImpact);
  expect(impacts).toEqual(expect.arrayContaining([18_600, 9_950, 7_400]));
});

test("A7CONV-R2A-N2: a compound INCLUDED/excluded sentence never prices the included scope", async () => {
  const t = await asGc(convexTest(schema, modules));
  const res: any = await t.action(internal.llmRouter.executeReasoning, {
    taskType: "bid_leveling",
    division: "22 00 00",
    prompt: [
      "PROPOSAL",
      "Subcontractor: Meridian Harbor Mechanical LLC",
      "Base Bid Price: $842,150.13",
      "Scope: complete Division 22 plumbing scope including a triplex booster pump system with factory certified startup INCLUDED, while crane rigging and hoisting is excluded (by others).",
      "Lead time: 17 weeks.",
    ].join("\n"),
  });
  const exclusions = res.parsedJson?.identifiedExclusions || [];
  expect(JSON.stringify(exclusions)).not.toMatch(/BOOSTER/i);
  expect(exclusions.map((e: any) => e.costImpact)).toContain(25_000);
});

test("A7CONV-R2C-F1: VE credit lines are alternates, not exclusions; inline exclusion lists keep every clause", async () => {
  const t = await asGc(convexTest(schema, modules));
  const res: any = await t.action(internal.llmRouter.executeReasoning, {
    taskType: "bid_leveling",
    division: "22 00 00",
    prompt: [
      "PROPOSAL",
      "Subcontractor: Rivergate Mechanical LLC",
      "Base Bid Price: $700,000.00",
      "Scope: Division 22 plumbing rough-in and fixtures.",
      "Exclusions: crane rigging and hoisting excluded ($18,600); dewatering and pumping excluded ($11,460); seismic bracing excluded ($7,400).",
      "Value Engineering: LED lighting alternate credit of $27,450 offered (GC to decide, not included in base price).",
      "Lead time: 17 weeks.",
    ].join("\n"),
  });
  const exclusions = res.parsedJson?.identifiedExclusions || [];
  const exclusionText = JSON.stringify(exclusions);
  expect(exclusionText).not.toMatch(/LED lighting|27,450/i);
  const impacts = exclusions.map((e: any) => e.costImpact);
  expect(impacts).toEqual(expect.arrayContaining([18_600, 11_460, 7_400]));
  const ve = res.parsedJson?.valueEngineeringAlternates || [];
  expect(ve.some((v: any) => v.costDeduct === 27_450)).toBe(true);
  expect(ve.every((v: any) => v.isAccepted === false)).toBe(true);
});

test("A7CONV-R2C-F2: a negative stated base bid is never sign-flipped into a positive amount", async () => {
  const t = await asGc(convexTest(schema, modules));
  const res: any = await t.action(internal.llmRouter.executeReasoning, {
    taskType: "bid_leveling",
    division: "22 00 00",
    prompt: [
      "PROPOSAL",
      "Subcontractor: PaceFlow Plumbing LLC",
      "Base Bid Price: -$50,000.00",
      "Scope: Division 22 plumbing rough-in.",
      "Lead time: 12 weeks.",
    ].join("\n"),
  });
  expect((res.parsedJson?.baseBidAmount ?? 0) <= 0).toBe(true);
});

test("A7CONV-R2C-F3: the addendum certification gate holds server-side with zero certified RFIs", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "A7 Addendum Gate Project");
  await expect(
    t.action(api.files.generatePreBidAddendum, { projectId })
  ).rejects.toThrow(/certify at least one RFI/i);
});

test("A7CONV-R3C-1: a currency-word base amount is used; an insurance limit never becomes the base bid", async () => {
  const t = await asGc(convexTest(schema, modules));
  const res: any = await t.action(internal.llmRouter.executeReasoning, {
    taskType: "bid_leveling",
    division: "26 00 00",
    prompt: [
      "PROPOSAL",
      "Subcontractor: Vertica Electric LLC",
      "Base proposal amount (US dollars): 699,410.55 USD",
      "Scope: Division 26 switchgear and distribution.",
      "Insurance: ACORD 25 attached; $5,000,000 commercial umbrella liability included.",
      "Lead time: 14 weeks.",
    ].join("\n"),
  });
  expect(res.parsedJson?.baseBidAmount).toBeCloseTo(699_410.55, 2);
  expect(res.parsedJson?.baseBidAmount).not.toBe(5_000_000);
});

test("A7CONV-R3C-2/3/4/5: inclusion-negatives are not exclusions; plugs are not double-charged; omitted/not-by-us clauses are kept", async () => {
  const t = await asGc(convexTest(schema, modules));
  const noExclusions: any = await t.action(internal.llmRouter.executeReasoning, {
    taskType: "bid_leveling",
    division: "22 00 00",
    prompt: [
      "PROPOSAL",
      "Subcontractor: Northgate Plumbing LLC",
      "Base Bid Price: $584,190.73",
      "Scope: Division 22 plumbing rough-in is included; no items are excluded from this scope.",
      "Lead time: 9 weeks.",
    ].join("\n"),
  });
  expect(noExclusions.parsedJson?.identifiedExclusions).toEqual([]);

  const dedupe: any = await t.action(internal.llmRouter.executeReasoning, {
    taskType: "bid_leveling",
    division: "23 00 00",
    prompt: [
      "PROPOSAL",
      "Subcontractor: Paceflow Mechanical LLC",
      "Base Bid Price: $713,486.22",
      "Scope: Division 23 HVAC and controls.",
      "- Factory commissioning of DDC controls — omitted ($10,240)",
      "Lead time: 22 weeks.",
    ].join("\n"),
  });
  const dedupeExclusions = dedupe.parsedJson?.identifiedExclusions || [];
  const bacnet = dedupeExclusions.filter((e: any) => /commissioning|bacnet|ddc/i.test(e.description || ""));
  expect(bacnet.length).toBe(1);
  expect(bacnet[0].costImpact).toBe(10_240);

  const kept: any = await t.action(internal.llmRouter.executeReasoning, {
    taskType: "bid_leveling",
    division: "05 12 00",
    prompt: [
      "PROPOSAL",
      "Subcontractor: Northline Steel LLC",
      "Base Bid Price: $742,300.00",
      "2. Roof screen modifications and penthouse louver rework — omitted from this proposal.",
      "Temporary power from the permanent service — not by us; allowance $7,318.",
      "Lead time: 14 weeks.",
    ].join("\n"),
  });
  const keptImpacts = (kept.parsedJson?.identifiedExclusions || []).map((e: any) => e.costImpact);
  expect(keptImpacts).toContain(7_318);
  expect(keptImpacts.length).toBeGreaterThanOrEqual(2);
});

test("A7CONV-R23A: a model-supplied waiver can never zero an exclusion", () => {
  const res = sanitizeBidLevelingOutput(
    {
      baseBidAmount: 500_000,
      longLeadEquipmentWeeks: 10,
      identifiedExclusions: [
        {
          description: "Crane hoisting and rigging excluded",
          costImpact: 45_000,
          severity: "critical",
          isWaived: true,
        },
      ],
    },
    { division: "26 00 00" }
  );
  expect(res.identifiedExclusions[0].isWaived).toBe(false);
  expect(res.leveledTotalCost).toBe(545_000);
});

test("A7CONV-R20A: the scope named first in the text wins over later modifiers", () => {
  // A TAB row that mentions commissioning is TAB, not BACNET.
  expect(
    benchmarkExclusionAmount("23 00 00", "TAB balancing and commissioning report excluded")
  ).toBe(28_000);
  // A booster row that mentions controls is BOOSTER, not BACNET.
  expect(
    benchmarkExclusionAmount("22 00 00", "Booster pump startup, alignment, and controls verification excluded")
  ).toBe(12_000);
  // Pure BACnet wording still resolves to BACNET.
  expect(
    benchmarkExclusionAmount("23 00 00", "Factory commissioning of DDC controls omitted")
  ).toBe(18_000);
});

test("A7CONV-R19B: updateBidAdjustments accepts and preserves canonicalCode on exclusion rows", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await makeProject(t, "A7 Adjustments CanonicalCode Project");
  const packageId = await makePackage(t, projectId, "26 00 00", 1_250_000);
  const contractorId = await makeContractor(t, packageId, "A7 Adjustment Bidder");
  const bidId = await makeBid(t, packageId, contractorId, "A7 Adjustment Bidder", 1_000_000);
  const result: any = await t.mutation(api.bids.updateBidAdjustments, {
    bidId,
    identifiedExclusions: [
      {
        canonicalCode: "CSI_26_CRANE",
        description: "Crane hoisting and rigging excluded",
        costImpact: 45_000,
        severity: "critical",
      },
    ],
    coiComplianceStatus: "compliant",
  });
  expect(result.leveledTotalCost).toBe(1_045_000);
  const stored: any = await t.run(async (ctx) => await ctx.db.get(bidId));
  expect(stored.identifiedExclusions[0].canonicalCode).toBe("CSI_26_CRANE");
  expect(stored.leveledTotalCost).toBe(1_045_000);
});

test("A7CONV-R3C-6: inferred canonical codes never cross the package division", async () => {
  const t = await asGc(convexTest(schema, modules));
  const res: any = await t.action(internal.llmRouter.executeReasoning, {
    taskType: "bid_leveling",
    division: "23 00 00",
    prompt: [
      "PROPOSAL",
      "Subcontractor: Northline Mechanical LLC",
      "Base Bid Price: $742,300.00",
      "Chiller factory startup (certified technician) excluded ($6,425).",
      "Lead time: 14 weeks.",
    ].join("\n"),
  });
  const codes = (res.parsedJson?.identifiedExclusions || []).map((e: any) => e.canonicalCode || "");
  expect(codes.join(" ")).not.toMatch(/CSI_22/);
});

test("A7CONV-R4C-1: a VE deduct never overwrites a stated exclusion allowance", () => {
  const exclusions = [
    { description: "Concrete pumping — GC to provide", costImpact: 0 },
  ];
  const text =
    "Concrete pumping — GC to provide; allowance: $6,120. Alternate 1: omit decorative concrete staining, deduct $4,875.";
  const priced = applyExplicitExclusionAmounts(exclusions, text);
  expect(priced[0].costImpact).toBe(6_120);
});

test("A7CONV-R4C-2: month-based lead times convert deterministically at 4.33 weeks/month", () => {
  expect(normalizeLeadWeeksFromText(20, "Equipment lead time 5 months from notice to proceed.")).toBe(22);
  expect(normalizeLeadWeeksFromText(20, "Equipment lead time 5 months (about 22 weeks) from notice.")).toBe(22);
  expect(normalizeLeadWeeksFromText(17, "Lead time 17 weeks from NTP.")).toBe(17);
  expect(normalizeLeadWeeksFromText(12, "No schedule statement.")).toBe(12);
  // A7CONV-R5A-1: a model-returned 0 can never erase a stated week count.
  expect(normalizeLeadWeeksFromText(0, "Material lead time: 12 weeks.")).toBe(12);
  expect(normalizeLeadWeeksFromText(0, "20-week lead time for switchgear.")).toBe(20);
  // A7CONV-R6C-1: compound month+week statements sum both parts.
  expect(normalizeLeadWeeksFromText(2, "LEAD TIME: 3 months and 2 weeks from notice to proceed.")).toBe(15);
  // A7CONV-R6C-3: parenthesized numerals are read.
  expect(normalizeLeadWeeksFromText(12, "Lead time: approximately eighteen (18) weeks.")).toBe(18);
});

test("A7CONV-R6C-2: subrogation wording is a COI deficiency in raw text detection", () => {
  expect(detectCoiDeficiency("Insurance: additional insured included but subrogation waived.")).toBe(true);
  expect(detectCoiDeficiency("Umbrella liability endorsement excluded.")).toBe(true);
  expect(detectCoiDeficiency("Fully compliant ACORD 25 with $5M umbrella included.")).toBe(false);
  expect(detectCoiDeficiency("Standard statutory limits only.")).toBe(true);
  expect(detectCoiDeficiency("Insurance: compliant ACORD 25 attached.")).toBe(false);
  expect(detectCoiDeficiency(undefined)).toBe(false);
  // A7CONV-R7C-3: "statutory WC only" is also a deficiency.
  expect(detectCoiDeficiency("Insurance: we carry statutory WC only.")).toBe(true);
});

test("A7CONV-R7C-1/2/3: space-separated amounts, SCHEDULE lead statements, and variant exclusion phrases", () => {
  // Space-separated thousands must not be truncated to their first group.
  const spaced = applyExplicitExclusionAmounts(
    [{ description: "Crane hoisting of the pump skid — excluded", costImpact: 0 }],
    "Crane hoisting of the pump skid — excluded ($ 12 345)."
  );
  expect(spaced[0].costImpact).toBe(12_345);
  const notInScope = applyExplicitExclusionAmounts(
    [{ description: "Temporary power — not in our scope", costImpact: 0 }],
    "Temporary power — not in our scope ($ 51 250)."
  );
  expect(notInScope[0].costImpact).toBe(51_250);
  // SCHEDULE: N weeks is a lead statement.
  expect(normalizeLeadWeeksFromText(0, "SCHEDULE: 6 weeks from notice to proceed.")).toBe(6);
  expect(normalizeLeadWeeksFromText(0, "Schedule: 20 weeks from notice to proceed.")).toBe(20);
});

test("A7CONV-R8C-1: percentage-priced exclusions take the benchmark and disclose the basis", () => {
  const exclusions = [
    { description: "Rooftop crane hoisting of the pump skid — not in our scope", costImpact: 14_961 },
  ];
  const percentText =
    "TOTAL PROPOSAL PRICE: $498,700.00. Rooftop crane hoisting of the pump skid is not in our scope; the GC budget carries a proportional 3% of our contract value.";
  const priced = applyUnpricedExclusionBenchmarks(exclusions, percentText, "22 00 00");
  expect(priced[0].costImpact).toBe(25_000);
  expect(priced[0].description).toMatch(/percentage; benchmark applied/i);
  // A stated dollar amount in the same sentence wins over the percentage rule.
  const dollar = applyUnpricedExclusionBenchmarks(
    exclusions,
    "Rooftop crane hoisting of the pump skid is not in our scope (3%); a stated allowance of $12,345 applies."
  );
  expect(dollar[0].costImpact).toBe(14_961);
  // A7CONV-R9B: a dollar cap in the same sentence beats the percentage basis.
  const cap = applyUnpricedExclusionBenchmarks(
    [{ description: "Penthouse crane rigging is not in our scope", costImpact: 0 }],
    "Penthouse crane rigging is not in our scope; the GC carry allowance is capped at $23,750 (approximately 4.5% of our contract value)."
  );
  expect(cap[0].costImpact).toBe(0);
  expect(cap[0].description).not.toMatch(/benchmark applied/i);
  // A7CONV-R9A-2/R11B-F3: an unpriced pump-skid crane takes the documented
  // pump-skid line (25,000) regardless of the package division.
  const div23 = applyUnpricedExclusionBenchmarks(
    [{ description: "Penthouse crane hoisting of the pump skid excluded", costImpact: 25_000 }],
    "The proposal states no dollar amount for this item.",
    "23 00 00"
  );
  expect(div23[0].costImpact).toBe(25_000);
  const div23Chiller = applyUnpricedExclusionBenchmarks(
    [{ description: "Rooftop crane pick and rigging to cooling tower deck excluded", costImpact: 0 }],
    "The proposal states no dollar amount for this item.",
    "23 00 00"
  );
  expect(div23Chiller[0].costImpact).toBe(48_000);
});

test("A7CONV-R8A-1: a model-supplied canonical code cannot cross the package division", () => {
  const res = sanitizeBidLevelingOutput(
    {
      baseBidAmount: 500_000,
      longLeadEquipmentWeeks: 10,
      identifiedExclusions: [
        { canonicalCode: "CSI_22_CRANE", description: "Chiller crane pick excluded", costImpact: 48_000, severity: "critical" },
      ],
    },
    { division: "23 00 00" }
  );
  expect(res.identifiedExclusions[0].costImpact).toBe(48_000);
  expect(res.identifiedExclusions[0].canonicalCode).toBeUndefined();
  const sameDiv = sanitizeBidLevelingOutput(
    {
      baseBidAmount: 500_000,
      longLeadEquipmentWeeks: 10,
      identifiedExclusions: [
        { canonicalCode: "CSI_23_CRANE", description: "Chiller crane pick excluded", costImpact: 48_000, severity: "critical" },
      ],
    },
    { division: "23 00 00" }
  );
  expect(sameDiv.identifiedExclusions[0].canonicalCode).toBe("CSI_23_CRANE");
});

test("A7CONV-R10A/R10B: core-drill scopes price as CORE, credits never bind, word amounts bind", () => {
  // The word "penetration" must not turn core drilling into firestopping.
  expect(benchmarkExclusionAmount("22 00 00", "Core drilling and penetration sleeves excluded")).toBe(16_000);
  expect(benchmarkExclusionAmount("26 00 00", "UL 1479 floor penetration firestopping excluded")).toBe(22_000);
  // A negative credit line never becomes an exclusion cost.
  const credit = applyExplicitExclusionAmounts(
    [{ description: "Penthouse crane rigging is excluded", costImpact: 0 }],
    "Penthouse crane rigging is excluded. Credit for salvaged switchgear units: -$2,500."
  );
  expect(credit[0].costImpact).toBe(0);
  // A stated amount written in words binds.
  const words = applyExplicitExclusionAmounts(
    [{ description: "Crane rigging is excluded", costImpact: 0 }],
    "Crane rigging is excluded; the GC carry allowance is thirty-three thousand dollars."
  );
  expect(words[0].costImpact).toBe(33_000);
  // Severity labels are derived from impact, not the model.
  const severity = sanitizeBidLevelingOutput(
    {
      baseBidAmount: 100_000,
      longLeadEquipmentWeeks: 8,
      identifiedExclusions: [
        { description: "Small cleanup item excluded", costImpact: 5_000, severity: "critical" },
      ],
    },
    { division: "26 00 00" }
  );
  expect(severity.identifiedExclusions[0].severity).toBe("minor");
});

test("A7CONV-R11B/R11A: explicit firestop wording, pump-skid crane, base-line guard, severity normalization", () => {
  // Explicit firestop wording beats sleeve nouns.
  expect(
    benchmarkExclusionAmount("26 00 00", "UL 1479 firestopping of plumbing riser sleeves and electrical penetrations")
  ).toBe(22_000);
  // A pump-skid lift takes the documented pump-skid line regardless of package division.
  expect(benchmarkExclusionAmount("26 00 00", "Penthouse crane hoisting of the pump skid excluded")).toBe(25_000);
  // The BASE BID PRICE line is never a stated exclusion amount, even when the
  // model description contains "priced"/"percentage-based".
  const guarded = applyUnpricedExclusionBenchmarks(
    [{ description: "Rooftop crane hoisting — priced percentage-based carry", costImpact: 0 }],
    "BASE BID PRICE: $900,000. Rooftop crane hoisting is not in our scope; a proportional 3% carry applies.",
    "22 00 00"
  );
  expect(guarded[0].costImpact).toBe(25_000);
  expect(guarded[0].description).toMatch(/percentage; benchmark applied/i);
  // Severity normalization follows the final impact.
  expect(
    normalizeExclusionSeverity([{ description: "TAB report excluded", costImpact: 28_000, severity: "minor" }])[0].severity
  ).toBe("moderate");
  // A percentage-of-required-umbrella statement is a COI deficiency.
  expect(detectCoiDeficiency("Insurance: we carry 90% of the required umbrella.")).toBe(true);
});

test("A7CONV-R15A: the deterministic scope-gap net restores a dropped exclusion and stated amounts still win", () => {
  const text =
    "Penthouse crane rigging and hoisting is excluded; the insurance-mandated crane allowance is $43,800.00.";
  const augmented = augmentExclusionsWithDeterministicGaps<{ description: string; costImpact: number }>([], text, "26 00 00");
  expect(augmented.length).toBe(1);
  expect(augmented[0].costImpact).toBe(45_000);
  const finalExclusions = applyExplicitExclusionAmounts(
    applyUnpricedExclusionBenchmarks(augmented, text, "26 00 00"),
    text
  );
  expect(finalExclusions[0].costImpact).toBe(43_800);
  // Included scopes are never added.
  expect(
    augmentExclusionsWithDeterministicGaps<{ description: string; costImpact: number }>([], "Crane rigging and hoisting is included in the base bid.", "26 00 00")
  ).toEqual([]);
  // Existing rows are not duplicated.
  expect(
    augmentExclusionsWithDeterministicGaps(
      [{ description: "Penthouse crane rigging excluded", costImpact: 45_000 }],
      "Crane rigging is excluded.",
      "26 00 00"
    ).length
  ).toBe(1);
  // Negated scope statements are not gaps.
  expect(
    augmentExclusionsWithDeterministicGaps<{ description: string; costImpact: number }>(
      [],
      "Nothing is excluded from this scope.",
      "26 00 00"
    )
  ).toEqual([]);
  // A7CONV-R16A-F1: only the HEAD scope of the sentence is a candidate; a
  // modifier mention ("vibration isolation on the booster skid") adds nothing.
  expect(
    augmentExclusionsWithDeterministicGaps(
      [{ description: "Vibration isolation on the booster skid excluded", costImpact: 6_900 }],
      "Vibration isolation on the booster skid is excluded at $6,900.00.",
      "22 00 00"
    ).length
  ).toBe(1);
  // A7CONV-R16B-F1: a negation sentence with an "as specified" inclusion adds nothing.
  expect(
    augmentExclusionsWithDeterministicGaps<{ description: string; costImpact: number }>(
      [],
      "No items are excluded from our Base Bid and crane rigging and hoisting is provided as specified.",
      "23 00 00"
    )
  ).toEqual([]);
  // A7CONV-R16B-F2: umbrella liability limits phrased after the amount are affirmative.
  expect(
    detectCoiAffirmativeCompliance("coverage with umbrella liability limits of $5,000,000.00 are included.")
  ).toBe(true);
  // A7CONV-R18B-F1: "subrogation included" cannot clear an umbrella exclusion.
  expect(
    detectCoiDeficiency("Workers' compensation only. Umbrella liability endorsement excluded. Subrogation included.")
  ).toBe(true);
  expect(detectCoiDeficiency("Umbrella liability endorsement excluded. Subrogation included.")).toBe(true);
  // A7CONV-R21B: plural "statutory workers' compensation coverage only" is a deficiency.
  expect(detectCoiDeficiency("Insurance: statutory workers' compensation coverage only.")).toBe(true);
  expect(detectCoiDeficiency("$5,000,000 umbrella included. Subrogation included.")).toBe(false);
});

test("A7CONV-R13B: position-aware binding, allowance exemptions, and sentence-local COI deficiency", () => {
  // R13B-F1: a quoted base before the exclusion clause never binds.
  const quoted = applyExplicitExclusionAmounts(
    [{ description: "Seismic structural bracing per IBC Section 1613 is excluded", costImpact: 0 }],
    "Quoted at $1,182,500.00 for Division 26, seismic structural bracing per IBC Section 1613 is excluded at 3.5% of contract value."
  );
  expect(quoted[0].costImpact).toBe(0);
  const quotedBench = applyUnpricedExclusionBenchmarks(
    [{ description: "Seismic structural bracing per IBC Section 1613 is excluded", costImpact: 0 }],
    "Quoted at $1,182,500.00 for Division 26, seismic structural bracing per IBC Section 1613 is excluded at 3.5% of contract value.",
    "26 00 00"
  );
  expect(quotedBench[0].costImpact).toBe(55_000);
  expect(quotedBench[0].description).toMatch(/percentage; benchmark applied/i);

  // R13B-F2: a stated allowance binds even beside an umbrella requirement.
  const umbrella = applyExplicitExclusionAmounts(
    [{ description: "Penthouse crane rigging excluded", costImpact: 0 }],
    "Penthouse crane rigging is excluded at $39,500.00 with a $5,000,000.00 umbrella liability insurance requirement."
  );
  expect(umbrella[0].costImpact).toBe(39_500);

  // R13B-F3: "total"/"insurance-mandated" allowance clauses still bind.
  const totalAllowance = applyExplicitExclusionAmounts(
    [{ description: "Firestopping work excluded", costImpact: 0 }],
    "The total firestopping allowance is $18,400.00."
  );
  expect(totalAllowance[0].costImpact).toBe(18_400);
  const insuranceAllowance = applyExplicitExclusionAmounts(
    [{ description: "Crane rigging excluded", costImpact: 0 }],
    "The insurance-mandated crane allowance is $43,800.00."
  );
  expect(insuranceAllowance[0].costImpact).toBe(43_800);

  // R13B-F4: "umbrella included" plus an unrelated "excluded" is compliant.
  expect(
    detectCoiDeficiency(
      "Insurance: ACORD 25 attached; $5,000,000.00 commercial umbrella liability included. Seismic bracing is excluded."
    )
  ).toBe(false);
  expect(detectCoiDeficiency("Umbrella liability endorsement excluded.")).toBe(true);
  // A7CONV-R14A-F1: text affirmative compliance is detected in $5,000,000.00 form.
  expect(
    detectCoiAffirmativeCompliance("ACORD 25 attached; $5,000,000.00 commercial umbrella liability included.")
  ).toBe(true);
  // A model-declared deficiency penalty is clamped to the documented constant.
  const clamped = sanitizeBidLevelingOutput(
    {
      baseBidAmount: 500_000,
      longLeadEquipmentWeeks: 10,
      coiComplianceStatus: "deficiency_detected",
      coiPenalty: 43_800,
    },
    { division: "26 00 00" }
  );
  expect(clamped.coiComplianceStatus).toBe("deficiency_detected");
  expect(clamped.coiPenalty).toBe(15_000);
});

test("A7CONV-R12B: base/retainage amounts never bind as exclusions; scope collisions resolve by head noun", () => {
  // A base amount named in the exclusion sentence is not the exclusion cost.
  const baseLeak = applyExplicitExclusionAmounts(
    [{ description: "Penthouse crane rigging and hoisting excluded", costImpact: 45_000 }],
    "The base proposal price for Division 26 is $1,024,500.00 and penthouse crane rigging and hoisting is excluded."
  );
  expect(baseLeak[0].costImpact).toBe(45_000);
  // A retainage amount never prices a percentage-only exclusion.
  const retainage = applyExplicitExclusionAmounts(
    applyUnpricedExclusionBenchmarks(
      [{ description: "Seismic structural bracing per IBC Section 1613 is excluded", costImpact: 0 }],
      "Seismic structural bracing per IBC Section 1613 is excluded (3.5% of contract value) and a 10% retainage of $115,300 will be withheld.",
      "26 00 00"
    ),
    "Seismic structural bracing per IBC Section 1613 is excluded (3.5% of contract value) and a 10% retainage of $115,300 will be withheld."
  );
  expect(retainage[0].costImpact).toBe(55_000);
  // Head-noun precedence for core/firestop collisions.
  expect(benchmarkExclusionAmount("22 00 00", "Core drilling of firestopping sleeves excluded")).toBe(16_000);
  expect(benchmarkExclusionAmount("26 00 00", "UL 1479 firestopping of plumbing riser sleeves excluded")).toBe(22_000);
  // A rooftop cooling-tower lift takes the Div 23 line even in a Div 22 package.
  expect(benchmarkExclusionAmount("22 00 00", "Rooftop crane pick and rigging of the cooling tower excluded")).toBe(48_000);
  // A word-amount tail naming a different scope binds to THAT scope, not the previous one.
  const wordSwap = applyExplicitExclusionAmounts(
    [
      { description: "Penthouse crane hoisting of the pump skid is excluded", costImpact: 25_000 },
      { description: "Firestopping work at riser penetrations is excluded", costImpact: 22_000 },
    ],
    "Penthouse crane hoisting of the pump skid is excluded. The GC carry for the firestopping work is one hundred and twenty-five thousand dollars."
  );
  expect(wordSwap[0].costImpact).toBe(25_000);
  expect(wordSwap[1].costImpact).toBe(125_000);
});

test("A7CONV-R5C-1/2: next-line amounts bind to the bulleted exclusion and subrogation is a COI deficiency", async () => {
  const t = await asGc(convexTest(schema, modules));
  const res: any = await t.action(internal.llmRouter.executeReasoning, {
    taskType: "bid_leveling",
    division: "26 00 00",
    prompt: [
      "PROPOSAL",
      "Subcontractor: Meridian Electric LLC",
      "Base Bid Price: $688,000.00",
      "EXCLUSIONS:",
      "1. Temporary power distribution board",
      "$9,250",
      "2. UL 1479 firestopping at floor penetrations — excluded (by others)",
      "$22,000",
      "Insurance: Waiver of subrogation excluded.",
      "Lead time: 4 weeks (expedited).",
    ].join("\n"),
  });
  const exclusions = res.parsedJson?.identifiedExclusions || [];
  const tempPower = exclusions.find((e: any) => /temporary power/i.test(e.description || ""));
  expect(tempPower?.costImpact).toBe(9_250);
  const firestop = exclusions.find((e: any) => /firestop/i.test(e.description || ""));
  expect(firestop?.costImpact).toBe(22_000);
  expect(res.parsedJson?.coiComplianceStatus).toBe("deficiency_detected");
  expect(res.parsedJson?.coiPenalty).toBe(15_000);
});