import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { formatCents } from "../lib/money";
import { APPROVED_PAY_APP_STATUSES } from "../payApps/validation";
import { invoiceRecipientForProject, type InvoiceRecipient } from "../payments/changeOrderRecipient";
import {
  CO_APPROVED_STATUSES,
  CO_CAPACITY,
  CO_CAPACITY_MESSAGE,
  changeOrderEditBlock,
  changeOrderLabel,
  changeOrderScopeOf,
  contractSumBreakdown,
  type ChangeOrderScope,
  type ChangeOrderStatus,
  type ContractSumBreakdown,
} from "../payments/changeOrderMath";
import { agreementContractSumCents } from "../payments/sov";

/**
 * Read side of change orders v2 (architecture §16, §22): row views with the caller's capabilities,
 * contract-sum breakdowns and the change-order summary of a pay app. Shared by the change-order
 * functions, the owner portal and the G702 view.
 */

export const CHANGE_ORDERS_HASH = "#/change-orders";

export type CoParty = "gc" | "sub" | "owner";

/** Which party drafted the change order: subcontract COs by the sub or the GC, prime COs always by the GC. */
export function requesterPartyOf(co: Doc<"changeOrders">): "gc" | "sub" {
  return co.requestedByParty ?? "gc";
}

/** Drafts are private to the party that drafts them; the other side sees a CO once it is submitted. */
export function visibleToParty(co: Doc<"changeOrders">, party: CoParty): boolean {
  const scope = changeOrderScopeOf(co);
  if (party === "owner" && scope !== "prime") return false;
  if (party === "sub" && scope === "prime") return false;
  if (co.status === "draft") return requesterPartyOf(co) === party;
  return true;
}

/** The party that decides a submitted change order: the GC for subcontract COs, the owner for prime COs. */
export function deciderOf(scope: ChangeOrderScope): CoParty {
  return scope === "prime" ? "owner" : "gc";
}

export type InvoiceControl = { show: boolean; enabled: boolean; reason: string | null };

/**
 * "Invoice now" for the GC on a prime change order: offered (enabled) only once the owner approved it
 * and the project's owner company has a billing email; with no owner it shows disabled with the reason.
 * A CO on a submitted owner pay app is billed there, so it shows disabled naming that application.
 */
export function invoiceControlFor(
  co: Doc<"changeOrders">,
  party: CoParty,
  recipient: InvoiceRecipient | null,
  ownerPayAppNo: number | null = null,
): InvoiceControl {
  const hidden = { show: false, enabled: false, reason: null };
  if (party !== "gc" || changeOrderScopeOf(co) !== "prime") return hidden;
  const open = co.status === "draft" || co.status === "submitted" || co.status === "approved";
  if (recipient !== null && !recipient.ok) return open ? { show: true, enabled: false, reason: recipient.reason } : hidden;
  if (co.status !== "approved") return hidden;
  if (co.amountCents <= 0) return { show: true, enabled: false, reason: "A deductive change order is credited, not invoiced." };
  if (ownerPayAppNo !== null && co.paypalInvoiceId === undefined) {
    return { show: true, enabled: false, reason: ownerPayAppBilledReason(co.number, ownerPayAppNo) };
  }
  return { show: true, enabled: recipient?.ok === true, reason: null };
}

export function ownerPayAppBilledReason(number: number, applicationNo: number): string {
  return `${changeOrderLabel(number, "prime")} is billed on owner pay app #${applicationNo}, so it can't also be invoiced with Invoice now.`;
}

/**
 * Prime change orders on an owner pay app the GC has submitted (at any later status), with the first
 * such application number. A draft that was never submitted reserves nothing.
 */
export async function changeOrdersOnSubmittedOwnerPayApps(ctx: QueryCtx, projectId: Id<"projects">): Promise<Map<string, number>> {
  const apps = await ctx.db
    .query("ownerPayApps")
    .withIndex("by_projectId_and_applicationNo", (q) => q.eq("projectId", projectId))
    .take(500);
  const out = new Map<string, number>();
  for (const app of apps) {
    const submitted = app.status !== "draft" || app.history.some((h) => h.status !== "draft");
    if (!submitted) continue;
    for (const line of app.lines) {
      if (line.kind === "change_order" && line.changeOrderId !== undefined && !out.has(line.changeOrderId)) out.set(line.changeOrderId, app.applicationNo);
    }
  }
  return out;
}

export function changeOrderRowView(
  co: Doc<"changeOrders">,
  opts: {
    party: CoParty;
    agreement: Doc<"agreements"> | null;
    recipient: InvoiceRecipient | null;
    sovLineNo?: number | null;
    linkedLabel?: string | null;
    ownerPayAppNo?: number | null;
  },
) {
  const scope = changeOrderScopeOf(co);
  const status = co.status as ChangeOrderStatus;
  const mine = requesterPartyOf(co) === opts.party;
  const decides = deciderOf(scope) === opts.party;
  const editBlock = changeOrderEditBlock(status);
  const prime = scope === "prime";
  const invoice = invoiceControlFor(co, opts.party, opts.recipient, opts.ownerPayAppNo ?? null);
  return {
    _id: co._id,
    scope,
    number: co.number,
    label: changeOrderLabel(co.number, scope),
    title: co.title ?? co.description,
    description: co.title === undefined ? "" : co.description,
    amountCents: co.amountCents,
    scheduleDays: co.scheduleDays ?? null,
    status,
    projectId: co.projectId ?? opts.agreement?.projectId ?? null,
    agreementId: co.agreementId ?? null,
    agreementNumber: opts.agreement?.agreementNumber ?? null,
    subcontractorName: scope === "subcontract" ? (opts.agreement?.subcontractorName ?? null) : null,
    requestedByParty: requesterPartyOf(co),
    rejectionReason: co.status === "rejected" ? (co.rejectionReason ?? null) : null,
    sovLineId: co.sovLineId ?? null,
    sovLineNo: opts.sovLineNo ?? null,
    linkedChangeOrderId: opts.party === "owner" ? null : (co.linkedChangeOrderId ?? null),
    linkedLabel: opts.party === "owner" ? null : (opts.linkedLabel ?? null),
    createdAt: co.createdAt,
    submittedAt: co.submittedAt ?? null,
    approvedAt: co.approvedAt ?? null,
    rejectedAt: co.rejectedAt ?? null,
    judgeDemoApproval: co.judgeDemo ? co.judgeDemo.approvedFor : null,
    // Invoice fields exist only on prime change orders (the legacy "Invoice now").
    paypalInvoiceId: prime ? (co.paypalInvoiceId ?? null) : null,
    paypalInvoiceStatus: prime ? (co.paypalInvoiceStatus ?? null) : null,
    payerViewUrl: prime ? (co.payerViewUrl ?? null) : null,
    recipientEmail: prime && opts.party === "gc" ? (co.recipientEmail ?? null) : null,
    error: prime && opts.party === "gc" ? (co.error ?? null) : null,
    invoicedAt: co.invoicedAt ?? null,
    paidAt: co.paidAt ?? null,
    editBlockedReason: editBlock,
    canEdit: mine && editBlock === null,
    canDelete: mine && editBlock === null,
    canSubmit: mine && status === "draft",
    canWithdraw: mine && status === "submitted",
    canApprove: decides && status === "submitted",
    canReject: decides && status === "submitted",
    invoice,
    canRefresh: prime && (opts.party === "gc" || opts.party === "owner") && co.paypalInvoiceId !== undefined,
  };
}
export type ChangeOrderRowView = ReturnType<typeof changeOrderRowView>;

function overCapacity(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "CO_CAPACITY", message: `${CO_CAPACITY_MESSAGE} This contract has more, so its sums cannot be shown completely.` });
}

/**
 * Subcontract change orders of one agreement in number order, all of them (legacy prime rows on the
 * agreement are skipped); more than CO_CAPACITY is refused rather than summed partially.
 */
export async function subcontractChangeOrders(ctx: QueryCtx, agreementId: Id<"agreements">): Promise<Doc<"changeOrders">[]> {
  const rows: Doc<"changeOrders">[] = [];
  // Legacy prime rows on the agreement are bounded by the prime capacity of its project.
  const scanned = await ctx.db
    .query("changeOrders")
    .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", agreementId))
    .take(2 * CO_CAPACITY + 1);
  for (const co of scanned) if (changeOrderScopeOf(co) === "subcontract") rows.push(co);
  if (rows.length > CO_CAPACITY || scanned.length > 2 * CO_CAPACITY) throw overCapacity();
  return rows;
}

/** Prime change orders of one project in number order, all of them; more than CO_CAPACITY is refused. */
export async function primeChangeOrders(ctx: QueryCtx, projectId: Id<"projects">): Promise<Doc<"changeOrders">[]> {
  const rows = await ctx.db
    .query("changeOrders")
    .withIndex("by_projectId_and_scope_and_number", (q) => q.eq("projectId", projectId).eq("scope", "prime"))
    .take(CO_CAPACITY + 1);
  if (rows.length > CO_CAPACITY) throw overCapacity();
  return rows;
}

/** The highest change-order number in use on the contract, from the number index. */
export async function highestChangeOrderNumber(
  ctx: QueryCtx,
  scope: ChangeOrderScope,
  key: { agreementId?: Id<"agreements">; projectId: Id<"projects"> },
): Promise<number> {
  if (scope === "prime") {
    const last = await ctx.db
      .query("changeOrders")
      .withIndex("by_projectId_and_scope_and_number", (q) => q.eq("projectId", key.projectId).eq("scope", "prime"))
      .order("desc")
      .first();
    return last?.number ?? 0;
  }
  for await (const co of ctx.db
    .query("changeOrders")
    .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", key.agreementId!))
    .order("desc")) {
    if (changeOrderScopeOf(co) === "subcontract") return co.number;
  }
  return 0;
}

function approvedAmounts(rows: readonly Doc<"changeOrders">[]): number[] {
  return rows.filter((co) => CO_APPROVED_STATUSES.has(co.status as ChangeOrderStatus)).map((co) => co.amountCents);
}

/** Subcontract sum: the agreement's original sum plus its approved change orders. */
export async function agreementContractSum(ctx: QueryCtx, agreement: Doc<"agreements">): Promise<ContractSumBreakdown> {
  return contractSumBreakdown(agreementContractSumCents(agreement), approvedAmounts(await subcontractChangeOrders(ctx, agreement._id)));
}

/** Prime contract sum: the project's contract value plus its approved prime change orders; null without a contract value. */
export async function primeContractSum(ctx: QueryCtx, project: Doc<"projects">): Promise<ContractSumBreakdown | null> {
  if (project.contractValueCents === undefined) return null;
  return contractSumBreakdown(project.contractValueCents, approvedAmounts(await primeChangeOrders(ctx, project._id)));
}

export async function recipientFor(ctx: QueryCtx, projectId: Id<"projects">, party: CoParty): Promise<InvoiceRecipient | null> {
  return party === "gc" ? await invoiceRecipientForProject(ctx, projectId) : null;
}

/** Views of a set of change orders for one party, with SOV line numbers and linked labels resolved. */
export async function rowViews(
  ctx: QueryCtx,
  rows: readonly Doc<"changeOrders">[],
  opts: { party: CoParty; recipient: InvoiceRecipient | null },
): Promise<ChangeOrderRowView[]> {
  const agreements = new Map<string, Doc<"agreements"> | null>();
  const billedOnOwnerApps = new Map<string, Map<string, number>>();
  const out: ChangeOrderRowView[] = [];
  for (const co of rows) {
    if (!visibleToParty(co, opts.party)) continue;
    let ownerPayAppNo: number | null = null;
    if (opts.party === "gc" && changeOrderScopeOf(co) === "prime" && co.status === "approved" && co.projectId !== undefined) {
      if (!billedOnOwnerApps.has(co.projectId)) billedOnOwnerApps.set(co.projectId, await changeOrdersOnSubmittedOwnerPayApps(ctx, co.projectId));
      ownerPayAppNo = billedOnOwnerApps.get(co.projectId)!.get(co._id) ?? null;
    }
    let agreement: Doc<"agreements"> | null = null;
    if (co.agreementId !== undefined) {
      if (!agreements.has(co.agreementId)) agreements.set(co.agreementId, await ctx.db.get(co.agreementId));
      agreement = agreements.get(co.agreementId) ?? null;
    }
    const line = co.sovLineId ? await ctx.db.get(co.sovLineId) : null;
    const linked = co.linkedChangeOrderId && opts.party !== "owner" ? await ctx.db.get(co.linkedChangeOrderId) : null;
    out.push(
      changeOrderRowView(co, {
        party: opts.party,
        agreement,
        recipient: opts.recipient,
        sovLineNo: line?.lineNo ?? null,
        linkedLabel: linked ? changeOrderLabel(linked.number, changeOrderScopeOf(linked)) : null,
        ownerPayAppNo,
      }),
    );
  }
  return out;
}

/** "+$8,750.00 additions, -$1,200.00 deductions" for the change-order summary. */
export function breakdownText(b: ContractSumBreakdown): string {
  const parts = [];
  if (b.additionsCents !== 0) parts.push(`+${formatCents(b.additionsCents)} additions`);
  if (b.deductionsCents !== 0) parts.push(`${formatCents(b.deductionsCents)} deductions`);
  return parts.length === 0 ? "No approved change orders" : parts.join(", ");
}

/**
 * The change-order summary of a G702: approved subcontract COs whose SOV line is on the sheet, each
 * marked as approved this period when it was approved after the previous approved application was filed.
 */
export async function payAppChangeOrderSummary(
  ctx: QueryCtx,
  payApp: Doc<"payApplications">,
  sheetLineIds: ReadonlySet<string>,
): Promise<{ _id: Id<"changeOrders">; label: string; title: string; amountCents: number; approvedAt: number | null; thisPeriod: boolean }[]> {
  const cos = await subcontractChangeOrders(ctx, payApp.agreementId);
  const approved = cos.filter((co) => CO_APPROVED_STATUSES.has(co.status as ChangeOrderStatus) && co.sovLineId && sheetLineIds.has(co.sovLineId));
  if (approved.length === 0) return [];
  const history = await ctx.db
    .query("payApplications")
    .withIndex("by_agreementId", (q) => q.eq("agreementId", payApp.agreementId))
    .take(500);
  const filedAt = (p: Doc<"payApplications">) => p.submittedAt ?? p.createdAt;
  const thisFiled = payApp.status === "draft" ? Number.MAX_SAFE_INTEGER : filedAt(payApp);
  let boundary = 0;
  for (const p of history) {
    if (p._id === payApp._id || !APPROVED_PAY_APP_STATUSES.has(p.status)) continue;
    const t = filedAt(p);
    if (t < thisFiled && t > boundary) boundary = t;
  }
  return approved.map((co) => ({
    _id: co._id,
    label: changeOrderLabel(co.number, "subcontract"),
    title: co.title ?? co.description,
    amountCents: co.amountCents,
    approvedAt: co.approvedAt ?? null,
    thisPeriod: (co.approvedAt ?? 0) > boundary,
  }));
}
