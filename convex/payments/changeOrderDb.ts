import { ConvexError, v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { invoiceRecipientForProject } from "./changeOrderRecipient";
import {
  canMoveChangeOrder,
  changeOrderLabel,
  changeOrderScopeOf,
  changeOrderStatusFromInvoice,
  type ChangeOrderStatus,
} from "./changeOrderMath";

/**
 * Invoice bookkeeping for the legacy "Invoice now" on approved prime change orders (architecture §16):
 * the PayPal invoice to the project owner's billing email and the status it reports back.
 */

const beginInvoiceResult = v.union(
  v.object({
    state: v.literal("done"),
    status: v.string(),
    paypalInvoiceId: v.optional(v.string()),
    payerViewUrl: v.optional(v.string()),
  }),
  v.object({
    state: v.literal("ready"),
    paypalInvoiceId: v.optional(v.string()),
    createRequestSuffix: v.string(),
    projectId: v.id("projects"),
    agreementId: v.union(v.id("agreements"), v.null()),
    input: v.object({
      label: v.string(),
      title: v.string(),
      description: v.string(),
      amountCents: v.number(),
      recipientEmail: v.string(),
      projectTitle: v.string(),
      agreementNumber: v.union(v.string(), v.null()),
    }),
  }),
);
export type BeginInvoice = Infer<typeof beginInvoiceResult>;

/** Fixes the invoice recipient on the row and returns what the action needs to create or resume the invoice. */
export const beginInvoice = internalMutation({
  args: { changeOrderId: v.id("changeOrders") },
  returns: beginInvoiceResult,
  handler: async (ctx, { changeOrderId }): Promise<BeginInvoice> => {
    const co = await ctx.db.get(changeOrderId);
    if (co === null) throw new ConvexError({ code: "NOT_FOUND", message: "Change order not found." });
    if (changeOrderScopeOf(co) !== "prime") {
      throw new ConvexError({
        code: "NOT_INVOICEABLE",
        message: "Only prime change orders approved by the owner are invoiced. Subcontract change orders are billed through pay apps.",
      });
    }
    if (co.status === "invoiced" || co.status === "paid" || co.status === "cancelled") {
      return { state: "done", status: co.status, paypalInvoiceId: co.paypalInvoiceId, payerViewUrl: co.payerViewUrl };
    }
    if (co.status !== "approved") {
      throw new ConvexError({
        code: "NOT_INVOICEABLE",
        message: `${changeOrderLabel(co.number, "prime")} is ${co.status}; only a change order the owner approved can be invoiced.`,
      });
    }
    if (co.amountCents <= 0) {
      throw new ConvexError({ code: "NOT_INVOICEABLE", message: "A deductive change order is credited, not invoiced." });
    }
    const agreement = co.agreementId ? await ctx.db.get(co.agreementId) : null;
    const projectId = co.projectId ?? agreement?.projectId;
    const project = projectId ? await ctx.db.get(projectId) : null;
    if (project === null) throw new ConvexError({ code: "NOT_FOUND", message: "Project not found." });
    // A cached recipient is never trusted on its own: the owner may have been removed or replaced
    // since the last attempt, so every attempt re-resolves the project's current owner.
    const recipient = await invoiceRecipientForProject(ctx, project._id);
    if (!recipient.ok) {
      await ctx.db.patch(changeOrderId, { error: recipient.reason });
      throw new ConvexError({ code: "NO_OWNER_EMAIL", message: recipient.reason });
    }
    const recipientEmail = recipient.email;
    const cached = co.recipientEmail;
    const recipientChanged = cached !== undefined && cached.toLowerCase() !== recipientEmail.toLowerCase();
    if (recipientChanged && co.paypalInvoiceId !== undefined) {
      const reason =
        "The PayPal invoice draft for this change order is addressed to a previous project owner, so it was not sent. Create a new change order to invoice the current owner.";
      await ctx.db.patch(changeOrderId, { error: reason });
      throw new ConvexError({ code: "OWNER_CHANGED", message: reason });
    }
    if (cached !== recipientEmail) {
      await ctx.db.patch(changeOrderId, {
        recipientEmail,
        ...(recipientChanged ? { recipientRevision: (co.recipientRevision ?? 0) + 1 } : {}),
      });
    }
    const revision = recipientChanged ? (co.recipientRevision ?? 0) + 1 : (co.recipientRevision ?? 0);
    return {
      state: "ready",
      paypalInvoiceId: co.paypalInvoiceId,
      createRequestSuffix: revision > 0 ? `_r${revision}` : "",
      projectId: project._id,
      agreementId: agreement?._id ?? null,
      input: {
        label: changeOrderLabel(co.number, "prime"),
        title: co.title ?? co.description,
        description: co.title === undefined ? "" : co.description,
        amountCents: co.amountCents,
        recipientEmail,
        projectTitle: project.title,
        agreementNumber: agreement?.agreementNumber ?? null,
      },
    };
  },
});

function mergeAudit(co: Doc<"changeOrders">, auditRecorded: boolean): boolean {
  return (co.auditRecorded ?? true) && auditRecorded;
}

export const recordInvoiceCreated = internalMutation({
  args: { changeOrderId: v.id("changeOrders"), paypalInvoiceId: v.string(), auditRecorded: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const co = await ctx.db.get(args.changeOrderId);
    if (co === null) return null;
    await ctx.db.patch(args.changeOrderId, {
      paypalInvoiceId: args.paypalInvoiceId,
      paypalInvoiceStatus: "DRAFT",
      auditRecorded: mergeAudit(co, args.auditRecorded),
    });
    return null;
  },
});

export const recordInvoiceSent = internalMutation({
  args: {
    changeOrderId: v.id("changeOrders"),
    payerViewUrl: v.string(),
    paypalInvoiceStatus: v.string(),
    auditRecorded: v.boolean(),
  },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    const co = await ctx.db.get(args.changeOrderId);
    if (co === null) throw new ConvexError({ code: "NOT_FOUND", message: "Change order not found." });
    const now = Date.now();
    const implied = changeOrderStatusFromInvoice(args.paypalInvoiceStatus);
    const status: ChangeOrderStatus = implied === "paid" || implied === "cancelled" ? implied : "invoiced";
    const next = canMoveChangeOrder(co.status, status) ? status : co.status;
    await ctx.db.patch(args.changeOrderId, {
      status: next,
      payerViewUrl: args.payerViewUrl,
      paypalInvoiceStatus: args.paypalInvoiceStatus,
      auditRecorded: mergeAudit(co, args.auditRecorded),
      invoicedAt: co.invoicedAt ?? now,
      statusCheckedAt: now,
      error: undefined,
      ...(next === "paid" && co.paidAt === undefined ? { paidAt: now } : {}),
    });
    return { status: next };
  },
});

export const recordInvoiceError = internalMutation({
  args: { changeOrderId: v.id("changeOrders"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const co = await ctx.db.get(args.changeOrderId);
    if (co !== null) await ctx.db.patch(args.changeOrderId, { error: args.error });
    return null;
  },
});

/**
 * Applies a PayPal invoice status to its change order. Shared by "Refresh status" and the
 * INVOICING.INVOICE.* webhook handler; replays and stale statuses never move a change order backwards.
 */
export async function applyInvoiceStatusTo(
  ctx: MutationCtx,
  co: Doc<"changeOrders">,
  paypalInvoiceStatus: string,
): Promise<{ status: ChangeOrderStatus; changed: boolean }> {
  const implied = changeOrderStatusFromInvoice(paypalInvoiceStatus);
  const now = Date.now();
  const changed = implied !== null && canMoveChangeOrder(co.status, implied);
  const status = changed ? implied : co.status;
  await ctx.db.patch(co._id, {
    status,
    paypalInvoiceStatus,
    statusCheckedAt: now,
    ...(status === "paid" && co.paidAt === undefined ? { paidAt: now } : {}),
  });
  return { status, changed };
}

const applyResult = v.object({
  changeOrderId: v.union(v.id("changeOrders"), v.null()),
  status: v.union(v.string(), v.null()),
  changed: v.boolean(),
});

export const applyInvoiceStatus = internalMutation({
  args: {
    changeOrderId: v.optional(v.id("changeOrders")),
    paypalInvoiceId: v.optional(v.string()),
    paypalInvoiceStatus: v.string(),
  },
  returns: applyResult,
  handler: async (ctx, args) => {
    let co: Doc<"changeOrders"> | null = null;
    if (args.changeOrderId) co = await ctx.db.get(args.changeOrderId);
    else if (args.paypalInvoiceId) {
      const invoiceId = args.paypalInvoiceId;
      co = await ctx.db
        .query("changeOrders")
        .withIndex("by_paypalInvoiceId", (q) => q.eq("paypalInvoiceId", invoiceId))
        .first();
    }
    if (co === null) return { changeOrderId: null, status: null, changed: false };
    const out = await applyInvoiceStatusTo(ctx, co, args.paypalInvoiceStatus);
    return { changeOrderId: co._id, ...out };
  },
});

export const changeOrderRow = internalQuery({
  args: { changeOrderId: v.id("changeOrders") },
  handler: async (ctx, { changeOrderId }) => {
    const co = await ctx.db.get(changeOrderId);
    if (co === null) return null;
    const agreement = co.agreementId ? await ctx.db.get(co.agreementId) : null;
    return {
      _id: co._id,
      label: changeOrderLabel(co.number, changeOrderScopeOf(co)),
      status: co.status,
      amountCents: co.amountCents,
      paypalInvoiceId: co.paypalInvoiceId ?? null,
      agreementId: co.agreementId ?? null,
      projectId: co.projectId ?? agreement?.projectId ?? null,
    };
  },
});
