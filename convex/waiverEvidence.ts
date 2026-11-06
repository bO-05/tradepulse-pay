import { ConvexError, v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { requireDocScope } from "./lib/projectScope";
import { notFound } from "./lib/tenancy";
import { loadWaiverGateState, NO_CURRENT_AMOUNT_MESSAGE } from "./lib/lienWaivers";
import {
  EVIDENCE_TICKET_TTL_MS,
  IP_MAX_CHARS,
  STATEMENT_MAX_CHARS,
  USER_AGENT_MAX_CHARS,
} from "./lib/waiverEvidence";
import {
  randomToken,
  sha256Hex,
  WAIVER_STATEMENT_VERSION,
  waiverStatementText,
} from "./lib/waiverStatement";

/**
 * B10: signing evidence for a lien waiver.
 *
 * A waiver attestation is worth more when you can show exactly what was signed, from where, and
 * with which browser. Mutations never see request headers, so the evidence path is:
 *
 *   1. issueTicket (this file, authenticated): snapshots the amount, through date and signer, builds
 *      the statement text, and returns a 32-byte single-use ticket. Only the ticket's SHA-256 is stored.
 *   2. POST /api/waivers/evidence (convex/waiverEvidenceHttp.ts): reads x-forwarded-for and
 *      user-agent, hashes the statement the browser posted back, and records it against the ticket.
 *   3. signWaiver: refuses to write a waiver unless the evidence belongs to this signer, this pay app,
 *      this kind and this amount, and marks the evidence used.
 *
 * Anything weaker (a client-asserted IP, or a user id posted in the request body) would record
 * evidence the signer could forge, which is worse than recording none.
 */

/** How long a ticket stays redeemable and how long evidence stays fresh: see convex/lib/waiverEvidence.ts. */
const SIGNER_TITLE_MAX = 120;

function invalid(message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "INVALID_WAIVER_EVIDENCE", message });
}

function trimTo(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Snapshots the statement the sub is about to sign and returns a single-use ticket. The amount and
 * through date are read from the pay app, so the statement cannot be widened by the client.
 */
export const issueTicket = mutation({
  args: {
    payAppId: v.string(),
    kind: v.union(v.literal("conditional"), v.literal("unconditional"), v.literal("retainage")),
    signedByName: v.string(),
    signerTitle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["sub"], write: true });
    const payApp = scope.doc;
    const agreement = await ctx.db.get(payApp.agreementId);
    if (agreement === null) throw notFound();
    if (scope.viewer.user.actorType === "agent") {
      throw invalid("A billing agent cannot sign a lien waiver; the subcontractor must sign it.");
    }
    if (agreement.lienWaiverGate?.enabled !== true) {
      throw invalid("The GC has not enabled the lien-waiver gate on this subcontract.");
    }
    const name = args.signedByName.trim();
    if (name.length < 2) throw invalid("Enter the full name of the person signing.");
    if (args.signerTitle !== undefined && args.signerTitle.trim().length > SIGNER_TITLE_MAX) {
      throw invalid(`Keep the title under ${SIGNER_TITLE_MAX} characters.`);
    }
    const title = trimTo(args.signerTitle, SIGNER_TITLE_MAX);

    const state = await loadWaiverGateState(ctx, agreement, payApp);
    if (state === null) throw invalid("The GC has not enabled the lien-waiver gate on this subcontract.");
    let amountCents: number;
    let throughDate: string;
    if (args.kind === "conditional") {
      if (state.current === null) throw invalid(NO_CURRENT_AMOUNT_MESSAGE);
      if (payApp.status !== "approved" && payApp.status !== "approved_as_noted" && payApp.status !== "paid") {
        throw invalid("The conditional waiver can be signed after the GC approves the payment.");
      }
      amountCents = state.current.amountCents;
      throughDate = state.current.throughDate;
    } else if (args.kind === "retainage") {
      if (state.retainage === null) {
        throw invalid("There is no retainage to release yet: the final payment must be paid and retainage must still be held.");
      }
      amountCents = state.retainage.amountCents;
      throughDate = state.retainage.throughDate;
    } else {
      if (!state.requirePriorUnconditional || state.prior === null) {
        throw invalid("There is no prior paid payment that needs an unconditional waiver.");
      }
      amountCents = state.prior.amountCents;
      throughDate = state.prior.throughDate;
    }
    if (amountCents <= 0) throw invalid("The waiver amount is not available.");

    const statementText = waiverStatementText({
      kind: args.kind,
      projectTitle: agreement.projectTitle,
      agreementNumber: agreement.agreementNumber,
      recipientName: agreement.generalContractorName,
      amountCents,
      throughDate,
      signedByName: name,
      ...(title !== undefined ? { signerTitle: title } : {}),
    });
    if (statementText.length > STATEMENT_MAX_CHARS) {
      throw invalid("The waiver statement is longer than this record can store. Contact the GC.");
    }

    // The ticket is returned in the clear exactly once; only its hash is stored.
    const ticket = randomToken();
    const now = Date.now();
    const expiresAt = now + EVIDENCE_TICKET_TTL_MS;
    const evidenceId = await ctx.db.insert("waiverEvidence", {
      payAppId: payApp._id,
      agreementId: agreement._id,
      kind: args.kind,
      signedByUserId: scope.viewer.userId,
      signedByName: name,
      ...(title !== undefined ? { signerTitle: title } : {}),
      amountCents,
      throughDate,
      statementText,
      statementHash: await sha256Hex(statementText),
      statementVersion: WAIVER_STATEMENT_VERSION,
      ticketHash: await sha256Hex(ticket),
      issuedAt: now,
      expiresAt,
    });
    return {
      ticket,
      evidenceId,
      statementText,
      statementVersion: WAIVER_STATEMENT_VERSION,
      expiresAt,
      amountCents,
      throughDate,
    };
  },
});

/**
 * Called only by the HTTP action in convex/waiverEvidenceHttp.ts, which is where the request
 * headers come from. The action hashes the posted text; this mutation re-checks that it is the text
 * issued to this ticket, so a caller cannot swap the statement between the two steps.
 */
export const recordEvidence = internalMutation({
  args: {
    ticket: v.string(),
    statementText: v.string(),
    statementHash: v.string(),
    ipAddress: v.string(),
    ipSource: v.string(),
    userAgent: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.ticket.length < 20 || args.ticket.length > 128) {
      throw invalid("This signing session is not recognised. Start the signature again.");
    }
    const ticketHash = await sha256Hex(args.ticket);
    const row = await ctx.db
      .query("waiverEvidence")
      .withIndex("by_ticketHash", (q) => q.eq("ticketHash", ticketHash))
      .unique();
    const now = Date.now();
    if (row === null) throw invalid("This signing session is not recognised. Start the signature again.");
    if (row.usedByWaiverId !== undefined) {
      throw invalid("This signing session was already used. Start the signature again.");
    }
    if (row.expiresAt < now) throw invalid("This signing session expired. Start the signature again.");
    if (row.statementText !== args.statementText) {
      throw invalid("The statement changed after it was issued. Review it and sign again.");
    }
    if (row.statementHash !== args.statementHash) {
      throw invalid("The statement could not be verified. Review it and sign again.");
    }
    await ctx.db.patch(row._id, {
      observedAt: now,
      ipAddress: args.ipAddress.slice(0, IP_MAX_CHARS),
      ipSource: args.ipSource.slice(0, 32),
      userAgent: args.userAgent.slice(0, USER_AGENT_MAX_CHARS),
    });
    return { evidenceId: row._id, statementHash: row.statementHash, observedAt: now };
  },
});
