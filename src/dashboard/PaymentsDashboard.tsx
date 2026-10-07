import { useAuthToken } from "@convex-dev/auth/react";
import { useConvex, useQuery } from "convex/react";
import { useMemo, useRef, useState } from "react";
import { AgStudioAiModule, enableStudioDevValidations, type AgAiHarnessSetup } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import { api } from "../../convex/_generated/api";
import { formatCents } from "../../convex/lib/money";
import { createTradePulseHarness } from "./aiHarness";
import { buildDashboardData, dashboardTotals } from "./dataSources";
import { DASHBOARD_INITIAL_STATE } from "./layout";
import { createConvexStudioAdapter, studioProxyUrl } from "./studioAdapter";
import { StudioIsland } from "./StudioIsland";
import { tradePulseStudioTheme } from "./theme";
import { dashboardWidgets, type DashboardRegistry } from "./widgets";

const STUDIO_MODULES = [AgStudioAiModule];

if (import.meta.env.DEV) enableStudioDevValidations();

/**
 * AG Studio payments dashboard. This module is only reached through React.lazy so Studio
 * (several MB) stays out of the entry chunk.
 */
export default function PaymentsDashboard() {
  const raw = useQuery(api.dashboard.queries.getDashboardData, {});
  const data = useMemo(() => (raw ? buildDashboardData(raw) : undefined), [raw]);
  const totals = useMemo(() => (raw ? dashboardTotals(raw) : undefined), [raw]);
  const [editing, setEditing] = useState(false);
  const convex = useConvex();
  const token = useAuthToken();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  // Built once: Studio would rebuild the harness (and drop the open chat) on a new `ai` value.
  const ai = useMemo<AgAiHarnessSetup>(() => {
    const adapter = createConvexStudioAdapter({
      url: studioProxyUrl({
        VITE_CONVEX_SITE_URL: import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
        VITE_CONVEX_URL: import.meta.env.VITE_CONVEX_URL as string | undefined,
      }),
      getToken: () => tokenRef.current,
    });
    const loadPaySummary = () => convex.query(api.dashboard.payAgent.getPaySummary, {});
    return (params) => createTradePulseHarness(params, { adapter, loadPaySummary });
  }, [convex]);

  if (raw === undefined || data === undefined || totals === undefined) {
    return <p className="text-sm text-slate-400">Loading dashboard…</p>;
  }

  const readOnly = raw.readOnly;
  const mode = !readOnly && editing ? "edit" : "view";

  return (
    <section className="space-y-3" aria-label="Payments dashboard">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold">Payments dashboard</h1>
          <p className="text-xs text-slate-400" data-testid="dashboard-convex-totals">
            Live from Convex · paid {formatCents(totals.totalPaidCents)} · retainage held{" "}
            {formatCents(totals.retainageHeldCents)} · pending pay apps {formatCents(totals.pendingPayAppCents)} ·{" "}
            {raw.payments.length} payments, {raw.payApps.length} pay apps, {raw.retainage.length} retainage entries,{" "}
            {raw.changeOrders.length} change orders
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {readOnly ? (
            <span
              className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300"
              data-testid="dashboard-read-only"
            >
              Read-only
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="rounded-lg border border-emerald-700 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-900/40"
            >
              {editing ? "Done editing" : "Edit layout"}
            </button>
          )}
        </div>
      </header>
      <StudioIsland style={{ height: "calc(100vh - 150px)", minHeight: 640 }}>
        <AgStudioProvider licenseKey={import.meta.env.VITE_AG_STUDIO_LICENSE_KEY} modules={STUDIO_MODULES}>
          <div style={{ height: "100%" }} data-testid="ag-studio-dashboard">
            <AgStudio<DashboardRegistry>
              data={data}
              mode={mode}
              theme={tradePulseStudioTheme}
              widgets={dashboardWidgets}
              initialState={DASHBOARD_INITIAL_STATE}
              ai={ai}
            />
          </div>
        </AgStudioProvider>
      </StudioIsland>
    </section>
  );
}
