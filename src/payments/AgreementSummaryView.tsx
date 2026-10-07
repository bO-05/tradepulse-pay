import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { formatDate, formatDollars } from "./format";

export function AgreementSummaryView({ agreementId, backHash }: { agreementId: string; backHash: string }) {
  const agreement = useQuery(api.portal.getAgreementSummary, { agreementId });

  if (agreement === undefined) {
    return <p className="text-sm text-slate-400" role="status">Loading agreement…</p>;
  }

  if (agreement === null) {
    return (
      <div className="max-w-xl bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-3" role="alert">
        <h2 className="text-base font-semibold">Agreement not found</h2>
        <p className="text-sm text-slate-400">
          This agreement does not exist or your account does not have access to it.
        </p>
        <a href={backHash} className="inline-block text-sm text-emerald-400 hover:text-emerald-300">
          Back
        </a>
      </div>
    );
  }

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
          <dd className="font-semibold">{formatDollars(agreement.contractSum)}</dd>
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
      <a href={backHash} className="inline-block text-sm text-emerald-400 hover:text-emerald-300">
        Back
      </a>
    </div>
  );
}
