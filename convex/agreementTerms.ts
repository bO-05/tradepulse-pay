import { internalMutation, mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { agreementTermsValidator } from "./schema";
import { auditActor, requireDocScope } from "./lib/projectScope";
import { draftFromTerms, firstTermsError, stateName, termsFromDraft, validateAgreementTerms } from "./lib/agreementTerms";
import { legacyTermFields, projectPlace, refreshAgreementDocument, resolveAgreementTerms, termsContextFor } from "./lib/agreementDocument";

/**
 * Agreement terms for the Terms editor. The project's GC reads and edits them; the agreement's own
 * sub (and its linked billing agent) reads them; everyone else gets "Not found.".
 */
export const getAgreementTerms = query({
  args: { agreementId: v.id("agreements") },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "agreements", args.agreementId, { roles: ["gc", "sub"] });
    const agreement = access.doc;
    const project = access.project;
    const context = termsContextFor(agreement, project);
    const locked = agreement.status === "executed";
    const superseded = agreement.status === "superseded";
    return {
      agreementId: agreement._id,
      agreementNumber: agreement.agreementNumber,
      status: agreement.status,
      locked,
      superseded,
      canEdit: access.partyRole === "gc" && !locked && !superseded && project.archived !== true,
      terms: resolveAgreementTerms(agreement, project),
      context,
      projectStateName: stateName(context.projectState),
      contractText: agreement.contractText,
    };
  },
});

export const updateAgreementTerms = mutation({
  args: { agreementId: v.id("agreements"), terms: agreementTermsValidator },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "agreements", args.agreementId, { roles: ["gc"], write: true });
    const agreement = access.doc;
    if (agreement.status === "executed") {
      throw new ConvexError({ code: "TERMS_LOCKED", message: "Terms are locked after execution." });
    }
    if (agreement.status === "superseded") {
      throw new ConvexError({ code: "TERMS_LOCKED", message: "This agreement is superseded; its terms are read-only." });
    }
    const draft = draftFromTerms(args.terms);
    const errors = validateAgreementTerms(draft, termsContextFor(agreement, access.project));
    const first = firstTermsError(errors);
    if (first) throw new ConvexError({ code: "INVALID", field: first.field, message: first.message, fields: errors });
    const terms = termsFromDraft(draft);
    await refreshAgreementDocument(ctx, agreement._id, terms);
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      tradePackageId: agreement.tradePackageId,
      eventType: "compliance_audit",
      title: `Subcontract terms updated: ${agreement.agreementNumber}`,
      description: `Terms for ${agreement.agreementNumber} (${agreement.subcontractorName}) were updated before execution.`,
      ...auditActor(access),
      contractorId: agreement.contractorId,
      timestamp: Date.now(),
    });
    return resolveAgreementTerms((await ctx.db.get(agreement._id))!, access.project);
  },
});

/**
 * Idempotent backfill: stores resolved terms on agreements that predate per-agreement terms. Drafts
 * also get regenerated text; executed and superseded agreements keep the text they were recorded with.
 */
export const backfillAgreementTerms = internalMutation({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("agreements").paginate(args.paginationOpts);
    let updated = 0;
    for (const agreement of page.page) {
      if (agreement.terms && agreement.terms.governingState) continue;
      const project = await ctx.db.get(agreement.projectId);
      if (!project) continue;
      if (agreement.terms) {
        const state = projectPlace(project).state;
        if (!state) continue;
        await ctx.db.patch(agreement._id, { terms: { ...agreement.terms, governingState: state } });
        updated += 1;
        continue;
      }
      if (agreement.status === "generated") {
        await refreshAgreementDocument(ctx, agreement._id);
      } else {
        const terms = resolveAgreementTerms(agreement, project);
        await ctx.db.patch(agreement._id, { terms, ...legacyTermFields(terms) });
      }
      updated += 1;
    }
    return { updated, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
