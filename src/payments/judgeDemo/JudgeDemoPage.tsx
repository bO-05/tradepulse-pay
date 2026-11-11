import { useAction, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { DEMO_CONTRACT_SUM } from "../../../convex/judgeDemo/scenario";
import { judgeDemoHash, ledgerHash } from "../../auth/navigation";
import { FundingProvider, FundMilestoneControl, readableError } from "../FundMilestone";
import { formatCents } from "../format";
import { LicenseCheckPanel } from "../LicenseCheck";
import { SandboxTopUpPanel } from "./SandboxTopUpPanel";
import { deriveSteps, JUDGE_DEMO_AUTOSTART_KEY, type DemoInboxItem, type StepStatus } from "./steps";
import { useJudgeDemoDriver } from "./useJudgeDemoDriver";
import { listedRunHistory, partitionRunHistory, runHistoryNeedsClock, runOptionLabel, runTimerText, type RunHistoryItem } from "./runHistory";
import { NotFoundState } from "../../ui/NotFoundState";
import { ReferenceNotice } from "../ReferenceNotice";
import { CommercialReferenceBadge, ConfirmDialog, formatDateTime } from "../../ui";

const STATUS_STYLE: Record<StepStatus, { label: string; style: string }> = {
  todo: { label: "Waiting", style: "border-slate-700 bg-slate-800 text-slate-300" },
  running: { label: "Running", style: "border-sky-800 bg-sky-950 text-sky-200" },
  human: { label: "Needs you", style: "border-amber-700 bg-amber-950 text-amber-200" },
  done: { label: "Done", style: "border-emerald-800 bg-emerald-950 text-emerald-200" },
  error: { label: "Problem", style: "border-rose-800 bg-rose-950 text-rose-200" },
};

/** The counted checkbox for runs that never finished; hidden entirely when there is nothing to show. */
export function AbandonedRunsToggle({
  count,
  checked,
  onChange,
}: {
  count: number;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  if (count === 0) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-slate-400" data-testid="judge-demo-abandoned-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      Show {count} abandoned {count === 1 ? "run" : "runs"} (started but not finished within an hour; kept for the record)
    </label>
  );
}

/** Demo-company GC only: one-click guided demo against the real sandbox, reachable from the demo simulator and the nav. */
export function JudgeDemoPage({ initialRunId }: { initialRunId?: string }) {
  const [runId, setRunId] = useState<Id<"judgeDemoRuns"> | null>((initialRunId as Id<"judgeDemoRuns"> | undefined) ?? null);
  const defaultRun = useQuery(api.judgeDemo.runs.getRun, runId ? "skip" : {});
  const selectedRun = useQuery(api.judgeDemo.runs.getRunByPath, runId ? { runId } : "skip");
  const run = runId ? selectedRun : defaultRun;
  const history = useQuery(api.judgeDemo.runs.listRuns, {});
  const agreementId = run?.agreementId;
  const ledger = useQuery(api.payments.ledger.getAgreementLedger, agreementId ? { agreementId } : "skip");
  const inbox = useQuery(api.payApps.proposals.listInbox, agreementId ? { agreementId } : "skip");
  const changeOrders = useQuery(api.billing.changeOrders.listForProject, run ? { projectId: run.projectId } : "skip");
  const dashboard = useQuery(api.dashboard.queries.getDashboardData, agreementId ? {} : "skip");
  const dashboardTotals = dashboard ? (dashboard.agreements.find((a) => a.agreementId === agreementId)?.totals ?? null) : undefined;
  const refreshCo = useAction(api.payments.invoices.refreshChangeOrderStatus);
  const releaseRetainage = useAction(api.payments.retainage.releaseRetainage);
  const [now, setNow] = useState(Date.now());
  const [closeoutNote, setCloseoutNote] = useState<string | null>(null);
  const [closeoutError, setCloseoutError] = useState<string | null>(null);
  const [closeoutBusy, setCloseoutBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmCloseout, setConfirmCloseout] = useState(false);
  const [showAbandoned, setShowAbandoned] = useState(false);

  const pinRun = (id: Id<"judgeDemoRuns">) => {
    setRunId(id);
    // Replace, without remounting the active driver. Reloads/bookmarks restore this exact run.
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${judgeDemoHash(id)}`);
  };
  useEffect(() => {
    if (runId === null && run) pinRun(run._id);
  }, [runId, run]);

  const byId = useMemo(() => new Map((inbox ?? []).map((i) => [i.payApp._id as string, i as unknown as DemoInboxItem])), [inbox]);
  const honest = run?.honestPayAppId ? (byId.get(run.honestPayAppId) ?? null) : null;
  const agent = run?.agentPayAppId ? (byId.get(run.agentPayAppId) ?? null) : null;
  const primeRows = changeOrders?.prime?.changeOrders ?? [];
  const changeOrder = (run?.changeOrderId ? primeRows.find((co) => co._id === run.changeOrderId) : undefined) ?? primeRows[0] ?? null;

  const driver = useJudgeDemoDriver(
    {
      run: run ?? (run === null ? null : undefined),
      ledger: ledger ?? (ledger === null ? null : undefined),
      honest,
      agent,
      changeOrder: changeOrders ? changeOrder : undefined,
    },
    pinRun,
  );

  const autostarted = useRef(false);
  useEffect(() => {
    if (autostarted.current || run === undefined || (runId !== null && run === null)) return;
    if (sessionStorage.getItem(JUDGE_DEMO_AUTOSTART_KEY) === "1") {
      autostarted.current = true;
      sessionStorage.removeItem(JUDGE_DEMO_AUTOSTART_KEY);
      setConfirmStart(true);
    }
  }, [run, driver]);

  const steps = deriveSteps({
    agreementStatus: run?.agreementStatus ?? null,
    ledger: ledger ?? null,
    honest,
    agent,
    honestFiled: Boolean(run?.honestPayAppId),
    agentFiled: Boolean(run?.agentPayAppId),
    changeOrder,
    dashboardTotals,
  });
  const mobilization = ledger?.milestones.find((m) => m.name === "Mobilization") ?? null;
  const selectedHistoryItem = useMemo<RunHistoryItem | null>(() => {
    if (!run) return null;
    const listed = history?.find((item) => item.runId === run._id);
    if (listed) return listed;
    // A directly linked run older than the listed history still labels and times from its own data.
    return {
      runId: run._id,
      agreementNumber: run.agreementNumber,
      createdAt: run.createdAt,
      payAppsPaid: Boolean(honest?.payApp.status === "paid" && agent?.payApp.status === "paid"),
      ownerPaid: changeOrder?.status === "paid",
    };
  }, [run, history, honest, agent, changeOrder]);
  const invoicedAt = changeOrder?.invoicedAt ?? null;
  const timer = selectedHistoryItem ? runTimerText(selectedHistoryItem, invoicedAt, now) : null;
  // One shared clock covers every time-limited entry, not only the selected one. It stops as soon as
  // no entry can change, even when a completed or abandoned run stays selected.
  const ticking = runHistoryNeedsClock(history ?? [], selectedHistoryItem, now);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  const { abandoned: abandonedRuns } = partitionRunHistory(history ?? [], now);
  const listedRuns = listedRunHistory(history ?? [], now, showAbandoned);
  if (runId !== null && run === null) return <NotFoundState />;

  return (
    <div className="max-w-4xl space-y-4" data-testid="judge-demo-page">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          Guided demo
          <span className="rounded-full border border-amber-600 bg-amber-950/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-200">
            Demo
          </span>
        </h1>
        <p className="text-sm text-slate-300">
          After confirmation, the guided flow uses the real PayPal sandbox, the configured model provider and a hosted-browser CSLB lookup: it creates a fresh demo
          agreement (${DEMO_CONTRACT_SUM.toLocaleString("en-US")}, seismic bracing excluded) for sub1's contractor, funds Mobilization, files an
          honest pay app for sub1 and an overbilled one for a labeled billing agent, runs the rules review with the model's
          explanations and the CSLB licence check, cuts the flagged line by its own dollars, captures and pays with 10% retainage, and invoices a change
          order to the Owner.
        </p>
        {run?.readOnlyReference && <CommercialReferenceBadge kind="commercial" />}
        {run?.readOnlyReference && <ReferenceNotice kind="commercial" />}
        <p className="text-xs text-amber-200">
          The two pay apps label which party each filing represents. PayPal approval
          and the Owner's invoice payment are real browser steps and are never faked. The guided run stops after invoice submission;
          pay the invoice separately to complete the Owner-payment step. By starting, you authorize the guided run to approve the displayed proposals as the GC.
          {" "}Compliance records are demo data without uploaded documents, not proof of real insurance, tax or licensing compliance.
        </p>
        <label className="block text-xs text-slate-300">
          Inspect a previous run (latest 20)
          <select className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-sm"
            aria-label="Demo run" disabled={driver.running} value={run?._id ?? ""}
            onChange={(event) => { if (event.target.value) window.location.hash = judgeDemoHash(event.target.value); }}>
            {!run && <option value="">Choose a run</option>}
            {selectedHistoryItem && !listedRuns.some((r) => r.runId === selectedHistoryItem.runId) && (
              <option value={selectedHistoryItem.runId}>
                {runOptionLabel(selectedHistoryItem, now)}
              </option>
            )}
            {listedRuns.map((item) => <option key={item.runId} value={item.runId}>
              {runOptionLabel(item, now)}
            </option>)}
          </select>
        </label>
        <AbandonedRunsToggle count={abandonedRuns.length} checked={showAbandoned} onChange={setShowAbandoned} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="judge-demo-start"
            disabled={driver.running}
            onClick={() => setConfirmStart(true)}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50"
          >
            Run TradePulse Pay demo
          </button>
          {run && !run.readOnlyReference && (
            <button
              type="button"
              data-testid="judge-demo-continue"
              disabled={driver.running}
              onClick={() => void driver.drive(false)}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
            >
              Continue this run
            </button>
          )}
        </div>
        {driver.phase && (
          <p className="text-sm text-sky-200" role="status" data-testid="judge-demo-phase">
            {driver.running ? "⏳ " : ""}
            {driver.phase}
          </p>
        )}
        {driver.error && (
          <p className="text-sm text-rose-300" role="alert" data-testid="judge-demo-error">
            {driver.error}
          </p>
        )}
      </header>
      <ConfirmDialog
        open={confirmStart}
        title="Start a new sandbox demo run?"
        amountCents={5500000}
        amountLabel="New synthetic subcontract"
        details={[
          { label: "Funding", value: "$5,500 PayPal sandbox authorization, requiring your checkout approval" },
          { label: "Recipients", value: "Existing demo subcontractor's configured sandbox payee; $1,850 invoice to the demo Owner" },
          { label: "Provider calls", value: "Model-written review explanation, hosted CSLB license lookup and PayPal sandbox; these use provider credits" },
          { label: "Shared account limit", value: "Up to 3 new guided runs per hour" },
        ]}
        effect="Creates a new project, $55,000 agreement and two labeled pay applications. After funding, the guided run approves the displayed proposals as the GC and sends sandbox payouts with 10% retainage. The Owner pays the invoice separately. The new run remains in history; the preserved reference run is unchanged. Cancel creates nothing."
        confirmLabel="Create sandbox run"
        onCancel={() => setConfirmStart(false)}
        onConfirm={async () => { setConfirmStart(false); await driver.drive(true); }}
      />

      {run === undefined ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : run === null ? (
        <p className="text-sm text-slate-400">No demo run yet.</p>
      ) : (
        <>
          <section className="rounded-xl border border-slate-800 p-4 text-sm flex flex-wrap gap-x-6 gap-y-1" data-testid="judge-demo-run">
            <span>
              Agreement{" "}
              <a href={ledgerHash(run.agreementId)} className="font-mono text-emerald-300 underline" data-testid="judge-demo-agreement">
                {run.agreementNumber}
              </a>
            </span>
            <span>Started {formatDateTime(run.createdAt, { timeZone: "UTC" })} UTC</span>
            <span data-testid="judge-demo-elapsed" data-abandoned={timer?.abandoned ? "true" : undefined}>
              {timer?.text}
            </span>
          </section>
          {timer?.abandoned && !run.readOnlyReference && (
            <p className="rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs text-slate-300" role="note" data-testid="judge-demo-abandoned-note">
              This run was started but not finished. Nothing below was faked: each step shows what Convex and PayPal recorded before it stopped.
              Start a new run with <strong>Run TradePulse Pay demo</strong>, or pick a completed run above.
            </p>
          )}

          <h2 className="font-semibold">Guided run steps</h2>
          <ol className="space-y-2" data-testid="judge-demo-steps">
            {steps.map((step, i) => (
              <li key={step.id} className="rounded-xl border border-slate-800 p-3 space-y-2" data-testid={`judge-demo-step-${step.id}`} data-status={step.status}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="font-medium">
                    {i + 1}. {step.label}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLE[step.status].style}`}>{STATUS_STYLE[step.status].label}</span>
                </div>
                <p className="text-xs text-slate-400" data-testid={`judge-demo-detail-${step.id}`}>
                  {step.detail}
                </p>
                {step.id === "fund" && !run.readOnlyReference && (step.status === "human" || step.status === "running") && mobilization && (
                  <div className="space-y-1">
                    <p className="text-xs text-amber-200">
                      Human step: click Fund, choose "Debit or Credit Card" and pay as guest with the sandbox card (4032031427005060,
                      01/29, CVV 480). Choose United States; use Sandbox Buyer, 123 Test Street, San Jose, CA 95131,
                      phone 2025550100 and a unique @example.com email. Do not create a PayPal account or enter real details.
                      The demo continues as soon as PayPal authorizes.
                    </p>
                    <FundingProvider>
                      <FundMilestoneControl milestone={mobilization} />
                    </FundingProvider>
                  </div>
                )}
                {step.id === "license" && run.contractorId && (run.agentPayAppId || run.honestPayAppId) && (
                  <LicenseCheckPanel contractorId={run.contractorId} readOnly={run.readOnlyReference} />
                )}
                {step.id === "owner_pays" && !run.readOnlyReference && step.status === "human" && changeOrder?.payerViewUrl && (
                  <div className="space-y-1 text-xs">
                    <p className="text-amber-200">
                      Human step: sign in as owner@demo.tradepulse in another browser, open Change orders and pay{" "}
                      {changeOrder.label} with the guest card, or open the{" "}
                      <a href={changeOrder.payerViewUrl} target="_blank" rel="noreferrer" className="underline text-emerald-300" data-testid="judge-demo-payer-link">
                        PayPal payer view
                      </a>
                      . Then refresh the status here (the PayPal webhook also updates it).
                    </p>
                    <button
                      type="button"
                      data-testid="judge-demo-refresh-co"
                      disabled={refreshBusy}
                      className="rounded-lg border border-slate-700 px-3 py-1 hover:bg-slate-800"
                      onClick={async () => {
                        setRefreshBusy(true);
                        setRefreshError(null);
                        try {
                          await refreshCo({ changeOrderId: changeOrder._id });
                        } catch (e) {
                          setRefreshError(readableError(e));
                        } finally {
                          setRefreshBusy(false);
                        }
                      }}
                    >
                      {refreshBusy ? "Refreshing…" : "Refresh status"}
                    </button>
                    {refreshError && <p role="alert" className="text-rose-300">{refreshError}</p>}
                  </div>
                )}
              </li>
            ))}
          </ol>

          {!run.readOnlyReference && <section className="rounded-xl border border-slate-800 p-4 space-y-3" aria-label="Closeout" data-testid="judge-demo-closeout">
            <h2 className="font-semibold">Optional closeout: release retainage</h2>
            <p className="text-xs text-slate-400">
              Retainage held on this agreement: {formatCents(ledger?.retainageReleasableCents ?? 0)}. Release only when appropriate for
              this demo's closeout. A separate sandbox platform top-up is optional, and only needed if available platform funds are insufficient.
            </p>
            <SandboxTopUpPanel suggestedCents={Math.ceil(((ledger?.retainageReleasableCents ?? 0) * 11) / 1000) * 100} />
            <button
              type="button"
              disabled={closeoutBusy || (ledger?.retainageReleasableCents ?? 0) <= 0 || !ledger?.retainagePayeeEmail}
              data-testid="judge-demo-release-retainage"
              className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-600 disabled:opacity-50"
              onClick={() => setConfirmCloseout(true)}
            >
              Release retainage {formatCents(ledger?.retainageReleasableCents ?? 0)}
            </button>
            <ConfirmDialog
              open={confirmCloseout}
              title="Release retainage now?"
              amountCents={ledger?.retainageReleasableCents ?? 0}
              amountLabel="Retainage payout"
              payee={ledger?.retainagePayeeEmail ?? "No confirmed PayPal payee yet"}
              payeeLabel="Payee (confirmed PayPal email)"
              effect={`Pays the sub ${formatCents(ledger?.retainageReleasableCents ?? 0)} immediately as a PayPal sandbox payout. This is the optional closeout release and can't be undone.`}
              confirmLabel={`Release ${formatCents(ledger?.retainageReleasableCents ?? 0)} payout`}
              onCancel={() => setConfirmCloseout(false)}
              onConfirm={async () => {
                setConfirmCloseout(false);
                setCloseoutBusy(true);
                setCloseoutError(null);
                try {
                  const res = await releaseRetainage({
                    agreementId: run.agreementId,
                    expectedCents: ledger?.retainageReleasableCents ?? 0,
                  });
                  setCloseoutNote(res.message);
                } catch (e) {
                  setCloseoutError(readableError(e));
                } finally {
                  setCloseoutBusy(false);
                }
              }}
            />
            {closeoutNote && <p className="text-xs text-emerald-300" role="status">{closeoutNote}</p>}
            {closeoutError && <p className="text-xs text-rose-300" role="alert">{closeoutError}</p>}
          </section>}

          <p className="text-sm">
            See the same numbers in the{" "}
            <a href={ledgerHash(run.agreementId)} className="text-emerald-300 underline">
              agreement ledger
            </a>
            , the{" "}
            <a href="#/inbox" className="text-emerald-300 underline">
              approval inbox
            </a>{" "}
            and the{" "}
            <a href="#/dashboard" className="text-emerald-300 underline" data-testid="judge-demo-dashboard-link">
              dashboard
            </a>
            .
          </p>
        </>
      )}
    </div>
  );
}
