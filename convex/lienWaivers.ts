import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { auditActor, findDocScope, requireDocScope } from "./lib/projectScope";
import { findActiveMembership, notFound } from "./lib/tenancy";
import { isReadOnlyReference } from "./lib/demoReference";
import {
  LIEN_WAIVER_DISCLAIMER,
  loadWaiverGateState,
  NO_CURRENT_AMOUNT_MESSAGE,
  payAppLabel,
  type WaiverSlot,
} from "./lib/lienWaivers";
import { formatCents } from "./lib/money";
import { notify } from "./lib/notify";
import { EVIDENCE_MAX_AGE_MS } from "./lib/waiverEvidence";
import { payAppHash } from "./payApps/g703";

const SIGNER_TITLE_MAX = 120;
const NOTE_MAX = 500;

function invalid(message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "INVALID_WAIVER", message });
}

function cleanText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`Keep this under ${max} characters.`);
  return trimmed.length === 0 ? undefined : trimmed;
}

function signedView(w: Doc<"lienWaivers"> | null) {
  if (w === null) return null;
  return {
    waiverId: w._id,
    signedByName: w.signedByName,
    signerTitle: w.signerTitle ?? null,
    signedAt: w.signedAt,
    note: w.note ?? null,
    amountCents: w.amountCents,
    throughDate: w.throughDate,
    supersededAt: w.supersededAt ?? null,
    supersededByWaiverId: w.supersededByWaiverId ?? null,
  };
}

/** A signature only satisfies its slot when it covers the slot's current amount. */
function waiverMatches(signed: { amountCents: number } | null, amountCents: number): boolean {
  return signed !== null && signed.amountCents === amountCents;
}

function slotView(s: WaiverSlot) {
  return {
    payAppId: s.payAppId,
    label: s.label,
    amountCents: s.amountCents,
    throughDate: s.throughDate,
    signed: signedView(s.signed),
  };
}

/** The GC's opt-in switch, for the agreement page. Null for every other party. */
export const agreementGate = query({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const scope = await findDocScope(ctx, "agreements", args.agreementId);
    if (scope === null || scope.partyRole !== "gc") return null;
    const membership = await findActiveMembership(ctx, scope.viewer.userId);
    const gate = scope.doc.lienWaiverGate;
    return {
      enabled: gate?.enabled === true,
      requirePriorUnconditional: gate?.requirePriorUnconditional ?? true,
      enabledAt: gate?.enabledAt ?? null,
      enabledByName: gate?.enabledByName ?? null,
      canManage:
        membership?.role === "admin" &&
        membership.companyId === scope.company?._id &&
        !isReadOnlyReference(scope.project) &&
        scope.project.archived !== true &&
        scope.viewer.user.emailVerificationTime !== undefined,
      disclaimer: LIEN_WAIVER_DISCLAIMER,
    };
  },
});

/** Turns the per-agreement lien-waiver gate on or off. Any change is audited. */
export const setGate = mutation({
  args: {
    agreementId: v.string(),
    enabled: v.boolean(),
    requirePriorUnconditional: v.optional(v.boolean()),
    /** Shown to the sub when the GC turns the gate off. */
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "agreements", args.agreementId, { roles: ["gc"], write: true });
    const membership = await findActiveMembership(ctx, scope.viewer.userId);
    if (membership?.role !== "admin" || membership.companyId !== scope.company?._id) {
      throw new ConvexError({ code: "FORBIDDEN", message: "Forbidden: company admin required." });
    }
    const agreement = scope.doc;
    const now = Date.now();
    const reason = cleanText(args.reason, NOTE_MAX);
    const requirePrior = args.requirePriorUnconditional ?? agreement.lienWaiverGate?.requirePriorUnconditional ?? true;
    if (args.enabled) {
      const existing = agreement.lienWaiverGate;
      await ctx.db.patch(agreement._id, {
        lienWaiverGate:
          existing?.enabled === true
            ? { ...existing, requirePriorUnconditional: requirePrior }
            : {
                enabled: true,
                enabledAt: now,
                enabledByUserId: scope.viewer.userId,
                enabledByName: scope.user.name ?? scope.user.email ?? "GC admin",
                requirePriorUnconditional: requirePrior,
              },
      });
    } else if (agreement.lienWaiverGate !== undefined) {
      await ctx.db.patch(agreement._id, { lienWaiverGate: undefined });
    }
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      agreementId: agreement._id,
      eventType: args.enabled ? "lien_waiver_gate_enabled" : "lien_waiver_gate_disabled",
      title: args.enabled ? "Lien-waiver gate enabled" : "Lien-waiver gate disabled",
      description: args.enabled
        ? `${agreement.agreementNumber}: payouts now require a signed conditional waiver${requirePrior ? " and an unconditional waiver for the prior payment" : ""}.`
        : `${agreement.agreementNumber}: payouts no longer require a lien-waiver signature.${reason !== undefined ? ` Reason: ${reason}` : ""}`,
      ...auditActor(scope),
      timestamp: now,
    });
    // A gate the sub relies on is never turned off silently: tell the sub's company.
    if (!args.enabled) {
      const contractor = await ctx.db.get(agreement.contractorId);
      const anyPayApp = await ctx.db
        .query("payApplications")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreement._id))
        .order("desc")
        .first();
      const subCompanyId = contractor?.linkedCompanyId ?? anyPayApp?.subCompanyId;
      if (subCompanyId !== undefined) {
        await notify(
          ctx,
          { companyId: subCompanyId },
          {
            kind: "lien_waiver_gate_disabled",
            title: `Lien-waiver requirement turned off on ${agreement.agreementNumber}`,
            body: `${scope.user.name ?? scope.user.email ?? "The GC admin"} turned off the lien-waiver gate. Payouts no longer wait for a waiver signature; signatures already recorded stay in the audit log.${reason !== undefined ? ` Reason: ${reason}` : ""}`,
            link: anyPayApp !== null ? payAppHash(anyPayApp._id) : "#/payments",
            projectId: agreement.projectId,
          },
        );
      }
    }
    return { enabled: args.enabled, requirePriorUnconditional: args.enabled ? requirePrior : false };
  },
});

/** What the pay-app page needs to show or collect the two waivers. Null when the gate is off. */
export const payAppState = query({
  args: { payAppId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["gc", "sub"] });
    const payApp = scope.doc;
    const agreement = await ctx.db.get(payApp.agreementId);
    if (agreement === null) throw notFound();
    const state = await loadWaiverGateState(ctx, agreement, payApp);
    if (state === null) return null;
    const human = scope.viewer.user.actorType !== "agent";
    const writable =
      scope.partyRole === "sub" &&
      human &&
      !isReadOnlyReference(scope.project) &&
      scope.project.archived !== true &&
      scope.viewer.user.emailVerificationTime !== undefined;
    const signableStatus = payApp.status === "approved" || payApp.status === "approved_as_noted" || payApp.status === "paid";
    return {
      enabled: true,
      agreementNumber: agreement.agreementNumber,
      projectTitle: agreement.projectTitle,
      recipientName: agreement.generalContractorName,
      requirePriorUnconditional: state.requirePriorUnconditional,
      viewerRole: scope.partyRole,
      current: state.current === null ? null : slotView(state.current),
      prior: state.prior === null ? null : slotView(state.prior),
      canSignCurrent:
        writable &&
        signableStatus &&
        state.current !== null &&
        !waiverMatches(state.current.signed, state.current.amountCents),
      canSignPrior:
        writable &&
        state.requirePriorUnconditional &&
        state.prior !== null &&
        !waiverMatches(state.prior.signed, state.prior.amountCents),
      waitingForApproval: state.current === null,
      noAmountMessage: NO_CURRENT_AMOUNT_MESSAGE,
      disclaimer: LIEN_WAIVER_DISCLAIMER,
    };
  },
});

/**
 * The sub signs one waiver: the conditional waiver for this payment, or the unconditional waiver
 * for the prior paid payment. The amount and through-date come from the pay app on the server, so a
 * client cannot widen or narrow the waiver.
 */
export const signWaiver = mutation({
  args: {
    payAppId: v.string(),
    kind: v.union(v.literal("conditional"), v.literal("unconditional")),
    signedByName: v.string(),
    signerTitle: v.optional(v.string()),
    note: v.optional(v.string()),
    acknowledged: v.boolean(),
    /** B10: the evidence row recorded by the HTTP action for this exact statement. */
    evidenceId: v.id("waiverEvidence"),
  },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["sub"], write: true });
    const payApp = scope.doc;
    const agreement = await ctx.db.get(payApp.agreementId);
    if (agreement === null) throw notFound();
    const project = await ctx.db.get(agreement.projectId);
    if (project === null) throw notFound();
    if (scope.viewer.user.actorType === "agent") {
      throw invalid("A billing agent cannot sign a lien waiver; the subcontractor must sign it.");
    }
    if (agreement.lienWaiverGate?.enabled !== true) {
      throw invalid("The GC has not enabled the lien-waiver gate on this subcontract.");
    }
    if (!args.acknowledged) throw invalid("Confirm the waiver statement before signing.");
    const name = args.signedByName.trim();
    if (name.length < 2) throw invalid("Enter the full name of the person signing.");
    const title = cleanText(args.signerTitle, SIGNER_TITLE_MAX);
    const note = cleanText(args.note, NOTE_MAX);

    const state = await loadWaiverGateState(ctx, agreement, payApp);
    if (state === null) throw invalid("The GC has not enabled the lien-waiver gate on this subcontract.");
    let covers: Doc<"payApplications">;
    let amountCents: number;
    let throughDate: string;
    let existing: Doc<"lienWaivers"> | null;
    if (args.kind === "conditional") {
      if (state.current === null) throw invalid(NO_CURRENT_AMOUNT_MESSAGE);
      if (payApp.status !== "approved" && payApp.status !== "approved_as_noted" && payApp.status !== "paid") {
        throw invalid("The conditional waiver can be signed after the GC approves the payment.");
      }
      covers = payApp;
      amountCents = state.current.amountCents;
      throughDate = state.current.throughDate;
      existing = state.current.signed;
    } else {
      if (!state.requirePriorUnconditional || state.prior === null) {
        throw invalid("There is no prior paid payment that needs an unconditional waiver.");
      }
      const prior = await ctx.db.get(state.prior.payAppId);
      if (prior === null) throw notFound();
      covers = prior;
      amountCents = state.prior.amountCents;
      throughDate = state.prior.throughDate;
      existing = state.prior.signed;
    }
    if (existing !== null && existing.amountCents === amountCents) {
      return { waiverId: existing._id, alreadySigned: true, signedAt: existing.signedAt };
    }
    if (amountCents <= 0) throw invalid("The waiver amount is not available.");

    // B10: a signature is only recorded against evidence that was observed for this signer, this
    // pay app, this kind and this amount. The evidence row cannot be reused for another signature.
    const evidence = await ctx.db.get(args.evidenceId);
    if (evidence === null) throw invalid("The signing evidence is missing. Review the statement and sign again.");
    if (evidence.signedByUserId !== scope.viewer.userId) {
      throw invalid("The signing evidence was recorded for a different signer. Sign again.");
    }
    if (evidence.payAppId !== payApp._id || evidence.kind !== args.kind) {
      throw invalid("The signing evidence was recorded for a different waiver. Sign again.");
    }
    if (evidence.usedByWaiverId !== undefined) {
      throw invalid("The signing evidence was already used. Review the statement and sign again.");
    }
    if (evidence.observedAt === undefined) {
      throw invalid("The signing evidence was not recorded. Review the statement and sign again.");
    }
    if (evidence.amountCents !== amountCents || evidence.throughDate !== throughDate) {
      throw invalid("The amount or through date changed after the statement was issued. Review the new statement and sign again.");
    }
    if (evidence.signedByName !== name) {
      throw invalid("The signer name changed after the statement was issued. Review the statement and sign again.");
    }
    if (evidence.observedAt + EVIDENCE_MAX_AGE_MS < Date.now()) {
      throw invalid("The signing evidence expired. Review the statement and sign again.");
    }
    const now = Date.now();
    const waiverId = await ctx.db.insert("lienWaivers", {
      projectId: agreement.projectId,
      agreementId: agreement._id,
      payAppId: payApp._id,
      coversPayAppId: covers._id,
      kind: args.kind,
      recipientName: agreement.generalContractorName,
      amountCents,
      throughDate,
      signedByName: name,
      ...(title !== undefined ? { signerTitle: title } : {}),
      signedByUserId: scope.viewer.userId,
      signedAt: now,
      gateEnabledAt: agreement.lienWaiverGate.enabledAt,
      evidenceId: evidence._id,
      ...(note !== undefined ? { note } : {}),
    });
    await ctx.db.patch(evidence._id, { usedByWaiverId: waiverId });
    // A signature for a superseded amount is kept as evidence but can never be mistaken for the
    // live one; the replacement above is what the gate reads.
    if (existing !== null && existing.amountCents !== amountCents) {
      await ctx.db.patch(existing._id, { supersededAt: now, supersededByWaiverId: waiverId });
    }
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      agreementId: agreement._id,
      eventType: "waiver_signed",
      title: args.kind === "conditional" ? "Conditional lien waiver signed" : "Unconditional lien waiver signed",
      description: `${name} signed the ${args.kind} waiver for ${formatCents(amountCents)} through ${throughDate} (${
        args.kind === "conditional" ? `pay app ${payAppLabel(covers)}` : `prior pay app ${payAppLabel(covers)}`
      }), recipient ${agreement.generalContractorName}.${
        existing !== null
          ? ` This replaces the earlier signature for ${formatCents(existing.amountCents)}, which is kept as superseded.`
          : ""
      } Evidence: SHA-256 ${evidence.statementHash.slice(0, 16)}… over ${evidence.statementText.length} characters (${
        evidence.statementVersion
      }), recorded ${new Date(evidence.observedAt).toISOString()} from ${
        evidence.ipAddress !== undefined && evidence.ipAddress !== "" ? evidence.ipAddress : "an unavailable address"
      } (${evidence.ipSource ?? "unavailable"}), browser ${evidence.userAgent ?? "unknown"}.`,
      ...auditActor(scope),
      timestamp: now,
    });
    if (project.gcCompanyId !== undefined) {
      await notify(
        ctx,
        { companyId: project.gcCompanyId },
        {
          kind: "waiver_signed",
          title: `${agreement.subcontractorName} signed the ${args.kind} lien waiver for ${formatCents(amountCents)}`,
          body: `${agreement.agreementNumber} · ${project.title}. ${LIEN_WAIVER_DISCLAIMER}`,
          link: payAppHash(payApp._id),
          projectId: project._id,
        },
      );
    }
    return { waiverId, alreadySigned: false, signedAt: now };
  },
});
