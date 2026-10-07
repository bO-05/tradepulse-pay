import { toPayPalString } from "../lib/money";

/**
 * Pure helpers for change-order invoices (architecture §4 step 5): Invoicing v2 request body,
 * response parsing and the PayPal invoice status → change order status mapping.
 */

export type ChangeOrderStatus = "draft" | "invoiced" | "paid" | "cancelled";

export const SANDBOX_PAYER_VIEW_BASE = "https://www.sandbox.paypal.com/invoice/p/#";

/** "CO-001" style label for a change order number. */
export function changeOrderLabel(number: number): string {
  return `CO-${String(number).padStart(3, "0")}`;
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
  draft: ["invoiced", "paid", "cancelled"],
  invoiced: ["paid", "cancelled"],
  paid: [],
  cancelled: [],
};

/** paid and cancelled are terminal; a late or replayed status never moves a change order backwards. */
export function canMoveChangeOrder(from: ChangeOrderStatus, to: ChangeOrderStatus): boolean {
  return NEXT[from].includes(to);
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
  number: number;
  description: string;
  amountCents: number;
  recipientEmail: string;
  agreementNumber: string;
  projectTitle: string;
  subcontractorName: string;
};

export function buildInvoiceBody(input: ChangeOrderInvoiceInput) {
  const label = changeOrderLabel(input.number);
  return {
    detail: {
      currency_code: "USD",
      reference: `${input.agreementNumber} ${label}`.slice(0, 120),
      note: `Change order ${label} on ${input.projectTitle} (${input.subcontractorName}, agreement ${input.agreementNumber}).`.slice(0, 4000),
      payment_term: { term_type: "DUE_ON_RECEIPT" },
    },
    primary_recipients: [{ billing_info: { email_address: input.recipientEmail } }],
    items: [
      {
        name: `Change order ${label}`.slice(0, 200),
        description: input.description.slice(0, 1000),
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
