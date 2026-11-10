import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { sumCents } from "../lib/money";
import { requireProjectScope } from "../lib/projectScope";
import { projectKindOf } from "../lib/projectKind";
import { requireRole } from "../lib/roles";
import { accessibleProjectIds, requireProjectAccess, type ProjectAccess } from "../lib/tenancy";
import { isoDate } from "../payApps/g703Math";
import { createReadBudget, loadAgreementFinancials, type ReadBudget } from "../payments/agreementHistory";
import { CO_CAPACITY } from "../payments/changeOrderMath";
import { OWNER_PAID_CHANGE_ORDER_STATUSES } from "../portal";
import { primeRetainageHeld } from "./ownerRollup";

/**
 * The GC's money strip (architecture §6.1): collected from owners, paid to subs, sub retainage held
 * and approved work owed this week, each with the stored rows behind it.
 *
 * Every figure is a sum of integer cents an existing ledger reader already produced — paid owner pay
 * apps (`figures.currentPaymentDueCents`), the owner portal's paid prime change-order derivation,
 * per-agreement `LedgerTotals.paidCents` and `retainageHeldCents`, `primeRetainageHeld` and the
 * approved G702/G703 figures. This module adds no money formula; it only scopes, filters and sums.
 */

/** Project-scope is one project; portfolio scope is bounded to keep one query inside Convex's read cap. */
export const MAX_PROJECTS = 200;
export const MAX_AGREEMENTS_PER_PROJECT = 200;
export const MAX_OWNER_PAY_APPS_PER_PROJECT = 500;
/** Receipt arrays past this count are trimmed and `truncated` says so. */
export const MAX_RECEIPTS = 500;
/** Documents the portfolio query may read across agreements' money history (same budget as the dashboard). */
export const MONEY_READ_BUDGET = 12_000;

/** Only an undecided payment waits on the GC; a paid app is collected/paid history, not owed. */
const OWED_PAY_APP_STATUSES = new Set(["approved", "approved_as_noted"]);

const projectContextValidator = v.object({
  projectId: v.id("projects"),
  projectTitle: v.string(),
  projectKind: v.union(v.literal("residential"), v.literal("commercial")),
  /** The owner-side retainage rate stored on the project, shown beside the collected figure. */
  ownerRetainageBps: v.union(v.number(), v.null()),
});

const ownerPayAppReceiptValidator = v.object({
  projectId: v.id("projects"),
  ownerPayAppId: v.id("ownerPayApps"),
  applicationNo: v.number(),
  amountCents: v.number(),
  retainageCents: v.number(),
  paypalInvoiceId: v.union(v.string(), v.null()),
  paidAt: v.union(v.number(), v.null()),
});

const payoutReceiptValidator = v.object({
  projectId: v.id("projects"),
  agreementId: v.id("agreements"),
  agreementNumber: v.string(),
  paymentId: v.id("payments"),
  payAppId: v.union(v.id("payApplications"), v.null()),
  kind: v.union(v.literal("payout"), v.literal("retainage_release")),
  payoutBatchId: v.union(v.string(), v.null()),
  amountCents: v.number(),
  paidAt: v.number(),
});

const retainageReceiptValidator = v.object({
  projectId: v.id("projects"),
  agreementId: v.id("agreements"),
  agreementNumber: v.string(),
  payAppId: v.union(v.id("payApplications"), v.null()),
  amountCents: v.number(),
  /** The subcontract's retainage rate, shown beside the held figure. */
  retainageBps: v.union(v.number(), v.null()),
});

const owedReceiptValidator = v.object({
  projectId: v.id("projects"),
  payAppId: v.id("payApplications"),
  agreementId: v.id("agreements"),
  agreementNumber: v.string(),
  /** `dueDate ?? periodEnd`: the stored date the week filter used. */
  dueDate: v.string(),
  amountCents: v.number(),
});

export const projectMoneyValidator = v.object({
  scope: v.object({
    kind: v.union(v.literal("project"), v.literal("portfolio")),
    projectId: v.union(v.id("projects"), v.null()),
    projectTitle: v.union(v.string(), v.null()),
    projectKind: v.union(v.literal("residential"), v.literal("commercial"), v.null()),
    /** Every project the figures cover: the one project, or the caller's GC projects. */
    projects: v.array(projectContextValidator),
  }),
  collectedFromOwnerCents: v.number(),
  /** Paid owner pay apps plus paid prime change orders; the existing four-cell strip uses the field above. */
  collectedFromOwnerInclChangeOrdersCents: v.number(),
  paidToSubsCents: v.number(),
  retainageHeldCents: v.number(),
  /** The prime retainage the owner holds, returned separately from the sub retainage above. */
  ownerRetainageHeldCents: v.number(),
  owedThisWeekCents: v.number(),
  receipts: v.object({
    ownerPayApps: v.array(ownerPayAppReceiptValidator),
    payouts: v.array(payoutReceiptValidator),
    retainage: v.array(retainageReceiptValidator),
    owed: v.array(owedReceiptValidator),
  }),
  /** Server clock when the snapshot was read, in epoch milliseconds. */
  asOf: v.number(),
  /** Last day (Sunday) of the Monday–Sunday week containing `asOf`, YYYY-MM-DD. */
  weekEnd: v.string(),
  /** A read hit its safety bound, so at least one figure understates the full ledger. */
  truncated: v.boolean(),
});

type ProjectContext = Infer<typeof projectContextValidator>;
type OwnerPayAppReceipt = Infer<typeof ownerPayAppReceiptValidator>;
type PayoutReceipt = Infer<typeof payoutReceiptValidator>;
type RetainageReceipt = Infer<typeof retainageReceiptValidator>;
type OwedReceipt = Infer<typeof owedReceiptValidator>;

/**
 * The last day (a Sunday) of the Monday–Sunday week that contains `asOf`, as YYYY-MM-DD.
 * "Owed this week" compares stored `dueDate ?? periodEnd` strings against this date.
 */
export function weekEndOf(asOf: number): string {
  const at = new Date(asOf);
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + ((7 - day.getUTCDay()) % 7));
  return isoDate(day);
}

/** The stored date an approved pay app is owed on, or null when the row predates G702 periods. */
function owedDateOf(app: { dueDate?: string; periodEnd?: string }): string | null {
  return app.dueDate ?? app.periodEnd ?? null;
}

type MoneySums = {
  collectedFromOwnerCents: number;
  collectedFromOwnerInclChangeOrdersCents: number;
  paidToSubsCents: number;
  retainageHeldCents: number;
  ownerRetainageHeldCents: number;
  owedThisWeekCents: number;
  ownerPayApps: OwnerPayAppReceipt[];
  payouts: PayoutReceipt[];
  retainage: RetainageReceipt[];
  owed: OwedReceipt[];
  truncated: boolean;
};

function emptySums(truncated: boolean): MoneySums {
  return {
    collectedFromOwnerCents: 0,
    collectedFromOwnerInclChangeOrdersCents: 0,
    paidToSubsCents: 0,
    retainageHeldCents: 0,
    ownerRetainageHeldCents: 0,
    owedThisWeekCents: 0,
    ownerPayApps: [],
    payouts: [],
    retainage: [],
    owed: [],
    truncated,
  };
}

/** Adds one project's stored rows to the strip. Callers have already passed the tenancy guard. */
async function addProjectMoney(
  ctx: QueryCtx,
  access: ProjectAccess,
  weekEnd: string,
  budget: ReadBudget,
  sums: MoneySums,
): Promise<void> {
  const project = access.project;

  // Collected from the owner: paid owner pay apps only, at their stored current payment due.
  // Paid prime change orders stay out of this bucket; the change-order surface reports them.
  const ownerApps = await ctx.db
    .query("ownerPayApps")
    .withIndex("by_projectId_and_applicationNo", (q) => q.eq("projectId", project._id))
    .take(MAX_OWNER_PAY_APPS_PER_PROJECT + 1);
  if (ownerApps.length > MAX_OWNER_PAY_APPS_PER_PROJECT) sums.truncated = true;
  const scopedOwnerApps = ownerApps.slice(0, MAX_OWNER_PAY_APPS_PER_PROJECT);
  const paidOwnerApps = scopedOwnerApps.filter((app) => app.status === "paid");
  const paidOwnerAppsCents = sumCents(paidOwnerApps.map((app) => app.figures.currentPaymentDueCents));
  sums.collectedFromOwnerCents += paidOwnerAppsCents;
  sums.collectedFromOwnerInclChangeOrdersCents += paidOwnerAppsCents;
  for (const app of paidOwnerApps) {
    sums.ownerPayApps.push({
      projectId: project._id,
      ownerPayAppId: app._id,
      applicationNo: app.applicationNo,
      amountCents: app.figures.currentPaymentDueCents,
      retainageCents: app.figures.retainageCents,
      paypalInvoiceId: app.paypalInvoiceId ?? null,
      paidAt: app.paidAt ?? null,
    });
  }
  // The owner's retainage is the prime figure the owner-billing tab shows, never the sub ledger.
  sums.ownerRetainageHeldCents += primeRetainageHeld(scopedOwnerApps)?.cents ?? 0;

  const agreements = (
    await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(MAX_AGREEMENTS_PER_PROJECT + 1)
  )
    .filter((agreement) => agreement.status !== "draft")
    .sort((a, b) => a.agreementNumber.localeCompare(b.agreementNumber));
  if (agreements.length > MAX_AGREEMENTS_PER_PROJECT) sums.truncated = true;

  for (const agreement of agreements.slice(0, MAX_AGREEMENTS_PER_PROJECT)) {
    const financials = await loadAgreementFinancials(ctx, agreement, budget);
    if (financials.truncated) sums.truncated = true;
    // An approved pay app whose final amount cannot be established is left out of the billing rows,
    // so an owed figure could understate what is actually approved.
    if (financials.billing.unresolved.length > 0) sums.truncated = true;

    // Paid to subs: the agreement ledger's own paid total (successful payouts and retainage
    // releases, net), never re-derived from the pay apps.
    sums.paidToSubsCents += financials.totals.paidCents;
    const paymentsById = new Map(financials.history.payments.map((payment) => [payment._id as string, payment]));
    for (const payment of financials.history.payments) {
      if ((payment.kind !== "payout" && payment.kind !== "retainage_release") || payment.status !== "success") continue;
      sums.payouts.push({
        projectId: project._id,
        agreementId: agreement._id,
        agreementNumber: agreement.agreementNumber,
        paymentId: payment._id,
        payAppId: payment.payAppId ?? null,
        kind: payment.kind,
        payoutBatchId: payment.paypalPayoutBatchId ?? null,
        amountCents: payment.netCents,
        paidAt: payment.updatedAt ?? payment.createdAt,
      });
    }

    // Sub retainage held: the retainage ledger balance `projectRetainage` shows as `subHeldCents`
    // per agreement. That view leaves superseded agreements out, so the two agree exactly.
    if (agreement.status !== "superseded") {
      sums.retainageHeldCents += financials.totals.retainageHeldCents;
      for (const entry of financials.history.retainage) {
        const payment = entry.paymentId === undefined ? undefined : paymentsById.get(entry.paymentId as string);
        sums.retainage.push({
          projectId: project._id,
          agreementId: agreement._id,
          agreementNumber: agreement.agreementNumber,
          payAppId: payment?.payAppId ?? null,
          amountCents: entry.deltaCents,
          retainageBps: agreement.terms?.retainageBps ?? Math.round(agreement.retainagePercent * 100),
        });
      }
    }

    // Owed this week: approved work not yet paid, due on or before the end of the current week.
    // The amount is the stored G703 approved current payment due, with the stored final approval
    // as the legacy no-G702 fallback (loadBillingHistory also rebuilds a missing final approval).
    for (const app of financials.billing.rows) {
      if (!OWED_PAY_APP_STATUSES.has(app.status)) continue;
      const dueDate = owedDateOf(app);
      if (dueDate === null || dueDate > weekEnd) continue;
      const amountCents = app.g703?.approved?.currentPaymentDueCents ?? app.finalApproval?.totalCents ?? 0;
      sums.owedThisWeekCents += amountCents;
      sums.owed.push({
        projectId: project._id,
        payAppId: app._id,
        agreementId: agreement._id,
        agreementNumber: agreement.agreementNumber,
        dueDate,
        amountCents,
      });
    }
  }
}

/**
 * Adds the paid prime change orders to only the inclusive collected figure. This runs after every
 * project's existing ledger reads so the new field cannot consume budget ahead of an established
 * bucket. Both the per-project change-order capacity and the shared money read budget stay bounded.
 */
async function addPaidPrimeChangeOrders(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  budget: ReadBudget,
  sums: MoneySums,
): Promise<void> {
  const limit = Math.max(0, Math.min(CO_CAPACITY, budget.remaining));
  const changeOrders = await ctx.db
    .query("changeOrders")
    .withIndex("by_projectId_and_scope_and_number", (q) => q.eq("projectId", projectId).eq("scope", "prime"))
    .take(limit + 1);
  if (changeOrders.length > limit) sums.truncated = true;
  const scopedChangeOrders = changeOrders.slice(0, limit);
  budget.remaining -= scopedChangeOrders.length;
  const paidChangeOrders = scopedChangeOrders.filter((co) => OWNER_PAID_CHANGE_ORDER_STATUSES.has(co.status));
  sums.collectedFromOwnerInclChangeOrdersCents += sumCents(paidChangeOrders.map((co) => co.amountCents));
}

function trimReceipts<T>(rows: T[], sums: MoneySums): T[] {
  if (rows.length <= MAX_RECEIPTS) return rows;
  sums.truncated = true;
  return rows.slice(0, MAX_RECEIPTS);
}

/**
 * One role-guarded read for the GC money strip (architecture §6.1). With `projectId` it answers for
 * that project, which the caller must be the GC on; without it, for every project where the caller
 * is the GC. Subs and owners get "Forbidden"; another GC's project id reads "Not found.".
 */
export const getProjectMoney = query({
  args: { projectId: v.optional(v.id("projects")) },
  returns: projectMoneyValidator,
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);

    const accesses: ProjectAccess[] = [];
    let truncated = false;
    if (args.projectId !== undefined) {
      accesses.push(await requireProjectScope(ctx, args.projectId, { roles: ["gc"] }));
    } else {
      const projectIds = await accessibleProjectIds(ctx);
      if (projectIds.length > MAX_PROJECTS) truncated = true;
      for (const projectId of projectIds.slice(0, MAX_PROJECTS)) {
        const access = await requireProjectAccess(ctx, projectId);
        if (access.partyRole === "gc") accesses.push(access);
      }
    }

    const asOf = Date.now();
    const weekEnd = weekEndOf(asOf);
    const budget = createReadBudget(MONEY_READ_BUDGET);
    const sums = emptySums(truncated);
    for (const access of accesses) await addProjectMoney(ctx, access, weekEnd, budget, sums);
    for (const access of accesses) await addPaidPrimeChangeOrders(ctx, access.project._id, budget, sums);

    sums.ownerPayApps.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.applicationNo - b.applicationNo);
    sums.payouts.sort((a, b) => a.paidAt - b.paidAt || a.agreementNumber.localeCompare(b.agreementNumber));
    sums.retainage.sort((a, b) => a.agreementNumber.localeCompare(b.agreementNumber));
    sums.owed.sort(
      (a, b) =>
        a.dueDate.localeCompare(b.dueDate) ||
        a.agreementNumber.localeCompare(b.agreementNumber) ||
        a.payAppId.localeCompare(b.payAppId),
    );

    const projects: ProjectContext[] = accesses.map((access) => ({
      projectId: access.project._id,
      projectTitle: access.project.title,
      projectKind: projectKindOf(access.project),
      ownerRetainageBps: access.project.retainageBps ?? null,
    }));
    const one = args.projectId !== undefined ? projects[0] : null;
    // Trim before the return so `truncated` reflects a receipt cap too.
    const receipts = {
      ownerPayApps: trimReceipts(sums.ownerPayApps, sums),
      payouts: trimReceipts(sums.payouts, sums),
      retainage: trimReceipts(sums.retainage, sums),
      owed: trimReceipts(sums.owed, sums),
    };
    return {
      scope: {
        kind: args.projectId !== undefined ? ("project" as const) : ("portfolio" as const),
        projectId: one?.projectId ?? null,
        projectTitle: one?.projectTitle ?? null,
        projectKind: one?.projectKind ?? null,
        projects,
      },
      collectedFromOwnerCents: sums.collectedFromOwnerCents,
      collectedFromOwnerInclChangeOrdersCents: sums.collectedFromOwnerInclChangeOrdersCents,
      paidToSubsCents: sums.paidToSubsCents,
      retainageHeldCents: sums.retainageHeldCents,
      ownerRetainageHeldCents: sums.ownerRetainageHeldCents,
      owedThisWeekCents: sums.owedThisWeekCents,
      receipts,
      asOf,
      weekEnd,
      truncated: sums.truncated,
    };
  },
});
