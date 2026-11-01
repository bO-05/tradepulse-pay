import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { notify } from "../lib/notify";
import { formatIsoDate } from "../payApps/g703Math";
import { invoiceRecipientForProject } from "../payments/changeOrderRecipient";
import { canMoveOwnerPayApp, ownerStatusFromInvoice, type OwnerPayAppStatus } from "./ownerBillingMath";

/**
 * Approval and PayPal invoice bookkeeping for owner pay apps. The owner's approval is recorded first;
 * the invoice to the project owner company's billing email follows (ownerInvoices.ts) and can be
 * resumed with the same PayPal-Request-Id keys until it is sent.
 */

const GC_OWNER_BILLING_HASH = "#/billing/owner-billing";

async function notifyGc(
  ctx: MutationCtx,
  app: Doc<"ownerPayApps">,
  input: { kind: "owner_pay_app_approved" | "owner_pay_app_paid"; title: string; body: string },
): Promise<void> {
  const project = await ctx.db.get(app.projectId);
  if (project?.gcCompanyId === undefined) return;
  await notify(ctx, { companyId: project.gcCompanyId }, { ...input, link: GC_OWNER_BILLING_HASH, projectId: project._id });
}

/** Records the owner's approval of a submitted owner pay app. Repeat calls after approval change nothing. */
export const markApproved = internalMutation({
  args: { ownerPayAppId: v.id("ownerPayApps"), userId: v.id("users"), actor: v.string() },
  returns: v.object({ status: v.string(), alreadyApproved: v.boolean() }),
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.ownerPayAppId);
    if (app === null) throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });
    if (app.status === "approved" || app.status === "approved_invoiced" || app.status === "paid") {
      return { status: app.status, alreadyApproved: true };
    }
    if (app.status !== "submitted_to_owner") {
      throw new ConvexError({ code: "INVALID_STATE", message: "Only an owner pay app awaiting your review can be approved." });
    }
    const now = Date.now();
    await ctx.db.patch(app._id, {
      status: "approved",
      approvedAt: now,
      approvedBy: args.userId,
      updatedAt: now,
      history: [...app.history, { status: "approved", at: now, byUserId: args.userId, byName: args.actor }],
    });
    await ctx.db.insert("auditLogs", {
      projectId: app.projectId,
      eventType: "compliance_audit",
      title: `Owner approved owner pay app #${app.applicationNo}`,
      description: `Current payment due ${formatCents(app.figures.currentPaymentDueCents)}.`,
      actor: args.actor,
      actorUserId: args.userId,
      timestamp: now,
    });
    await notifyGc(ctx, app, {
      kind: "owner_pay_app_approved",
      title: `Owner approved owner pay app #${app.applicationNo} – ${formatCents(app.figures.currentPaymentDueCents)}`,
      body: `Application #${app.applicationNo} for the period ending ${formatIsoDate(app.periodEnd)} was approved by the owner.`,
    });
    return { status: "approved", alreadyApproved: false };
  },
});

const beginResult = v.union(
  v.object({ state: v.literal("done"), status: v.string(), paypalInvoiceId: v.optional(v.string()), payerViewUrl: v.optional(v.string()) }),
  v.object({
    state: v.literal("ready"),
    projectId: v.id("projects"),
    paypalInvoiceId: v.optional(v.string()),
    input: v.object({
      projectTitle: v.string(),
      applicationNo: v.number(),
      periodEndLabel: v.string(),
      amountCents: v.number(),
      recipientEmail: v.string(),
    }),
  }),
);
export type BeginOwnerInvoice = Infer<typeof beginResult>;

/** Fixes the recipient (the project owner company's billing email) and returns what the invoice action needs. */
export const beginInvoice = internalMutation({
  args: { ownerPayAppId: v.id("ownerPayApps") },
  returns: beginResult,
  handler: async (ctx, { ownerPayAppId }): Promise<BeginOwnerInvoice> => {
    const app = await ctx.db.get(ownerPayAppId);
    if (app === null) throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });
    if (app.status === "approved_invoiced" || app.status === "paid") {
      return { state: "done", status: app.status, paypalInvoiceId: app.paypalInvoiceId, payerViewUrl: app.payerViewUrl };
    }
    if (app.status !== "approved") {
      throw new ConvexError({ code: "NOT_INVOICEABLE", message: "Only an owner pay app the owner approved is invoiced." });
    }
    if (app.figures.currentPaymentDueCents <= 0) {
      return { state: "done", status: app.status, paypalInvoiceId: undefined, payerViewUrl: undefined };
    }
    const project = await ctx.db.get(app.projectId);
    if (project === null) throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });
    const recipient = await invoiceRecipientForProject(ctx, project._id);
    if (!recipient.ok) {
      await ctx.db.patch(app._id, { error: recipient.reason });
      throw new ConvexError({ code: "NO_OWNER_EMAIL", message: recipient.reason });
    }
    if (app.paypalInvoiceId !== undefined && app.recipientEmail !== undefined && app.recipientEmail.toLowerCase() !== recipient.email.toLowerCase()) {
      const reason = "The PayPal invoice draft for this owner pay app is addressed to a previous owner billing email, so it was not sent. Contact support to reissue it.";
      await ctx.db.patch(app._id, { error: reason });
      throw new ConvexError({ code: "OWNER_CHANGED", message: reason });
    }
    if (app.recipientEmail !== recipient.email) await ctx.db.patch(app._id, { recipientEmail: recipient.email });
    return {
      state: "ready",
      projectId: project._id,
      paypalInvoiceId: app.paypalInvoiceId,
      input: {
        projectTitle: project.title,
        applicationNo: app.applicationNo,
        periodEndLabel: formatIsoDate(app.periodEnd),
        amountCents: app.figures.currentPaymentDueCents,
        recipientEmail: recipient.email,
      },
    };
  },
});

function mergeAudit(app: Doc<"ownerPayApps">, auditRecorded: boolean): boolean {
  return (app.auditRecorded ?? true) && auditRecorded;
}

export const recordInvoiceCreated = internalMutation({
  args: { ownerPayAppId: v.id("ownerPayApps"), paypalInvoiceId: v.string(), auditRecorded: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.ownerPayAppId);
    if (app === null) return null;
    await ctx.db.patch(app._id, { paypalInvoiceId: args.paypalInvoiceId, paypalInvoiceStatus: "DRAFT", auditRecorded: mergeAudit(app, args.auditRecorded) });
    return null;
  },
});

async function applyStatus(ctx: MutationCtx, app: Doc<"ownerPayApps">, target: OwnerPayAppStatus | null, patch: Partial<Doc<"ownerPayApps">>) {
  const now = Date.now();
  const changed = target !== null && canMoveOwnerPayApp(app.status, target);
  const status = changed ? target : app.status;
  await ctx.db.patch(app._id, {
    ...patch,
    status,
    statusCheckedAt: now,
    updatedAt: now,
    ...(status === "approved_invoiced" || status === "paid" ? { invoicedAt: app.invoicedAt ?? now } : {}),
    ...(status === "paid" && app.paidAt === undefined ? { paidAt: now } : {}),
  });
  if (changed && status === "paid") {
    await notifyGc(ctx, app, {
      kind: "owner_pay_app_paid",
      title: `Owner paid owner pay app #${app.applicationNo} – ${formatCents(app.figures.currentPaymentDueCents)}`,
      body: `The PayPal invoice for application #${app.applicationNo} is paid.`,
    });
  }
  return { status, changed };
}

export const recordInvoiceSent = internalMutation({
  args: { ownerPayAppId: v.id("ownerPayApps"), payerViewUrl: v.string(), paypalInvoiceStatus: v.string(), auditRecorded: v.boolean() },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.ownerPayAppId);
    if (app === null) throw new ConvexError({ code: "NOT_FOUND", message: "Not found." });
    const implied = ownerStatusFromInvoice(args.paypalInvoiceStatus) ?? "approved_invoiced";
    const out = await applyStatus(ctx, app, implied, {
      payerViewUrl: args.payerViewUrl,
      paypalInvoiceStatus: args.paypalInvoiceStatus,
      auditRecorded: mergeAudit(app, args.auditRecorded),
      error: undefined,
    });
    return { status: out.status };
  },
});

export const recordInvoiceError = internalMutation({
  args: { ownerPayAppId: v.id("ownerPayApps"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.ownerPayAppId);
    if (app !== null) await ctx.db.patch(app._id, { error: args.error });
    return null;
  },
});

/**
 * Applies a PayPal invoice status to its owner pay app. Shared by "Refresh status" and the
 * INVOICING.INVOICE.* webhook; replays and stale statuses never move an owner pay app back.
 */
export async function applyOwnerInvoiceStatusTo(ctx: MutationCtx, app: Doc<"ownerPayApps">, paypalInvoiceStatus: string) {
  return await applyStatus(ctx, app, ownerStatusFromInvoice(paypalInvoiceStatus), { paypalInvoiceStatus });
}

export const applyInvoiceStatus = internalMutation({
  args: { ownerPayAppId: v.id("ownerPayApps"), paypalInvoiceStatus: v.string() },
  returns: v.object({ status: v.union(v.string(), v.null()), changed: v.boolean() }),
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.ownerPayAppId);
    if (app === null) return { status: null, changed: false };
    return await applyOwnerInvoiceStatusTo(ctx, app, args.paypalInvoiceStatus);
  },
});

export const ownerPayAppRow = internalQuery({
  args: { ownerPayAppId: v.id("ownerPayApps") },
  handler: async (ctx, { ownerPayAppId }) => {
    const app = await ctx.db.get(ownerPayAppId);
    if (app === null) return null;
    return {
      _id: app._id as Id<"ownerPayApps">,
      projectId: app.projectId,
      applicationNo: app.applicationNo,
      status: app.status,
      amountCents: app.figures.currentPaymentDueCents,
      paypalInvoiceId: app.paypalInvoiceId ?? null,
    };
  },
});
