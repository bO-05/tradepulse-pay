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
    const outcome = entry.ok ? "succeeded" : `failed${entry.errorName ? ` (${entry.errorName})` : ""}`;
    const parts = [
      `${entry.method} ${entry.path} -> HTTP ${entry.status}`,
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
    });
  },
});
