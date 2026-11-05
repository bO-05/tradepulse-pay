import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useId } from "react";
import { api } from "../../convex/_generated/api";
import { agreementHash, type Role } from "../auth/navigation";
import { OWNER_PAY_APPS_HASH } from "../billing/OwnerBilling";
import { requestNewProject } from "../projects/newProjectRequest";
import { Button, EmptyState, formatCents, formatDate } from "../ui";
import { CHANGE_ORDERS_PAGE_HASH, ChangeOrderRows } from "./ChangeOrders";
import { formatDollars } from "./format";

type OwnerOverview = NonNullable<FunctionReturnType<typeof api.portal.ownerOverview>>;
type OwnerJob = NonNullable<OwnerOverview[number]["ownerJob"]>;

/** The owner's read-only “job so far”: approved progress and money, never a payment control. */
function OwnerJobSoFar({ job }: { job: OwnerJob }) {
  const headingId = useId();
  const percent = job.completionBps === null ? null : job.completionBps / 100;
  const paidApps = `${job.paidApplicationCount} pay app${job.paidApplicationCount === 1 ? "" : "s"}`;
  const latest = job.latestApplicationNo === null ? null : `pay app #${job.latestApplicationNo}`;
  const latestSentence = job.latestApplicationNo === null ? "A pay app" : `Pay app #${job.latestApplicationNo}`;
  const status =
    job.latestStatus === "submitted_to_owner"
      ? `${latestSentence} is waiting for your review${job.paymentDueCents === null ? "" : ` · ${formatCents(job.paymentDueCents)} current payment due`}.`
      : job.latestStatus === "changes_requested"
        ? `You asked the GC for changes on ${latest ?? "the latest pay app"}.`
        : job.latestStatus === "approved"
          ? `You approved ${latest ?? "the latest pay app"}; the GC has not invoiced it yet.`
          : job.latestStatus === "approved_invoiced"
            ? `${latest ?? "The latest pay app"} is approved and invoiced; payment is pending.`
            : job.latestStatus === "paid"
              ? `Paid through ${latest ?? "the latest pay app"}. ${paidApps} paid.`
              : "No owner pay app yet. The GC's progress will appear here after the first pay app.";
  const basis =
    job.basis === "approved"
      ? `Approved through ${job.approvedApplicationNo === null ? "the latest pay app" : `pay app #${job.approvedApplicationNo}`}.`
      : job.basis === "submitted"
        ? `The GC reports this on ${latest ?? "the latest pay app"}; it is waiting for your review.`
        : "No approved or submitted owner pay app yet.";
  const dates = [
    job.startDate === null ? null : `Started ${formatDate(job.startDate)}`,
    job.substantialCompletionDate === null ? null : `Target completion ${formatDate(job.substantialCompletionDate)}`,
  ].filter((value): value is string => value !== null);

  return (
    <section
      className="rounded-xl border border-emerald-900/70 bg-emerald-950/20 p-4"
      aria-labelledby={headingId}
      data-testid="owner-job-so-far"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={headingId} className="text-sm font-semibold text-emerald-100">
            Job so far
          </h3>
          <p className="text-xs text-slate-400">Approved progress and money on the prime contract. Read-only.</p>
        </div>
        <span className="rounded-full border border-emerald-800 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-200">
          {job.basis === "approved" ? "Approved" : job.basis === "submitted" ? "Awaiting your review" : "Not started"}
        </span>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,2fr)]">
        <div>
          <div className="flex items-end justify-between gap-2">
            <p className="text-3xl font-semibold tabular-nums text-ink" data-testid="owner-job-percent">
              {percent === null ? "—" : `${percent.toFixed(1)}%`}
            </p>
            <p className="text-xs text-slate-400">complete</p>
          </div>
          <div
            className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800"
            role="progressbar"
            aria-label="Approved work complete"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent === null ? undefined : Math.round(percent)}
          >
            <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} />
          </div>
          <p className="mt-2 text-xs text-slate-400" data-testid="owner-job-basis">
            {basis}
          </p>
          {dates.length > 0 ? (
            <p className="mt-1 text-xs text-slate-400" data-testid="owner-job-dates">
              {dates.join(" · ")}
            </p>
          ) : null}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <JobMetric label="Contract to date" value={formatCents(job.contractSumToDateCents)} testId="owner-job-contract" />
          <JobMetric label="Completed & stored" value={formatCents(job.completedAndStoredCents)} testId="owner-job-completed" />
          <JobMetric label="Paid to date" value={formatCents(job.paidToDateCents)} testId="owner-job-paid" />
          <JobMetric label="Retainage held" value={formatCents(job.retainageHeldCents)} testId="owner-job-retainage" />
          <JobMetric label="Balance to finish" value={formatCents(job.balanceToFinishCents)} testId="owner-job-balance" />
          <JobMetric
            label="Change orders"
            value={formatCents(job.changeOrdersApprovedCents)}
            detail={job.openChangeOrders > 0 ? `${job.openChangeOrders} awaiting your review` : `${formatCents(job.paidChangeOrdersCents)} paid`}
            testId="owner-job-change-orders"
          />
        </dl>
      </div>

      <p className="mt-3 text-xs text-slate-400" data-testid="owner-job-status">
        {status}
      </p>
      <p className="mt-1 text-[11px] text-slate-400">
        Paid to date = {formatCents(job.paidOwnerPayAppsCents)} in paid pay apps + {formatCents(job.paidChangeOrdersCents)} in paid change
        orders. Figures come from owner pay apps and paid prime change orders; they do not move money.
      </p>
    </section>
  );
}

function JobMetric({ label, value, detail, testId }: { label: string; value: string; detail?: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="font-semibold tabular-nums text-slate-100">{value}</dd>
      {detail ? <dd className="text-[11px] text-slate-400">{detail}</dd> : null}
    </div>
  );
}

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
      <h1 className="text-xl font-semibold">{role === "gc" ? "Project summaries" : "Owner home"}</h1>
      {projects.map((project) => (
        <section key={project._id} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold">{project.title}</h2>
            <p className="text-xs text-slate-400">
              {project.location} · {project.projectType} · Budget {formatDollars(project.estBudget)}
              {project.isDemoProject ? " · demo project" : ""}
            </p>
          </div>

          {project.partyRole === "owner" && project.ownerJob !== null && <OwnerJobSoFar job={project.ownerJob} />}

          {project.partyRole === "gc" && (
          <div>
            <h3 className="text-sm font-semibold mb-2">Subcontract agreements</h3>
            {project.agreements.length === 0 ? (
              <p className="text-sm text-slate-400">No agreements yet.</p>
            ) : (
              <div className="table-scroll" role="region" aria-label="Subcontract agreements" tabIndex={0}><table className="w-full text-sm">
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
              </table></div>
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
  in_progress: "Funded · authorization partly used",
  complete: "Closed",
  paid: "Funding used",
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
        <div className="table-scroll" role="region" aria-label="Funding tranche status" tabIndex={0}><table className="w-full text-sm">
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
        </table></div>
      )}
    </div>
  );
}
