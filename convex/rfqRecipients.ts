/**
 * RFQ recipient review and per-bidder RFQ email status. The GC reviews the exact recipient list
 * (previewRfqRecipients) and confirms it; rfqActions only emails the bidders and addresses confirmed
 * there. Web-discovered addresses are never emailed until a GC member confirms or edits them.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { auditActor, requireDocScope } from "./lib/projectScope";
import { recipientAllowed } from "./lib/recipientAllowlist";
import { RFQ_INBOX } from "./lib/mailer";
import { generalContractorNameFor } from "./lib/gcCompanyName";
import { RFQ_PRE_REPLY_STATUSES, rfqRecipientState, rfqSubject, type RfqRecipientState } from "./lib/rfqEmail";
import { ensureRfqThreadRow } from "./inboundEmail";
import { validateEmail } from "./validation";
import { confirmVendorEmail } from "./lib/vendorDirectory";

const RECIPIENT_NOTES: Record<RfqRecipientState, string> = {
  ready: "Will be emailed.",
  already_sent: "RFQ already sent to this address; it will not be emailed again.",
  no_email: "No email address on file. Add one before sending.",
  email_unconfirmed: "Email not confirmed: this address came from web discovery. Confirm or edit it before sending.",
  blocked_recipient: "Not on this test deployment's recipient allowlist; the mailer will refuse it.",
};

/** The exact recipient list a GC reviews before any RFQ email goes out. */
export const previewRfqRecipients = query({
  args: { tradePackageId: v.id("tradePackages"), contractorIds: v.optional(v.array(v.id("contractors"))) },
  handler: async (ctx, args) => {
    const { doc: pkg, project, company } = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"] });
    const all = await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
      .take(200);
    const wanted = args.contractorIds ? new Set(args.contractorIds) : null;
    const rows = wanted ? all.filter((c) => wanted.has(c._id)) : all;
    const gcName = await generalContractorNameFor(ctx, project);
    return {
      fromInbox: RFQ_INBOX,
      isDemo: company?.isDemo === true,
      gcName,
      subjectPreview: rfqSubject({ gcName, projectTitle: project.title, csiDivision: pkg.csiDivision, tradeName: pkg.tradeName, ref: "XXXXXXXX" }),
      recipients: rows.map((c) => {
        const state = rfqRecipientState(c, (email) => recipientAllowed(email));
        return {
          contractorId: c._id,
          companyName: c.companyName,
          email: c.contactEmail.trim().toLowerCase(),
          state,
          note: RECIPIENT_NOTES[state],
          rfqEmailStatus: c.rfqEmailStatus ?? null,
        };
      }),
    };
  },
});

/** GC confirms a bidder's RFQ email (optionally correcting it). Required for web-discovered addresses. */
export const confirmBidderEmail = mutation({
  args: { contractorId: v.id("contractors"), email: v.string() },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "contractors", args.contractorId, { roles: ["gc"], write: true });
    const contractor = access.doc;
    const email = validateEmail(args.email).toLowerCase();
    const changed = email !== contractor.contactEmail.trim().toLowerCase();
    const now = Date.now();
    await ctx.db.patch(contractor._id, {
      contactEmail: email,
      emailConfirmedAt: now,
      emailConfirmedByUserId: access.user._id,
      updatedAt: now,
    });
    await confirmVendorEmail(ctx, contractor.vendorId, email);
    const pkg = await ctx.db.get(contractor.tradePackageId);
    if (pkg) {
      await ctx.db.insert("auditLogs", {
        projectId: pkg.projectId,
        tradePackageId: pkg._id,
        contractorId: contractor._id,
        eventType: "compliance_audit",
        title: changed ? `RFQ email changed: ${contractor.companyName}` : `RFQ email confirmed: ${contractor.companyName}`,
        description: changed
          ? `The RFQ email for ${contractor.companyName} was changed and confirmed by a GC member.`
          : `A GC member confirmed ${contractor.companyName}'s RFQ email address.`,
        ...auditActor(access),
        timestamp: now,
      });
    }
    return { email, changed };
  },
});

/** Inbound mail routed to this package (bidder threads and the GC's triage), newest first. GC only. */
export const listPackageMessages = query({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    const { doc: pkg, project } = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"] });
    const rows = await ctx.db
      .query("inboundEmails")
      .withIndex("by_tradePackageId", (q) => q.eq("tradePackageId", pkg._id))
      .order("desc")
      .take(200);
    return rows
      // Defense in depth: a row is shown only when its tenant ids match this package's project and company.
      .filter((r) => r.routing !== "unrouted" && r.projectId === project._id && r.companyId === project.gcCompanyId)
      .map((r) => ({
        id: r._id,
        routing: r.routing,
        matchMethod: r.matchMethod ?? null,
        contractorId: r.contractorId ?? null,
        from: r.from,
        fromName: r.fromName ?? null,
        subject: r.subject,
        excerpt: r.text.slice(0, 1200),
        receivedAt: r.receivedAt,
        lateReason: r.lateReason ?? null,
      }));
  },
});

type Prepared =
  | {
      action: "send";
      to: string;
      ref: string;
      threadRowId: Id<"emailThreads">;
      idempotencyKey: string;
      keyTs: number;
      content: {
        gcName: string;
        projectTitle: string;
        projectLocation: string;
        projectState?: string;
        csiDivision: string;
        tradeName: string;
        scopeSummary: string;
        mandatoryInclusions: string[];
        bidDeadline: string;
        bidderName: string;
      };
    }
  | { action: "skip"; status: Exclude<RfqRecipientState, "ready"> | "email_changed" | "not_in_package"; reason: string };

/**
 * Checks one confirmed recipient against the bidder's current record and reserves the RFQ thread
 * reference. Nothing visible changes here: the bidder's status is written only after the mailer answers.
 */
export const prepareRfqSend = internalMutation({
  args: { tradePackageId: v.id("tradePackages"), contractorId: v.id("contractors"), email: v.string() },
  handler: async (ctx, args): Promise<Prepared> => {
    const contractor = await ctx.db.get(args.contractorId);
    const pkg = await ctx.db.get(args.tradePackageId);
    if (!contractor || !pkg || contractor.tradePackageId !== pkg._id) {
      return { action: "skip", status: "not_in_package", reason: "This bidder is not on the package." };
    }
    const project = await ctx.db.get(pkg.projectId);
    if (!project) return { action: "skip", status: "not_in_package", reason: "This bidder is not on the package." };
    const to = contractor.contactEmail.trim().toLowerCase();
    if (to !== args.email.trim().toLowerCase()) {
      return { action: "skip", status: "email_changed", reason: "The email changed after you reviewed the list; review and confirm again." };
    }
    // The allowlist is enforced by the mailer so the refusal is recorded in emailOutbox.
    const state = rfqRecipientState(contractor, () => true);
    if (state !== "ready") return { action: "skip", status: state, reason: RECIPIENT_NOTES[state] };

    const thread = await ensureRfqThreadRow(ctx, { projectId: project._id, tradePackageId: pkg._id, contractorId: contractor._id });
    // Same address and no bounce: reuse the key, so a retry reconciles instead of sending twice.
    const reuseKey =
      contractor.rfqKeyTs !== undefined && contractor.rfqEmailTo === to && contractor.rfqEmailStatus !== "bounced";
    const keyTs = reuseKey ? contractor.rfqKeyTs! : Date.now();
    if (!reuseKey) await ctx.db.patch(contractor._id, { rfqKeyTs: keyTs, rfqEmailTo: to });
    return {
      action: "send",
      to,
      ref: thread.ref,
      threadRowId: thread.threadRowId,
      idempotencyKey: `rfq.${contractor._id}.${keyTs}`,
      keyTs,
      content: {
        gcName: await generalContractorNameFor(ctx, project),
        projectTitle: project.title,
        projectLocation: project.location,
        projectState: project.state ?? project.address?.state,
        csiDivision: pkg.csiDivision,
        tradeName: pkg.tradeName,
        scopeSummary: pkg.scopeSummary,
        mandatoryInclusions: pkg.mandatoryInclusions,
        bidDeadline: pkg.bidDeadline,
        bidderName: contractor.companyName,
      },
    };
  },
});

const outcomeStatus = v.union(
  v.literal("sent"),
  v.literal("failed"),
  v.literal("skipped_budget"),
  v.literal("blocked_recipient"),
  v.literal("not_sent"),
);

/** Writes the mailer's real outcome on the bidder. A bounce already recorded on the outbox row wins over "sent". */
export const recordRfqOutcome = internalMutation({
  args: {
    contractorId: v.id("contractors"),
    to: v.string(),
    status: outcomeStatus,
    error: v.optional(v.string()),
    outboxId: v.optional(v.id("emailOutbox")),
    ref: v.optional(v.string()),
    threadId: v.optional(v.string()),
    /** rfqKeyTs of the send this outcome belongs to. */
    attemptKeyTs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const contractor = await ctx.db.get(args.contractorId);
    if (!contractor) return null;
    let status: Doc<"contractors">["rfqEmailStatus"] = args.status;
    let error = args.error;
    if (args.outboxId) {
      const row = await ctx.db.get(args.outboxId);
      if (row?.status === "delivery_failed") {
        status = row.deliveryEvent === "bounced" ? "bounced" : "failed";
        error = row.error ?? error;
      }
    }
    const demo = status === "not_sent";
    const now = Date.now();
    // The bidder can reply (by token) while this send is still awaiting AgentMail. A reply to the same
    // address recorded after this attempt began proves receipt, so its late outcome must not downgrade it.
    const repliedToThisAttempt =
      contractor.rfqEmailStatus === "replied" &&
      contractor.rfqEmailTo === args.to &&
      contractor.rfqRepliedAt !== undefined &&
      (args.attemptKeyTs === undefined || contractor.rfqRepliedAt >= args.attemptKeyTs);
    if (repliedToThisAttempt) {
      await ctx.db.patch(contractor._id, {
        ...(args.outboxId ? { rfqOutboxId: args.outboxId } : {}),
        ...(args.ref ? { rfqRef: args.ref } : {}),
        ...(args.threadId ? { rfqThreadId: args.threadId } : {}),
        ...(status === "sent" ? { rfqSentAt: now, dispatchedAt: now } : {}),
      });
      const pkg = await ctx.db.get(contractor.tradePackageId);
      if (pkg && pkg.status === "draft") await ctx.db.patch(pkg._id, { status: "rfqs_dispatched" });
      return { status };
    }
    await ctx.db.patch(contractor._id, {
      rfqEmailStatus: status,
      rfqEmailError: status === "sent" ? undefined : error,
      rfqEmailTo: args.to,
      ...(args.outboxId ? { rfqOutboxId: args.outboxId } : {}),
      ...(args.ref ? { rfqRef: args.ref } : {}),
      ...(args.threadId ? { rfqThreadId: args.threadId } : {}),
      ...(status === "sent" ? { rfqSentAt: now, dispatchedAt: now } : {}),
      // Demo companies send no email; their bidders keep the simulated "invited" stage.
      ...(RFQ_PRE_REPLY_STATUSES.has(contractor.rfqStatus) ? { rfqStatus: demo ? "invited" : status } : {}),
      ...(demo ? { dispatchedAt: now } : {}),
    });
    if (status === "sent" || demo) {
      const pkg = await ctx.db.get(contractor.tradePackageId);
      if (pkg && pkg.status === "draft") await ctx.db.patch(pkg._id, { status: "rfqs_dispatched" });
    }
    return { status };
  },
});

export function assertRecipientList(recipients: { contractorId: Id<"contractors">; email: string }[]): void {
  if (recipients.length === 0) {
    throw new ConvexError({ code: "INVALID" as const, message: "Choose at least one bidder to email." });
  }
  if (recipients.length > 50) {
    throw new ConvexError({ code: "INVALID" as const, message: "Send to at most 50 bidders at a time." });
  }
}
