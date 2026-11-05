import { Component, type ReactNode } from "react";
import { ledgerHash } from "../auth/navigation";
import { formatCents } from "../payments/format";
import type { DashboardRaw } from "./dataSources";

/** Ordinary React ledger links: no Studio widgets, AI claims, or license dependency. */
export function DashboardFallback({ raw, reason }: { raw: Pick<DashboardRaw, "agreements"> & Partial<Pick<DashboardRaw, "changeOrders">>; reason?: string }) {
  const active = raw.agreements.filter(
    (a) => a.totals.capturedCents !== 0 || a.totals.paidCents !== 0 || a.totals.retainageHeldCents !== 0 || a.totals.changeOrdersPaidCents !== 0,
  );
  const hidden = raw.agreements.length - active.length;
  return (
    <div className="space-y-4" data-testid="dashboard-basic-view">
      {reason ? (
        <p role="status" className="text-sm text-amber-200">
          {reason} Showing the basic report instead; the optional Studio layout is unavailable here.
        </p>
      ) : (
        <p className="text-sm text-ink-subtle">Basic report from the same payment ledger. No Studio license is needed.</p>
      )}
      {active.length > 0 ? <MoneyChart agreements={active} /> : null}
      {raw.agreements.length === 0 && !raw.changeOrders?.length ? <p className="text-sm text-slate-400">No agreements to report.</p> : active.length > 0 ? (
        <ul className="space-y-2">
          {active.map((agreement) => (
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
      {hidden > 0 ? (
        <p className="text-xs text-ink-subtle">
          {hidden} agreement{hidden === 1 ? "" : "s"} with no payment activity yet {hidden === 1 ? "is" : "are"} hidden.
        </p>
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

type FallbackAgreement = Pick<DashboardRaw, "agreements">["agreements"][number];

/** One bar per agreement: paid, retainage held, captured-but-unpaid, and the remaining contract. */
function MoneyChart({ agreements }: { agreements: FallbackAgreement[] }) {
  const rows = agreements.slice(0, 8);
  return (
    <section aria-labelledby="money-chart-title" data-testid="dashboard-money-chart" className="rounded-xl border border-slate-800 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="money-chart-title" className="text-sm font-semibold">Money position by agreement</h2>
        <p className="flex flex-wrap items-center gap-3 text-[11px] text-ink-subtle">
          <Legend className="bg-emerald-500" label="Paid" />
          <Legend className="bg-amber-400" label="Retainage held" />
          <Legend className="bg-sky-500" label="Captured, not paid" />
        </p>
      </div>
      <ul className="mt-3 space-y-3">
        {rows.map((a) => {
          const paid = Math.max(0, a.totals.paidCents);
          const held = Math.max(0, a.totals.retainageHeldCents);
          const capturedPending = Math.max(0, a.totals.capturedCents - paid - held);
          const captured = paid + held + capturedPending;
          const scale = Math.max(a.contractSumCents ?? 0, captured, 1);
          const pct = (v: number) => `${((v / scale) * 100).toFixed(2)}%`;
          return (
            <li key={a.agreementId}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
                <span className="min-w-0 truncate text-slate-300">
                  {a.agreementNumber} · {a.subcontractor}
                </span>
                <span className="tabular-nums text-ink-subtle">
                  {formatCents(paid)} paid of {formatCents(a.contractSumCents ?? captured)}
                </span>
              </div>
              <div
                role="img"
                aria-label={`${a.agreementNumber}: ${formatCents(paid)} paid, ${formatCents(held)} retainage held, ${formatCents(capturedPending)} captured not paid, of ${formatCents(scale)}`}
                className="mt-1 flex h-2.5 overflow-hidden rounded-full bg-slate-800"
              >
                {paid > 0 ? <span className="bg-emerald-500" style={{ width: pct(paid) }} /> : null}
                {held > 0 ? <span className="bg-amber-400" style={{ width: pct(held) }} /> : null}
                {capturedPending > 0 ? <span className="bg-sky-500" style={{ width: pct(capturedPending) }} /> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-sm ${className}`} />
      {label}
    </span>
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
