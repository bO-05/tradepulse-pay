import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { agreementHash, payAppHash, sovHash } from "../auth/navigation";
import { formatCents, formatDate, formatDollars } from "./format";
import { subPayoutStatusLabel } from "./payoutStatusLabel";
import { WithdrawPayAppButton } from "./WithdrawPayAppButton";
import { submissionAttribution } from "./SubmissionAttribution";
import { MilestoneFundingTable } from "./MilestoneFundingSummary";
import { statusLabelFor } from "../ui/statusLabels";
import { demoDisplayName, demoPeriodLabel, demoProjectName } from "../lib/demoCopy";
import { maskSandboxEmail } from "../lib/demoPrivacy";

const PAY_APP_PAGE_SIZE = 25;

export function SubPortal() {
  const portal = useQuery(api.portal.mySubPortal, {});
  const payApps = usePaginatedQuery(api.portal.mySubPayApps, {}, { initialNumItems: PAY_APP_PAGE_SIZE });

  if (portal === undefined) {
    return <p className="text-sm text-slate-400" role="status">Loading your agreements…</p>;
  }
  const residential = portal.agreements.length > 0 && portal.agreements.every((a) => a.projectKind === "residential");

  return (
    <div className="space-y-6 max-w-5xl">
      <h1 className="text-xl font-semibold">My agreements & pay applications</h1>
      <section aria-labelledby="sub-profile" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 id="sub-profile" className="text-base font-semibold mb-3">
          Subcontractor profile
        </h2>
        <dl className="grid sm:grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-xs text-slate-400">Contractor</dt>
            <dd className="font-semibold" data-testid="sub-contractor-name">
              {portal.contractorName ? demoDisplayName(portal.contractorName) : "Not linked to a contractor yet"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">PayPal payout email</dt>
            <dd className="font-semibold break-all" data-testid="sub-paypal-email">
              {portal.paypalEmail ? maskSandboxEmail(portal.paypalEmail) : "Not set"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Account</dt>
            <dd className="font-semibold">{demoDisplayName(portal.displayName)}</dd>
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
          <div className="table-scroll" role="region" aria-label="My agreements" tabIndex={0}><table className="w-full text-sm">
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th className="py-2 pr-3 font-medium">Agreement</th>
                <th className="py-2 pr-3 font-medium">Subcontractor</th>
                <th className="py-2 pr-3 font-medium">Project</th>
                <th className="py-2 pr-3 font-medium text-right">Contract sum</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">
                  <span className="sr-only">Schedule of values</span>
                </th>
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
                  <td className="py-2 pr-3">{demoDisplayName(a.subcontractorName)}</td>
                  <td className="py-2 pr-3">{demoProjectName(a.projectTitle)}</td>
                  <td className="py-2 pr-3 text-right">{formatDollars(a.contractSum)}</td>
                  <td className="py-2 pr-3">{statusLabelFor(a.status, a.projectKind)}</td>
                  <td className="py-2 pr-3">
                    <a href={sovHash(a._id)} className="text-emerald-400 hover:text-emerald-300">
                      Schedule of values
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <section aria-labelledby="sub-milestone-funding" className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div>
          <h2 id="sub-milestone-funding" className="text-base font-semibold">
            Milestone funding
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Whether the GC has funded each milestone of your executed agreements, newest first. Funding is handled by the GC.
          </p>
        </div>
        {portal.milestoneFunding.length === 0 ? (
          <p className="text-sm text-slate-400">{residential ? "No signed agreements yet." : "No executed agreements yet."}</p>
        ) : (
          portal.milestoneFunding.map((a) => (
            <div key={a.agreementId} data-testid="sub-milestone-funding-agreement">
              <h3 className="text-sm font-semibold mb-1">
                {a.agreementNumber} <span className="font-normal text-slate-400">· {demoProjectName(a.projectTitle)}</span>
              </h3>
              <MilestoneFundingTable milestones={a.milestones} label={`Milestone funding for ${a.agreementNumber}`} />
            </div>
          ))
        )}
      </section>

      <section aria-labelledby="sub-payapp-form" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 id="sub-payapp-form" className="text-base font-semibold mb-3">
          Submit pay application
        </h2>
        <p className="text-sm text-slate-300">
          {residential
            ? "Pay applications are filed per billing period on the pay app breakdown and summary."
            : "Pay applications are filed per billing period on the G702/G703 continuation sheet."}{" "}
          <a href="#/pay-apps" className="text-emerald-400 hover:text-emerald-300">
            Open Pay apps
          </a>{" "}
          to start or continue one.
        </p>
      </section>

      <section aria-labelledby="sub-payapps" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 id="sub-payapps" className="text-base font-semibold mb-3">
          Pay applications
        </h2>
        {payApps.status === "LoadingFirstPage" ? (
          <p className="text-sm text-slate-400" role="status">Loading pay applications…</p>
        ) : payApps.results.length === 0 ? (
          <p className="text-sm text-slate-400">No pay applications yet.</p>
        ) : (
          <div className="table-scroll" role="region" aria-label="My pay applications" tabIndex={0}><table className="w-full text-sm">
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
                  <td className="py-2 pr-3">
                    <a href={payAppHash(p._id)} className="text-emerald-400 hover:text-emerald-300">
                      {demoPeriodLabel(p.periodLabel)}
                    </a>
                  </td>
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
                  <td className="py-2 pr-3">{p.status === "draft" ? `Created ${formatDate(p.createdAt)} · not submitted` : formatDate(p.submittedAt ?? p.createdAt)}</td>
                  <td className="py-2 pr-3 text-xs">
                    {p.status === "draft" ? "Unsubmitted draft · created by the subcontractor" : submissionAttribution(p.submittedBy, p.judgeDemoFiledBy)}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {p.canWithdraw ? <WithdrawPayAppButton payAppId={p._id} periodLabel={demoPeriodLabel(p.periodLabel)} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
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
  if (status === "approved" || status === "approved_as_noted") return <span>Approved; payment is being sent.</span>;
  if (status === "revision_requested") return <span className="text-amber-300">The GC requested a revision. Open the pay app to revise it.</span>;
  return <span className="text-slate-400">—</span>;
}
