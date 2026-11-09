import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useId } from "react";
import { api } from "../../convex/_generated/api";
import { agreementHash, type Role } from "../auth/navigation";
import { OWNER_PAY_APPS_HASH } from "../billing/OwnerBilling";
import { requestNewProject } from "../projects/newProjectRequest";
import { Button, CommercialReferenceBadge, EmptyState, LinkButton, MoneyTrail, formatCents, formatDate, type MoneyTrailStep } from "../ui";
import { statusLabelFor } from "../ui/statusLabels";
import { termsForKind, type Terms } from "../lib/terms";
import { CHANGE_ORDERS_PAGE_HASH, ChangeOrderRows } from "./ChangeOrders";
import { ReferenceNotice } from "./ReferenceNotice";
import { formatDollars } from "./format";
import { demoDisplayName, demoProjectDescription, demoProjectName } from "../lib/demoCopy";
import { tradeLineDisplay } from "../lib/tradeLineDisplay";

type OwnerOverview = NonNullable<FunctionReturnType<typeof api.portal.ownerOverview>>;
type OwnerProject = OwnerOverview[number];
type OwnerJob = NonNullable<OwnerProject["ownerJob"]>;

/** The owner-facing status sentence, shared by the lead job card and the compact job rows. */
function jobStatusSentence(job: OwnerJob, terms: Terms): string {
  const paidApps = `${job.paidApplicationCount} ${terms.ownerBillLower}${job.paidApplicationCount === 1 ? "" : "s"}`;
  const latest = job.latestApplicationNo === null ? null : `${terms.ownerBillLower} #${job.latestApplicationNo}`;
  const billSentence = terms.kind === "residential" ? terms.ownerBill : "Pay app";
  const latestSentence =
    job.latestApplicationNo === null
      ? terms.kind === "residential"
        ? "A draw"
        : "A pay app"
      : `${billSentence} #${job.latestApplicationNo}`;
  const latestFallback = `the latest ${terms.ownerBillLower}`;
  return job.latestStatus === "submitted_to_owner"
    ? `${latestSentence} is waiting for your review${job.paymentDueCents === null ? "" : ` · ${formatCents(job.paymentDueCents)} current payment due`}.`
    : job.latestStatus === "changes_requested"
      ? `You asked the GC for changes on ${latest ?? latestFallback}.`
      : job.latestStatus === "approved"
        ? `You approved ${latest ?? latestFallback}; the GC has not invoiced it yet.`
        : job.latestStatus === "approved_invoiced"
          ? `${latest ?? (terms.kind === "residential" ? "The latest draw" : "The latest pay app")} is approved and invoiced; payment is pending.`
          : job.latestStatus === "paid"
            ? `Paid through ${latest ?? latestFallback}. ${paidApps} paid.`
            : terms.kind === "residential"
              ? "No draw yet. The GC's progress will appear here after the first draw."
              : "No owner pay app yet. The GC's progress will appear here after the first pay app.";
}

/**
 * The owner's read-only “job so far”: approved progress and money, never a payment control.
 *
 * Paid is the headline because that is the outcome the owner checks first; the split beneath it
 * shows how much came from draws and how much from change orders. The balance, contract and
 * retainage stay as labeled steps. Every `owner-job-*` hook stays on its own element.
 */
function OwnerJobSoFar({ job, terms }: { job: OwnerJob; terms: Terms }) {
  const headingId = useId();
  const percent = job.completionBps === null ? null : job.completionBps / 100;
  const basis =
    job.basis === "approved"
      ? `Approved through ${job.approvedApplicationNo === null ? `the latest ${terms.ownerBillLower}` : `${terms.ownerBillLower} #${job.approvedApplicationNo}`}.`
      : job.basis === "submitted"
        ? `The GC reports this on ${job.latestApplicationNo === null ? `the latest ${terms.ownerBillLower}` : `${terms.ownerBillLower} #${job.latestApplicationNo}`}; it is waiting for your review.`
        : `No approved or submitted ${terms.ownerBill.toLowerCase()} yet.`;
  const dates = [
    job.startDate === null ? null : `Started ${formatDate(job.startDate)}`,
    job.substantialCompletionDate === null ? null : `Target completion ${formatDate(job.substantialCompletionDate)}`,
  ].filter((value): value is string => value !== null);
  const steps: MoneyTrailStep[] = [
    { label: "Contract to date", valueCents: job.contractSumToDateCents, valueTestId: "owner-job-contract" },
    {
      label: terms.kind === "residential" ? terms.drawColumns.workCompleted : "Completed & stored",
      valueCents: job.completedAndStoredCents,
      valueTestId: "owner-job-completed",
    },
    { label: "Retainage held", valueCents: job.retainageHeldCents, valueTestId: "owner-job-retainage" },
    {
      label: "Balance to finish",
      valueCents: job.balanceToFinishCents,
      valueTestId: "owner-job-balance",
      note: "Includes retainage",
    },
    {
      label: "Change orders",
      valueCents: job.changeOrdersApprovedCents,
      valueTestId: "owner-job-change-orders",
      note: job.openChangeOrders > 0 ? `${job.openChangeOrders} awaiting your review` : `${formatCents(job.paidChangeOrdersCents)} paid`,
    },
  ];
  const paidSplit =
    terms.kind === "residential"
      ? `${formatCents(job.paidOwnerPayAppsCents)} draw · ${formatCents(job.paidChangeOrdersCents)} change order`
      : `${formatCents(job.paidOwnerPayAppsCents)} in paid ${terms.ownerBillsLower} · ${formatCents(job.paidChangeOrdersCents)} in paid change orders`;

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
          <p className="text-xs text-slate-400">
            {terms.kind === "residential" ? "Approved progress and money on the contract." : "Approved progress and money on the prime contract."}
          </p>
        </div>
        <span className="rounded-full border border-emerald-800 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-200">
          {job.basis === "approved" ? "Approved" : job.basis === "submitted" ? "Awaiting your review" : "Not started"}
        </span>
        {job.latestApplicationNo === null ? null : (
          <LinkButton variant="primary" size="md" href={OWNER_PAY_APPS_HASH} data-testid="owner-home-open-draw">
            Open {terms.ownerBill} #{job.latestApplicationNo}
          </LinkButton>
        )}
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

        <MoneyTrail
          testId="owner-money-trail"
          ariaLabel="Money trail"
          hero={{
            label: "Paid to date",
            valueCents: job.paidToDateCents,
            valueTestId: "owner-job-paid",
            note: paidSplit,
            tone: "positive",
          }}
          steps={steps}
          footer={
            <div className="space-y-1">
              <p className="text-xs text-slate-400" data-testid="owner-job-status">
                {jobStatusSentence(job, terms)}
              </p>
              <p className="text-xs text-slate-400">
                Paid to date = {formatCents(job.paidOwnerPayAppsCents)} in paid {terms.ownerBillsLower} + {formatCents(job.paidChangeOrdersCents)} in paid change
                orders.
              </p>
            </div>
          }
        />
      </div>
      <ReferenceNotice title="Preserved reference job · read-only." />
    </section>
  );
}

/** A secondary job on the owner's portfolio: keeps its own vocabulary and badge, never a write control. */
function SecondaryProjectCard({ project }: { project: OwnerProject }) {
  const terms = termsForKind(project.projectKind);
  const job = project.ownerJob;
  const percent = job === null || job.completionBps === null ? null : job.completionBps / 100;
  return (
    <section
      className="rounded-xl border border-line bg-surface p-4"
      data-project-kind={terms.kind}
      data-testid="owner-project-secondary"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">{demoProjectName(project.title)}</h3>
        <CommercialReferenceBadge kind={project.projectKind} />
      </div>
      <p className="mt-1 text-xs text-ink-subtle">
        {project.location} · {demoProjectDescription(project.projectType)} · Budget {formatDollars(project.estBudget)}
      </p>
      {job !== null ? (
        <>
          <p className="mt-2 text-sm text-ink-muted">
            {percent === null ? "Not started" : <span className="tabular-nums">{percent.toFixed(1)}%</span>} complete ·{" "}
            <span className="tabular-nums font-semibold text-ink">{formatCents(job.paidToDateCents)}</span> paid ·{" "}
            <span className="tabular-nums font-semibold text-ink">{formatCents(job.balanceToFinishCents)}</span> balance to finish
          </p>
          <p className="mt-1 text-xs text-ink-subtle">{jobStatusSentence(job, terms)}</p>
        </>
      ) : null}
    </section>
  );
}

/** Pure ordering: a residential job leads the owner's portfolio; everything else keeps server order. */
function orderOwnerProjects(projects: OwnerOverview): { lead: OwnerProject | null; rest: OwnerProject[] } {
  const lead = projects.find((project) => project.projectKind === "residential") ?? projects[0] ?? null;
  return { lead, rest: lead === null ? [] : projects.filter((project) => project._id !== lead._id) };
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

  const owner = role !== "gc";
  const ordered = owner ? orderOwnerProjects(projects) : null;
  const primaryProject = ordered?.lead ?? null;

  return (
    <div className="space-y-6 max-w-5xl">
      <h1 className="text-xl font-semibold">{owner ? "Owner home" : "Project summaries"}</h1>
      {projects
        .filter((project) => !owner || project._id === primaryProject?._id)
        .map((project) => {
          const terms = termsForKind(project.projectKind);
          return (
            <section
              key={project._id}
              className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4"
              data-project-kind={terms.kind}
            >
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold">{demoProjectName(project.title)}</h2>
                  <CommercialReferenceBadge kind={project.projectKind} />
                </div>
                <p className="text-xs text-slate-400">
                  {project.location} · {demoProjectDescription(project.projectType)} · Budget {formatDollars(project.estBudget)}
                </p>
              </div>

              {project.partyRole === "owner" && project.ownerJob !== null && <OwnerJobSoFar job={project.ownerJob} terms={terms} />}

              {project.partyRole === "gc" && (
                <div>
                  <h3 className="text-sm font-semibold mb-2">Subcontract agreements</h3>
                  {project.agreements.length === 0 ? (
                    <p className="text-sm text-slate-400">No agreements yet.</p>
                  ) : (
                    <div className="table-scroll" role="region" aria-label="Subcontract agreements" tabIndex={0}>
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
                              <td className="py-2 pr-3">{demoDisplayName(a.subcontractorName)}</td>
                              <td className="py-2 pr-3">{a.tradeName}</td>
                              <td className="py-2 pr-3 text-right">{formatDollars(a.contractSum)}</td>
                              <td className="py-2 pr-3">{statusLabelFor(a.status, terms.kind)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {project.partyRole === "owner" && (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="portal-prime-retainage">
                  <p>
                    Retainage you hold on the {terms.kind === "residential" ? "contract" : "prime contract"}:{" "}
                    <span className="font-semibold tabular-nums">
                      {project.primeRetainageHeldCents === null ? "None yet" : formatCents(project.primeRetainageHeldCents)}
                    </span>
                  </p>
                  <a href={OWNER_PAY_APPS_HASH} className="inline-flex min-h-6 items-center text-xs text-emerald-400 hover:text-emerald-300">
                    {terms.ownerBills}
                  </a>
                </div>
              )}

              {project.partyRole === "owner" && <OwnerTrancheStatus projectId={project._id} terms={terms} />}

              <div data-testid="portal-change-orders">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <h3 className="text-sm font-semibold">Change orders</h3>
                  <a href={CHANGE_ORDERS_PAGE_HASH} className="inline-flex min-h-6 items-center text-xs text-emerald-400 hover:text-emerald-300">
                    All change orders
                  </a>
                </div>
                {project.primeContractSum ? (
                  <p className="text-sm text-slate-300 mb-2" data-testid="portal-prime-contract-sum">
                    {terms.kind === "residential" ? "Contract sum to date" : "Prime contract sum to date"}{" "}
                    <span className="font-semibold tabular-nums">{formatCents(project.primeContractSum.toDateCents)}</span>
                    {" "}(original {formatCents(project.primeContractSum.originalCents)}, net change{" "}
                    {project.primeContractSum.netChangeCents > 0 ? "+" : ""}
                    {formatCents(project.primeContractSum.netChangeCents)})
                  </p>
                ) : null}
                <ChangeOrderRows
                  rows={project.changeOrders}
                  emptyText={terms.kind === "residential" ? "No change orders on this project yet." : "No prime change orders on this project yet."}
                  projectKind={project.projectKind}
                />
              </div>
            </section>
          );
        })}

      {ordered !== null && ordered.rest.length > 0 ? (
        <section aria-labelledby="owner-other-projects">
          <h2 id="owner-other-projects" className="text-sm font-semibold text-ink-muted">
            Other projects
          </h2>
          <div className="mt-2 space-y-3">
            {ordered.rest.map((project) => (
              <SecondaryProjectCard key={project._id} project={project} />
            ))}
          </div>
        </section>
      ) : null}
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

/** Owner: funded-milestone status per trade on this project, read-only. */
function OwnerTrancheStatus({ projectId, terms }: { projectId: string; terms: Terms }) {
  const trades = useQuery(api.billing.tranches.ownerProjectTranches, { projectId });
  if (trades === undefined) return null;
  return (
    <div data-testid="owner-tranches">
      <h3 className="text-sm font-semibold mb-2">{terms.fundedMilestones}</h3>
      {trades.length === 0 ? (
        <p className="text-sm text-slate-400">No {terms.fundedMilestones.toLowerCase()} yet.</p>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label={terms.kind === "residential" ? `${terms.fundedMilestone} status` : "Funding tranche status"}
          tabIndex={0}
        >
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th className="py-2 pr-3 font-medium">{terms.kind === "residential" ? terms.trades : "Trade"}</th>
                <th className="py-2 pr-3 font-medium">{terms.fundedMilestone}</th>
                <th className="py-2 pr-3 font-medium text-right">Amount</th>
                <th className="py-2 pr-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {trades.flatMap((t) =>
                t.tranches.map((tr) => (
                  <tr key={tr._id} className="border-t border-slate-800" data-testid="owner-tranche-row">
                    <td className="py-2 pr-3">{tradeLineDisplay(t.trade)}</td>
                    <td className="py-2 pr-3">{tr.name}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatCents(tr.amountCents)}</td>
                    <td className="py-2 pr-3">{OWNER_TRANCHE_STATUS[tr.status] ?? "Not funded"}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
