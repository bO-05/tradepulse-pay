import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const paypalAuditEntryValidator = v.object({
  operation: v.string(),
  method: v.string(),
  path: v.string(),
  status: v.number(),
  ok: v.boolean(),
  attempts: v.number(),
  paypalRequestId: v.optional(v.string()),
  paypalDebugId: v.optional(v.string()),
  resourceId: v.optional(v.string()),
  errorName: v.optional(v.string()),
  outcome: v.optional(v.union(v.literal("succeeded"), v.literal("failed"), v.literal("indeterminate"))),
  via: v.union(v.literal("rest"), v.literal("sdk")),
});

/** Records one PayPal write in auditLogs. Callers must never pass tokens, secrets or request bodies. */
export const record = internalMutation({
  args: {
    entry: paypalAuditEntryValidator,
    actor: v.string(),
    projectId: v.optional(v.id("projects")),
    agreementId: v.optional(v.id("agreements")),
  },
  returns: v.id("auditLogs"),
  handler: async (ctx, { entry, actor, projectId, agreementId }) => {
    const indeterminate = entry.outcome === "indeterminate";
    const outcome = indeterminate
      ? `outcome unknown${entry.errorName ? ` (${entry.errorName})` : ""}`
      : entry.ok
        ? "succeeded"
        : `failed${entry.errorName ? ` (${entry.errorName})` : ""}`;
    const parts = [
      `${entry.method} ${entry.path} -> ${indeterminate ? "no readable response" : `HTTP ${entry.status}`}`,
      `attempts ${entry.attempts}`,
      entry.paypalRequestId ? `PayPal-Request-Id ${entry.paypalRequestId}` : undefined,
      entry.resourceId ? `resource ${entry.resourceId}` : undefined,
      entry.paypalDebugId ? `debug_id ${entry.paypalDebugId}` : undefined,
    ].filter((p): p is string => p !== undefined);
    return await ctx.db.insert("auditLogs", {
      projectId,
      agreementId,
      eventType: "paypal_write",
      title: `PayPal ${entry.operation} ${outcome}`,
      description: parts.join(" · "),
      actor,
      timestamp: Date.now(),
      operation: entry.operation,
      httpMethod: entry.method,
      httpStatus: entry.status,
      paypalRequestId: entry.paypalRequestId,
      paypalDebugId: entry.paypalDebugId,
      paypalResourceId: entry.resourceId,
      attempts: entry.attempts,
      paypalOutcome: entry.outcome ?? (entry.ok ? "succeeded" : "failed"),
    });
  },
});
