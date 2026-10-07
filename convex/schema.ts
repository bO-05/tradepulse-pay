import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export const roleValidator = v.union(v.literal("gc"), v.literal("sub"), v.literal("owner"));
export const actorTypeValidator = v.union(v.literal("human"), v.literal("agent"));

export const milestoneStatusValidator = v.union(
  v.literal("planned"),
  v.literal("funding"),
  v.literal("funded"),
  v.literal("funding_expired"),
  v.literal("in_progress"),
  v.literal("complete"),
  v.literal("paid"),
);

export const payAppStatusValidator = v.union(
  v.literal("submitted"),
  v.literal("under_review"),
  v.literal("reviewed"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("withdrawn"),
  v.literal("paid"),
);

export const proposalKindValidator = v.union(
  v.literal("capture"),
  v.literal("payout"),
  v.literal("retainage_release"),
  v.literal("reschedule"),
  v.literal("hold"),
);

export const proposalStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("executed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const paymentKindValidator = v.union(
  v.literal("funding"),
  v.literal("payout"),
  v.literal("retainage_release"),
);

// Union of the funding lifecycle and the payout lifecycle; the per-kind legal
// transitions are enforced by convex/payments/stateMachine.ts, not the schema.
export const paymentStatusValidator = v.union(
  v.literal("created"),
  v.literal("approved"),
  v.literal("authorized"),
  v.literal("partially_captured"),
  v.literal("captured"),
  v.literal("voided"),
  v.literal("expired"),
  v.literal("pending"),
  v.literal("success"),
  v.literal("unclaimed"),
  v.literal("returned"),
  v.literal("failed"),
);

export const changeOrderStatusValidator = v.union(
  v.literal("draft"),
  v.literal("invoiced"),
  v.literal("paid"),
  v.literal("cancelled"),
);

export const licenseStatusValidator = v.union(
  v.literal("active"),
  v.literal("expired"),
  v.literal("suspended"),
  v.literal("not_found"),
  v.literal("unverified"),
);

export const lineVerdictValidator = v.union(
  v.literal("ok"),
  v.literal("overbilled"),
  v.literal("excluded_scope"),
  v.literal("front_loaded"),
  v.literal("out_of_sequence"),
);

export default defineSchema({
  ...authTables,

  // Convex Auth users, extended with AgentID agent identity claims. Missing
  // claims are stored as undefined (field absent), never null.
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    actorType: v.optional(actorTypeValidator),
    agentSub: v.optional(v.string()),
    ownerSub: v.optional(v.string()),
    ownerName: v.optional(v.string()),
    ownerEmail: v.optional(v.string()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  userProfiles: defineTable({
    userId: v.id("users"),
    role: roleValidator,
    displayName: v.string(),
    contractorId: v.optional(v.id("contractors")),
    paypalEmail: v.optional(v.string()),
    actorType: v.optional(actorTypeValidator),
    agentEmail: v.optional(v.string()),
    ownerEmail: v.optional(v.string()),
    ownerName: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_contractorId", ["contractorId"])
    .index("by_role", ["role"]),

  // GC-managed authorization of AgentID billing agents to act for a sub.
  agentLinks: defineTable({
    agentEmail: v.string(), // lowercased
    contractorId: v.id("contractors"),
    agreementId: v.optional(v.id("agreements")),
    status: v.union(v.literal("active"), v.literal("revoked")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    revokedBy: v.optional(v.id("users")),
    revokedAt: v.optional(v.number()),
  })
    .index("by_agentEmail_and_status", ["agentEmail", "status"])
    .index("by_contractorId", ["contractorId"]),

  // Schedule of values; lines sum exactly to the agreement contract sum.
  scheduleOfValues: defineTable({
    agreementId: v.id("agreements"),
    lineNo: v.number(),
    description: v.string(),
    csiCode: v.optional(v.string()),
    scheduledValueCents: v.number(),
    excludedScope: v.boolean(),
    sourceBidLineRef: v.optional(v.string()),
  }).index("by_agreementId_and_lineNo", ["agreementId", "lineNo"]),

  milestones: defineTable({
    agreementId: v.id("agreements"),
    name: v.string(),
    order: v.number(),
    plannedDate: v.number(),
    amountCents: v.number(),
    status: milestoneStatusValidator,
    sovLineIds: v.array(v.id("scheduleOfValues")),
  }).index("by_agreementId_and_order", ["agreementId", "order"]),

  payApplications: defineTable({
    agreementId: v.id("agreements"),
    subUserId: v.id("users"),
    periodLabel: v.string(),
    lines: v.array(
      v.object({
        sovLineId: v.id("scheduleOfValues"),
        pctCompleteThisPeriod: v.number(), // percent 0-100
        pctCompleteToDate: v.number(), // percent 0-100
        requestedCents: v.number(),
      }),
    ),
    requestedTotalCents: v.number(),
    notes: v.string(),
    lienWaiver: v.boolean(),
    status: payAppStatusValidator,
    submittedBy: v.object({
      userId: v.id("users"),
      actorType: actorTypeValidator,
      agentEmail: v.optional(v.string()),
      ownerEmail: v.optional(v.string()),
      ownerName: v.optional(v.string()),
    }),
    // Dollar figures here are computed by code from the model's percentages;
    // the model never authors amounts.
    review: v.optional(
      v.object({
        engine: v.string(), // model id, or "Offline rules engine"
        lines: v.array(
          v.object({
            sovLineId: v.id("scheduleOfValues"),
            verdict: lineVerdictValidator,
            recommendedPctToDate: v.number(),
            approvedCents: v.number(),
            reason: v.string(),
          }),
        ),
        flags: v.object({
          lienWaiverMissing: v.boolean(),
          licenseIssue: v.boolean(),
          notes: v.string(),
        }),
        approvedTotalCents: v.number(),
        traceRunId: v.optional(v.string()),
        reviewedAt: v.number(),
      }),
    ),
    withdrawnAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_agreementId", ["agreementId"])
    .index("by_agreementId_and_status", ["agreementId", "status"])
    .index("by_subUserId", ["subUserId"])
    .index("by_status", ["status"]),

  agentProposals: defineTable({
    payAppId: v.optional(v.id("payApplications")),
    agreementId: v.id("agreements"),
    milestoneId: v.optional(v.id("milestones")),
    kind: proposalKindValidator,
    amountCents: v.optional(v.number()),
    rationale: v.string(),
    flags: v.array(v.string()),
    status: proposalStatusValidator,
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    editedAmountCents: v.optional(v.number()),
    paymentId: v.optional(v.id("payments")),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_agreementId_and_status", ["agreementId", "status"])
    .index("by_payAppId", ["payAppId"]),

  payments: defineTable({
    agreementId: v.id("agreements"),
    milestoneId: v.optional(v.id("milestones")),
    payAppId: v.optional(v.id("payApplications")),
    proposalId: v.optional(v.id("agentProposals")),
    kind: paymentKindValidator,
    status: paymentStatusValidator,
    paypalOrderId: v.optional(v.string()),
    paypalAuthorizationId: v.optional(v.string()),
    authorizationExpiresAt: v.optional(v.number()),
    honorPeriodEndsAt: v.optional(v.number()),
    paypalCaptureId: v.optional(v.string()),
    paypalPayoutBatchId: v.optional(v.string()),
    paypalPayoutItemId: v.optional(v.string()),
    grossCents: v.number(),
    retainageCents: v.number(),
    netCents: v.number(),
    capturedCents: v.optional(v.number()),
    idempotencyKey: v.string(),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_agreementId", ["agreementId"])
    .index("by_milestoneId", ["milestoneId"])
    .index("by_payAppId", ["payAppId"])
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_paypalOrderId", ["paypalOrderId"])
    .index("by_paypalAuthorizationId", ["paypalAuthorizationId"])
    .index("by_paypalCaptureId", ["paypalCaptureId"])
    .index("by_paypalPayoutBatchId", ["paypalPayoutBatchId"])
    .index("by_paypalPayoutItemId", ["paypalPayoutItemId"])
    .index("by_kind_and_status", ["kind", "status"]),

  // Balance = sum of deltaCents (+held / -released).
  retainageLedger: defineTable({
    agreementId: v.id("agreements"),
    paymentId: v.optional(v.id("payments")),
    deltaCents: v.number(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_agreementId", ["agreementId"])
    .index("by_paymentId", ["paymentId"]),

  changeOrders: defineTable({
    agreementId: v.id("agreements"),
    number: v.number(),
    description: v.string(),
    amountCents: v.number(),
    status: changeOrderStatusValidator,
    paypalInvoiceId: v.optional(v.string()),
    payerViewUrl: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    paidAt: v.optional(v.number()),
  })
    .index("by_agreementId_and_number", ["agreementId", "number"])
    .index("by_paypalInvoiceId", ["paypalInvoiceId"])
    .index("by_status", ["status"]),

  // eventId is unique by convention: writers must check by_eventId before insert.
  paypalEvents: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    resourceId: v.optional(v.string()),
    receivedAt: v.number(),
    verified: v.boolean(),
    processed: v.boolean(),
    error: v.optional(v.string()),
  })
    .index("by_eventId", ["eventId"])
    .index("by_receivedAt", ["receivedAt"]),

  // CSLB license lookups via KERNEL, cached 24h.
  licenseChecks: defineTable({
    contractorId: v.id("contractors"),
    licenseNumber: v.string(),
    state: v.literal("CA"),
    status: licenseStatusValidator,
    rawSummary: v.string(),
    liveViewUrl: v.optional(v.string()),
    checkedAt: v.number(),
  }).index("by_contractorId_and_checkedAt", ["contractorId", "checkedAt"]),

  // Commercial construction project root
  projects: defineTable({
    title: v.string(), // e.g. "The Domain Tower B - Commercial MEP"
    location: v.string(), // "Austin, TX"
    projectType: v.string(), // "Class-A Commercial Mixed-Use"
    estBudget: v.number(),
    targetCompletionWeeks: v.number(),
    specDocumentText: v.string(),
    isDemoProject: v.boolean(), // Allows public read access for judges
    generalContractorName: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_demo", ["isDemoProject"]),

  // CSI MasterFormat Trade Packages
  tradePackages: defineTable({
    projectId: v.id("projects"),
    csiDivision: v.string(), // e.g. "26 00 00"
    tradeName: v.string(), // "Electrical & Lighting Systems"
    budgetEstimate: v.number(),
    agentMailbox: v.string(), // e.g. "austin-elec-rfq@agentmail.to"
    agentMailboxId: v.string(),
    // True when the AgentMail plan's inbox limit forced reuse of an existing
    // inbox; the UI discloses it instead of claiming a dedicated inbox.
    agentMailboxShared: v.optional(v.boolean()),
    scopeSummary: v.string(),
    mandatoryInclusions: v.array(v.string()), // ["Crane hoisting", "Seismic bracing", "Temporary power"]
    bidDeadline: v.string(),
    status: v.string(), // "draft" | "rfqs_dispatched" | "leveling" | "awarded"
  }).index("by_project", ["projectId"]),

  // Discovered Subcontractors
  contractors: defineTable({
    tradePackageId: v.id("tradePackages"),
    companyName: v.string(),
    contactEmail: v.string(),
    phone: v.optional(v.string()),
    licenseNumber: v.string(),
    licenseStatus: v.string(),
    sourceUrl: v.string(),
    rfqStatus: v.string(), // "discovered" | "invited" | "rfi_submitted" | "bid_received"
    dispatchedAt: v.optional(v.number()),
    /** A14-02: optimistic-concurrency marker for concurrent edits. */
    updatedAt: v.optional(v.number()),
  }).index("by_package", ["tradePackageId"]),

  // Two-way Pre-Bid RFIs and Clarifications
  conversations: defineTable({
    tradePackageId: v.id("tradePackages"),
    contractorId: v.id("contractors"),
    threadId: v.string(), // Matches AgentMail thread_id
    inboundSubject: v.string(),
    inboundQuestion: v.string(),
    autonomousReply: v.string(),
    confidenceScore: v.number(),
    status: v.string(), // "pending_analysis" | "clarified" | "escalated_to_pm" | "failed_analysis" | "rejected"
    pmCertifiedAt: v.optional(v.number()),
    pmCertifiedBy: v.optional(v.string()),
    reviewNote: v.optional(v.string()),
    // Set only when automated analysis fails; the submitted text stays intact so
    // the bidder can retry instead of losing the RFI.
    analysisError: v.optional(v.string()),
    timestamp: v.number(),
  })
    .index("by_contractor", ["contractorId"])
    .index("by_thread", ["threadId"])
    .index("by_package", ["tradePackageId"]),

  // Normalized Apples-to-Apples Bid Leveling Records
  bids: defineTable({
    tradePackageId: v.id("tradePackages"),
    contractorId: v.id("contractors"),
    subcontractorName: v.string(),
    baseBidAmount: v.number(),
    lineItems: v.array(
      v.object({
        item: v.string(),
        unit: v.string(),
        quantity: v.number(),
        unitCost: v.number(),
        totalCost: v.number(),
      })
    ),
    identifiedExclusions: v.array(
      v.object({
        canonicalCode: v.optional(v.string()),
        description: v.string(),
        costImpact: v.number(),
        severity: v.string(), // "critical" | "moderate" | "minor"
        isWaived: v.optional(v.boolean()),
      })
    ),
    valueEngineeringAlternates: v.optional(
      v.array(
        v.object({
          description: v.string(),
          costDeduct: v.number(),
          isAccepted: v.boolean(),
        })
      )
    ),
    longLeadEquipmentWeeks: v.number(),
    leadTimePenalty: v.number(),
    /** GC-owned schedule baseline the penalty was computed against (12 Div 26 / 16 Div 22-23). */
    leadTimeTargetWeeks: v.optional(v.number()),
    coiComplianceStatus: v.string(), // "compliant" | "deficiency_detected"
    coiPenalty: v.number(),
    leveledTotalCost: v.number(), // True normalized cost = base + un-waived scope gaps + penalties - accepted alternates
    isAwarded: v.boolean(),
    sourceFileId: v.optional(v.id("projectFiles")),
    revisionNumber: v.optional(v.number()), // 1 = first submission; increments on re-ingest
    lastRevisedAt: v.optional(v.number()),
    receivedAt: v.number(),
  })
    .index("by_package", ["tradePackageId"])
    .index("by_contractor", ["contractorId"])
    .index("by_source_file", ["sourceFileId"]),

  // Persisted cross-trade clash resolution state (deduct credits / assigned voids)
  clashResolutions: defineTable({
    projectId: v.id("projects"),
    clashId: v.string(),
    kind: v.union(v.literal("double_buy"), v.literal("scope_void")),
    status: v.union(v.literal("deducted"), v.literal("assigned")),
    amount: v.number(),
    note: v.optional(v.string()),
    resolvedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_clash", ["projectId", "clashId"]),

  // AIA Document A401 Subcontract Agreements
  agreements: defineTable({
    projectId: v.id("projects"),
    tradePackageId: v.id("tradePackages"),
    bidId: v.id("bids"),
    contractorId: v.id("contractors"),
    agreementNumber: v.string(), // e.g. "A401-2026-2601"
    documentTitle: v.string(), // "AIA Document A401™ – 2017 Standard Form of Agreement Between Contractor and Subcontractor"
    subcontractorName: v.string(),
    subcontractorEmail: v.optional(v.string()),
    generalContractorName: v.string(),
    projectTitle: v.string(),
    projectLocation: v.string(),
    csiDivision: v.string(),
    tradeName: v.string(),
    contractSum: v.number(),
    retainagePercent: v.number(),
    liquidatedDamagesDaily: v.number(),
    scopeSummary: v.string(),
    mandatoryInclusions: v.array(v.string()),
    status: v.string(), // "generated" | "executed"
    contractText: v.string(),
    executedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_bid", ["bidId"])
    .index("by_package", ["tradePackageId"])
    .index("by_project", ["projectId"]),

  // Convex File Storage (_storage) for drawings, specs, quote PDFs, and COIs
  projectFiles: defineTable({
    projectId: v.id("projects"),
    tradePackageId: v.optional(v.id("tradePackages")),
    storageId: v.string(),
    fileName: v.string(),
    fileType: v.string(), // "blueprint" | "spec" | "quote_pdf" | "coi_certificate" | "addendum"
    fileSize: v.number(),
    uploadedBy: v.string(),
    uploadedAt: v.number(),
    textContent: v.optional(v.string()),
  })
    .index("by_project", ["projectId"])
    .index("by_package", ["tradePackageId"]),

  // Live Reactive Activity Audit Stream
  auditLogs: defineTable({
    projectId: v.id("projects"),
    tradePackageId: v.optional(v.id("tradePackages")),
    eventType: v.string(), // "rfq_dispatched" | "rfi_clarified" | "quote_received" | "bid_leveled" | "contract_awarded" | "file_uploaded" | "compliance_audit" | "cron_executed"
    title: v.string(),
    description: v.string(),
    actor: v.string(),
    timestamp: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_package", ["tradePackageId"])
    .index("by_timestamp", ["timestamp"]),

  // Real-World Chief Estimator Evaluation Runs & Telemetry
  evalRuns: defineTable({
    runId: v.string(), // e.g. "eval_20260912_104500"
    targetEnvironment: v.string(), // "prod" | "dev" | "local"
    triggeredBy: v.string(), // "cli_benchmark" | "judge_diagnostics" | "regression"
    totalCases: v.number(),
    passedCases: v.number(),
    scopeRecallAvg: v.number(),
    scopePrecisionAvg: v.number(),
    leveledCostMape: v.number(),
    veAccuracyAvg: v.number(),
    coiF1Score: v.number(),
    clashRecallAvg: v.number(),
    aiaConformityAvg: v.number(),
    overallScore: v.number(),
    totalDurationMs: v.number(),
    // Holdout cases omit the answer from the prompt; optional so pre-existing
    // runs remain valid.
    holdoutCases: v.optional(v.number()),
    holdoutPassed: v.optional(v.number()),
    holdoutMape: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_runId", ["runId"])
    .index("by_createdAt", ["createdAt"]),

  // Full LLM Prompt/Completion Execution Traces & Comparative Benchmarks
  agentTraces: defineTable({
    runId: v.string(),
    caseId: v.string(),
    csiDivision: v.string(),
    contractorName: v.string(),
    provider: v.string(), // "OpenAI" | "Anthropic" | "Vertex AI / Gemini" | "DeterministicEngine"
    model: v.string(),
    rawPrompt: v.string(),
    systemPrompt: v.optional(v.string()),
    rawResponse: v.string(),
    parsedOutput: v.any(),
    groundTruth: v.any(),
    metrics: v.any(),
    status: v.string(), // "PASS" | "FAIL"
    latencyMs: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.number(),
    timestamp: v.number(),
  })
    .index("by_runId", ["runId"])
    .index("by_caseId", ["caseId"])
    .index("by_run_and_timestamp", ["runId", "timestamp"])
    .index("by_timestamp", ["timestamp"]),
});
