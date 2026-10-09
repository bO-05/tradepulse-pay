import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { NotFoundState } from "../ui/NotFoundState";
import { ledgerHash, sovHash } from "../auth/navigation";
import { formatDate } from "./format";
import { formatCents } from "../ui/format";
import { MilestoneFundingTable } from "./MilestoneFundingSummary";
import { AgreementTermsPanel } from "../contracts/AgreementTermsPanel";

export function AgreementSummaryView({ agreementId, backHash }: { agreementId: string; backHash: string }) {
  const agreement = useQuery(api.portal.getAgreementSummary, { agreementId });

  if (agreement === undefined) {
    return <p className="text-sm text-slate-400" role="status">Loading agreement…</p>;
  }

  if (agreement === null) return <NotFoundState />;

  return (
    <div className="max-w-3xl bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-slate-400">{agreement.agreementNumber}</p>
          <h2 className="text-lg font-semibold">{agreement.subcontractorName}</h2>
          <p className="text-sm text-slate-400">
            {agreement.projectTitle} · Division {agreement.csiDivision} {agreement.tradeName}
          </p>
        </div>
        <span className="text-xs font-semibold uppercase tracking-wide rounded-full px-2.5 py-1 bg-slate-800 border border-slate-700">
          {agreement.status}
        </span>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
        <div>
          <dt className="text-xs text-slate-400">Contract sum</dt>
          <dd className="font-semibold">{formatCents(agreement.contractSumCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-400">Retainage</dt>
          <dd className="font-semibold">{agreement.retainagePercent}%</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-400">Executed</dt>
          <dd className="font-semibold">{formatDate(agreement.executedAt)}</dd>
        </div>
      </dl>
      {agreement.baseBidCents !== null && (
        <section aria-labelledby="agreement-award-breakdown" className="text-sm">
          <h3 id="agreement-award-breakdown" className="text-sm font-semibold mb-1">
            How the contract sum was set
          </h3>
          <ul className="space-y-0.5 text-slate-300">
            <li>Base bid: {formatCents(agreement.baseBidCents)}</li>
            {agreement.acceptedAlternates.map((a) => (
              <li key={`acc-${a.description}`}>
                {a.description} accepted: +{formatCents(a.amountCents)}
              </li>
            ))}
            {agreement.veDeducts.map((a) => (
              <li key={`ve-${a.description}`}>
                {a.description} (accepted deduct): −{formatCents(a.amountCents)}
              </li>
            ))}
            {agreement.declinedAlternates.map((a) => (
              <li key={`dec-${a.description}`} className="text-slate-400">
                {a.description} not accepted ({formatCents(a.amountCents)})
              </li>
            ))}
            <li className="text-slate-400">Leveling plugs used to compare bids are not part of the contract sum.</li>
          </ul>
        </section>
      )}
      {agreement.excludedScopeNotes.length > 0 && (
        <section aria-labelledby="agreement-excluded-scope" className="text-sm">
          <h3 id="agreement-excluded-scope" className="text-sm font-semibold mb-1">
            Excluded scope (not in contract)
          </h3>
          <ul className="list-disc pl-5 text-slate-300">
            {agreement.excludedScopeNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      )}
      <AgreementTermsPanel agreementId={agreement._id} />
      {agreement.status === "executed" ? (
        <section aria-labelledby="agreement-milestone-funding">
          <h3 id="agreement-milestone-funding" className="text-sm font-semibold mb-1">
            Milestone funding
          </h3>
          <MilestoneFundingTable milestones={agreement.milestones} label={`Milestone funding for ${agreement.agreementNumber}`} />
        </section>
      ) : null}
      <div className="flex gap-4">
        <a href={sovHash(agreement._id)} className="inline-block text-sm text-emerald-400 hover:text-emerald-300">
          Schedule of values
        </a>
        <a href={ledgerHash(agreement._id)} className="inline-block text-sm text-emerald-400 hover:text-emerald-300">
          Open payment ledger
        </a>
        <a href={backHash} className="inline-block text-sm text-emerald-400 hover:text-emerald-300">
          Back
        </a>
      </div>
    </div>
  );
}
