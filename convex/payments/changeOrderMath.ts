import { formatCents, toPayPalString } from "../lib/money";

/**
 * Pure helpers for change-order invoices (architecture §4 step 5): Invoicing v2 request body,
 * response parsing and the PayPal invoice status → change order status mapping.
 */

export type ChangeOrderStatus = "draft" | "submitted" | "approved" | "rejected" | "void" | "invoiced" | "paid" | "cancelled";
export type ChangeOrderScope = "subcontract" | "prime";

export const SANDBOX_PAYER_VIEW_BASE = "https://www.sandbox.paypal.com/invoice/p/#";

/** Rows written before scope existed were invoiced to the owner, i.e. prime change orders. */
export function changeOrderScopeOf(co: { scope?: ChangeOrderScope }): ChangeOrderScope {
  return co.scope ?? "prime";
}

/** "CO #1" for a subcontract change order, "PCO #1" for a prime (owner) change order. */
export function changeOrderLabel(number: number, scope: ChangeOrderScope = "subcontract"): string {
  return `${scope === "prime" ? "PCO" : "CO"} #${number}`;
}

/**
 * Statuses at which a change order counts in the contract sum (it was approved). invoiced, paid and
 * cancelled only describe the "Invoice now" invoice of an approved prime CO: cancelling that invoice
 * withdraws the receivable, not the owner's approval, so the scope stays in the contract.
 */
export const CO_APPROVED_STATUSES: ReadonlySet<ChangeOrderStatus> = new Set(["approved", "invoiced", "paid", "cancelled"]);

/**
 * Supported change orders per contract: per agreement for subcontract COs, per project for prime COs,
 * drafts and decided ones alike (matching the 200 change-order lines of the SOV capacity). Creation
 * beyond it is refused, and every read loads the contract's COs completely or refuses; none truncates.
 */
export const CO_CAPACITY = 200;
export const CO_CAPACITY_MESSAGE = `A contract can have at most ${CO_CAPACITY} change orders (drafts, rejected and approved ones together).`;

/**
 * Whether an approved prime CO is billed with its own "Invoice now" invoice (started, sent or paid).
 * Such a CO is billed outside owner pay apps; a cancelled invoice billed nothing.
 */
export function isDirectlyInvoiced(co: { status: string; paypalInvoiceId?: string; directInvoiceStartedAt?: number }): boolean {
  if (co.status === "cancelled") return false;
  return co.status === "invoiced" || co.status === "paid" || co.paypalInvoiceId !== undefined || co.directInvoiceStartedAt !== undefined;
}

export type ApprovedCoForSums = { id: string; amountCents: number; approvedAt?: number; createdAt: number; number: number };

/**
 * The contract sum before and after each approved change order, in approval order (approval time,
 * then number), for records approved before the sums were captured at approval.
 */
export function contractSumsByApproval(originalCents: number, approved: readonly ApprovedCoForSums[]): Map<string, { beforeCents: number; afterCents: number }> {
  const ordered = [...approved].sort((a, b) => (a.approvedAt ?? a.createdAt) - (b.approvedAt ?? b.createdAt) || a.number - b.number);
  const out = new Map<string, { beforeCents: number; afterCents: number }>();
  let running = originalCents;
  for (const co of ordered) {
    out.set(co.id, { beforeCents: running, afterCents: running + co.amountCents });
    running += co.amountCents;
  }
  return out;
}

/**
 * Maps a PayPal invoice status to the change order status it implies, or null when it implies no
 * change (DRAFT, refunds and unknown values never move a change order).
 */
export function changeOrderStatusFromInvoice(invoiceStatus: string | undefined): ChangeOrderStatus | null {
  switch (invoiceStatus) {
    case "PAID":
    case "MARKED_AS_PAID":
      return "paid";
    case "CANCELLED":
      return "cancelled";
    case "SENT":
    case "SCHEDULED":
    case "UNPAID":
    case "PARTIALLY_PAID":
    case "PAYMENT_PENDING":
      return "invoiced";
    default:
      return null;
  }
}

const NEXT: Record<ChangeOrderStatus, readonly ChangeOrderStatus[]> = {
  draft: ["submitted", "void"],
  submitted: ["draft", "approved", "rejected", "void"],
  approved: ["invoiced", "paid", "cancelled"],
  rejected: [],
  void: [],
  invoiced: ["paid", "cancelled"],
  paid: [],
  cancelled: [],
};

/**
 * The change-order lifecycle: draft ⇄ submitted → approved | rejected, then (prime only) invoiced → paid.
 * rejected, void, paid and cancelled are terminal; a late or replayed invoice status never moves a
 * change order backwards.
 */
export function canMoveChangeOrder(from: ChangeOrderStatus, to: ChangeOrderStatus): boolean {
  return NEXT[from].includes(to);
}

export const DECIDED_EDIT_MESSAGE: Record<"approved" | "rejected" | "void", string> = {
  approved: "Approved change orders cannot be edited – create a new change order",
  rejected: "Rejected change orders cannot be edited – create a new change order",
  void: "Void change orders cannot be edited – create a new change order",
};
export const SUBMITTED_EDIT_MESSAGE = "Submitted change orders cannot be edited in place – withdraw it to Draft first";

/** Why a change order's title, amount or schedule cannot change (or it cannot be deleted); null for drafts. */
export function changeOrderEditBlock(status: ChangeOrderStatus): string | null {
  if (status === "draft") return null;
  if (status === "submitted") return SUBMITTED_EDIT_MESSAGE;
  if (status === "rejected" || status === "void") return DECIDED_EDIT_MESSAGE[status];
  return DECIDED_EDIT_MESSAGE.approved;
}

export const CO_MAX_TITLE = 200;
export const CO_MAX_DESCRIPTION = 1000;
export const CO_MAX_SCHEDULE_DAYS = 3650;
export const CO_MAX_REASON = 1000;
/** ±$100,000,000.00: the largest change the app accepts in one change order. */
export const CO_MAX_ABS_CENTS = 10_000_000_000;

export type ChangeOrderFieldErrors = Partial<Record<"title" | "description" | "amountCents" | "scheduleDays", string>>;

/** Field checks shared by the form and the server: a title, a non-zero whole-cent amount, whole days. */
export function changeOrderFieldErrors(input: {
  title: string;
  description: string;
  amountCents: number | null;
  scheduleDays?: number | null;
}): ChangeOrderFieldErrors {
  const errors: ChangeOrderFieldErrors = {};
  const title = input.title.trim();
  if (title.length === 0) errors.title = "Enter a title for the change order.";
  else if (title.length > CO_MAX_TITLE) errors.title = `The title is limited to ${CO_MAX_TITLE} characters.`;
  if (input.description.trim().length > CO_MAX_DESCRIPTION) errors.description = `The description is limited to ${CO_MAX_DESCRIPTION} characters.`;
  const cents = input.amountCents;
  if (cents === null) errors.amountCents = "Enter the change order amount.";
  else if (!Number.isSafeInteger(cents)) errors.amountCents = "The amount must be whole cents.";
  else if (cents === 0) errors.amountCents = "The amount can't be $0.00. Use a negative amount for a deductive change order.";
  else if (Math.abs(cents) > CO_MAX_ABS_CENTS) errors.amountCents = "The amount can't be more than $100,000,000.00.";
  const days = input.scheduleDays;
  if (days !== undefined && days !== null && (!Number.isSafeInteger(days) || Math.abs(days) > CO_MAX_SCHEDULE_DAYS)) {
    errors.scheduleDays = "Schedule impact must be a whole number of days.";
  }
  return errors;
}

export type ContractSumBreakdown = {
  originalCents: number;
  additionsCents: number;
  deductionsCents: number;
  netChangeCents: number;
  toDateCents: number;
};

/** Original sum plus the approved change orders, with additions and deductions shown apart. */
export function contractSumBreakdown(originalCents: number, approvedAmounts: readonly number[]): ContractSumBreakdown {
  let additions = 0;
  let deductions = 0;
  for (const a of approvedAmounts) {
    if (a >= 0) additions += a;
    else deductions += a;
  }
  return {
    originalCents,
    additionsCents: additions,
    deductionsCents: deductions,
    netChangeCents: additions + deductions,
    toDateCents: originalCents + additions + deductions,
  };
}

/**
 * Architecture §22: a deductive change order may not take the contract sum to date below what was
 * already billed (total completed and stored on approved pay apps). Returns the refusal, or null.
 */
export function deductiveFloorProblem(opts: {
  contractSumToDateCents: number;
  amountCents: number;
  billedCents: number;
  billedOn?: string;
}): string | null {
  if (opts.amountCents >= 0) return null;
  const after = opts.contractSumToDateCents + opts.amountCents;
  if (after >= opts.billedCents) return null;
  return `This deductive change order would make the contract sum to date ${formatCents(after)}, below the ${formatCents(
    opts.billedCents,
  )} already billed ${opts.billedOn ?? "on approved pay apps"}. Reduce the deduction or reject it.`;
}

/** Reads the invoice id from the create response, whose 201 body is only a `self` link. */
export function invoiceIdFromCreateResponse(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { id?: unknown; href?: unknown; links?: Array<{ href?: unknown; rel?: unknown }> };
  if (typeof d.id === "string" && d.id.length > 0) return d.id;
  const hrefs: unknown[] = [d.href, ...(Array.isArray(d.links) ? d.links.filter((l) => l.rel === "self").map((l) => l.href) : [])];
  for (const href of hrefs) {
    if (typeof href !== "string") continue;
    const m = href.match(/\/v2\/invoicing\/invoices\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

/** Payer-view link: PayPal's recipient_view_url when present, else the documented sandbox URL form. */
export function payerViewUrlFor(invoiceId: string, recipientViewUrl?: string | null): string {
  if (typeof recipientViewUrl === "string" && recipientViewUrl.startsWith("https://")) return recipientViewUrl;
  return `${SANDBOX_PAYER_VIEW_BASE}${invoiceId}`;
}

export type ChangeOrderInvoiceInput = {
  label: string;
  title: string;
  description: string;
  amountCents: number;
  recipientEmail: string;
  projectTitle: string;
  /** Agreement the change order is billed through, when it has one. */
  agreementNumber: string | null;
};

export function buildInvoiceBody(input: ChangeOrderInvoiceInput) {
  const label = input.label;
  const via = input.agreementNumber ? ` (agreement ${input.agreementNumber})` : "";
  return {
    detail: {
      currency_code: "USD",
      reference: `${input.projectTitle} ${label}`.slice(0, 120),
      note: `Change order ${label} on ${input.projectTitle}${via}.`.slice(0, 4000),
      payment_term: { term_type: "DUE_ON_RECEIPT" },
    },
    primary_recipients: [{ billing_info: { email_address: input.recipientEmail } }],
    items: [
      {
        name: `Change order ${label}: ${input.title}`.slice(0, 200),
        description: (input.description || input.title).slice(0, 1000),
        quantity: "1",
        unit_amount: { currency_code: "USD", value: toPayPalString(input.amountCents) },
        unit_of_measure: "AMOUNT",
      },
    ],
  };
}

export type PayPalInvoice = {
  id?: string;
  status?: string;
  detail?: { metadata?: { recipient_view_url?: string } };
  amount?: { currency_code?: string; value?: string };
  primary_recipients?: Array<{ billing_info?: { email_address?: string } }>;
};
