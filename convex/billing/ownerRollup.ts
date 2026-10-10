import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { approvedWorkAndStored, isoDate, nextBillingDate } from "../payApps/g703Math";
import { loadBillingHistory } from "../payApps/billingHistory";
import { APPROVED_PAY_APP_STATUSES } from "../payApps/validation";
import { CO_APPROVED_STATUSES, isDirectlyInvoiced, type ChangeOrderStatus } from "../payments/changeOrderMath";
import { agreementContractSumCents } from "../payments/sov";
import { primeChangeOrders } from "./changeOrderView";
import {
  changeOrderKey,
  changeOrderLineLabel,
  gcKey,
  ownerG702,
  tradeKey,
  tradeLineFromToDate,
  tradeLineLabel,
  type OwnerG702,
} from "./ownerBillingMath";
import type { Infer } from "convex/values";
import type { ownerPayAppLineValidator } from "../schema";

/**
 * Builds the prime continuation sheet of an owner pay app (architecture §16): trade lines from the
 * subs' GC-approved pay apps for periods ending on or before the owner period end, the GC lines from
 * project setup and the owner-approved prime change orders not billed with "Invoice now".
 * Previous-application columns come from the owner pay app before it.
 */

export type StoredOwnerLine = Infer<typeof ownerPayAppLineValidator>;

const DEFAULT_BILLING_DAY = 25;
const PENDING_SUB_STATUSES = ["submitted", "under_review", "reviewed", "revision_requested"] as const;
const TRADE_AGREEMENT_STATUSES = new Set(["executed", "generated"]);
export const MAX_PRIME_LINES = 50;

export function ownerRetainageBps(project: Doc<"projects">): number {
  return project.retainageBps ?? 0;
}

function payAppPeriodEnd(p: Doc<"payApplications">, billingDay: number): string {
  return p.periodEnd ?? nextBillingDate(isoDate(new Date(p.createdAt)), billingDay);
}

function createdOrder(a: Doc<"payApplications">, b: Doc<"payApplications">): number {
  return a.createdAt - b.createdAt || a._creationTime - b._creationTime;
}

/** The sub's GC-approved billing to date on one agreement, through `periodEnd`. */
async function approvedToDate(ctx: QueryCtx, agreement: Doc<"agreements">, periodEnd: string, billingDay: number) {
  const history = await loadBillingHistory(ctx, agreement._id);
  const approved = history.rows
    .filter((p) => APPROVED_PAY_APP_STATUSES.has(p.status) && payAppPeriodEnd(p, billingDay) <= periodEnd)
    .sort(createdOrder);
  const toDateCents = approved.reduce((acc, p) => acc + (p.finalApproval?.totalCents ?? 0), 0);
  const latestG703 = [...approved].reverse().find((p) => p.g703 !== undefined);
  let storedToDateCents = 0;
  for (const l of latestG703?.g703?.lines ?? []) {
    const increment = latestG703!.finalApproval?.lines.find((x) => x.sovLineId === l.sovLineId)?.approvedCents ?? 0;
    storedToDateCents += approvedWorkAndStored(l, increment).storedCents;
  }
  const subRetainageCents = latestG703?.g703?.approved?.retainageCents;
  let pending = 0;
  for (const status of PENDING_SUB_STATUSES) {
    const rows = await ctx.db
      .query("payApplications")
      .withIndex("by_agreementId_and_status", (q) => q.eq("agreementId", agreement._id).eq("status", status))
      .take(50);
    pending += rows.filter((p) => payAppPeriodEnd(p, billingDay) <= periodEnd).length;
  }
  return { toDateCents, storedToDateCents, subRetainageCents, pending };
}

async function subNameOf(ctx: QueryCtx, agreement: Doc<"agreements">): Promise<string> {
  const contractor = await ctx.db.get(agreement.contractorId);
  return contractor?.companyName ?? agreement.subcontractorName;
}

/** The project's active owner company: `projects.ownerCompanyId` when set, else the one active owner member. */
export async function projectOwnerCompanyId(ctx: QueryCtx, project: Doc<"projects">): Promise<Id<"companies"> | null> {
  const members = await ctx.db
    .query("projectMembers")
    .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
    .take(200);
  const owners = members.filter((m) => m.partyRole === "owner" && m.status === "active");
  if (project.ownerCompanyId !== undefined) return owners.some((m) => m.companyId === project.ownerCompanyId) ? project.ownerCompanyId : null;
  return owners[0]?.companyId ?? null;
}

/** Retainage the owner holds on the prime contract: the latest owner-approved application's retainage to date. */
export function primeRetainageHeld(apps: readonly Doc<"ownerPayApps">[]): { cents: number; applicationNo: number } | null {
  const approved = apps.filter((a) => a.status === "approved" || a.status === "approved_invoiced" || a.status === "paid");
  const latest = approved.sort((a, b) => b.applicationNo - a.applicationNo)[0];
  return latest ? { cents: latest.figures.retainageCents, applicationNo: latest.applicationNo } : null;
}

export async function projectPrimeLines(ctx: QueryCtx, projectId: Id<"projects">): Promise<Doc<"primeLines">[]> {
  return await ctx.db
    .query("primeLines")
    .withIndex("by_projectId_and_lineNo", (q) => q.eq("projectId", projectId))
    .take(MAX_PRIME_LINES);
}

/** Owner pay apps of a project in application order. */
export async function projectOwnerPayApps(ctx: QueryCtx, projectId: Id<"projects">): Promise<Doc<"ownerPayApps">[]> {
  return await ctx.db
    .query("ownerPayApps")
    .withIndex("by_projectId_and_applicationNo", (q) => q.eq("projectId", projectId))
    .take(500);
}

export type OwnerSheet = {
  lines: StoredOwnerLine[];
  pendingSubPayApps: number;
  netChangeOrdersCents: number;
};

/**
 * The sheet for `periodEnd`. `entries` keeps the GC's this-period amounts on GC and change-order
 * lines when an existing draft is rebuilt.
 */
export async function buildOwnerSheet(
  ctx: QueryCtx,
  project: Doc<"projects">,
  opts: { periodEnd: string; previous: Doc<"ownerPayApps"> | null; entries?: ReadonlyMap<string, number> },
): Promise<OwnerSheet> {
  const bps = ownerRetainageBps(project);
  const billingDay = project.billingDay ?? DEFAULT_BILLING_DAY;
  const prev = new Map((opts.previous?.lines ?? []).map((l) => [l.key, l]));
  const prevColumns = (key: string) => {
    const p = prev.get(key);
    return { previousWorkCents: p ? p.previousWorkCents + p.workThisPeriodCents : 0, previousStoredCents: p ? p.storedCents : 0 };
  };
  const lines: StoredOwnerLine[] = [];
  let pendingSubPayApps = 0;

  const agreements = (
    await ctx.db
      .query("agreements")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(200)
  )
    .filter((a) => TRADE_AGREEMENT_STATUSES.has(a.status))
    .sort((a, b) => a.csiDivision.localeCompare(b.csiDivision) || a.agreementNumber.localeCompare(b.agreementNumber));
  for (const agreement of agreements) {
    const key = tradeKey(agreement._id);
    const billed = await approvedToDate(ctx, agreement, opts.periodEnd, billingDay);
    pendingSubPayApps += billed.pending;
    const before = prevColumns(key);
    lines.push({
      key,
      kind: "trade",
      agreementId: agreement._id,
      description: tradeLineLabel(agreement.tradeName, agreement.csiDivision, await subNameOf(ctx, agreement)),
      scheduledValueCents: agreementContractSumCents(agreement),
      ...tradeLineFromToDate({ toDateCents: billed.toDateCents, storedToDateCents: billed.storedToDateCents, ...before }),
      retainageBps: bps,
      ...(billed.subRetainageCents !== undefined ? { subRetainageCents: billed.subRetainageCents } : {}),
    });
  }

  for (const gl of await projectPrimeLines(ctx, project._id)) {
    const key = gcKey(gl._id);
    lines.push({
      key,
      kind: "gc",
      primeLineId: gl._id,
      description: gl.description,
      scheduledValueCents: gl.scheduledValueCents,
      ...prevColumns(key),
      workThisPeriodCents: opts.entries?.get(key) ?? 0,
      storedCents: 0,
      retainageBps: bps,
    });
  }

  let netChangeOrdersCents = 0;
  for (const co of await primeChangeOrders(ctx, project._id)) {
    if (!CO_APPROVED_STATUSES.has(co.status as ChangeOrderStatus)) continue;
    const key = changeOrderKey(co._id);
    // Billed with its own "Invoice now" invoice: kept off owner pay apps so it is never billed twice.
    if (isDirectlyInvoiced(co) && !prev.has(key)) continue;
    netChangeOrdersCents += co.amountCents;
    lines.push({
      key,
      kind: "change_order",
      changeOrderId: co._id,
      description: changeOrderLineLabel(co.number, co.title ?? co.description),
      scheduledValueCents: co.amountCents,
      ...prevColumns(key),
      workThisPeriodCents: opts.entries?.get(key) ?? 0,
      storedCents: 0,
      retainageBps: bps,
    });
  }

  // A line billed before that is no longer on the project (for example a superseded agreement) stays
  // on the sheet so the totals to date never drop.
  const present = new Set(lines.map((l) => l.key));
  for (const p of opts.previous?.lines ?? []) {
    if (present.has(p.key)) continue;
    lines.push({ ...p, ...prevColumns(p.key), workThisPeriodCents: 0, storedCents: p.storedCents });
  }

  return { lines, pendingSubPayApps, netChangeOrdersCents };
}

export function sheetFigures(project: Doc<"projects">, sheet: Pick<OwnerSheet, "lines" | "netChangeOrdersCents">, previous: Doc<"ownerPayApps"> | null): OwnerG702 {
  return ownerG702(sheet.lines, {
    originalContractSumCents: project.contractValueCents ?? 0,
    netChangeOrdersCents: sheet.netChangeOrdersCents,
    previousCertificatesCents: previous?.figures.earnedLessRetainageCents ?? 0,
  });
}
