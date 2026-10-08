import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { agreementHash } from "../auth/navigation";
import { ChangeOrderList } from "./ChangeOrders";
import { formatDollars } from "./format";

/** Read-only projects view for owners (and GC). No approve, fund or award controls live here. */
export function OwnerPortal() {
  const projects = useQuery(api.portal.ownerOverview, {});

  if (projects === undefined) {
    return <p className="text-sm text-slate-400" role="status">Loading projects…</p>;
  }
  if (projects.length === 0) {
    return <p className="text-sm text-slate-400">No projects yet.</p>;
  }

  return (
    <div className="space-y-6 max-w-5xl">
      {projects.map((project) => (
        <section key={project._id} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold">{project.title}</h2>
            <p className="text-xs text-slate-400">
              {project.location} · {project.projectType} · Budget {formatDollars(project.estBudget)}
              {project.isDemoProject ? " · demo project" : ""}
            </p>
          </div>

          {project.partyRole === "gc" && (
          <div>
            <h3 className="text-sm font-semibold mb-2">Subcontract agreements</h3>
            {project.agreements.length === 0 ? (
              <p className="text-sm text-slate-400">No agreements yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-400 text-left">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Agreement</th>
                    <th className="py-2 pr-3 font-medium">Subcontractor</th>
                    <th className="py-2 pr-3 font-medium">Trade</th>
                    <th className="py-2 pr-3 font-medium text-right">Contract sum</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {project.agreements.map((a) => (
                    <tr key={a._id} className="border-t border-slate-800">
                      <td className="py-2 pr-3">
                        <a href={agreementHash(a._id)} className="text-emerald-400 hover:text-emerald-300">
                          {a.agreementNumber}
                        </a>
                      </td>
                      <td className="py-2 pr-3">{a.subcontractorName}</td>
                      <td className="py-2 pr-3">{a.tradeName}</td>
                      <td className="py-2 pr-3 text-right">{formatDollars(a.contractSum)}</td>
                      <td className="py-2 pr-3">{a.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          )}

          <div>
            <h3 className="text-sm font-semibold mb-2">Change-order invoices</h3>
            <ChangeOrderList changeOrders={project.changeOrders} canRefresh canResend={false} showAgreement />
          </div>
        </section>
      ))}
    </div>
  );
}
