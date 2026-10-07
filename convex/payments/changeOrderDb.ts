import { ConvexError, v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery, query, type MutationCtx } from "../_generated/server";
import { requireRole } from "../lib/roles";
import { canMoveChangeOrder, changeOrderLabel, changeOrderStatusFromInvoice, type ChangeOrderStatus } from "./changeOrderMath";

const MAX_DESCRIPTION = 1000;

export function changeOrderView(co: Doc<"changeOrders">, agreement: Doc<"agreements"> | null) {
  return {
    _id: co._id,
    agreementId: co.agreementId,
    agreementNumber: agreement?.agreementNumber ?? null,
    number: co.number,
    label: changeOrderLabel(co.number),
    description: co.description,
    amountCents: co.amountCents,
    status: co.status,
    paypalInvoiceId: co.paypalInvoiceId ?? null,
    paypalInvoiceStatus: co.paypalInvoiceStatus ?? null,
    payerViewUrl: co.payerViewUrl ?? null,
    recipientEmail: co.recipientEmail ?? null,
    error: co.error ?? null,
    createdAt: co.createdAt,
    invoicedAt: co.invoicedAt ?? null,
    paidAt: co.paidAt ?? null,
    statusCheckedAt: co.statusCheckedAt ?? null,
  };
}
export type ChangeOrderView = ReturnType<typeof changeOrderView>;

/**
 * Change orders on one agreement for the GC and the Owner (the parties to the invoice). Subs get an
 * empty list. Returns null when the agreement does not exist.
 */
export const listForAgreement = query({
  args: { agreementId: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireRole(ctx, ["gc", "sub", "owner"]);
    const id = ctx.db.normalizeId("agreements", args.agreementId);
    if (id === null) return null;
    const agreement = await ctx.db.get(id);
    if (agreement === null) return null;
    if (viewer.role === "sub") return { canCreate: false, canRefresh: false, nextNumber: 1, changeOrders: [] };
    const rows = await ctx.db
      .query("changeOrders")
      .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", id))
      .take(200);
    const isGc = viewer.role === "gc";
    return {
      canCreate: isGc,
      canRefresh: true,
      nextNumber: (rows.at(-1)?.number ?? 0) + 1,
      changeOrders: rows.filter((co) => isGc || co.status !== "draft").map((co) => changeOrderView(co, agreement)),
    };
  },
});

export const insertChangeOrder = internalMutation({
  args: {
    agreementId: v.id("agreements"),
    number: v.optional(v.number()),
    description: v.string(),
    amountCents: v.number(),
    createdBy: v.optional(v.id("users")),
  },
  returns: v.id("changeOrders"),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get(args.agreementId);
    if (agreement === null || agreement.status === "superseded") {
      throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });
    }
    const description = args.description.trim();
    if (description.length === 0) throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Describe the change order." });
    if (description.length > MAX_DESCRIPTION) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: `The description is limited to ${MAX_DESCRIPTION} characters.` });
    }
    if (!Number.isSafeInteger(args.amountCents)) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: "The change order amount must be whole cents." });
    }
    if (args.amountCents <= 0) throw new ConvexError({ code: "INVALID_ARGUMENT", message: "The change order amount must be greater than $0.00." });

    const last = await ctx.db
      .query("changeOrders")
      .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", args.agreementId))
      .order("desc")
      .first();
    const number = args.number ?? (last?.number ?? 0) + 1;
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: "The change order number must be a whole number of at least 1." });
    }
    const existing = await ctx.db
      .query("changeOrders")
      .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", args.agreementId).eq("number", number))
      .first();
    if (existing !== null) {
      throw new ConvexError({
        code: "DUPLICATE_CHANGE_ORDER",
        message: `${changeOrderLabel(number)} already exists on agreement ${agreement.agreementNumber}.`,
      });
    }
    return await ctx.db.insert("changeOrders", {
      agreementId: args.agreementId,
      number,
      description,
      amountCents: args.amountCents,
      status: "draft",
      createdBy: args.createdBy,
      createdAt: Date.now(),
    });
  },
});

async function ownerInvoiceEmail(ctx: MutationCtx): Promise<string | undefined> {
  const owners = await ctx.db
    .query("userProfiles")
    .withIndex("by_role", (q) => q.eq("role", "owner"))
    .take(20);
  const fromProfile = owners.find((p) => p.paypalEmail)?.paypalEmail?.trim();
  return fromProfile || process.env.PAYPAL_SANDBOX_OWNER_EMAIL?.trim() || undefined;
}

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
    projectId: v.id("projects"),
    agreementId: v.id("agreements"),
    input: v.object({
      number: v.number(),
      description: v.string(),
      amountCents: v.number(),
      recipientEmail: v.string(),
      agreementNumber: v.string(),
      projectTitle: v.string(),
      subcontractorName: v.string(),
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
    if (co.status !== "draft") {
      return { state: "done", status: co.status, paypalInvoiceId: co.paypalInvoiceId, payerViewUrl: co.payerViewUrl };
    }
    const agreement = await ctx.db.get(co.agreementId);
    if (agreement === null) throw new ConvexError({ code: "NOT_FOUND", message: "Agreement not found." });
    const recipientEmail = co.recipientEmail ?? (await ownerInvoiceEmail(ctx));
    if (!recipientEmail) {
      const message = "No Owner PayPal email is on file, so no invoice was created.";
      await ctx.db.patch(changeOrderId, { error: message });
      throw new ConvexError({ code: "NO_OWNER_EMAIL", message });
    }
    if (co.recipientEmail === undefined) await ctx.db.patch(changeOrderId, { recipientEmail });
    return {
      state: "ready",
      paypalInvoiceId: co.paypalInvoiceId,
      projectId: agreement.projectId,
      agreementId: agreement._id,
      input: {
        number: co.number,
        description: co.description,
        amountCents: co.amountCents,
        recipientEmail,
        agreementNumber: agreement.agreementNumber,
        projectTitle: agreement.projectTitle,
        subcontractorName: agreement.subcontractorName,
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
    const agreement = await ctx.db.get(co.agreementId);
    return { ...changeOrderView(co, agreement), projectId: agreement?.projectId ?? null };
  },
});
