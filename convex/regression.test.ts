/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { asGc, type GcTest } from "./lib/testIdentity";
import { validateBidDeadline } from "./validation";

const modules = import.meta.glob("./**/*.ts");

async function createProject(t: GcTest, title = "Regression Project") {
  return await t.mutation(api.projects.createProject, {
    title,
    location: "Austin, TX",
    projectType: "Class-A Commercial Mixed-Use",
    estBudget: 2_500_000,
    targetCompletionWeeks: 52,
    specDocumentText: "Regression specification text.",
    isDemoProject: false,
  });
}

async function createPackage(t: GcTest, projectId: any) {
  return await t.mutation(api.tradePackages.createTradePackage, {
    projectId,
    csiDivision: "26 00 00",
    tradeName: "Electrical & Lighting Systems",
    budgetEstimate: 1_250_000,
    scopeSummary: "Switchgear, distribution, and branch power.",
    mandatoryInclusions: ["Crane hoisting", "Seismic bracing"],
    bidDeadline: "2026-10-31",
  });
}

async function createContractor(t: GcTest, tradePackageId: any) {
  return await t.mutation(api.contractors.createContractor, {
    tradePackageId,
    companyName: "Regression Electric LLC",
    contactEmail: "estimating@regression-electric.test",
    phone: "+1 (512) 555-0177",
    licenseNumber: "TX-REG-0001",
    licenseStatus: "Active / Verified",
    sourceUrl: "https://regression-electric.test",
    rfqStatus: "invited",
  });
}

test("F1: created project persists in listProjects", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "F1 Persistence Project");
  const projects = await t.query(api.projects.listProjects, {});
  expect(projects.some((p) => p._id === projectId && p.title === "F1 Persistence Project")).toBe(true);
});

test("F3/F4: saveFileRecord accepts real storage ids and persists records", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "F4 Upload Project");
  const { uploadIntentId } = await t.mutation(api.files.generateUploadUrl, { projectId });
  const storageId = await t.run(async (ctx) =>
    await ctx.storage.store(new Blob(["spec body for regression"], { type: "text/plain" }))
  );
  const fileId = await t.mutation(api.files.saveFileRecord, {
    projectId,
    uploadIntentId,
    storageId,
    fileName: "26_00_00_Regression_Spec.txt",
    fileType: "spec",
    fileSize: 25,
    uploadedBy: "Regression Test",
    contentType: "text/plain",
  });
  expect(fileId).toBeTruthy();
  const files = await t.query(api.files.listFilesByProject, { projectId });
  expect(files.some((f) => f._id === fileId && f.fileName === "26_00_00_Regression_Spec.txt")).toBe(true);
});

test("F3/A7CONV-R2C-F3: addendum requires at least one PM-certified RFI; zero certified is refused server-side", async () => {
  const base = convexTest(schema, modules);
  const t = await asGc(base);
  const projectId = await createProject(t, "F3 Addendum Project");
  // A7CONV-R2C-F3: zero certified RFIs must be refused by the action itself,
  // not only by the disabled UI button.
  await expect(t.action(api.files.generatePreBidAddendum, { projectId })).rejects.toThrow(/certify at least one/i);

  // With one PM-certified RFI and zero pending RFIs, the legal addendum generates.
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);
  await t.run(
    async (ctx) =>
      await ctx.db.insert("conversations", {
        tradePackageId: packageId,
        contractorId,
        threadId: "f3-thread",
        inboundSubject: "F3 subject",
        inboundQuestion: "F3 question?",
        autonomousReply: "F3 reply.",
        confidenceScore: 0.98,
        status: "clarified",
        pmCertifiedAt: Date.now(),
        timestamp: Date.now(),
      })
  );
  const result: any = await t.action(api.files.generatePreBidAddendum, { projectId });
  expect(result.success).toBe(true);
  // The filed addendum is reachable only through the authenticated file route, never a public storage URL.
  expect(result.downloadUrl).toBeUndefined();
  expect(result.storageId).toBeUndefined();
  expect(result.downloadPath).toBe(`/api/project-files/${result.fileId}`);
  expect(JSON.stringify(result)).not.toMatch(/\/api\/storage\/|convex\.cloud/);
  const files = await t.query(api.files.listFilesByProject, { projectId });
  expect(files.some((f) => f.fileType === "addendum")).toBe(true);

  const ok = await t.fetch(result.downloadPath, { method: "GET" });
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain("ADDENDUM");
  const anon = await base.fetch(result.downloadPath, { method: "GET" });
  expect([401, 404]).toContain(anon.status);
});

test("F9: invalid CSI divisions are rejected and valid ones accepted", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "F9 CSI Project");
  await expect(
    t.mutation(api.tradePackages.createTradePackage, {
      projectId,
      csiDivision: "99 99 99",
      tradeName: "Invalid Division",
      budgetEstimate: 100_000,
      scopeSummary: "Should be rejected.",
      mandatoryInclusions: ["None"],
      bidDeadline: "2026-10-31",
    })
  ).rejects.toThrow();
  const pkgId = await createPackage(t, projectId);
  expect(pkgId).toBeTruthy();
});

test("F9: implausible bid amounts are rejected; revisions increment", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Bid Floor Project");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);

  await expect(
    t.mutation(api.bids.submitDirectBid, {
      tradePackageId: packageId,
      contractorId,
      subcontractorName: "Regression Electric LLC",
      baseBidAmount: 1,
    })
  ).rejects.toThrow();

  await expect(
    t.mutation(api.bids.submitDirectBid, {
      tradePackageId: packageId,
      contractorId,
      subcontractorName: "Regression Electric LLC",
      baseBidAmount: 999_999_999,
    })
  ).rejects.toThrow();

  await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_100_000,
  });
  await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_150_000,
  });

  const bids = await t.query(api.bids.listByPackage, { tradePackageId: packageId });
  const bid = bids.find((b) => b.contractorId === contractorId);
  expect(bid?.revisionNumber).toBe(2);
  expect(bid?.lastRevisedAt).toBeTypeOf("number");
});

test("F5: executed agreements block bid changes", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Executed Agreement Project");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);
  await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_200_000,
  });
  const bids = await t.query(api.bids.listByPackage, { tradePackageId: packageId });
  const bid = bids.find((b) => b.contractorId === contractorId);

  await t.run(async (ctx) => {
    await ctx.db.patch(bid!._id, { isAwarded: true });
    await ctx.db.insert("agreements", {
      bidId: bid!._id,
      tradePackageId: packageId,
      projectId,
      contractorId,
      agreementNumber: "A401-REGRESSION",
      documentTitle: "AIA Document A401 - 2017 Standard Form of Agreement",
      subcontractorName: "Regression Electric LLC",
      generalContractorName: "Austin Commercial, LP",
      projectTitle: "Executed Agreement Project",
      projectLocation: "Austin, TX",
      csiDivision: "26 00 00",
      tradeName: "Electrical & Lighting Systems",
      scopeSummary: "Regression scope",
      mandatoryInclusions: ["Crane hoisting"],
      status: "executed",
      contractSum: 1_200_000,
      retainagePercent: 5,
      liquidatedDamagesDaily: 1000,
      contractText: "Regression agreement text",
      createdAt: Date.now(),
      executedAt: Date.now(),
    });
  });

  await expect(
    t.mutation(api.bids.submitDirectBid, {
      tradePackageId: packageId,
      contractorId,
      subcontractorName: "Regression Electric LLC",
      baseBidAmount: 1_250_000,
    })
  ).rejects.toThrow(/immutable/i);
});

test("Clash guard: projects without both trade packages return no clashes", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Clash Guard Project");
  const empty = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  expect(empty.doubleBuys).toEqual([]);
  expect(empty.scopeVoids).toEqual([]);
  expect(empty.summary.activeClashesCount).toBe(0);
});

test("Clash guard: both packages but zero bids return no clashes (no priced evidence)", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Zero Bid Clash Project");
  await createPackage(t, projectId);
  const hvacId = await t.mutation(api.tradePackages.createTradePackage, {
    projectId,
    csiDivision: "23 00 00",
    tradeName: "HVAC & Mechanical Systems",
    budgetEstimate: 1_500_000,
    scopeSummary: "Rooftop units and distribution.",
    mandatoryInclusions: ["TAB report"],
    bidDeadline: "2026-10-31",
  });
  expect(hvacId).toBeTruthy();
  const zeroBid = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  expect(zeroBid.doubleBuys).toEqual([]);
  expect(zeroBid.scopeVoids).toEqual([]);
  expect(zeroBid.summary.activeClashesCount).toBe(0);
});

test("B1/A24-01: clash credit is persisted as a resolution once both trades are priced", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Clash Resolution Project");
  const packageId = await createPackage(t, projectId);
  // A24-01: credits require priced evidence on both sides.
  const hvacId = await t.mutation(api.tradePackages.createTradePackage, {
    projectId,
    csiDivision: "23 00 00",
    tradeName: "HVAC Systems",
    budgetEstimate: 1_200_000,
    scopeSummary: "Rooftop units and hydronic piping.",
    mandatoryInclusions: ["Crane pick"],
    bidDeadline: "2026-10-31",
  });
  const elecContractor = await createContractor(t, packageId);
  const hvacContractor = await t.mutation(api.contractors.createContractor, {
    tradePackageId: hvacId,
    companyName: "Regression Mechanical LLC",
    contactEmail: "bids@regression-mech.test",
    licenseNumber: "TX-REG-0005",
    licenseStatus: "Active / Verified",
    sourceUrl: "https://regression-mech.test",
    rfqStatus: "invited",
  });
  await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId: elecContractor,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_100_000,
  });
  await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: hvacId,
    contractorId: hvacContractor,
    subcontractorName: "Regression Mechanical LLC",
    baseBidAmount: 1_150_000,
  });
  const result = await t.mutation(api.coordination.deductDoubleBuyCredit, {
    projectId,
    clashId: "clash-vfd-01",
    tradePackageId: packageId,
    deductAmount: 38_500,
    description: "VFD double-buy",
  });
  expect(result.success).toBe(true);
  const resolutions = await t.run(async (ctx) =>
    await ctx.db
      .query("clashResolutions")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect()
  );
  expect(resolutions.length).toBe(1);
  expect(resolutions[0].clashId).toBe("clash-vfd-01");
  expect(resolutions[0].status).toBe("deducted");
});

test("Guest RFI: submission without a contractor id succeeds (no v.id failure)", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Guest RFI Project");
  const packageId = await createPackage(t, projectId);
  const result = await t.mutation(api.simulation.submitCustomRfi, {
    tradePackageId: packageId,
    subject: "Guest regression question",
    question: "Does the base scope include crane hoisting for the main equipment?",
  });
  expect(result.success).toBe(true);
});

test("RFQ dispatch with zero discovered contractors is rejected and leaves the package undispached", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Zero Recipient RFQ Project");
  const packageId = await createPackage(t, projectId);

  await expect(t.mutation(api.rfq.dispatchRfqs, { tradePackageId: packageId })).rejects.toThrow(
    /No contractors have been discovered/i
  );

  const pkg = await t.query(api.tradePackages.getPackage, { tradePackageId: packageId });
  expect(pkg?.status).toBe("draft");

  const logs = await t.query(api.auditLogs.listRecentLogs, { projectId });
  expect(logs.some((l) => l.eventType === "rfq_dispatched")).toBe(false);
});

test("RFQ dispatch with discovered contractors marks them invited", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Recipient RFQ Project");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);
  await t.run(async (ctx) => await ctx.db.patch(contractorId, { rfqStatus: "discovered" }));

  const result: any = await t.mutation(api.rfq.dispatchRfqs, { tradePackageId: packageId });
  expect(result.success).toBe(true);
  expect(result.dispatchedCount).toBe(1);

  const contractors = await t.query(api.contractors.listByPackage, { tradePackageId: packageId });
  expect(contractors.find((c) => c._id === contractorId)?.rfqStatus).toBe("invited");
  const pkg = await t.query(api.tradePackages.getPackage, { tradePackageId: packageId });
  expect(pkg?.status).toBe("rfqs_dispatched");
});

/** Force the deterministic (no-network) reasoning path in tests. */
function withoutProviderKeys<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ["OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "VERTEX_API_KEY", "VERTEX_ACCESS_TOKEN", "GCP_PROJECT", "VERTEX_PROJECT_ID"] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  return fn().finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("F1: submitted RFI is persisted as pending_analysis before any LLM work", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "F1 Durability Project");
  const packageId = await createPackage(t, projectId);

  const result: any = await t.mutation(api.simulation.submitCustomRfi, {
    tradePackageId: packageId,
    subject: "F1 durability subject",
    question: "Is the 400A temporary power distribution board part of this package?",
  });
  expect(result.success).toBe(true);
  expect(result.conversationId).toBeTruthy();

  const convos = await t.run(async (ctx) =>
    await ctx.db
      .query("conversations")
      .withIndex("by_package", (q) => q.eq("tradePackageId", packageId))
      .collect()
  );
  expect(convos.length).toBe(1);
  expect(convos[0].status).toBe("pending_analysis");
  expect(convos[0].inboundQuestion).toContain("400A temporary power");
  expect(convos[0].inboundSubject).toBe("F1 durability subject");
});

test("F1: a failed analysis keeps the RFI text and records failed_analysis + error", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "F1 Failure Project");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);

  const pending: any = await t.mutation(internal.rfq.createPendingInboundRfi, {
    tradePackageId: packageId,
    contractorId,
    threadId: "th_f1_fail",
    inboundSubject: "F1 failure subject",
    inboundQuestion: "Will the GC provide crane access on weekends for this scope?",
  });

  // Simulate the failure class: the contractor record vanishes while the RFI is
  // in flight, so completing the analysis throws. The question must survive.
  await t.run(async (ctx) => {
    await ctx.db.delete(contractorId);
  });

  await withoutProviderKeys(() =>
    t.action(internal.emailActions.handleRfiProcessing, {
      tradePackageId: packageId,
      contractorId,
      fromEmail: "regression@sub.test",
      subject: "F1 failure subject",
      text: "Will the GC provide crane access on weekends for this scope?",
      threadId: "th_f1_fail",
      conversationId: pending,
    })
  );

  const convo: any = await t.run(async (ctx) => await ctx.db.get(pending));
  expect(convo.status).toBe("failed_analysis");
  expect(convo.inboundQuestion).toContain("crane access on weekends");
  expect(typeof convo.analysisError).toBe("string");
  expect(convo.analysisError.length).toBeGreaterThan(0);

  const logs = await t.query(api.auditLogs.listRecentLogs, { projectId });
  expect(logs.some((l) => /RFI Analysis Failed/i.test(l.title))).toBe(true);
});

test("F1: retry re-queues a failed RFI without losing the text and completes it", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "F1 Retry Project");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);

  const pending: any = await t.mutation(internal.rfq.createPendingInboundRfi, {
    tradePackageId: packageId,
    contractorId,
    threadId: "th_f1_retry",
    inboundSubject: "F1 retry subject",
    inboundQuestion: "Who furnishes the seismic bracing for conduit runs over 2.5 inches?",
  });
  await t.mutation(internal.rfq.failInboundRfiAnalysis, {
    conversationId: pending,
    error: "simulated transient failure",
  });

  const retry: any = await t.mutation(api.simulation.retryRfiAnalysis, { conversationId: pending });
  expect(retry.success).toBe(true);
  const afterRetry: any = await t.run(async (ctx) => await ctx.db.get(pending));
  expect(afterRetry.status).toBe("pending_analysis");
  expect(afterRetry.analysisError).toBeUndefined();
  expect(afterRetry.inboundQuestion).toContain("seismic bracing");

  vi.useFakeTimers();
  try {
    await withoutProviderKeys(() => t.finishAllScheduledFunctions(vi.runAllTimers));
  } finally {
    vi.useRealTimers();
  }
  const completed: any = await t.run(async (ctx) => await ctx.db.get(pending));
  expect(completed.status, `status=${completed.status} err=${completed.analysisError}`).toMatch(/clarified|escalated_to_pm/);
  expect(completed.autonomousReply.length).toBeGreaterThan(20);
});

test("F1: retry refuses to re-run an already answered RFI", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "F1 Answered Project");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);
  const pending: any = await t.mutation(internal.rfq.createPendingInboundRfi, {
    tradePackageId: packageId,
    contractorId,
    threadId: "th_f1_done",
    inboundSubject: "Answered",
    inboundQuestion: "Already handled?",
  });
  await t.mutation(internal.rfq.completeInboundRfi, {
    conversationId: pending,
    autonomousReply: "Yes, already handled.",
    confidenceScore: 0.97,
    status: "clarified",
  });
  const retry: any = await t.mutation(api.simulation.retryRfiAnalysis, { conversationId: pending });
  expect(retry.success).toBe(false);
});

test("F6: an RFI targeting another package is stored on that package, not the active one", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "F6 Routing Project");
  const electricalId = await createPackage(t, projectId);
  const plumbingId = await t.mutation(api.tradePackages.createTradePackage, {
    projectId,
    csiDivision: "22 00 00",
    tradeName: "Plumbing Systems",
    budgetEstimate: 620_000,
    scopeSummary: "Domestic water and sanitary.",
    mandatoryInclusions: ["Backflow certification"],
    bidDeadline: "2026-10-31",
  });

  const res: any = await t.mutation(api.simulation.submitCustomRfi, {
    tradePackageId: plumbingId,
    subject: "Medical gas routing",
    question: "Does this package require third-party medical gas certification?",
  });
  expect(res.success).toBe(true);

  const plumbingConvos = await t.run(async (ctx) =>
    await ctx.db
      .query("conversations")
      .withIndex("by_package", (q) => q.eq("tradePackageId", plumbingId))
      .collect()
  );
  const electricalConvos = await t.run(async (ctx) =>
    await ctx.db
      .query("conversations")
      .withIndex("by_package", (q) => q.eq("tradePackageId", electricalId))
      .collect()
  );
  expect(plumbingConvos.length).toBe(1);
  expect(electricalConvos.length).toBe(0);
  expect(plumbingConvos[0].inboundSubject).toBe("Medical gas routing");

  const guestContractors = await t.query(api.contractors.listByPackage, { tradePackageId: plumbingId });
  expect(guestContractors.length).toBe(1);
  expect(guestContractors[0].companyName).toContain("Guest");
});

async function seedAwardedExecuted(t: GcTest, title: string) {
  const projectId = await createProject(t, title);
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);
  const bidResult: any = await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_100_000,
  });
  const bidId = bidResult.bidId;
  const agreement: any = await t.mutation(api.agreements.generateAgreement, { bidId, tradePackageId: packageId });
  await t.mutation(api.agreements.executeAgreement, { agreementId: agreement._id });
  return { projectId, packageId, contractorId, bidId, agreementId: agreement._id };
}

test("A1-02: awarding a different bid cannot silently supersede an executed subcontract", async () => {
  const t = await asGc(convexTest(schema, modules));
  const { packageId } = await seedAwardedExecuted(t, "Executed Guard Project");
  const secondContractor = await t.mutation(api.contractors.createContractor, {
    tradePackageId: packageId,
    companyName: "Second Bidder LLC",
    contactEmail: "bids@second-bidder.test",
    phone: "+1 (512) 555-0199",
    licenseNumber: "TX-REG-0002",
    licenseStatus: "Active / Verified",
    sourceUrl: "https://second-bidder.test",
    rfqStatus: "invited",
  });
  const secondBidResult: any = await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId: secondContractor,
    subcontractorName: "Second Bidder LLC",
    baseBidAmount: 950_000,
  });
  const secondBid = secondBidResult.bidId;

  await expect(
    t.mutation(api.agreements.generateAgreement, { bidId: secondBid, tradePackageId: packageId })
  ).rejects.toThrow(/executed subcontract/i);

  await expect(
    t.mutation(api.bids.awardContract, { bidId: secondBid, tradePackageId: packageId })
  ).rejects.toThrow(/generate the agreement|executed subcontract/i);

  const agreements = await t.run(async (ctx) =>
    await ctx.db.query("agreements").withIndex("by_package", (q) => q.eq("tradePackageId", packageId)).collect()
  );
  expect(agreements.filter((a) => a.status === "executed").length).toBe(1);
});

test("A1-03/A3-03: deleting a contractor with bids or an executed subcontract is refused", async () => {
  const t = await asGc(convexTest(schema, modules));
  const { contractorId } = await seedAwardedExecuted(t, "Contractor Guard Project");

  await expect(t.mutation(api.contractors.deleteContractor, { contractorId })).rejects.toThrow(
    /executed subcontract/i
  );
  const bids = await t.run(async (ctx) =>
    await ctx.db.query("bids").withIndex("by_contractor", (q) => q.eq("contractorId", contractorId)).collect()
  );
  expect(bids.length).toBe(1);
});

test("A3-01: creating a trade package requires an existing project", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Orphan Guard Project");
  await t.run(async (ctx) => {
    await ctx.db.delete(projectId);
  });
  await expect(
    t.mutation(api.tradePackages.createTradePackage, {
      projectId,
      csiDivision: "28 00 00",
      tradeName: "Orphan Package",
      budgetEstimate: 100_000,
      scopeSummary: "Should not exist.",
      mandatoryInclusions: ["None"],
      bidDeadline: "2026-10-31",
    })
  ).rejects.toThrow(/Not found/);
});

test("A3-03: deleting a package with an executed subcontract is refused", async () => {
  const t = await asGc(convexTest(schema, modules));
  const { packageId } = await seedAwardedExecuted(t, "Package Delete Guard");
  await expect(t.mutation(api.tradePackages.deleteTradePackage, { tradePackageId: packageId })).rejects.toThrow(
    /executed subcontract/i
  );
});

test("A10-05/A10-06: long-lead and line-item bounds are enforced on every writer", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Bounds Guard Project");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);
  const created: any = await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_100_000,
  });
  const bidId = created.bidId;

  await expect(
    t.mutation(api.bids.submitDirectBid, {
      tradePackageId: packageId,
      contractorId,
      subcontractorName: "Regression Electric LLC",
      baseBidAmount: 1_100_000,
      lineItems: [{ item: "Bad", unit: "LS", quantity: -5, unitCost: 100, totalCost: -500 }],
    })
  ).rejects.toThrow(/non-negative/i);

  await expect(
    t.mutation(api.bids.updateBidLeveling, { bidId, longLeadEquipmentWeeks: -9 })
  ).rejects.toThrow(/0 and 520/);
  await expect(
    t.mutation(api.bids.updateBidAdjustments, { bidId, identifiedExclusions: [], longLeadEquipmentWeeks: 3.7 })
  ).rejects.toThrow(/whole number/);
});

test("A8-03/A10-04: a clash can only be credited once", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Clash Guard Project");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);
  const created: any = await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_100_000,
  });
  // A21-01: a cross-trade credit needs priced proposals on BOTH sides.
  const hvacId = await t.mutation(api.tradePackages.createTradePackage, {
    projectId,
    csiDivision: "23 00 00",
    tradeName: "HVAC Systems",
    budgetEstimate: 1_200_000,
    scopeSummary: "Rooftop units and hydronic piping.",
    mandatoryInclusions: ["Crane pick"],
    bidDeadline: "2026-10-31",
  });
  const hvacContractor = await t.mutation(api.contractors.createContractor, {
    tradePackageId: hvacId,
    companyName: "Regression Mechanical LLC",
    contactEmail: "bids@regression-mech.test",
    licenseNumber: "TX-REG-0004",
    licenseStatus: "Active / Verified",
    sourceUrl: "https://regression-mech.test",
    rfqStatus: "invited",
  });
  await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: hvacId,
    contractorId: hvacContractor,
    subcontractorName: "Regression Mechanical LLC",
    baseBidAmount: 1_150_000,
  });
  await t.mutation(api.coordination.deductDoubleBuyCredit, {
    projectId,
    clashId: "clash-vfd-01",
    tradePackageId: packageId,
    deductAmount: 38_500,
    description: "VFD double buy",
    bidId: created.bidId,
  });
  await expect(
    t.mutation(api.coordination.deductDoubleBuyCredit, {
      projectId,
      clashId: "clash-vfd-01",
      tradePackageId: packageId,
      deductAmount: 1_000,
      description: "VFD double buy again",
      bidId: created.bidId,
    })
  ).rejects.toThrow(/already been applied/i);
});

test("A10-01/A10-02: full-cycle simulation and project delete refuse executed subcontracts", async () => {
  const t = await asGc(convexTest(schema, modules));
  const { projectId, packageId } = await seedAwardedExecuted(t, "Executed Simulation Guard");

  await expect(
    t.mutation(api.simulation.runFullProcurementCycle, { projectId, tradePackageId: packageId })
  ).rejects.toThrow(/executed subcontract/i);

  await expect(t.mutation(api.projects.deleteProject, { projectId })).rejects.toThrow(/executed subcontract/i);

  const agreements: any[] = await t.run(async (ctx) =>
    await ctx.db.query("agreements").withIndex("by_package" as any, (q: any) => q.eq("tradePackageId", packageId)).collect()
  );
  expect(agreements.filter((a: any) => a.status === "executed").length).toBe(1);
});

test("RFQ dispatch without contractors returns a readable error", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Readable Dispatch Error");
  const packageId = await createPackage(t, projectId);
  await expect(t.mutation(api.rfq.dispatchRfqs, { tradePackageId: packageId })).rejects.toThrow(
    /Run Discovery before dispatching RFQs/i
  );
});

test("A12-01: awarding cannot ride on a superseded agreement", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Superseded Award Guard");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);
  const created: any = await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_100_000,
  });
  await t.mutation(api.agreements.generateAgreement, { bidId: created.bidId, tradePackageId: packageId });
  await t.mutation(api.bids.unawardContract, { bidId: created.bidId, tradePackageId: packageId });
  await expect(
    t.mutation(api.bids.awardContract, { bidId: created.bidId, tradePackageId: packageId })
  ).rejects.toThrow(/superseded/i);
  await t.mutation(api.agreements.generateAgreement, { bidId: created.bidId, tradePackageId: packageId });
  const result: any = await t.mutation(api.bids.awardContract, {
    bidId: created.bidId,
    tradePackageId: packageId,
  });
  expect(result.success).toBe(true);
});

test("A12-02: a revision to an awarded bid keeps the active agreement in sync", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Revision Sync Guard");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);
  const created: any = await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_000_000,
  });
  const agreement: any = await t.mutation(api.agreements.generateAgreement, {
    bidId: created.bidId,
    tradePackageId: packageId,
  });
  expect(agreement.contractSum).toBe(1_000_000);

  await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "Someone Else Entirely",
    baseBidAmount: 1_222_222,
  });
  const agreements: any[] = await t.run(async (ctx) =>
    await ctx.db.query("agreements").withIndex("by_bid" as any, (q: any) => q.eq("bidId", created.bidId)).collect()
  );
  const active = agreements.find((a: any) => a.status !== "superseded");
  expect(active?.contractSum).toBe(1_222_222);
});

test("A12-03: a package cannot be marked awarded without award evidence", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Status Evidence Guard");
  const packageId = await createPackage(t, projectId);
  await expect(
    t.mutation(api.tradePackages.updateStatus, { tradePackageId: packageId, status: "awarded" })
  ).rejects.toThrow(/awarded after a bid is awarded/i);

  const contractorId = await createContractor(t, packageId);
  const created: any = await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_100_000,
  });
  await t.mutation(api.agreements.generateAgreement, { bidId: created.bidId, tradePackageId: packageId });
  await t.mutation(api.tradePackages.updateStatus, { tradePackageId: packageId, status: "awarded" });
  const pkg: any = await t.run(async (ctx) => await ctx.db.get(packageId));
  expect(pkg.status).toBe("awarded");
});

test("A11-03: voiding an executed agreement reopens the package with an audit reason", async () => {
  const t = await asGc(convexTest(schema, modules));
  const { packageId, bidId, agreementId } = await seedAwardedExecuted(t, "Void Executed Guard");
  await expect(
    t.mutation(api.agreements.voidExecutedAgreement, { agreementId, reason: "short" })
  ).rejects.toThrow(/at least 10/i);

  const result: any = await t.mutation(api.agreements.voidExecutedAgreement, {
    agreementId,
    reason: "Recorded execution was a mistake; external amendment handled offline.",
  });
  expect(result.success).toBe(true);
  const agreement: any = await t.run(async (ctx) => await ctx.db.get(agreementId));
  const bid: any = await t.run(async (ctx) => await ctx.db.get(bidId));
  const pkg: any = await t.run(async (ctx) => await ctx.db.get(packageId));
  expect(agreement.status).toBe("superseded");
  expect(bid.isAwarded).toBe(false);
  expect(pkg.status).toBe("leveling");
});

test("A12-08: reserved system labels and invisible characters are rejected for names", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Name Guard");
  const packageId = await createPackage(t, projectId);
  await expect(
    t.mutation(api.contractors.createContractor, {
      tradePackageId: packageId,
      companyName: "AWARDED",
      contactEmail: "x@y.test",
      licenseNumber: "TX-1",
      licenseStatus: "active",
      sourceUrl: "https://x.test",
      rfqStatus: "discovered",
    })
  ).rejects.toThrow(/reserved system label/i);
  await expect(
    t.mutation(api.contractors.createContractor, {
      tradePackageId: packageId,
      companyName: "AUDIT\u200BQA12",
      contactEmail: "z@y.test",
      licenseNumber: "TX-2",
      licenseStatus: "active",
      sourceUrl: "https://z.test",
      rfqStatus: "discovered",
    })
  ).rejects.toThrow(/invisible/i);
});

test("A14-02: a stale contractor edit is refused instead of clobbering a newer save", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Concurrent Edit Guard");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);
  const list: any[] = await t.query(api.contractors.listByPackage, { tradePackageId: packageId });
  const stored = list.find((c) => c._id === contractorId);
  const staleMarker = (stored.updatedAt ?? 0) - 1;

  await expect(
    t.mutation(api.contractors.updateContractor, {
      contractorId,
      companyName: "Stale Edit LLC",
      contactEmail: "stale@example.test",
      licenseNumber: "TX-3",
      licenseStatus: "active",
      sourceUrl: "https://stale.test",
      expectedUpdatedAt: staleMarker,
    })
  ).rejects.toThrow(/changed in another session/i);

  await t.mutation(api.contractors.updateContractor, {
    contractorId,
    companyName: "Fresh Edit LLC",
    contactEmail: "fresh@example.test",
    licenseNumber: "TX-3",
    licenseStatus: "active",
    sourceUrl: "https://fresh.test",
    expectedUpdatedAt: stored.updatedAt,
  });
  const after: any[] = await t.query(api.contractors.listByPackage, { tradePackageId: packageId });
  expect(after.find((c) => c._id === contractorId)?.companyName).toBe("Fresh Edit LLC");
});

test("A14-01: a date-only bid deadline accepts the current UTC day", () => {
  const now = Date.UTC(2026, 8, 19, 0, 13); // 2026-09-19T00:13Z
  expect(validateBidDeadline("2026-09-19", now)).toBe("2026-09-19");
  expect(validateBidDeadline("2026-09-18", now)).toBe("2026-09-18"); // one day of TZ slack
  expect(() => validateBidDeadline("2026-09-17", now)).toThrow(/past/i);
});

test("A21-01: cross-trade clashes and credits require priced evidence on both sides", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Cross-Trade Evidence Guard");
  const elecId = await createPackage(t, projectId);
  const hvacId = await t.mutation(api.tradePackages.createTradePackage, {
    projectId,
    csiDivision: "23 00 00",
    tradeName: "HVAC Systems",
    budgetEstimate: 1_200_000,
    scopeSummary: "Rooftop units and hydronic piping.",
    mandatoryInclusions: ["Crane pick"],
    bidDeadline: "2026-10-31",
  });
  const contractorId = await createContractor(t, elecId);
  await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: elecId,
    contractorId,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_100_000,
  });

  // Electrical priced, HVAC not: no clash evidence may be asserted.
  const clashes: any = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  expect(clashes.doubleBuys.length).toBe(0);
  expect(clashes.scopeVoids.length).toBe(0);

  await expect(
    t.mutation(api.coordination.deductDoubleBuyCredit, {
      projectId,
      clashId: "clash-vfd-01",
      tradePackageId: elecId,
      deductAmount: 38_500,
      description: "VFD double buy",
    })
  ).rejects.toThrow(/both Division 26 .* and Division 23/i);

  // Price the HVAC side and the same clash becomes computable.
  const hvacContractor = await t.mutation(api.contractors.createContractor, {
    tradePackageId: hvacId,
    companyName: "Regression Mechanical LLC",
    contactEmail: "bids@regression-mech.test",
    licenseNumber: "TX-REG-0003",
    licenseStatus: "Active / Verified",
    sourceUrl: "https://regression-mech.test",
    rfqStatus: "invited",
  });
  await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: hvacId,
    contractorId: hvacContractor,
    subcontractorName: "Regression Mechanical LLC",
    baseBidAmount: 1_150_000,
  });
  const clashesAfter: any = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  expect(clashesAfter.doubleBuys.length).toBeGreaterThan(0);
});

test("A28-01/02/03/04: clash truth, manual-VE coverage, and credit bounds", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Clash Truth Guard");
  const elecId = await createPackage(t, projectId);
  const hvacId = await t.mutation(api.tradePackages.createTradePackage, {
    projectId,
    csiDivision: "23 00 00",
    tradeName: "HVAC Systems",
    budgetEstimate: 1_200_000,
    scopeSummary: "Rooftop units and hydronic piping.",
    mandatoryInclusions: ["Crane pick"],
    bidDeadline: "2026-10-31",
  });
  const elecContractor = await createContractor(t, elecId);
  await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: elecId,
    contractorId: elecContractor,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_100_000,
  });
  const hvacContractor = await t.mutation(api.contractors.createContractor, {
    tradePackageId: hvacId,
    companyName: "Regression Mechanical LLC",
    contactEmail: "bids@regression-mech.test",
    licenseNumber: "TX-REG-0006",
    licenseStatus: "Active / Verified",
    sourceUrl: "https://regression-mech.test",
    rfqStatus: "invited",
  });
  const hvacBid: any = await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: hvacId,
    contractorId: hvacContractor,
    subcontractorName: "Regression Mechanical LLC",
    baseBidAmount: 1_150_000,
  });

  // A28-01: a "base building ..." inclusion must not count as BAS coverage.
  await t.run(async (ctx) => {
    const pkg: any = await ctx.db.get(elecId);
    await ctx.db.patch(elecId, {
      mandatoryInclusions: [...pkg.mandatoryInclusions, "Base building general conditions allowance"],
    });
  });
  const before: any = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  expect(before.scopeVoids.find((v: any) => v.id === "void-bas-wiring-01")?.status).toBe("open");

  // A28-02: a manual accepted VE reduces exposure but does not mark the credit deducted.
  await t.mutation(api.bids.updateBidAdjustments, {
    bidId: hvacBid.bidId,
    identifiedExclusions: [],
    valueEngineeringAlternates: [{ description: "Manual VFD starter credit", costDeduct: 1_000, isAccepted: true }],
  });
  const after: any = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  const vfd = after.doubleBuys.find((d: any) => d.id === "clash-vfd-01");
  expect(vfd.status).toBe("detected");
  expect(vfd.redundantAmount).toBe(37_500);

  // A28-03: a zero credit is refused and cannot consume the clash.
  await expect(
    t.mutation(api.coordination.deductDoubleBuyCredit, {
      projectId,
      clashId: "clash-vfd-01",
      tradePackageId: hvacId,
      deductAmount: 0,
      description: "Zero credit",
      bidId: hvacBid.bidId,
    })
  ).rejects.toThrow(/greater than zero/i);

  // A28-04: a credit larger than the proposal's leveled cost is refused.
  await expect(
    t.mutation(api.coordination.deductDoubleBuyCredit, {
      projectId,
      clashId: "clash-vfd-01",
      tradePackageId: hvacId,
      deductAmount: 5_000_000,
      description: "Oversized credit",
      bidId: hvacBid.bidId,
    })
  ).rejects.toThrow(/exceeds the proposal/i);

  // The sanctioned credit still applies and only then marks the clash deducted.
  await t.mutation(api.coordination.deductDoubleBuyCredit, {
    projectId,
    clashId: "clash-vfd-01",
    tradePackageId: hvacId,
    deductAmount: 37_500,
    description: "VFD double buy",
    bidId: hvacBid.bidId,
  });
  const final: any = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  expect(final.doubleBuys.find((d: any) => d.id === "clash-vfd-01")?.status).toBe("deducted");

  // A30-01: if the credit alternate is later removed, the card must not keep a
  // phantom deducted claim, and the reversal path must clear the stale record.
  await t.mutation(api.bids.updateBidAdjustments, {
    bidId: hvacBid.bidId,
    identifiedExclusions: [],
    valueEngineeringAlternates: [],
  });
  const stale: any = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  expect(stale.doubleBuys.find((d: any) => d.id === "clash-vfd-01")?.status).toBe("detected");

  const reversed: any = await t.mutation(api.coordination.reverseDoubleBuyCredit, {
    projectId,
    clashId: "clash-vfd-01",
    tradePackageId: hvacId,
  });
  expect(reversed.success).toBe(true);
  const reDeduct: any = await t.mutation(api.coordination.deductDoubleBuyCredit, {
    projectId,
    clashId: "clash-vfd-01",
    tradePackageId: hvacId,
    deductAmount: 37_500,
    description: "VFD double buy",
    bidId: hvacBid.bidId,
  });
  expect(reDeduct.success).toBe(true);

  // A34-01/A34-02: equal-amount credits must be isolated by clash identity.
  await t.mutation(api.coordination.reverseDoubleBuyCredit, {
    projectId,
    clashId: "clash-vfd-01",
    tradePackageId: hvacId,
  });
  await t.mutation(api.coordination.deductDoubleBuyCredit, {
    projectId,
    clashId: "clash-vfd-01",
    tradePackageId: hvacId,
    deductAmount: 12_000,
    description: "VFD equal-amount credit",
    bidId: hvacBid.bidId,
  });
  await t.mutation(api.coordination.deductDoubleBuyCredit, {
    projectId,
    clashId: "clash-disconnect-02",
    tradePackageId: hvacId,
    deductAmount: 12_000,
    description: "Disconnect equal-amount credit",
    bidId: hvacBid.bidId,
  });
  const both: any = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  expect(both.doubleBuys.find((d: any) => d.id === "clash-vfd-01")?.status).toBe("deducted");
  expect(both.doubleBuys.find((d: any) => d.id === "clash-disconnect-02")?.status).toBe("deducted");

  // Un-accept ONLY the VFD credit: the disconnect card must stay deducted.
  const bidAfterBoth: any = await t.run(async (ctx) => await ctx.db.get(hvacBid.bidId));
  await t.mutation(api.bids.updateBidAdjustments, {
    bidId: hvacBid.bidId,
    identifiedExclusions: [],
    valueEngineeringAlternates: (bidAfterBoth.valueEngineeringAlternates || []).map((a: any) =>
      a.description.includes("[clash-vfd-01]") ? { ...a, isAccepted: false } : a
    ),
  });
  const masked: any = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  expect(masked.doubleBuys.find((d: any) => d.id === "clash-vfd-01")?.status).toBe("detected");
  expect(masked.doubleBuys.find((d: any) => d.id === "clash-vfd-01")?.staleResolution).toBe(true);
  expect(masked.doubleBuys.find((d: any) => d.id === "clash-disconnect-02")?.status).toBe("deducted");

  // Reverse the stale VFD record: only the VFD credit is cleared.
  const staleReverse: any = await t.mutation(api.coordination.reverseDoubleBuyCredit, {
    projectId,
    clashId: "clash-vfd-01",
    tradePackageId: hvacId,
  });
  expect(staleReverse.success).toBe(true);
  const afterStale: any = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  expect(afterStale.doubleBuys.find((d: any) => d.id === "clash-disconnect-02")?.status).toBe("deducted");
});

test("A36-01: reversal finds the carrier even when a sibling package id is passed", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Reversal Package Guard");
  const elecId = await createPackage(t, projectId);
  const hvacId = await t.mutation(api.tradePackages.createTradePackage, {
    projectId,
    csiDivision: "23 00 00",
    tradeName: "HVAC Systems",
    budgetEstimate: 1_200_000,
    scopeSummary: "Rooftop units and hydronic piping.",
    mandatoryInclusions: ["Crane pick"],
    bidDeadline: "2026-10-31",
  });
  const elecContractor = await createContractor(t, elecId);
  await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: elecId,
    contractorId: elecContractor,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_100_000,
  });
  const hvacContractor = await t.mutation(api.contractors.createContractor, {
    tradePackageId: hvacId,
    companyName: "Regression Mechanical LLC",
    contactEmail: "bids@regression-mech.test",
    licenseNumber: "TX-REG-0007",
    licenseStatus: "Active / Verified",
    sourceUrl: "https://regression-mech.test",
    rfqStatus: "invited",
  });
  const hvacBid: any = await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: hvacId,
    contractorId: hvacContractor,
    subcontractorName: "Regression Mechanical LLC",
    baseBidAmount: 1_150_000,
  });
  await t.mutation(api.coordination.deductDoubleBuyCredit, {
    projectId,
    clashId: "clash-vfd-01",
    tradePackageId: hvacId,
    deductAmount: 12_000,
    description: "VFD credit",
    bidId: hvacBid.bidId,
  });

  // Wrong (sibling) package id: the reversal must still find the carrier.
  const reversed: any = await t.mutation(api.coordination.reverseDoubleBuyCredit, {
    projectId,
    clashId: "clash-vfd-01",
    tradePackageId: elecId,
  });
  expect(reversed.success).toBe(true);
  expect(reversed.reversedAmount).toBe(12_000);
  const hvacAfter: any = await t.run(async (ctx) => await ctx.db.get(hvacBid.bidId));
  expect((hvacAfter.valueEngineeringAlternates || []).length).toBe(0);
  const detect: any = await t.query(api.coordination.detectCrossTradeClashes, { projectId });
  expect(detect.doubleBuys.find((d: any) => d.id === "clash-vfd-01")?.status).toBe("detected");
});

test("A3-06: invalid COI status and negative exclusion impacts are rejected", async () => {
  const t = await asGc(convexTest(schema, modules));
  const projectId = await createProject(t, "Adjustment Guard Project");
  const packageId = await createPackage(t, projectId);
  const contractorId = await createContractor(t, packageId);
  const bidCreated: any = await t.mutation(api.bids.submitDirectBid, {
    tradePackageId: packageId,
    contractorId,
    subcontractorName: "Regression Electric LLC",
    baseBidAmount: 1_100_000,
  });
  const bidId = bidCreated.bidId;
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
});