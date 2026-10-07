import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { centsToDollarsForDisplay, sumCents } from "../../convex/lib/money";

export type DashboardRaw = FunctionReturnType<typeof api.dashboard.queries.getDashboardData>;

/** Payment kinds whose successful net reaches the subcontractor (same rule as the agreement ledger). */
const PAID_KINDS = new Set(["payout", "retainage_release"]);
/** Pay applications still waiting on a GC decision (same set as convex/dashboard/queries.ts). */
export const PENDING_PAY_APP_STATUSES = new Set(["submitted", "under_review", "reviewed"]);

const dollars = (cents: number) => centsToDollarsForDisplay(cents);

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isoMonth(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export function paidNetCents(p: { kind: string; status: string; netCents: number }): number {
  return PAID_KINDS.has(p.kind) && p.status === "success" ? p.netCents : 0;
}

function verdictFlags(app: DashboardRaw["payApps"][number]): string {
  const flags: string[] = [];
  if (app.overbilledLines > 0) flags.push("overbilled");
  if (app.excludedScopeLines > 0) flags.push("excluded_scope");
  if (app.frontLoadedLines > 0) flags.push("front_loaded");
  if (app.outOfSequenceLines > 0) flags.push("out_of_sequence");
  if (app.lienWaiverMissing) flags.push("lien_waiver_missing");
  if (app.licenseIssue) flags.push("license_issue");
  return flags.length > 0 ? flags.join(", ") : "none";
}

/**
 * The KPI figures in cents, computed the way the Studio KPI tiles and the retainage gauge
 * aggregate the rows. They must equal the server's ledger totals (`raw.totals`).
 */
export function dashboardTotals(raw: Pick<DashboardRaw, "payments" | "payApps" | "retainage">) {
  return {
    totalPaidCents: sumCents(raw.payments.map(paidNetCents)),
    retainageHeldCents: sumCents(raw.retainage.map((r) => r.deltaCents)),
    retainageReleasedCents: sumCents(raw.retainage.map((r) => r.releasedCents)),
    pendingPayAppCents: sumCents(
      raw.payApps.filter((a) => PENDING_PAY_APP_STATUSES.has(a.status)).map((a) => a.requestedCents),
    ),
  };
}

/** The visible notice shown when the server hit a read safety bound instead of dropping rows silently. */
export function incompleteNotice(incomplete: DashboardRaw["incomplete"]): string {
  const parts = ["Data incomplete: the payment history is larger than the dashboard can read in one query."];
  if (incomplete.agreementsTruncated) parts.push("Only the newest agreements are included.");
  if (incomplete.agreementNumbers.length > 0) {
    parts.push(`The oldest rows are left out for ${incomplete.agreementNumbers.join(", ")}.`);
  }
  parts.push("Totals understate the full ledger.");
  return parts.join(" ");
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (id: string, name: string, description?: string) => ({
  id,
  name,
  description,
  format: "currencyFormat" as const,
  formatOptions: { format: usd },
});
const text = (id: string, name: string, extra: { hide?: boolean; description?: string } = {}) => ({
  id,
  name,
  format: "textFormat" as const,
  ...extra,
});
const int = (id: string, name: string, description?: string) => ({
  id,
  name,
  description,
  format: "integerFormat" as const,
  formatOptions: { format: "0" },
});
const date = (id: string, name: string) => ({ id, name, format: "dateFormat" as const });
const bool = (id: string, name: string) => ({ id, name, format: "booleanFormat" as const });

/**
 * Studio data definition: one conformed `agreements` dimension (subcontractor, trade, project)
 * and one fact table per money stream, each joined many-to-one on agreementId so a filter on
 * the subcontractor cross-filters every widget. Dollars are display-only numbers from cents.
 */
export function buildDashboardData(raw: DashboardRaw) {
  const agreements = raw.agreements.map((a) => ({
    agreementId: a.agreementId,
    agreementNumber: a.agreementNumber,
    subcontractor: a.subcontractor,
    trade: a.trade,
    project: a.project,
    status: a.status,
    contractSum: dollars(a.contractSumCents),
    retainagePercent: a.retainagePercent,
    retainageCap: dollars(a.retainageCapCents),
  }));
  const payments = raw.payments.map((p) => ({
    paymentId: p.paymentId,
    agreementId: p.agreementId,
    kind: p.kind,
    status: p.status,
    date: isoDate(p.createdAt),
    month: isoMonth(p.createdAt),
    gross: dollars(p.grossCents),
    retainage: dollars(p.retainageCents),
    net: dollars(p.netCents),
    paid: dollars(paidNetCents(p)),
    captured: dollars(p.capturedCents),
  }));
  const payApps = raw.payApps.map((a) => ({
    payAppId: a.payAppId,
    agreementId: a.agreementId,
    period: a.periodLabel,
    status: a.status,
    date: isoDate(a.createdAt),
    requested: dollars(a.requestedCents),
    aiRecommended: a.aiRecommendedCents === null ? null : dollars(a.aiRecommendedCents),
    finalApproved: a.finalApprovedCents === null ? null : dollars(a.finalApprovedCents),
    pending: dollars(PENDING_PAY_APP_STATUSES.has(a.status) ? a.requestedCents : 0),
    reviewEngine: a.reviewEngine ?? "not reviewed",
    flags: verdictFlags(a),
    overbilledLines: a.overbilledLines,
    excludedScopeLines: a.excludedScopeLines,
    lienWaiverMissing: a.lienWaiverMissing,
    licenseIssue: a.licenseIssue,
  }));
  const retainage = raw.retainage.map((r) => ({
    entryId: r.entryId,
    agreementId: r.agreementId,
    date: isoDate(r.createdAt),
    month: isoMonth(r.createdAt),
    reason: r.reason,
    paymentKind: r.paymentKind ?? "none",
    balance: dollars(r.deltaCents),
    withheld: dollars(r.withheldCents),
    released: dollars(r.releasedCents),
  }));
  const changeOrders = raw.changeOrders.map((c) => ({
    changeOrderId: c.changeOrderId,
    agreementId: c.agreementId,
    number: c.number,
    description: c.description,
    status: c.status,
    date: isoDate(c.createdAt),
    amount: dollars(c.amountCents),
  }));
  const milestones = raw.milestones.map((m) => ({
    milestoneId: m.milestoneId,
    agreementId: m.agreementId,
    name: m.name,
    order: m.order,
    status: m.status,
    plannedDate: isoDate(m.plannedDate),
    amount: dollars(m.amountCents),
  }));

  const fact = (tableId: string) => ({
    id: `${tableId}-agreements`,
    source: { tableId, fieldId: "agreementId" },
    target: { tableId: "agreements", fieldId: "agreementId" },
    type: "many-to-one" as const,
  });

  return {
    description:
      "TradePulse Pay payments data for the signed-in GC's projects. Amounts are US dollars derived from integer cents in Convex.",
    sources: [
      {
        id: "agreements",
        name: "Agreements",
        description: "One row per subcontract agreement (conformed dimension).",
        data: agreements,
        fields: [
          text("agreementId", "Agreement ID", { hide: true }),
          text("agreementNumber", "Agreement #"),
          text("subcontractor", "Subcontractor"),
          text("trade", "Trade"),
          text("project", "Project"),
          text("status", "Agreement status"),
          money("contractSum", "Contract sum"),
          { id: "retainagePercent", name: "Retainage %", format: "decimalFormat" as const },
          money("retainageCap", "Retainage cap", "Contract sum × retainage %: the most retainage the agreement can hold."),
        ],
      },
      {
        id: "payments",
        name: "Payments",
        description: "Funding authorizations, milestone payouts and retainage releases.",
        data: payments,
        fields: [
          text("paymentId", "Payment ID"),
          text("agreementId", "Agreement ID", { hide: true }),
          text("kind", "Kind"),
          text("status", "Status"),
          date("date", "Date"),
          text("month", "Month"),
          money("gross", "Gross"),
          money("retainage", "Retainage withheld"),
          money("net", "Net"),
          money("paid", "Paid (net)", "Net of successful payouts and retainage releases; 0 otherwise."),
          money("captured", "Captured"),
        ],
      },
      {
        id: "payApps",
        name: "Pay applications",
        description: "Subcontractor pay applications with the AI review recommendation and the GC's final approval.",
        data: payApps,
        fields: [
          text("payAppId", "Pay app ID"),
          text("agreementId", "Agreement ID", { hide: true }),
          text("period", "Period"),
          text("status", "Status"),
          date("date", "Submitted"),
          money("requested", "Requested"),
          money("aiRecommended", "AI recommended", "Code-computed approved total from the review verdicts."),
          money("finalApproved", "GC final approved"),
          money("pending", "Pending amount", "Requested amount of pay apps still awaiting a GC decision."),
          text("reviewEngine", "Review engine"),
          text("flags", "Review flags"),
          int("overbilledLines", "Overbilled lines"),
          int("excludedScopeLines", "Excluded-scope lines"),
          bool("lienWaiverMissing", "Lien waiver missing"),
          bool("licenseIssue", "License issue"),
        ],
      },
      {
        id: "retainage",
        name: "Retainage ledger",
        description:
          "Signed ledger entries. Balance sum = retainage held. Released counts only retainage-release entries (a failed release's restoring credit cancels it); payout reversals lower withheld, not released. Held = withheld − released.",
        data: retainage,
        fields: [
          text("entryId", "Entry ID"),
          text("agreementId", "Agreement ID", { hide: true }),
          date("date", "Date"),
          text("month", "Month"),
          text("reason", "Reason"),
          text("paymentKind", "Payment kind"),
          money("balance", "Retainage held", "Signed delta; the sum is the retainage currently held."),
          money("withheld", "Withheld", "Withheld from payouts, net of failed or returned payout reversals."),
          money("released", "Released", "Released at closeout, net of failed or returned releases."),
        ],
      },
      {
        id: "changeOrders",
        name: "Change orders",
        description: "Change orders invoiced to the owner through PayPal.",
        data: changeOrders,
        fields: [
          text("changeOrderId", "Change order ID"),
          text("agreementId", "Agreement ID", { hide: true }),
          int("number", "CO #"),
          text("description", "Description"),
          text("status", "Status"),
          date("date", "Created"),
          money("amount", "Amount"),
        ],
      },
      {
        id: "milestones",
        name: "Milestones",
        description: "Agreement payment milestones.",
        data: milestones,
        fields: [
          text("milestoneId", "Milestone ID"),
          text("agreementId", "Agreement ID", { hide: true }),
          text("name", "Milestone"),
          int("order", "Order"),
          text("status", "Status"),
          date("plannedDate", "Planned date"),
          money("amount", "Amount"),
        ],
      },
    ],
    relationships: ["payments", "payApps", "retainage", "changeOrders", "milestones"].map(fact),
  };
}
