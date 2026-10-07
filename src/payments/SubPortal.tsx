import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { agreementHash } from "../auth/navigation";
import { formatCents, formatDate, formatDollars } from "./format";
import { PayAppForm } from "./PayAppForm";
import { subPayoutStatusLabel } from "./payoutStatusLabel";
import { WithdrawPayAppButton } from "./WithdrawPayAppButton";

const PAY_APP_PAGE_SIZE = 25;

export function SubPortal() {
  const portal = useQuery(api.portal.mySubPortal, {});
  const payApps = usePaginatedQuery(api.portal.mySubPayApps, {}, { initialNumItems: PAY_APP_PAGE_SIZE });

  if (portal === undefined) {
    return <p className="text-sm text-slate-400" role="status">Loading your agreements…</p>;
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <section aria-labelledby="sub-profile" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 id="sub-profile" className="text-base font-semibold mb-3">
          Subcontractor profile
        </h2>
        <dl className="grid sm:grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-xs text-slate-400">Contractor</dt>
            <dd className="font-semibold" data-testid="sub-contractor-name">
              {portal.contractorName ?? "Not linked to a contractor yet"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">PayPal payout email</dt>
            <dd className="font-semibold break-all" data-testid="sub-paypal-email">
              {portal.paypalEmail ?? "Not set"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Account</dt>
            <dd className="font-semibold">{portal.displayName}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="sub-agreements" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 id="sub-agreements" className="text-base font-semibold mb-3">
          My agreements
        </h2>
        {portal.agreements.length === 0 ? (
          <p className="text-sm text-slate-400">No agreements for your company yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th className="py-2 pr-3 font-medium">Agreement</th>
                <th className="py-2 pr-3 font-medium">Subcontractor</th>
                <th className="py-2 pr-3 font-medium">Project</th>
                <th className="py-2 pr-3 font-medium text-right">Contract sum</th>
                <th className="py-2 pr-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {portal.agreements.map((a) => (
                <tr key={a._id} className="border-t border-slate-800">
                  <td className="py-2 pr-3">
                    <a href={agreementHash(a._id)} className="text-emerald-400 hover:text-emerald-300">
                      {a.agreementNumber}
                    </a>
                  </td>
                  <td className="py-2 pr-3">{a.subcontractorName}</td>
                  <td className="py-2 pr-3">{a.projectTitle}</td>
                  <td className="py-2 pr-3 text-right">{formatDollars(a.contractSum)}</td>
                  <td className="py-2 pr-3">{a.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="sub-payapp-form" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 id="sub-payapp-form" className="text-base font-semibold mb-3">
          Submit pay application
        </h2>
        <PayAppForm agreements={portal.agreements} />
      </section>

      <section aria-labelledby="sub-payapps" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 id="sub-payapps" className="text-base font-semibold mb-3">
          Pay applications
        </h2>
        {payApps.status === "LoadingFirstPage" ? (
          <p className="text-sm text-slate-400" role="status">Loading pay applications…</p>
        ) : payApps.results.length === 0 ? (
          <p className="text-sm text-slate-400">No pay applications submitted yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th className="py-2 pr-3 font-medium">Period</th>
                <th className="py-2 pr-3 font-medium">Agreement</th>
                <th className="py-2 pr-3 font-medium text-right">Requested</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Outcome</th>
                <th className="py-2 pr-3 font-medium">Submitted</th>
                <th className="py-2 pr-3 font-medium">Submitted by</th>
                <th className="py-2 pr-3 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {payApps.results.map((p) => (
                <tr key={p._id} className="border-t border-slate-800" data-testid="sub-payapp-row">
                  <td className="py-2 pr-3">{p.periodLabel}</td>
                  <td className="py-2 pr-3">{p.agreementNumber}</td>
                  <td className="py-2 pr-3 text-right">{formatCents(p.requestedTotalCents)}</td>
                  <td className="py-2 pr-3" data-testid="sub-payapp-status">
                    {p.status}
                    {p.withdrawnAt ? <span className="block text-xs text-slate-400">on {formatDate(p.withdrawnAt)}</span> : null}
                    {p.rejectedAt ? <span className="block text-xs text-slate-400">on {formatDate(p.rejectedAt)}</span> : null}
                  </td>
                  <td className="py-2 pr-3 text-xs" data-testid="sub-payapp-outcome">
                    <PayAppOutcome status={p.status} outcome={p.outcome} rejectionReason={p.rejectionReason} />
                  </td>
                  <td className="py-2 pr-3">{formatDate(p.createdAt)}</td>
                  <td className="py-2 pr-3 text-xs">
                    {p.submittedBy.actorType === "agent"
                      ? `Billing agent ${p.submittedBy.agentEmail ?? ""}${p.submittedBy.onBehalfOf ? ` on behalf of ${p.submittedBy.onBehalfOf}` : ""}`
                      : "Subcontractor (human)"}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {p.canWithdraw ? <WithdrawPayAppButton payAppId={p._id} periodLabel={p.periodLabel} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {payApps.status === "CanLoadMore" || payApps.status === "LoadingMore" ? (
          <button
            type="button"
            className="mt-3 text-sm text-emerald-400 hover:text-emerald-300 disabled:text-slate-500"
            disabled={payApps.status === "LoadingMore"}
            onClick={() => payApps.loadMore(PAY_APP_PAGE_SIZE)}
            data-testid="sub-payapp-show-older"
          >
            {payApps.status === "LoadingMore" ? "Loading older pay applications…" : "Show older pay applications"}
          </button>
        ) : null}
      </section>
    </div>
  );
}

type Outcome = {
  approvedGrossCents: number | null;
  retainageHeldCents: number | null;
  retainageWithheldCents: number | null;
  netCents: number | null;
  netPaid: boolean;
  payoutStatus: string | null;
  paypalItemStatus: string | null;
} | null;

function PayAppOutcome({ status, outcome, rejectionReason }: { status: string; outcome: Outcome; rejectionReason: string | null }) {
  if (status === "rejected") {
    return (
      <span className="text-rose-300">
        Rejected by the GC; nothing was paid.
        {rejectionReason ? (
          <span className="block text-slate-300" data-testid="sub-payapp-rejection-reason">
            Reason: {rejectionReason}
          </span>
        ) : null}
      </span>
    );
  }
  if (outcome && outcome.approvedGrossCents !== null) {
    const label = subPayoutStatusLabel(outcome.payoutStatus);
    const ledgerCredited = outcome.retainageHeldCents !== null;
    return (
      <div className="space-y-1">
        <p className={label.tone} data-testid="sub-payapp-payout-status" data-status={outcome.payoutStatus ?? ""}>
          {label.status}
        </p>
        <dl className="grid grid-cols-[auto_auto] gap-x-2 tabular-nums">
          <dt className="text-slate-400">Approved gross</dt>
          <dd data-testid="sub-payapp-approved-gross">{formatCents(outcome.approvedGrossCents)}</dd>
          <dt className="text-slate-400">{ledgerCredited ? "Retainage held" : "Retainage to withhold"}</dt>
          <dd data-testid="sub-payapp-retainage">
            {formatCents(ledgerCredited ? outcome.retainageHeldCents! : (outcome.retainageWithheldCents ?? 0))}
          </dd>
          <dt className="text-slate-400">{label.net}</dt>
          <dd data-testid="sub-payapp-net">{formatCents(outcome.netCents ?? 0)}</dd>
        </dl>
      </div>
    );
  }
  if (status === "approved") return <span>Approved; payment is being sent.</span>;
  return <span className="text-slate-400">—</span>;
}
