import { ConvexError, v } from "convex/values";
import { mutation } from "../_generated/server";
import { auditActor, requireDocScope } from "../lib/projectScope";
import { findActiveMembership, notFound } from "../lib/tenancy";
import { complianceHoldFor, OVERRIDE_REASON_MAX } from "./hold";

export const ADMIN_ONLY_MESSAGE = "Only company admins can override";

/**
 * A GC company admin lifts the compliance payment hold for one pay app with a required reason
 * (architecture §17). Members of the GC company, subs, billing agents and owners cannot. The
 * override is audit-logged and shown on the pay app; other pay apps stay on hold, and every other
 * pay gate still applies.
 */
export const overrideComplianceHold = mutation({
  args: { payAppId: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "payApplications", args.payAppId, { roles: ["gc"], write: true });
    if (scope.company === null) throw notFound();
    const membership = await findActiveMembership(ctx, scope.user._id);
    if (membership === null || membership.companyId !== scope.company._id || membership.role !== "admin") {
      throw new ConvexError({ code: "FORBIDDEN", message: `${ADMIN_ONLY_MESSAGE}.` });
    }
    const reason = args.reason.trim();
    if (reason === "") throw new ConvexError({ code: "INVALID", message: "Enter a reason for the override." });
    if (reason.length > OVERRIDE_REASON_MAX) {
      throw new ConvexError({ code: "INVALID", message: `The reason must be ${OVERRIDE_REASON_MAX} characters or fewer.` });
    }
    const payApp = scope.doc;
    if (payApp.complianceOverride !== undefined) {
      throw new ConvexError({ code: "ALREADY_OVERRIDDEN", message: "The compliance hold on this pay app is already overridden." });
    }
    if (payApp.status === "paid") throw new ConvexError({ code: "ALREADY_PAID", message: "This pay app is already paid." });
    const agreement = await ctx.db.get(payApp.agreementId);
    if (agreement === null) throw notFound();
    const hold = await complianceHoldFor(ctx, agreement);
    if (hold.holdMessage === null) {
      throw new ConvexError({ code: "NO_HOLD", message: "This pay app has no compliance hold to override." });
    }
    const actor = auditActor(scope);
    const at = Date.now();
    await ctx.db.patch(payApp._id, {
      complianceOverride: { byUserId: scope.user._id, byName: actor.actor, reason, at, holdMessage: hold.holdMessage },
    });
    const label = payApp.applicationNo !== undefined ? `pay app #${payApp.applicationNo}` : `pay app "${payApp.periodLabel}"`;
    await ctx.db.insert("auditLogs", {
      projectId: agreement.projectId,
      agreementId: agreement._id,
      eventType: "compliance_override",
      title: `Compliance hold overridden on ${label} for ${agreement.subcontractorName}`,
      description: `${actor.actor} overrode the compliance hold on ${label} (${payApp._id}) at ${new Date(at).toISOString()}. Hold: ${hold.holdMessage}. Reason: ${reason}`,
      ...actor,
      timestamp: at,
    });
    return { overriddenAt: at };
  },
});
