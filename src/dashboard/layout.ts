import type { AgReportState } from "ag-studio";
import type { DashboardRegistry } from "./widgets";

export const DASHBOARD_PAGE_ID = "payments-overview";

const title = (text: string, subtitle?: string) => ({
  title: { enabled: true, text },
  ...(subtitle ? { subtitle: { enabled: true, text: subtitle } } : {}),
});

/**
 * Default report: a subcontractor filter that cross-filters everything (via the agreements
 * dimension), three KPI tiles, the cash-flow pivot, the retainage gauge and the pay-app review card.
 */
export const DASHBOARD_INITIAL_STATE: AgReportState<DashboardRegistry> = {
  selectedPageId: DASHBOARD_PAGE_ID,
  pages: [
    {
      id: DASHBOARD_PAGE_ID,
      layout: { columns: 24, rowHeight: 40 },
      widgets: {
        "filter-subcontractor": {
          type: "list-filter",
          dataMapping: { value: [{ id: "agreements.subcontractor" }] },
          format: title("Subcontractor"),
        },
        "filter-kind": {
          type: "list-filter",
          dataMapping: { value: [{ id: "payments.kind" }] },
          format: title("Payment kind"),
        },
        "kpi-total-paid": {
          type: "value",
          dataMapping: { value: [{ id: "payments.paid", aggregation: "sum" }] },
          format: title("Total paid", "Net of successful payouts and retainage releases"),
        },
        "kpi-retainage-held": {
          type: "value",
          dataMapping: { value: [{ id: "retainage.balance", aggregation: "sum" }] },
          format: title("Retainage held", "Retainage ledger balance"),
        },
        "kpi-pending-pay-apps": {
          type: "value",
          dataMapping: { value: [{ id: "payApps.pending", aggregation: "sum" }] },
          format: title("Pending pay apps", "Requested, awaiting a GC decision"),
        },
        "pivot-cash-flow": {
          type: "pivot-grid",
          dataMapping: {
            rows: [{ id: "payments.month" }],
            columns: [{ id: "agreements.subcontractor" }],
            values: [{ id: "payments.paid", aggregation: "sum" }],
          },
          format: title("Cash flow by month", "Net paid per subcontractor"),
        },
        "retainage-gauge": {
          type: "retainageGauge",
          dataMapping: {
            held: [{ id: "retainage.balance", aggregation: "sum" }],
            released: [{ id: "retainage.released", aggregation: "sum" }],
            cap: [{ id: "agreements.retainageCap", aggregation: "sum" }],
          },
          format: title("Retainage held vs released"),
        },
        "pay-app-review": {
          type: "payAppReview",
          dataMapping: {
            details: [
              { id: "agreements.subcontractor" },
              { id: "payApps.period" },
              { id: "payApps.status" },
              { id: "payApps.flags" },
              { id: "payApps.payAppId" },
            ],
            requested: [{ id: "payApps.requested", aggregation: "sum" }],
            recommended: [{ id: "payApps.aiRecommended", aggregation: "sum" }],
            finalApproved: [{ id: "payApps.finalApproved", aggregation: "sum" }],
          },
          format: title("Pay-app review", "Requested vs AI recommended, with review flags"),
        },
      },
      widgetLayout: {
        "filter-subcontractor": { xTrack: 0, yTrack: 0, xSpan: 5, ySpan: 9 },
        "filter-kind": { xTrack: 0, yTrack: 9, xSpan: 5, ySpan: 6 },
        "kpi-total-paid": { xTrack: 5, yTrack: 0, xSpan: 6, ySpan: 3 },
        "kpi-retainage-held": { xTrack: 11, yTrack: 0, xSpan: 6, ySpan: 3 },
        "kpi-pending-pay-apps": { xTrack: 17, yTrack: 0, xSpan: 7, ySpan: 3 },
        "pivot-cash-flow": { xTrack: 5, yTrack: 3, xSpan: 12, ySpan: 8 },
        "retainage-gauge": { xTrack: 17, yTrack: 3, xSpan: 7, ySpan: 8 },
        "pay-app-review": { xTrack: 5, yTrack: 11, xSpan: 19, ySpan: 9 },
      },
    },
  ],
};
