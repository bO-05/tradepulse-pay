import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { agreementHash, type Role } from "../auth/navigation";
import { OWNER_PAY_APPS_HASH } from "../billing/OwnerBilling";
import { requestNewProject } from "../projects/newProjectRequest";
import { Button, EmptyState } from "../ui";
import { CHANGE_ORDERS_PAGE_HASH, ChangeOrderRows } from "./ChangeOrders";
import { formatCents, formatDollars } from "./format";

/** Read-only projects view for owners (and GC). No approve, fund or award controls live here. */
export function OwnerPortal({ role }: { role?: Role }) {
  const projects = useQuery(api.portal.ownerOverview, {});

  if (projects === undefined) {
    return <p className="text-sm text-slate-400" role="status">Loading projects…</p>;
  }
  if (projects.length === 0) {
    return role === "gc" ? (
      <EmptyState
        title="No projects yet"
        description="Create your first project to set up trade packages, invite bidders and manage contracts. Nothing is added for you automatically."
        action={<Button onClick={() => requestNewProject()}>Create your first project</Button>}
        className="max-w-3xl"
      />
    ) : (
      <EmptyState title="No projects yet" description="Projects you are invited to will appear here." className="max-w-3xl" />
    );
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

          {project.partyRole === "owner" && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="portal-prime-retainage">
              <p>
                Retainage you hold on the prime contract:{" "}
                <span className="font-semibold tabular-nums">
                  {project.primeRetainageHeldCents === null ? "None yet" : formatCents(project.primeRetainageHeldCents)}
                </span>
              </p>
              <a href={OWNER_PAY_APPS_HASH} className="text-xs text-emerald-400 hover:text-emerald-300">
                Owner pay apps
              </a>
            </div>
          )}

          {project.partyRole === "owner" && <OwnerTrancheStatus projectId={project._id} />}

          <div data-testid="portal-change-orders">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h3 className="text-sm font-semibold">Change orders</h3>
              <a href={CHANGE_ORDERS_PAGE_HASH} className="text-xs text-emerald-400 hover:text-emerald-300">
                All change orders
              </a>
            </div>
            {project.primeContractSum ? (
              <p className="text-sm text-slate-300 mb-2" data-testid="portal-prime-contract-sum">
                Prime contract sum to date <span className="font-semibold tabular-nums">{formatCents(project.primeContractSum.toDateCents)}</span>
                {" "}(original {formatCents(project.primeContractSum.originalCents)}, net change{" "}
                {project.primeContractSum.netChangeCents > 0 ? "+" : ""}
                {formatCents(project.primeContractSum.netChangeCents)})
              </p>
            ) : null}
            <ChangeOrderRows rows={project.changeOrders} emptyText="No prime change orders on this project yet." />
          </div>
        </section>
      ))}
    </div>
  );
}

const OWNER_TRANCHE_STATUS: Record<string, string> = {
  planned: "Not funded",
  funding: "Checkout started",
  funded: "Funded",
  in_progress: "Partly paid out",
  complete: "Closed",
  paid: "Paid out",
  funding_expired: "Funding expired",
};

/** Owner: funding tranche status per trade on this project, read-only. */
function OwnerTrancheStatus({ projectId }: { projectId: string }) {
  const trades = useQuery(api.billing.tranches.ownerProjectTranches, { projectId });
  if (trades === undefined) return null;
  return (
    <div data-testid="owner-tranches">
      <h3 className="text-sm font-semibold mb-2">Funding tranches</h3>
      {trades.length === 0 ? (
        <p className="text-sm text-slate-400">No funding tranches yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-400 text-left">
            <tr>
              <th className="py-2 pr-3 font-medium">Trade</th>
              <th className="py-2 pr-3 font-medium">Tranche</th>
              <th className="py-2 pr-3 font-medium text-right">Amount</th>
              <th className="py-2 pr-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {trades.flatMap((t) =>
              t.tranches.map((tr) => (
                <tr key={tr._id} className="border-t border-slate-800" data-testid="owner-tranche-row">
                  <td className="py-2 pr-3">{t.trade}</td>
                  <td className="py-2 pr-3">{tr.name}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatCents(tr.amountCents)}</td>
                  <td className="py-2 pr-3">{OWNER_TRANCHE_STATUS[tr.status] ?? "Not funded"}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
