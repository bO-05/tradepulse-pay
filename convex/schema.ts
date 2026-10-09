import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export const roleValidator = v.union(v.literal("gc"), v.literal("sub"), v.literal("owner"));
export const actorTypeValidator = v.union(v.literal("human"), v.literal("agent"));
export const companyKindValidator = roleValidator;
export const companyMemberRoleValidator = v.union(v.literal("admin"), v.literal("member"));
export const addressValidator = v.object({
  line1: v.string(),
  line2: v.optional(v.string()),
  city: v.string(),
  state: v.string(),
  zip: v.string(),
});

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
  v.literal("capture_pending"),
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
  v.literal("inactive"),
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

// Dollar figures here are computed by code from the model's percentages
// (fractions 0-1); the model never authors amounts.
export const payAppReviewValidator = v.object({
  engine: v.string(), // display label: "Anthropic <model id>" or "Offline rules engine"
  provider: v.string(), // "Anthropic" or "Offline rules engine"
  model: v.string(), // model id that ran, or "none" for the rules engine
  fallbackReason: v.optional(v.string()),
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
    /** Latest completed license check status at review time, or "none" when no check exists. */
    licenseStatus: v.optional(v.union(licenseStatusValidator, v.literal("none"))),
    notes: v.string(),
  }),
  approvedTotalCents: v.number(),
  traceRunId: v.optional(v.string()),
  reviewedAt: v.number(),
});

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
    // The user's company (role mirrors its kind). Agents carry their linked sub company here.
    companyId: v.optional(v.id("companies")),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_contractorId", ["contractorId"])
    .index("by_role", ["role"]),

  companies: defineTable({
    name: v.string(),
    kind: companyKindValidator,
    isDemo: v.boolean(),
    // Stable key of a seeded Demo company ("gc", "sub:rosendin", ...); lets seeds find it by id, never by name.
    demoKey: v.optional(v.string()),
    legalName: v.optional(v.string()),
    address: v.optional(addressValidator),
    phone: v.optional(v.string()),
    website: v.optional(v.string()),
    billingEmail: v.optional(v.string()),
    payoutPaypalEmail: v.optional(v.string()),
    defaultRetainageBps: v.optional(v.number()),
    createdByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
  })
    .index("by_kind", ["kind"])
    .index("by_isDemo", ["isDemo"]),

  // One active company per user (enforced by the writers, see convex/lib/tenancy.ts).
  companyMembers: defineTable({
    companyId: v.id("companies"),
    userId: v.id("users"),
    role: companyMemberRoleValidator,
    status: v.union(v.literal("active"), v.literal("removed")),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_and_status", ["userId", "status"])
    .index("by_companyId", ["companyId"])
    .index("by_companyId_and_userId", ["companyId", "userId"]),

  // Company-level access to a project. The GC company also has access through projects.gcCompanyId.
  projectMembers: defineTable({
    projectId: v.id("projects"),
    companyId: v.id("companies"),
    partyRole: roleValidator,
    contractorId: v.optional(v.id("contractors")),
    vendorId: v.optional(v.id("vendors")),
    addedByUserId: v.optional(v.id("users")),
    removedAt: v.optional(v.number()),
    removedByUserId: v.optional(v.id("users")),
    status: v.union(v.literal("active"), v.literal("removed")),
    createdAt: v.number(),
  })
    .index("by_projectId", ["projectId"])
    .index("by_companyId", ["companyId"])
    .index("by_project_company_and_status", ["projectId", "companyId", "status"]),

  // The plaintext token exists only in the invite link; only its sha256 hex is stored.
  invites: defineTable({
    tokenHash: v.string(),
    email: v.string(), // lowercased
    kind: v.union(v.literal("teammate"), v.literal("sub"), v.literal("owner")),
    inviterCompanyId: v.id("companies"),
    projectId: v.optional(v.id("projects")),
    contractorId: v.optional(v.id("contractors")),
    vendorId: v.optional(v.id("vendors")),
    // Suggested name for the company the invitee creates (owner invites; editable on accept).
    companyName: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("revoked"), v.literal("expired")),
    expiresAt: v.number(),
    acceptedByUserId: v.optional(v.id("users")),
    acceptedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    emailStatus: v.union(v.literal("sent"), v.literal("bounced"), v.literal("failed"), v.literal("skipped_budget"), v.literal("not_sent")),
    emailError: v.optional(v.string()),
    lastSentAt: v.optional(v.number()),
    // Increments on every token rotation; part of the email idempotency key.
    tokenVersion: v.optional(v.number()),
    createdByUserId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_inviterCompanyId", ["inviterCompanyId"])
    .index("by_inviterCompanyId_and_kind_and_status", ["inviterCompanyId", "kind", "status"])
    .index("by_email", ["email"])
    .index("by_projectId", ["projectId"]),

  // Hashes of invite tokens replaced by a resend, so an old link reads "no longer valid" instead of "not valid".
  retiredInviteTokens: defineTable({
    tokenHash: v.string(),
    inviteId: v.id("invites"),
    retiredAt: v.number(),
  }).index("by_tokenHash", ["tokenHash"]),

  // A GC company's vendor directory (architecture §14). linkedCompanyId is set when the vendor's sub accepts an invite.
  vendors: defineTable({
    companyId: v.id("companies"),
    name: v.string(),
    trades: v.array(v.string()), // CSI divisions, e.g. "26 00 00"
    contactName: v.string(),
    email: v.string(), // lowercased
    phone: v.optional(v.string()),
    licenseNumber: v.optional(v.string()),
    licenseState: v.optional(v.string()),
    linkedCompanyId: v.optional(v.id("companies")),
    payoutEmailConfirmed: v.optional(
      v.object({ email: v.string(), confirmedByUserId: v.id("users"), confirmedAt: v.number() })
    ),
    status: v.union(v.literal("active"), v.literal("inactive")),
    createdAt: v.number(),
  })
    .index("by_companyId", ["companyId"])
    .index("by_linkedCompanyId", ["linkedCompanyId"]),

  // One row per send attempt key, written only by convex/lib/mailer.ts. Never stores codes or invite tokens.
  emailOutbox: defineTable({
    kind: v.union(
      v.literal("auth_code"),
      v.literal("invite"),
      v.literal("rfq"),
      v.literal("rfi_answer"),
      v.literal("notification"),
      v.literal("other")
    ),
    to: v.string(), // lowercased
    fromInbox: v.string(),
    subject: v.optional(v.string()),
    companyId: v.optional(v.id("companies")),
    projectId: v.optional(v.id("projects")),
    // Charged against the budget: pending (call in flight), sent, uncertain (AgentMail may have accepted it
    // but the response was lost) and delivery_failed (sent, then bounced or rejected).
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("uncertain"),
      v.literal("delivery_failed"),
      v.literal("failed"),
      v.literal("skipped_budget")
    ),
    idempotencyKey: v.string(),
    day: v.string(), // UTC yyyy-mm-dd of the latest attempt
    attempts: v.number(),
    agentmailMessageId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    error: v.optional(v.string()),
    deliveryEvent: v.optional(v.string()), // last AgentMail delivery webhook: delivered | bounced | complained | rejected
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_day_and_status", ["day", "status"])
    .index("by_threadId", ["threadId"])
    .index("by_agentmailMessageId", ["agentmailMessageId"]),

  // Bounces/rejections that arrived before any outbox row carried their message id; finishSend applies them.
  emailEarlyDeliveryEvents: defineTable({
    agentmailMessageId: v.string(),
    event: v.string(), // bounced | rejected
    receivedAt: v.number(),
  }).index("by_agentmailMessageId", ["agentmailMessageId"]),

  // Outbound RFQ conversations this deployment started; inbound mail routes by threadId, then by `[TP-<ref>]`.
  emailThreads: defineTable({
    ref: v.string(),
    kind: v.literal("rfq"),
    projectId: v.id("projects"),
    companyId: v.optional(v.id("companies")),
    tradePackageId: v.id("tradePackages"),
    contractorId: v.id("contractors"),
    threadId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_ref", ["ref"])
    .index("by_threadId", ["threadId"])
    .index("by_contractorId", ["contractorId"]),

  // Every AgentMail thread recognized as part of an RFQ conversation (each outbound send and each
  // token-routed inbound thread), so token-free follow-ups on any of them still route.
  emailThreadLinks: defineTable({
    threadId: v.string(),
    emailThreadId: v.id("emailThreads"),
    contractorId: v.id("contractors"),
    source: v.union(v.literal("outbound"), v.literal("inbound_token")),
    createdAt: v.number(),
  }).index("by_threadId", ["threadId"]),

  // Verified inbound AgentMail messages. "unrouted" rows carry no tenant ids and are never shown to tenants.
  inboundEmails: defineTable({
    eventId: v.string(),
    messageId: v.string(),
    inboxId: v.string(),
    threadId: v.string(),
    from: v.string(), // lowercased address
    fromName: v.optional(v.string()),
    subject: v.string(),
    text: v.string(),
    inReplyTo: v.optional(v.string()),
    routing: v.union(v.literal("routed"), v.literal("triage"), v.literal("unrouted")),
    matchMethod: v.optional(v.union(v.literal("thread"), v.literal("token"))),
    projectId: v.optional(v.id("projects")),
    companyId: v.optional(v.id("companies")),
    tradePackageId: v.optional(v.id("tradePackages")),
    contractorId: v.optional(v.id("contractors")),
    attachments: v.optional(v.array(v.any())),
    receivedAt: v.number(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_messageId", ["messageId"])
    .index("by_routing", ["routing"])
    .index("by_tradePackageId", ["tradePackageId"]),

  // GC-managed authorization of AgentID billing agents to act for a sub.
  agentLinks: defineTable({
    agentEmail: v.string(), // lowercased
    contractorId: v.id("contractors"),
    // Contractor name when the link was made, so the list stays readable after the contractor row is gone.
    contractorName: v.optional(v.string()),
    agreementId: v.optional(v.id("agreements")),
    status: v.union(v.literal("active"), v.literal("revoked")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    revokedBy: v.optional(v.id("users")),
    revokedAt: v.optional(v.number()),
    // GC company that created the link, and the sub company of the linked contractor.
    gcCompanyId: v.optional(v.id("companies")),
    subCompanyId: v.optional(v.id("companies")),
  })
    .index("by_agentEmail_and_status", ["agentEmail", "status"])
    .index("by_contractorId", ["contractorId"])
    .index("by_gcCompanyId", ["gcCompanyId"]),

  // Schedule of values; lines sum exactly to the agreement contract sum.
  scheduleOfValues: defineTable({
    agreementId: v.id("agreements"),
    lineNo: v.number(),
    description: v.string(),
    csiCode: v.optional(v.string()),
    scheduledValueCents: v.number(),
    excludedScope: v.boolean(),
    sourceBidLineRef: v.optional(v.string()),
    // Canonical JSON of the award inputs the SOV and milestones were generated from.
    sourceFingerprint: v.optional(v.string()),
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
    review: v.optional(payAppReviewValidator),
    // The GC's final approved split, which billing math uses; review.lines keeps the recommendation.
    finalApproval: v.optional(
      v.object({
        totalCents: v.number(),
        lines: v.array(v.object({ sovLineId: v.id("scheduleOfValues"), approvedCents: v.number() })),
        approvedBy: v.id("users"),
        approvedAt: v.number(),
      }),
    ),
    rejectedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    withdrawnAt: v.optional(v.number()),
    // The agreement's contractor, copied at submission so the sub portal can page one contractor's
    // pay apps newest first across all its agreements. Older rows: payApps/backfill.ts.
    contractorId: v.optional(v.id("contractors")),
    // The sub company the contractor was linked to at submission, so the sub portal can page all
    // of a company's pay apps with one index. Older rows: payApps/backfill.ts.
    subCompanyId: v.optional(v.id("companies")),
    // Set when the GC's one-click judge demo filed this pay app as a stand-in for the sub or its agent.
    judgeDemo: v.optional(v.object({ runId: v.id("judgeDemoRuns"), filedBy: v.string() })),
    createdAt: v.number(),
  })
    .index("by_agreementId", ["agreementId"])
    .index("by_agreementId_and_status", ["agreementId", "status"])
    .index("by_contractorId", ["contractorId"])
    .index("by_subCompanyId", ["subCompanyId"])
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
    // Who wrote the proposal: the pay agent's model, the code policy filling a required proposal the
    // model skipped, or a GC release started from the agreement ledger.
    source: v.optional(v.union(v.literal("agent"), v.literal("code_policy"), v.literal("gc_ledger"))),
    agentRunId: v.optional(v.string()),
    licenseStatus: v.optional(v.string()),
    licenseCheckId: v.optional(v.id("licenseChecks")),
    paypalCaptureId: v.optional(v.string()),
    captureStatus: v.optional(v.string()),
    overrideLicenseHold: v.optional(v.boolean()),
    executedAt: v.optional(v.number()),
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
    // Funding rows: one entry per capture against the authorization (requestKey dedupes retries).
    captures: v.optional(
      v.array(
        v.object({
          captureId: v.string(),
          amountCents: v.number(),
          requestKey: v.string(),
          finalCapture: v.boolean(),
          status: v.string(),
          releasePaymentId: v.optional(v.id("payments")),
          capturedAt: v.number(),
        }),
      ),
    ),
    // Payout rows: the funding payment whose capture paid for this release.
    fundingPaymentId: v.optional(v.id("payments")),
    // Payout rows: recipient snapshot at release time, and PayPal's raw item status (e.g. UNCLAIMED).
    receiverEmail: v.optional(v.string()),
    paypalItemStatus: v.optional(v.string()),
    // Payout rows: a "Retry payout" row points at the original release it re-sends (same capture).
    retryOfPaymentId: v.optional(v.id("payments")),
    // Funding rows: honor-period watcher state. PayPal allows one reauthorization per authorization.
    reauthorizationCount: v.optional(v.number()),
    reauthorizeAttempts: v.optional(v.number()),
    reauthorizedAt: v.optional(v.number()),
    previousAuthorizationIds: v.optional(v.array(v.string())),
    reauthorizeError: v.optional(v.string()),
    reauthorizeRetryAfter: v.optional(v.number()),
    expiredAt: v.optional(v.number()),
    // Funding rows: set before the remainder void is sent; new releases are refused while it is set.
    closingAt: v.optional(v.number()),
    idempotencyKey: v.string(),
    error: v.optional(v.string()),
    // False once any PayPal write for this payment succeeded but its auditLogs entry could not be stored.
    auditRecorded: v.optional(v.boolean()),
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
    recipientEmail: v.optional(v.string()),
    // Bumped when the project's owner changes before the invoice exists, so the PayPal create
    // request id changes and PayPal's idempotency cache cannot replay an invoice to the old owner.
    recipientRevision: v.optional(v.number()),
    paypalInvoiceStatus: v.optional(v.string()),
    error: v.optional(v.string()),
    auditRecorded: v.optional(v.boolean()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    invoicedAt: v.optional(v.number()),
    paidAt: v.optional(v.number()),
    statusCheckedAt: v.optional(v.number()),
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
    .index("by_resourceId", ["resourceId"])
    .index("by_receivedAt", ["receivedAt"]),

  // CSLB license lookups via KERNEL, cached 24h.
  licenseChecks: defineTable({
    contractorId: v.id("contractors"),
    licenseNumber: v.string(),
    state: v.literal("CA"),
    status: licenseStatusValidator,
    rawSummary: v.string(),
    liveViewUrl: v.optional(v.string()),
    /** Start time while running; completion time once done. */
    checkedAt: v.number(),
    /** "running" while the KERNEL browser is open. Rows without a phase are complete. */
    phase: v.optional(v.union(v.literal("running"), v.literal("done"))),
    startedAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    kernelSessionId: v.optional(v.string()),
    browserDeleted: v.optional(v.boolean()),
    trigger: v.optional(v.string()),
    /** Set by the internal clearLicenseCache helper; the row stays as history but is no longer reused. */
    cacheCleared: v.optional(v.boolean()),
  })
    .index("by_contractorId_and_checkedAt", ["contractorId", "checkedAt"])
    .index("by_contractorId_and_licenseNumber_and_checkedAt", ["contractorId", "licenseNumber", "checkedAt"]),

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
    // Owning GC company. Optional only until every writer sets it; the tenancy migration backfills it.
    gcCompanyId: v.optional(v.id("companies")),
    // Owner's name as typed by the GC, and the owner company once its contact accepts an invite.
    ownerName: v.optional(v.string()),
    ownerCompanyId: v.optional(v.id("companies")),
    // Archived projects stay readable by id but are hidden from project lists by default.
    archived: v.optional(v.boolean()),
    // §14 setup fields. Optional only because pre-wizard rows lack them; createProject requires them.
    address: v.optional(addressValidator),
    state: v.optional(v.string()),
    contractValueCents: v.optional(v.number()),
    retainageBps: v.optional(v.number()),
    billingDay: v.optional(v.number()),
    startDate: v.optional(v.string()),
    substantialCompletionDate: v.optional(v.string()),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"), v.literal("closed"))),
    createdAt: v.number(),
  })
    .index("by_demo", ["isDemoProject"])
    .index("by_gcCompanyId", ["gcCompanyId"]),

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
    // Existing contractors (discovered for another package) invited to bid on this one.
    invitedContractorIds: v.optional(v.array(v.id("contractors"))),
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
    // The sub company that operates this bidder record, once linked (invite accept or demo migration).
    linkedCompanyId: v.optional(v.id("companies")),
    vendorId: v.optional(v.id("vendors")),
  })
    .index("by_package", ["tradePackageId"])
    .index("by_linkedCompanyId", ["linkedCompanyId"]),

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
    .index("by_project", ["projectId"])
    .index("by_contractorId", ["contractorId"]),

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
    .index("by_package", ["tradePackageId"])
    .index("by_storageId", ["storageId"]),

  // One per generated upload URL: binds the stored object to the uploader, company and project,
  // so saveFileRecord only accepts storage ids the caller itself uploaded for that project.
  uploadIntents: defineTable({
    userId: v.id("users"),
    companyId: v.id("companies"),
    projectId: v.id("projects"),
    createdAt: v.number(),
    expiresAt: v.number(),
    storageId: v.optional(v.id("_storage")),
    usedAt: v.optional(v.number()),
  }).index("by_storageId", ["storageId"]),

  // Live Reactive Activity Audit Stream
  auditLogs: defineTable({
    // Optional because some PayPal writes (e.g. webhook signature checks) happen before a project is known.
    projectId: v.optional(v.id("projects")),
    tradePackageId: v.optional(v.id("tradePackages")),
    eventType: v.string(), // "rfq_dispatched" | "rfi_clarified" | "quote_received" | "bid_leveled" | "contract_awarded" | "file_uploaded" | "compliance_audit" | "cron_executed" | "paypal_write"
    title: v.string(),
    description: v.string(),
    actor: v.string(),
    timestamp: v.number(),
    // PayPal write metadata (never tokens, secrets or request bodies).
    operation: v.optional(v.string()),
    httpMethod: v.optional(v.string()),
    httpStatus: v.optional(v.number()),
    paypalRequestId: v.optional(v.string()),
    paypalDebugId: v.optional(v.string()),
    paypalResourceId: v.optional(v.string()),
    attempts: v.optional(v.number()),
    paypalOutcome: v.optional(v.union(v.literal("succeeded"), v.literal("failed"), v.literal("indeterminate"))),
    agreementId: v.optional(v.id("agreements")),
    // Set when a billing agent acted: its AgentID subject and email, and the owner it acts for.
    agentSub: v.optional(v.string()),
    agentEmail: v.optional(v.string()),
    ownerEmail: v.optional(v.string()),
    // Who acted (set for signed-in actions) and, for vendor-specific events, which contractor the
    // event concerns. Sub and owner companies only see entries carrying their own ids.
    actorUserId: v.optional(v.id("users")),
    actorCompanyId: v.optional(v.id("companies")),
    contractorId: v.optional(v.id("contractors")),
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
    // Set on non-bid-leveling suites (e.g. "pay_app_review"); the leveling metrics above are then 0.
    suite: v.optional(v.string()),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    fixtureScores: v.optional(
      v.array(
        v.object({
          fixtureId: v.string(),
          score: v.number(), // fraction of lines with the expected verdict
          passed: v.boolean(),
          provider: v.string(),
          model: v.string(),
          checks: v.array(v.string()),
        }),
      ),
    ),
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
    provider: v.string(), // "OpenAI" | "Anthropic" | "Vertex AI / Gemini" | "Offline rules engine"
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

  // One-click TradePulse Pay judge demo: one fresh agreement per run.
  judgeDemoRuns: defineTable({
    startedBy: v.id("users"),
    gcEmail: v.string(),
    projectId: v.id("projects"),
    agreementId: v.id("agreements"),
    agreementNumber: v.string(),
    honestPayAppId: v.optional(v.id("payApplications")),
    agentPayAppId: v.optional(v.id("payApplications")),
    createdAt: v.number(),
  }).index("by_startedBy", ["startedBy"]),

  // Sandbox-only CAPTURE orders that top up the platform account so retainage releases are covered
  // after PayPal capture fees. Not part of any agreement's money.
  sandboxTopUps: defineTable({
    paypalOrderId: v.string(),
    amountCents: v.number(),
    // "pending" = PayPal returned a PENDING capture; only "captured" (capture COMPLETED) funds the platform.
    status: v.union(v.literal("created"), v.literal("pending"), v.literal("captured"), v.literal("denied"), v.literal("failed")),
    approveUrl: v.optional(v.string()),
    paypalCaptureId: v.optional(v.string()),
    captureStatus: v.optional(v.string()),
    error: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    capturedAt: v.optional(v.number()),
  })
    .index("by_paypalOrderId", ["paypalOrderId"])
    .index("by_createdAt", ["createdAt"]),
});
