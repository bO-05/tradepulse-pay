import { useQuery } from "convex/react";
import type { ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { formatCents, formatDate } from "./format";
import { FundMilestoneControl, FundingProvider, FundingStatus } from "./FundMilestone";
import { ReleaseControl, ReleaseList } from "./ReleaseMilestone";

const TOTALS: { key: "contractSumCents" | "billedCents" | "paidCents" | "retainageHeldCents" | "balanceCents"; label: string }[] = [
  { key: "contractSumCents", label: "Contract sum" },
  { key: "billedCents", label: "Billed" },
  { key: "paidCents", label: "Paid" },
  { key: "retainageHeldCents", label: "Retainage held" },
  { key: "balanceCents", label: "Balance to finish" },
];

export function AgreementLedgerView({ agreementId, backHash }: { agreementId: string; backHash: string }) {
  const ledger = useQuery(api.payments.ledger.getAgreementLedger, { agreementId });

  if (ledger === undefined) {
    return <p className="text-sm text-slate-400" role="status">Loading ledger…</p>;
  }

  if (ledger === null) {
    return (
      <div className="max-w-xl bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-3" role="alert">
        <h2 className="text-base font-semibold">Agreement not found</h2>
        <p className="text-sm text-slate-400">
          This agreement does not exist or your account does not have access to it.
        </p>
        <a href={backHash} className="inline-block text-sm text-emerald-400 hover:text-emerald-300">
          Back to payments
        </a>
      </div>
    );
  }

  const { agreement, sov, milestones, totals, canFund, canRelease, retainageLedger } = ledger;

  return (
    <div className="max-w-5xl space-y-6">
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <a href={backHash} className="text-xs text-emerald-400 hover:text-emerald-300">
              ← Payments
            </a>
            <p className="text-xs text-slate-400 mt-1" data-testid="ledger-agreement-number">
              {agreement.agreementNumber}
            </p>
            <h2 className="text-lg font-semibold">{agreement.subcontractorName}</h2>
            <p className="text-sm text-slate-400">
              {agreement.projectTitle} · Division {agreement.csiDivision} {agreement.tradeName} · Retainage{" "}
              {agreement.retainagePercent}%
            </p>
          </div>
          <span className="text-xs font-semibold uppercase tracking-wide rounded-full px-2.5 py-1 bg-slate-800 border border-slate-700">
            {agreement.status}
          </span>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm" data-testid="ledger-totals">
          {TOTALS.map((t) => (
            <div key={t.key} className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
              <dt className="text-xs text-slate-400">{t.label}</dt>
              <dd className="font-semibold tabular-nums" data-testid={`ledger-${t.key}`}>
                {formatCents(totals[t.key])}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="ledger-sov" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h3 id="ledger-sov" className="text-base font-semibold mb-3">
          Schedule of values
        </h3>
        {sov.length === 0 ? (
          <p className="text-sm text-slate-400">
            {agreement.status === "executed"
              ? "No schedule of values yet."
              : "The schedule of values is created when the agreement is executed."}
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="ledger-sov-table">
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 font-medium">Scope</th>
                <th className="py-2 pr-3 font-medium text-right">Scheduled value</th>
              </tr>
            </thead>
            <tbody>
              {sov.map((line) => (
                <tr key={line._id} className="border-t border-slate-800" data-testid="sov-line">
                  <td className="py-2 pr-3 text-slate-400">{line.lineNo}</td>
                  <td className="py-2 pr-3">{line.description}</td>
                  <td className="py-2 pr-3">
                    {line.excludedScope ? (
                      <span className="text-[11px] font-semibold uppercase rounded-full px-2 py-0.5 bg-amber-950 text-amber-300 border border-amber-800">
                        Excluded scope
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">Base scope</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatCents(line.scheduledValueCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-700 font-semibold">
                <td className="py-2 pr-3" colSpan={3}>
                  Total
                </td>
                <td className="py-2 pr-3 text-right tabular-nums" data-testid="ledger-sov-total">
                  {formatCents(ledger.sovTotalCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>

      <section aria-labelledby="ledger-milestones" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h3 id="ledger-milestones" className="text-base font-semibold mb-3">
          Milestones
        </h3>
        {milestones.length === 0 ? (
          <p className="text-sm text-slate-400">
            {agreement.status === "executed"
              ? "No milestones yet."
              : "Milestones are created when the agreement is executed."}
          </p>
        ) : (
          <MaybeFundingProvider enabled={canFund}>
            <table className="w-full text-sm" data-testid="ledger-milestones-table">
              <thead className="text-xs text-slate-400 text-left">
                <tr>
                  <th className="py-2 pr-3 font-medium">Milestone</th>
                  <th className="py-2 pr-3 font-medium">Planned date</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium text-right">Amount</th>
                  <th className="py-2 pl-3 font-medium">Funding</th>
                </tr>
              </thead>
              <tbody>
                {milestones.map((m) => (
                  <tr key={m._id} className="border-t border-slate-800" data-testid="milestone-row">
                    <td className="py-2 pr-3">{m.name}</td>
                    <td className="py-2 pr-3">{formatDate(m.plannedDate, { utc: true })}</td>
                    <td className="py-2 pr-3">
                      <span
                        className="text-xs rounded-full px-2 py-0.5 bg-slate-800 border border-slate-700"
                        data-testid="milestone-status"
                      >
                        {m.status}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatCents(m.amountCents)}</td>
                    <td className="py-2 pl-3 align-top space-y-1">
                      <FundingStatus milestone={m} />
                      {canFund && <FundMilestoneControl milestone={m} />}
                      <ReleaseList milestone={m} canRelease={canRelease} />
                      {canRelease && <ReleaseControl milestone={m} retainagePercent={agreement.retainagePercent} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </MaybeFundingProvider>
        )}
      </section>

      <section aria-labelledby="ledger-retainage" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h3 id="ledger-retainage" className="text-base font-semibold mb-3">
          Retainage ledger
        </h3>
        {retainageLedger.length === 0 ? (
          <p className="text-sm text-slate-400">No retainage held yet. Each sub payout withholds {agreement.retainagePercent}%.</p>
        ) : (
          <table className="w-full text-sm" data-testid="retainage-ledger-table">
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Reason</th>
                <th className="py-2 pr-3 font-medium text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              {retainageLedger.map((r) => (
                <tr key={r._id} className="border-t border-slate-800" data-testid="retainage-row">
                  <td className="py-2 pr-3 text-slate-400">{formatDate(r.createdAt)}</td>
                  <td className="py-2 pr-3">{r.reason}</td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${r.deltaCents < 0 ? "text-rose-300" : ""}`}>
                    {r.deltaCents > 0 ? "+" : ""}
                    {formatCents(r.deltaCents)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-700 font-semibold">
                <td className="py-2 pr-3" colSpan={2}>
                  Retainage held
                </td>
                <td className="py-2 pr-3 text-right tabular-nums" data-testid="retainage-ledger-balance">
                  {formatCents(totals.retainageHeldCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>
    </div>
  );
}

function MaybeFundingProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return enabled ? <FundingProvider>{children}</FundingProvider> : <>{children}</>;
}
