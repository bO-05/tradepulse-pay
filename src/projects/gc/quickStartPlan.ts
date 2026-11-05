import { SOV_MAX_DESCRIPTION, sovLineProblems } from "../../../convex/lib/sovRules";
import { CSI_DIVISION_OPTIONS, normalizeInviteEmail } from "../../../convex/lib/inviteRules";
import { validateVendorInput } from "../../../convex/lib/vendorRules";
import { parseMoneyToCents } from "../../ui/masks";

/** Pure planning and parsing for the GC Quick start wizard. No Convex or React imports. */

export const QUICK_START_MIN_LINES = 3;
export const QUICK_START_MAX_LINES = 8;
export const QUICK_START_MIN_BID_CENTS = 100_000; // matches bids.assertBidAmountPlausible

export type QuickStartSovRow = {
  id: string;
  description: string;
  amountCents: number | null;
};

export type QuickStartSub = {
  companyName: string;
  contactName: string;
  email: string;
  csiDivision: string;
  phone: string;
  licenseNumber: string;
};

export type QuickStartSovErrors = {
  rows: Record<number, { description?: string; amountCents?: string }>;
  total?: string;
  count?: string;
};

export function newQuickStartRow(seed = ""): QuickStartSovRow {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    description: seed,
    amountCents: null,
  };
}

export function emptyQuickStartRows(): QuickStartSovRow[] {
  return Array.from({ length: QUICK_START_MIN_LINES }, () => newQuickStartRow());
}

export function isQuickStartDivision(value: string): boolean {
  return CSI_DIVISION_OPTIONS.some((option) => option.value === value);
}

export function quickStartSubErrors(sub: QuickStartSub): {
  companyName?: string;
  contactName?: string;
  email?: string;
  csiDivision?: string;
  phone?: string;
  licenseNumber?: string;
} {
  const errors: ReturnType<typeof quickStartSubErrors> = {};
  if (!isQuickStartDivision(sub.csiDivision)) errors.csiDivision = "Choose a CSI trade.";
  const checked = validateVendorInput({
    name: sub.companyName,
    trades: isQuickStartDivision(sub.csiDivision) ? [sub.csiDivision] : [],
    contactName: sub.contactName,
    email: sub.email,
    phone: sub.phone,
    licenseNumber: sub.licenseNumber,
  });
  if (!checked.ok) {
    errors.companyName = checked.errors.name;
    errors.contactName = checked.errors.contactName;
    errors.email = checked.errors.email;
    errors.phone = checked.errors.phone;
    errors.licenseNumber = checked.errors.licenseNumber;
    if (!errors.csiDivision) errors.csiDivision = checked.errors.trades;
  }
  // The invite needs a contact name; the directory only requires it when present.
  if (!errors.contactName && sub.contactName.trim().length < 2) {
    errors.contactName = "Enter the contact's name.";
  }
  if (!errors.email && normalizeInviteEmail(sub.email) === null) {
    errors.email = "Enter a valid email address, like name@company.com.";
  }
  return errors;
}

export function quickStartSovErrors(rows: QuickStartSovRow[]): QuickStartSovErrors {
  const errors: QuickStartSovErrors = { rows: {} };
  if (rows.length < QUICK_START_MIN_LINES) {
    errors.count = `Add at least ${QUICK_START_MIN_LINES} lines so the GC can track progress and the sub can bill.`;
  } else if (rows.length > QUICK_START_MAX_LINES) {
    errors.count = `Quick start takes up to ${QUICK_START_MAX_LINES} lines. Add more from the schedule of values after setup.`;
  }
  let totalCents = 0;
  rows.forEach((row, index) => {
    const description = row.description.trim();
    const amount = row.amountCents;
    const rowErrors: { description?: string; amountCents?: string } = {};
    if (description === "") rowErrors.description = "Describe this line of work.";
    else if (description.length > SOV_MAX_DESCRIPTION) {
      rowErrors.description = `Use at most ${SOV_MAX_DESCRIPTION} characters.`;
    }
    if (amount === null) rowErrors.amountCents = "Enter an amount.";
    else if (!Number.isSafeInteger(amount) || amount <= 0) rowErrors.amountCents = "Enter an amount greater than $0.00.";
    else {
      const problems = sovLineProblems({ description, scheduledValueCents: amount });
      if (problems.length > 0) rowErrors.amountCents = problems.join("; ");
      totalCents += amount;
    }
    if (rowErrors.description || rowErrors.amountCents) errors.rows[index] = rowErrors;
  });
  if (rows.length >= QUICK_START_MIN_LINES && rows.length <= QUICK_START_MAX_LINES && totalCents < QUICK_START_MIN_BID_CENTS) {
    errors.total = "The SOV total must be at least $1,000.00, the minimum this app accepts for a subcontract bid.";
  }
  return errors;
}

export function quickStartSovTotalCents(rows: QuickStartSovRow[]): number {
  return rows.reduce((sum, row) => sum + (row.amountCents ?? 0), 0);
}

export function quickStartHasErrors(errors: { rows: Record<number, unknown>; total?: string; count?: string }): boolean {
  return Boolean(errors.count || errors.total || Object.keys(errors.rows).length > 0);
}

const PASTE_ROW = /^(.*?)(?:\t|\s*\|\s*|,)\s*"?(\$?\s*[\d,]+(?:\.\d{1,2})?)"?\s*$/;

/**
 * Parses spreadsheet-style lines: `Description<TAB>$12,500.00`, `Description | 12500`,
 * or `Description, 12,500`. A header row is ignored. Returns row drafts, not ids.
 */
export function parsePastedSov(text: string): {
  rows: { description: string; amountCents: number }[];
  errors: string[];
} {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return { rows: [], errors: ["Paste one line per SOV row."] };
  if (lines.length > QUICK_START_MAX_LINES) {
    return { rows: [], errors: [`Quick start takes up to ${QUICK_START_MAX_LINES} lines.`] };
  }
  const rows: { description: string; amountCents: number }[] = [];
  const errors: string[] = [];
  lines.forEach((line, index) => {
    if (/^(description|item|line item)\s*(?:\t|\||,)\s*(amount|value|scheduled value)$/i.test(line)) {
      return; // header row
    }
    const match = PASTE_ROW.exec(line);
    if (!match) {
      errors.push(`Line ${index + 1}: use "Description, amount".`);
      return;
    }
    const description = match[1]
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/""/g, '"')
      .trim();
    if (description === "") {
      errors.push(`Line ${index + 1}: add a description.`);
      return;
    }
    const parsed = parseMoneyToCents(match[2]);
    if (!parsed.ok || parsed.value === null || parsed.value <= 0) {
      errors.push(`Line ${index + 1}: amount must be greater than $0.00.`);
      return;
    }
    if (description.length > SOV_MAX_DESCRIPTION) {
      errors.push(`Line ${index + 1}: description is longer than ${SOV_MAX_DESCRIPTION} characters.`);
      return;
    }
    rows.push({ description, amountCents: parsed.value });
  });
  if (errors.length === 0 && rows.length < QUICK_START_MIN_LINES) {
    errors.push(`Add at least ${QUICK_START_MIN_LINES} lines.`);
  }
  return { rows, errors };
}

/** The date input value for a bid due two weeks out (UTC date, no timezone surprise). */
export function quickStartBidDeadline(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 14));
  return d.toISOString().slice(0, 10);
}
