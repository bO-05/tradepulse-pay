import { useAction, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { DEMO_BILLING_AGENT_EMAIL, DEMO_CONTRACT_SUM } from "../../../convex/judgeDemo/scenario";
import { ledgerHash } from "../../auth/navigation";
import { FundingProvider, FundMilestoneControl, readableError } from "../FundMilestone";
import { formatCents } from "../format";
import { LicenseCheckPanel } from "../LicenseCheck";
import { SandboxTopUpPanel } from "./SandboxTopUpPanel";
import { deriveSteps, JUDGE_DEMO_AUTOSTART_KEY, type DemoInboxItem, type StepStatus } from "./steps";
import { useJudgeDemoDriver } from "./useJudgeDemoDriver";

const STATUS_STYLE: Record<StepStatus, { label: string; style: string }> = {
  todo: { label: "Waiting", style: "border-slate-700 bg-slate-800 text-slate-300" },
  running: { label: "Running", style: "border-sky-800 bg-sky-950 text-sky-200" },
  human: { label: "Needs you", style: "border-amber-700 bg-amber-950 text-amber-200" },
  done: { label: "Done", style: "border-emerald-800 bg-emerald-950 text-emerald-200" },
  error: { label: "Problem", style: "border-rose-800 bg-rose-950 text-rose-200" },
};

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Demo-company GC only: one-click guided demo against the real sandbox, reachable from the demo simulator and the nav. */
export function JudgeDemoPage() {
  const [runId, setRunId] = useState<Id<"judgeDemoRuns"> | null>(null);
  const run = useQuery(api.judgeDemo.runs.getRun, runId ? { runId } : {});
  const agreementId = run?.agreementId;
  const ledger = useQuery(api.payments.ledger.getAgreementLedger, agreementId ? { agreementId } : "skip");
  const inbox = useQuery(api.payApps.proposals.listInbox, run ? {} : "skip");
  const changeOrders = useQuery(api.billing.changeOrders.listForProject, run ? { projectId: run.projectId } : "skip");
  const dashboard = useQuery(api.dashboard.queries.getDashboardData, agreementId ? {} : "skip");
  const dashboardTotals = dashboard ? (dashboard.agreements.find((a) => a.agreementId === agreementId)?.totals ?? null) : undefined;
  const refreshCo = useAction(api.payments.invoices.refreshChangeOrderStatus);
  const releaseRetainage = useAction(api.payments.retainage.releaseRetainage);
  const [now, setNow] = useState(Date.now());
  const [closeoutNote, setCloseoutNote] = useState<string | null>(null);
  const [closeoutError, setCloseoutError] = useState<string | null>(null);
  const [closeoutBusy, setCloseoutBusy] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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
    setRunId,
  );

  const autostarted = useRef(false);
  useEffect(() => {
    if (autostarted.current || run === undefined) return;
    if (sessionStorage.getItem(JUDGE_DEMO_AUTOSTART_KEY) === "1") {
      autostarted.current = true;
      sessionStorage.removeItem(JUDGE_DEMO_AUTOSTART_KEY);
      void driver.drive(true);
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
  const invoicedAt = changeOrder?.invoicedAt ?? null;

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
          One click runs the full pay-application flow against the real PayPal sandbox, Anthropic and KERNEL: execute a fresh demo
          agreement (${DEMO_CONTRACT_SUM.toLocaleString("en-US")}, seismic bracing excluded) for sub1's contractor, fund Mobilization, file an
          honest pay app for sub1 and an overbilled one for the billing agent {DEMO_BILLING_AGENT_EMAIL}, run the AI review and the
          CSLB license check, approve (editing the agent's amount down), capture and pay with 10% retainage, and invoice a change
          order to the Owner.
        </p>
        <p className="text-xs text-amber-200">
          The two pay apps are filed by this demo as stand-ins and are labeled "Guided demo (Demo)" wherever they appear. PayPal approval
          and the Owner's invoice payment are real browser steps; the demo waits for them and never fakes them.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="judge-demo-start"
            disabled={driver.running}
            onClick={() => void driver.drive(true)}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50"
          >
            Run TradePulse Pay demo
          </button>
          {run && (
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
            <span>Started {new Date(run.createdAt).toLocaleTimeString()}</span>
            <span data-testid="judge-demo-elapsed">
              {invoicedAt ? `Finished in ${elapsed(invoicedAt - run.createdAt)} (start to change-order invoice)` : `Elapsed ${elapsed(now - run.createdAt)}`}
            </span>
          </section>

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
                {step.id === "fund" && step.status === "human" && mobilization && (
                  <div className="space-y-1">
                    <p className="text-xs text-amber-200">
                      Human step: click Fund, choose "Debit or Credit Card" and pay as guest with the sandbox card (4032031427005060,
                      01/29, CVV 480). The demo continues as soon as PayPal authorizes.
                    </p>
                    <FundingProvider>
                      <FundMilestoneControl milestone={mobilization} />
                    </FundingProvider>
                  </div>
                )}
                {step.id === "license" && run.contractorId && (run.agentPayAppId || run.honestPayAppId) && (
                  <LicenseCheckPanel contractorId={run.contractorId} />
                )}
                {step.id === "owner_pays" && step.status === "human" && changeOrder?.payerViewUrl && (
                  <div className="space-y-1 text-xs">
                    <p className="text-amber-200">
                      Human step: sign in as owner@demo.tradepulse in another browser, open Projects &amp; change orders and pay{" "}
                      {changeOrder.label} with the guest card, or open the{" "}
                      <a href={changeOrder.payerViewUrl} target="_blank" rel="noreferrer" className="underline text-emerald-300" data-testid="judge-demo-payer-link">
                        PayPal payer view
                      </a>
                      . Then refresh the status here (the PayPal webhook also updates it).
                    </p>
                    <button
                      type="button"
                      data-testid="judge-demo-refresh-co"
                      className="rounded-lg border border-slate-700 px-3 py-1 hover:bg-slate-800"
                      onClick={() => void refreshCo({ changeOrderId: changeOrder._id }).catch(() => undefined)}
                    >
                      Refresh status
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>

          <section className="rounded-xl border border-slate-800 p-4 space-y-3" aria-label="Closeout" data-testid="judge-demo-closeout">
            <h2 className="font-semibold">Optional closeout: release retainage</h2>
            <p className="text-xs text-slate-400">
              Retainage held on this agreement: {formatCents(ledger?.retainageReleasableCents ?? 0)}. In the sandbox, top up the platform
              account first (below), or the payout fails with INSUFFICIENT_FUNDS because of PayPal's capture fees.
            </p>
            <SandboxTopUpPanel suggestedCents={Math.ceil(((ledger?.retainageReleasableCents ?? 0) * 11) / 1000) * 100} />
            <button
              type="button"
              disabled={closeoutBusy || (ledger?.retainageReleasableCents ?? 0) <= 0}
              data-testid="judge-demo-release-retainage"
              className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-600 disabled:opacity-50"
              onClick={async () => {
                setCloseoutBusy(true);
                setCloseoutError(null);
                try {
                  const res = await releaseRetainage({ agreementId: run.agreementId });
                  setCloseoutNote(res.message);
                } catch (e) {
                  setCloseoutError(readableError(e));
                } finally {
                  setCloseoutBusy(false);
                }
              }}
            >
              Release retainage {formatCents(ledger?.retainageReleasableCents ?? 0)}
            </button>
            {closeoutNote && <p className="text-xs text-emerald-300" role="status">{closeoutNote}</p>}
            {closeoutError && <p className="text-xs text-rose-300" role="alert">{closeoutError}</p>}
          </section>

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
