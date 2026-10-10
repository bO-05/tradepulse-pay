/**
 * Owner pay app math (architecture §16, §22), in integer cents. The prime continuation sheet has one
 * line per trade package (its awarded sum, billed from the sub's approved pay apps), one per GC line
 * (general conditions, fee, insurance…) and one per approved prime change order. Retainage is the
 * prime rate on each line's completed and stored total, rounded half-up per prime line, so it can
 * differ by a cent from the sum of the sub's per-SOV-line retainage on the same work.
 *
 * Unlike a subcontract G702, the original contract sum is the prime contract value from project
 * setup, which can exceed the sum of the lines on the sheet (packages not yet awarded).
 */
import { formatCents, toPayPalString } from "../lib/money";
import { g703Line, g703LineErrors, type G703LineError } from "../payApps/g703Math";

export type OwnerLineKind = "trade" | "gc" | "change_order";

export type OwnerLine = {
  key: string;
  kind: OwnerLineKind;
  description: string;
  scheduledValueCents: number;
  previousWorkCents: number;
  previousStoredCents: number;
  workThisPeriodCents: number;
  storedCents: number;
  retainageBps: number;
};

export type OwnerG702 = {
  originalContractSumCents: number;
  netChangeOrdersCents: number;
  contractSumToDateCents: number;
  completedAndStoredCents: number;
  retainageCents: number;
  retainageWorkCents: number;
  retainageStoredCents: number;
  earnedLessRetainageCents: number;
  previousCertificatesCents: number;
  currentPaymentDueCents: number;
  balanceToFinishInclRetainageCents: number;
};

export function tradeKey(agreementId: string): string {
  return `trade:${agreementId}`;
}
export function gcKey(primeLineId: string): string {
  return `gc:${primeLineId}`;
}
export function changeOrderKey(changeOrderId: string): string {
  return `pco:${changeOrderId}`;
}

/** "Electrical (26 00 00) – Eastbay Electric". */
export function tradeLineLabel(tradeName: string, csiDivision: string, subName: string): string {
  const trade = tradeName.trim() || "Trade package";
  const csi = csiDivision.trim();
  return `${trade}${csi ? ` (${csi})` : ""} – ${subName.trim() || "Subcontractor"}`;
}

/** "PCO #1 – Dental chair circuits incl. GC markup". */
export function changeOrderLineLabel(number: number, title: string): string {
  return `PCO #${number} – ${title.trim()}`;
}

/** Per prime line: G, %, H and I (retainage rounded half-up on that line). */
export function ownerLineFigures(l: OwnerLine) {
  return g703Line(l);
}

/** G702 summary of an owner pay app. Retainage is the sum of the per-prime-line rounded figures. */
export function ownerG702(
  lines: readonly OwnerLine[],
  opts: { originalContractSumCents: number; netChangeOrdersCents: number; previousCertificatesCents: number },
): OwnerG702 {
  let completed = 0;
  let retainage = 0;
  let retainageStored = 0;
  for (const l of lines) {
    const f = g703Line(l);
    completed += f.totalCents;
    retainage += f.retainageCents;
    retainageStored += f.retainageStoredCents;
  }
  const contractSumToDate = opts.originalContractSumCents + opts.netChangeOrdersCents;
  const earned = completed - retainage;
  return {
    originalContractSumCents: opts.originalContractSumCents,
    netChangeOrdersCents: opts.netChangeOrdersCents,
    contractSumToDateCents: contractSumToDate,
    completedAndStoredCents: completed,
    retainageCents: retainage,
    retainageWorkCents: retainage - retainageStored,
    retainageStoredCents: retainageStored,
    earnedLessRetainageCents: earned,
    previousCertificatesCents: opts.previousCertificatesCents,
    currentPaymentDueCents: earned - opts.previousCertificatesCents,
    balanceToFinishInclRetainageCents: contractSumToDate - earned,
  };
}

/**
 * A trade line from the sub's approved billing to date: completed and stored to date `toDateCents`
 * (G), of which `storedToDateCents` is stored material (F). D comes from the previous owner pay app,
 * and this period's work E is what remains.
 */
export function tradeLineFromToDate(opts: {
  toDateCents: number;
  storedToDateCents: number;
  previousWorkCents: number;
  previousStoredCents: number;
}): { previousWorkCents: number; previousStoredCents: number; workThisPeriodCents: number; storedCents: number } {
  const stored = Math.max(0, Math.min(opts.storedToDateCents, opts.toDateCents));
  return {
    previousWorkCents: opts.previousWorkCents,
    previousStoredCents: opts.previousStoredCents,
    storedCents: stored,
    workThisPeriodCents: opts.toDateCents - stored - opts.previousWorkCents,
  };
}

/**
 * Checks the GC-entered amounts on GC and change-order lines with the same rules as sub lines: whole
 * non-negative cents, never above the line's remaining balance.
 */
export function gcEntryErrors(lines: readonly OwnerLine[], lineNoOf: (key: string) => number): G703LineError[] {
  return g703LineErrors(
    lines
      .filter((l) => l.kind !== "trade")
      .map((l) => ({
        sovLineId: l.key,
        lineNo: lineNoOf(l.key),
        scheduledValueCents: l.scheduledValueCents,
        previousWorkCents: l.previousWorkCents,
        previousStoredCents: l.previousStoredCents,
        pendingCents: 0,
        workThisPeriodCents: l.workThisPeriodCents,
        storedCents: l.storedCents,
      })),
  );
}

/** "1 sub pay app not yet approved"; null when none are waiting. */
export function pendingSubPayAppsNote(count: number): string | null {
  if (count <= 0) return null;
  return `${count} sub pay app${count === 1 ? "" : "s"} not yet approved`;
}

/** "Harbor Point Dental Office TI – Application #1". */
export function ownerInvoiceReference(projectTitle: string, applicationNo: number): string {
  return `${projectTitle.trim()} – Application #${applicationNo}`;
}

/** Notification title when the GC submits: "Owner pay app #1 ready – $48,841.97". */
export function ownerPayAppReadyTitle(applicationNo: number, currentPaymentDueCents: number): string {
  return `Owner pay app #${applicationNo} ready – ${formatCents(currentPaymentDueCents)}`;
}

export type OwnerPayAppStatus = "draft" | "submitted_to_owner" | "changes_requested" | "approved" | "approved_invoiced" | "paid";

/** Statuses at which the owner has approved the application (its figures are certified). */
export const OWNER_APPROVED_STATUSES: ReadonlySet<OwnerPayAppStatus> = new Set(["approved", "approved_invoiced", "paid"]);
/** Statuses the GC may still edit. */
export const OWNER_EDITABLE_STATUSES: ReadonlySet<OwnerPayAppStatus> = new Set(["draft", "changes_requested"]);

/** Owner pay app status implied by a PayPal invoice status; null when it implies no change. */
export function ownerStatusFromInvoice(invoiceStatus: string | undefined): OwnerPayAppStatus | null {
  switch (invoiceStatus) {
    case "PAID":
    case "MARKED_AS_PAID":
      return "paid";
    case "SENT":
    case "SCHEDULED":
    case "UNPAID":
    case "PARTIALLY_PAID":
    case "PAYMENT_PENDING":
      return "approved_invoiced";
    default:
      return null;
  }
}

const NEXT: Record<OwnerPayAppStatus, readonly OwnerPayAppStatus[]> = {
  draft: ["submitted_to_owner"],
  submitted_to_owner: ["approved", "changes_requested"],
  changes_requested: ["submitted_to_owner"],
  approved: ["approved_invoiced", "paid"],
  approved_invoiced: ["paid"],
  paid: [],
};

/** Forward-only lifecycle; replayed or stale invoice statuses never move an owner pay app back. */
export function canMoveOwnerPayApp(from: OwnerPayAppStatus, to: OwnerPayAppStatus): boolean {
  return NEXT[from].includes(to);
}

export const OWNER_COMMENT_MAX = 1000;

export type OwnerInvoiceInput = {
  projectTitle: string;
  applicationNo: number;
  periodEndLabel: string;
  amountCents: number;
  recipientEmail: string;
};

/** Invoicing v2 body for an approved owner pay app: one item for its current payment due. */
export function buildOwnerInvoiceBody(input: OwnerInvoiceInput) {
  const reference = ownerInvoiceReference(input.projectTitle, input.applicationNo);
  return {
    detail: {
      currency_code: "USD",
      reference: reference.slice(0, 120),
      note: `${reference}, period ending ${input.periodEndLabel}. Current payment due on the owner-approved application.`.slice(0, 4000),
      payment_term: { term_type: "DUE_ON_RECEIPT" },
    },
    primary_recipients: [{ billing_info: { email_address: input.recipientEmail } }],
    items: [
      {
        name: reference.slice(0, 200),
        description: `Owner pay application #${input.applicationNo}, period ending ${input.periodEndLabel}: current payment due.`.slice(0, 1000),
        quantity: "1",
        unit_amount: { currency_code: "USD", value: toPayPalString(input.amountCents) },
        unit_of_measure: "AMOUNT",
      },
    ],
  };
}
