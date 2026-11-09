import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { ledgerHash } from "../auth/navigation";
import { formatCents, formatDate } from "./format";
import { demoDisplayName } from "../lib/demoCopy";
import { termsForKind } from "../lib/terms";

/** Payments workspace home: the agreements the caller may see, each linking to its ledger. */
export function PaymentsWorkspace() {
  const agreements = useQuery(api.payments.ledger.listLedgerAgreements, {});

  if (agreements === undefined) {
    return <p className="text-sm text-slate-400" role="status">Loading agreements…</p>;
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <section aria-labelledby="payments-agreements" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h1 id="payments-agreements" className="text-base font-semibold mb-1">
          Payments — agreement ledgers
        </h1>
        <p className="text-xs text-slate-400 mb-4">
          Executing an agreement creates its schedule of values and milestones. Open a ledger to see them.
        </p>
        {agreements.length === 0 ? (
          <p className="text-sm text-slate-400">No agreements yet.</p>
        ) : (
          <div className="table-scroll" role="region" aria-label="Agreement payment ledgers" tabIndex={0}><table className="w-full text-sm" data-testid="payments-agreements">
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th className="py-2 pr-3 font-medium">Agreement</th>
                <th className="py-2 pr-3 font-medium">Subcontractor</th>
                <th className="py-2 pr-3 font-medium">Trade</th>
                <th className="py-2 pr-3 font-medium text-right">Contract sum to date</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Executed</th>
              </tr>
            </thead>
            <tbody>
              {agreements.map((a) => (
                <tr key={a._id} className="border-t border-slate-800">
                  <td className="py-2 pr-3">
                    <a href={ledgerHash(a._id)} className="text-emerald-400 hover:text-emerald-300">
                      {a.agreementNumber}
                    </a>
                  </td>
                  <td className="py-2 pr-3">{demoDisplayName(a.subcontractorName)}</td>
                  <td className="py-2 pr-3">
                    {termsForKind(a.projectKind).kind === "residential" ? a.tradeName : `Div ${a.csiDivision} ${a.tradeName}`}
                  </td>
                  <td className="py-2 pr-3 text-right">{formatCents(a.contractSumCents)}</td>
                  <td className="py-2 pr-3">{a.status}</td>
                  <td className="py-2 pr-3">{formatDate(a.executedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
