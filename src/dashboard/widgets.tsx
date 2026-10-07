import { useEffect, useState } from "react";
import type {
  AgDefaultWidgetDefinition,
  AgFormatShapeParams,
  AgWidgetData,
  AgWidgetDataFormat,
  AgWidgetField,
  AgWidgetFieldReference,
  AgWidgetParams,
} from "ag-studio";
import { createWidgets, type AgRegistry, type AgWidgetDefinition } from "ag-studio-react";
import { fromDollars, formatCents } from "../../convex/lib/money";
import { TRADEPULSE_PALETTE as P } from "./theme";

type CardFormat = AgWidgetDataFormat<unknown>;

export type PayAppReviewMapping = {
  details: AgWidgetFieldReference[];
  requested: AgWidgetFieldReference[];
  recommended: AgWidgetFieldReference[];
  finalApproved?: AgWidgetFieldReference[];
};
export type PayAppReviewWidget = AgWidgetData<PayAppReviewMapping, CardFormat> & { type: "payAppReview" };

export type RetainageGaugeMapping = {
  held: AgWidgetFieldReference[];
  released?: AgWidgetFieldReference[];
  cap?: AgWidgetFieldReference[];
};
export type RetainageGaugeWidget = AgWidgetData<RetainageGaugeMapping, CardFormat> & { type: "retainageGauge" };

type PayAppReviewDefinition = AgWidgetDefinition<"payAppReview", PayAppReviewWidget>;
type RetainageGaugeDefinition = AgWidgetDefinition<"retainageGauge", RetainageGaugeWidget>;

export interface DashboardRegistry extends AgRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | PayAppReviewDefinition | RetainageGaugeDefinition)[];
}

/** Display dollars from the engine back to exact cents before formatting, so cards and Convex agree to the cent. */
function money(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? formatCents(fromDollars(value)) : "—";
}

function cell(row: Record<string, unknown>, field: AgWidgetField | undefined): unknown {
  return field ? row[field.key] : undefined;
}

function useWidgetRows<TParams extends AgWidgetParams<PayAppReviewWidget | RetainageGaugeWidget>>(
  params: TParams,
  load: (params: TParams) => Promise<Record<string, unknown>[][] | null>,
) {
  const [rows, setRows] = useState<Record<string, unknown>[][] | null>(null);
  useEffect(() => {
    let cancelled = false;
    params.widgetApi.setDisplayState("loading", { prominent: rows === null });
    load(params)
      .then((result) => {
        if (cancelled) return;
        if (result === null) {
          params.widgetApi.setDisplayState("incompleteDataMapping");
          return;
        }
        setRows(result);
        params.widgetApi.setDisplayState(result.every((r) => r.length === 0) ? "noData" : "displayed");
      })
      .catch(() => {
        if (!cancelled) params.widgetApi.setDisplayState("noData");
      });
    return () => {
      cancelled = true;
    };
    // Studio hands a new params object on every refresh (data, filter or format change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  return rows;
}

const FLAG_STYLE: Record<string, string> = {
  overbilled: P.rose,
  excluded_scope: P.amber,
  front_loaded: P.amber,
  out_of_sequence: P.violet,
  lien_waiver_missing: P.rose,
  license_issue: P.rose,
};

function PayAppReviewCard(params: AgWidgetParams<PayAppReviewWidget>) {
  const { dataMapping } = params;
  const details = dataMapping.details ?? [];
  const requested = dataMapping.requested?.[0];
  const recommended = dataMapping.recommended?.[0];
  const finalApproved = dataMapping.finalApproved?.[0];
  const rows = useWidgetRows(params, async (p) => {
    if (details.length === 0 || !requested || !recommended) return null;
    const fields = [...details, requested, recommended, ...(finalApproved ? [finalApproved] : [])];
    const res = await p.widgetApi.getData({ fields, limit: { count: 50 } });
    return [res.results.rows];
  });
  const list = rows?.[0] ?? [];
  const flagsField = details.find((f) => /flags/i.test(String(f.fieldId)));
  const labelFields = details.filter((f) => f !== flagsField && !/payAppId/i.test(String(f.fieldId)));
  return (
    <div style={{ height: "100%", overflow: "auto", padding: 8, color: P.text, fontSize: 12 }} data-testid="pay-app-review-card">
      {list.map((row, i) => {
        const flags = String(cell(row, flagsField) ?? "none")
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f && f !== "none");
        const req = cell(row, requested);
        const rec = cell(row, recommended);
        const fin = cell(row, finalApproved);
        return (
          <div
            key={i}
            style={{ border: `1px solid ${P.border}`, borderRadius: 10, padding: 8, marginBottom: 6, background: P.panel }}
          >
            <div style={{ fontWeight: 600, color: P.emeraldLight }}>
              {labelFields.map((f) => String(cell(row, f) ?? "")).filter(Boolean).join(" · ")}
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 4, flexWrap: "wrap" }}>
              <span>
                Requested <strong>{money(req)}</strong>
              </span>
              <span>
                AI recommended <strong>{rec === null || rec === undefined ? "not reviewed" : money(rec)}</strong>
              </span>
              {finalApproved ? (
                <span>
                  GC approved <strong>{fin === null || fin === undefined ? "—" : money(fin)}</strong>
                </span>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
              {flags.length === 0 ? (
                <span style={{ color: P.subtleText }}>No review flags</span>
              ) : (
                flags.map((f) => (
                  <span
                    key={f}
                    style={{
                      border: `1px solid ${FLAG_STYLE[f] ?? P.border}`,
                      color: FLAG_STYLE[f] ?? P.text,
                      borderRadius: 999,
                      padding: "0 6px",
                      fontSize: 11,
                    }}
                  >
                    {f}
                  </span>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RetainageGauge(params: AgWidgetParams<RetainageGaugeWidget>) {
  const held = params.dataMapping.held?.[0];
  const released = params.dataMapping.released?.[0];
  const cap = params.dataMapping.cap?.[0];
  const rows = useWidgetRows(params, async (p) => {
    if (!held) return null;
    // Separate queries: these measures live on different tables, and summing a dimension
    // measure across the fact join would count it once per ledger row.
    const queries = [held, released, cap].map((field, i) =>
      field
        ? p.widgetApi.getData({ fields: [field] }, { queryId: `retainage-${i}` }).then((r) => r.results.rows)
        : Promise.resolve([] as Record<string, unknown>[]),
    );
    return await Promise.all(queries);
  });
  const value = (i: number, field: AgWidgetField | undefined) => {
    const v = rows?.[i]?.[0] ? cell(rows[i][0], field) : undefined;
    return typeof v === "number" ? v : 0;
  };
  const heldValue = value(0, held);
  const releasedValue = value(1, released);
  const capValue = value(2, cap);
  // Fill against everything withheld so far (held + released); the cap is shown as context.
  const max = released ? heldValue + releasedValue : capValue;
  const pct = max > 0 ? Math.min(1, Math.max(0, heldValue / max)) : 0;
  const pctText = pct > 0 && pct < 0.01 ? (pct * 100).toFixed(2) : String(Math.round(pct * 100));
  const angle = Math.PI * pct;
  const r = 70;
  const arc = (a: number) => `${80 - r * Math.cos(a)} ${85 - r * Math.sin(a)}`;
  return (
    <div
      style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: P.text }}
      data-testid="retainage-gauge"
    >
      <svg viewBox="0 0 160 95" style={{ width: "100%", maxWidth: 260 }} role="img" aria-label="Retainage held gauge">
        <path d={`M ${arc(0)} A ${r} ${r} 0 0 1 ${arc(Math.PI)}`} stroke={P.raised} strokeWidth={14} fill="none" />
        {pct > 0 ? (
          <path d={`M ${arc(0)} A ${r} ${r} 0 0 1 ${arc(angle)}`} stroke={P.emerald} strokeWidth={14} fill="none" />
        ) : null}
        <text x={80} y={78} textAnchor="middle" fill={P.text} fontSize={14} fontWeight={700}>
          {money(heldValue)}
        </text>
        <text x={80} y={92} textAnchor="middle" fill={P.subtleText} fontSize={8}>
          held {max > 0 ? `· ${pctText}% of ${released ? "withheld" : "cap"}` : ""}
        </text>
      </svg>
      <div style={{ display: "flex", gap: 12, fontSize: 12, marginTop: 4, flexWrap: "wrap", justifyContent: "center" }}>
        <span>
          Held <strong>{money(heldValue)}</strong>
        </span>
        {released ? (
          <span>
            Released <strong>{money(releasedValue)}</strong>
          </span>
        ) : null}
        {cap ? (
          <span>
            Cap <strong>{money(capValue)}</strong>
          </span>
        ) : null}
      </div>
    </div>
  );
}

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="3" y="5" width="26" height="22" rx="4" fill="none" stroke="#10b981" stroke-width="2"/><path d="M8 12h16M8 17h10M8 22h6" stroke="#10b981" stroke-width="2"/></svg>';
const GAUGE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M4 24a12 12 0 0 1 24 0" fill="none" stroke="#334155" stroke-width="4"/><path d="M4 24a12 12 0 0 1 16-11.3" fill="none" stroke="#10b981" stroke-width="4"/></svg>';

/**
 * Studio exposes no public shape builder, so both cards reuse the built-in KPI (value) widget's
 * format shape: it covers the title, subtitle, caption, appearance and cross-filter settings the
 * cards read, which is what the AI needs to configure them.
 */
function builtInValueFormatShape(params: AgFormatShapeParams) {
  const base = createWidgets<DashboardRegistry>({ additionalTypes: [] } as never).widgets.find((w) => w.id === "value");
  if (!base?.formatShape) throw new Error("AG Studio value widget has no format shape");
  return base.formatShape(params);
}

export const PAY_APP_REVIEW_DEFINITION: PayAppReviewDefinition = {
  id: "payAppReview",
  label: "Pay-app review",
  icon: ICON,
  comp: PayAppReviewCard,
  dataMapping: {
    details: {
      type: "fieldset",
      supportedRoles: ["category"],
      requires: { cardinality: "many" },
      required: true,
      aiDescription: "Fields that identify each pay application (subcontractor, period, status, payAppId) and the review flags text.",
    },
    requested: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { per: "dataMapping.details", cardinality: "one" },
      required: true,
      aiDescription: "Requested amount of the pay application (payApps.requested, sum).",
    },
    recommended: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { per: "dataMapping.details", cardinality: "one" },
      required: true,
      aiDescription: "AI review recommended approved total, computed by code (payApps.aiRecommended, sum).",
    },
    finalApproved: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { per: "dataMapping.details", cardinality: "one" },
      aiDescription: "The GC's final approved amount (payApps.finalApproved, sum).",
    },
  },
  defaultState: {
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
  },
  formatShape: builtInValueFormatShape as PayAppReviewDefinition["formatShape"],
  form: (params) =>
    params.createDefaults({
      dataMappingItems: [
        { key: "details", label: "Pay app details" },
        { key: "requested", label: "Requested" },
        { key: "recommended", label: "AI recommended" },
        { key: "finalApproved", label: "GC approved" },
      ],
    }),
  defaultSize: { width: 520, height: 360 },
  minSize: { width: 280, height: 160 },
  ai: {
    label: "Pay-app review card",
    description:
      "A list of pay application cards. Each card shows requested vs AI-recommended (and GC-approved) dollars and the review verdict flags such as overbilled, excluded_scope, lien_waiver_missing.",
    usage: "Use to review pay applications and their AI review flags. Not for time series.",
    configuration:
      "Map details to agreements.subcontractor, payApps.period, payApps.status, payApps.flags and payApps.payAppId; requested to payApps.requested (sum); recommended to payApps.aiRecommended (sum); finalApproved to payApps.finalApproved (sum).",
  },
};

export const RETAINAGE_GAUGE_DEFINITION: RetainageGaugeDefinition = {
  id: "retainageGauge",
  label: "Retainage gauge",
  icon: GAUGE_ICON,
  comp: RetainageGauge,
  dataMapping: {
    held: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { cardinality: "one" },
      required: true,
      aiDescription: "Retainage currently held: retainage.balance with sum (the signed ledger balance).",
    },
    released: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { cardinality: "one" },
      aiDescription: "Retainage released so far: retainage.released with sum.",
    },
    cap: {
      type: "field",
      supportedRoles: ["numeric"],
      requires: { cardinality: "one" },
      aiDescription: "Maximum retainage (agreements.retainageCap with sum). Shown as context; the gauge fills against the cap only when released is not mapped.",
    },
  },
  defaultState: {
    dataMapping: {
      held: [{ id: "retainage.balance", aggregation: "sum" }],
      released: [{ id: "retainage.released", aggregation: "sum" }],
      cap: [{ id: "agreements.retainageCap", aggregation: "sum" }],
    },
  },
  formatShape: builtInValueFormatShape as RetainageGaugeDefinition["formatShape"],
  form: (params) =>
    params.createDefaults({
      dataMappingItems: [
        { key: "held", label: "Held" },
        { key: "released", label: "Released" },
        { key: "cap", label: "Cap" },
      ],
    }),
  defaultSize: { width: 360, height: 260 },
  minSize: { width: 220, height: 160 },
  ai: {
    label: "Retainage gauge",
    description:
      "A half-circle gauge of retainage held, filled against total withheld (held + released) or, without released, against the cap.",
    usage: "Use to show how much retainage is held against what was released or the cap.",
    configuration:
      "Map held to retainage.balance (sum), released to retainage.released (sum) and cap to agreements.retainageCap (sum).",
  },
};

export const dashboardWidgets = createWidgets<DashboardRegistry>({
  additionalTypes: [PAY_APP_REVIEW_DEFINITION, RETAINAGE_GAUGE_DEFINITION],
  menu: [
    { label: "TradePulse", widgetIds: ["payAppReview", "retainageGauge"] },
    { label: "Value", widgetIds: ["value", "radial-gauge", "linear-gauge"] },
    { label: "Table", widgetIds: ["grid", "pivot-grid"] },
    { label: "Column Chart", widgetIds: ["column-chart-grouped", "column-chart-stacked"] },
    { label: "Bar Chart", widgetIds: ["bar-chart-grouped", "bar-chart-stacked"] },
    { label: "Line Chart", widgetIds: ["line-chart", "area-chart"] },
    { label: "Proportional Chart", widgetIds: ["pie-chart", "donut-chart"] },
    { label: "Filter", widgetIds: ["list-filter", "button-filter", "date-filter"] },
    { label: "Static Content", widgetIds: ["text"] },
  ],
});
