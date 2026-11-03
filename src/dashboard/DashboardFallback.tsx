import { Component, type ReactNode } from "react";
import { ledgerHash } from "../auth/navigation";
import { formatCents } from "../payments/format";
import type { DashboardRaw } from "./dataSources";

/** Ordinary React ledger links: no Studio widgets, AI claims, or license dependency. */
export function DashboardFallback({ raw, reason }: { raw: Pick<DashboardRaw, "agreements"> & Partial<Pick<DashboardRaw, "changeOrders">>; reason: string }) {
  return (
    <div className="space-y-3" data-testid="dashboard-basic-view">
      <p role="status" className="text-sm text-amber-200">
        {reason} Basic view uses the same live Convex data. AG Studio layout editing and AI chat are unavailable here.
      </p>
      {raw.agreements.length === 0 && !raw.changeOrders?.length ? <p className="text-sm text-slate-400">No agreements to report.</p> : raw.agreements.length > 0 ? (
        <ul className="space-y-2">
          {raw.agreements.map((agreement) => (
            <li key={agreement.agreementId} className="rounded-lg border border-slate-800 p-3 text-sm">
              <a href={ledgerHash(agreement.agreementId)} className="text-emerald-300 underline">
                {agreement.agreementNumber} · {agreement.subcontractor}
              </a>
              <p className="text-xs text-slate-400">
                Captured {formatCents(agreement.totals.capturedCents)} · paid {formatCents(agreement.totals.paidCents)} ·
                retainage held {formatCents(agreement.totals.retainageHeldCents)} ·
                Owner prime CO income on this project (not part of this subcontract) {formatCents(agreement.totals.changeOrdersPaidCents)}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {raw.changeOrders?.length ? (
        <section aria-label="Change order payment history" className="space-y-2">
          <h2 className="font-semibold">Change order payment history</h2>
          {raw.changeOrders.map((co) => (
            <article key={co.changeOrderId} className="rounded-lg border border-slate-800 p-3 text-sm">
              <a href={`#/change-orders/${encodeURIComponent(co.changeOrderId)}`} className="text-emerald-300 underline">PCO #{co.number} · {co.description}</a>
              <p className="text-slate-300">{formatCents(co.amountCents)} · {co.status}</p>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}

/** Must be mounted inside StudioIsland: an outer root cannot catch a separate root's errors. */
export class StudioErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
