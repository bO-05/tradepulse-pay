import { useQuery } from "convex/react";
import { lazy, Suspense, useState } from "react";
import { api } from "../../convex/_generated/api";
import { formatCents } from "../../convex/lib/money";
import { incompleteNotice } from "./dataSources";
import { DashboardFallback, StudioErrorBoundary } from "./DashboardFallback";

const StudioDashboard = lazy(() => import("./StudioDashboard"));
/**
 * AG Studio payments dashboard. This module is only reached through React.lazy so Studio
 * (several MB) stays out of the entry chunk.
 */
export default function PaymentsDashboard() {
  const raw = useQuery(api.dashboard.queries.getDashboardData, {});
  const hasStudioKey = Boolean(import.meta.env.VITE_AG_STUDIO_LICENSE_KEY?.trim());
  const [basicView, setBasicView] = useState(false);

  if (raw === undefined) {
    return <p className="text-sm text-slate-400">Loading dashboard…</p>;
  }

  const { totals, incomplete } = raw;
  const readOnly = raw.readOnly;
  const fallback = <DashboardFallback raw={raw} reason="AG Studio could not load. Check the deployment's license and configuration." />;

  return (
    <section className="space-y-3" aria-label="Payments dashboard">
      <header className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold">Payments dashboard</h1>
          <p className="text-xs text-slate-400" data-testid="dashboard-convex-totals">
            Live from Convex · paid {formatCents(totals.paidCents)} · retainage held{" "}
            {formatCents(totals.retainageHeldCents)} · released {formatCents(totals.retainageReleasedCents)} · pending
            pay apps {formatCents(totals.pendingPayAppCents)} ·{" "}
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
          ) : null}
          {hasStudioKey && (
            <button
              type="button"
              onClick={() => setBasicView((v) => !v)}
              className="rounded-lg border border-emerald-700 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-900/40"
            >
              {basicView ? "Try AG Studio" : "Use basic view"}
            </button>
          )}
        </div>
      </header>
      {incomplete.truncated ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-600 bg-amber-950/40 px-3 py-2 text-xs text-amber-200"
          data-testid="dashboard-data-incomplete"
        >
          {incompleteNotice(incomplete)}
        </p>
      ) : null}
      {!hasStudioKey || basicView ? (
        <DashboardFallback raw={raw} reason={!hasStudioKey ? "AG Studio license is not configured." : "Basic view selected."} />
      ) : (
        <StudioErrorBoundary fallback={fallback}>
          <Suspense fallback={<p className="text-sm text-slate-400">Loading AG Studio…</p>}>
            <StudioDashboard raw={raw} />
          </Suspense>
        </StudioErrorBoundary>
      )}
    </section>
  );
}
