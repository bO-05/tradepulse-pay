import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { loadBillingHistory, type BillingHistory } from "../payApps/billingHistory";
import { computeLedgerTotals, type LedgerTotals } from "./ledgerTotals";
import { agreementContractSumCents } from "./sov";

/**
 * Safety bounds on the money history read for one agreement. Convex caps a query at roughly
 * 16k documents read, so a history past these bounds is returned newest-first up to the bound
 * and flagged `truncated` instead of failing the query or silently dropping rows.
 */
export const AGREEMENT_HISTORY_BOUNDS = {
  payments: 4000,
  retainage: 8000,
  changeOrders: 1000,
  payApps: 2000,
} as const;

export const HISTORY_TRUNCATED_MESSAGE =
  "Data incomplete: this agreement's payment history exceeds the safety bound read per query, so only the newest rows are counted and totals understate the full ledger.";

/** Shared document allowance for queries that load the history of many agreements at once. */
export type ReadBudget = { remaining: number };

export function createReadBudget(documents: number): ReadBudget {
  return { remaining: documents };
}

export type AgreementHistory = {
  payments: Doc<"payments">[];
  retainage: Doc<"retainageLedger">[];
  changeOrders: Doc<"changeOrders">[];
  /** True when any table held more rows than its bound (or the shared budget) allowed. */
  truncated: boolean;
};

type Bounded<T> = { rows: T[]; truncated: boolean };

/** Reads newest-first so a bound drops the oldest rows, then returns them in creation order. */
async function newestFirst<T>(
  read: (n: number) => Promise<T[]>,
  bound: number,
  budget: ReadBudget | undefined,
): Promise<Bounded<T>> {
  const limit = Math.max(0, Math.min(bound, budget?.remaining ?? bound));
  const rows = await read(limit + 1);
  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;
  if (budget) budget.remaining -= kept.length;
  return { rows: kept.reverse(), truncated };
}

/** Every payment, retainage entry and change order of an agreement, in creation order. */
export async function loadAgreementHistory(
  ctx: QueryCtx,
  agreementId: Id<"agreements">,
  budget?: ReadBudget,
): Promise<AgreementHistory> {
  const payments = await newestFirst(
    (n) =>
      ctx.db
        .query("payments")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
        .order("desc")
        .take(n),
    AGREEMENT_HISTORY_BOUNDS.payments,
    budget,
  );
  const retainage = await newestFirst(
    (n) =>
      ctx.db
        .query("retainageLedger")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
        .order("desc")
        .take(n),
    AGREEMENT_HISTORY_BOUNDS.retainage,
    budget,
  );
  const changeOrders = await newestFirst(
    (n) =>
      ctx.db
        .query("changeOrders")
        .withIndex("by_agreementId_and_number", (q) => q.eq("agreementId", agreementId))
        .order("desc")
        .take(n),
    AGREEMENT_HISTORY_BOUNDS.changeOrders,
    budget,
  );
  return {
    payments: payments.rows,
    retainage: retainage.rows,
    changeOrders: changeOrders.rows,
    truncated: payments.truncated || retainage.truncated || changeOrders.truncated,
  };
}

/** Every pay application of an agreement (all statuses), newest-first bounded, in creation order. */
export async function loadAgreementPayApps(
  ctx: QueryCtx,
  agreementId: Id<"agreements">,
  budget?: ReadBudget,
): Promise<Bounded<Doc<"payApplications">>> {
  return await newestFirst(
    (n) =>
      ctx.db
        .query("payApplications")
        .withIndex("by_agreementId", (q) => q.eq("agreementId", agreementId))
        .order("desc")
        .take(n),
    AGREEMENT_HISTORY_BOUNDS.payApps,
    budget,
  );
}

export type AgreementFinancials = {
  history: AgreementHistory;
  billing: BillingHistory;
  totals: LedgerTotals;
  /** History or billing could not be read completely; totals understate the real figures. */
  truncated: boolean;
};

/**
 * The agreement ledger's canonical totals (computeLedgerTotals over loadBillingHistory and the
 * complete payment/retainage/change-order history), shared by the ledger view, the dashboard and
 * the Studio pay agent so all three report the same cents.
 */
export async function loadAgreementFinancials(
  ctx: QueryCtx,
  agreement: Doc<"agreements">,
  budget?: ReadBudget,
): Promise<AgreementFinancials> {
  const history = await loadAgreementHistory(ctx, agreement._id, budget);
  let billing: BillingHistory;
  let billingTruncated = false;
  try {
    billing = await loadBillingHistory(ctx, agreement._id);
    if (budget) budget.remaining -= billing.rows.length;
  } catch (err) {
    if (!isBillingTooLarge(err)) throw err;
    billing = { rows: [], unresolved: [] };
    billingTruncated = true;
  }
  const totals = computeLedgerTotals({
    contractSumCents: agreementContractSumCents(agreement),
    payApps: billing.rows,
    payments: history.payments,
    retainage: history.retainage,
    changeOrders: history.changeOrders,
  });
  return { history, billing, totals, truncated: history.truncated || billingTruncated };
}

function isBillingTooLarge(err: unknown): boolean {
  const data = (err as { data?: unknown } | null)?.data;
  return typeof data === "object" && data !== null && (data as { code?: unknown }).code === "BILLING_HISTORY_TOO_LARGE";
}

/** Whether an agreement carries money history that must stay in totals even after it is voided. */
export function hasFinancialHistory(history: AgreementHistory, payAppCount: number): boolean {
  return history.payments.length > 0 || history.retainage.length > 0 || payAppCount > 0;
}
