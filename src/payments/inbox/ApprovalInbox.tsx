import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { fromDollars, toDollarString } from "../../../convex/lib/money";
import { readableError } from "../FundMilestone";
import { formatCents, formatDate } from "../format";
import { LicenseBadge, LicenseCheckPanel, type LicenseBadgeStatus } from "../LicenseCheck";
import { PayAppReviewCard } from "../PayAppReviews";

type InboxItem = FunctionReturnType<typeof api.payApps.proposals.listInbox>[number];
type Proposal = InboxItem["proposals"][number];

const KIND_LABEL: Record<string, string> = {
  capture: "Capture from milestone authorization",
  payout: "Payout to the sub (net of retainage)",
  reschedule: "Reschedule billing",
  hold: "Hold payment",
  retainage_release: "Retainage release",
};

const STATUS_STYLE: Record<string, string> = {
  pending: "border-sky-800 bg-sky-950 text-sky-200",
  approved: "border-indigo-800 bg-indigo-950 text-indigo-200",
  executed: "border-emerald-800 bg-emerald-950 text-emerald-200",
  failed: "border-rose-800 bg-rose-950 text-rose-200",
  rejected: "border-slate-700 bg-slate-800 text-slate-300",
};

const FLAG_TEXT: Record<string, string> = {
  overbilled_lines: "Overbilled lines",
  excluded_scope_lines: "Excluded-scope lines",
  front_loaded_lines: "Front-loaded lines",
  out_of_sequence_lines: "Out-of-sequence lines",
  lien_waiver_missing: "Lien waiver missing",
  reduced_from_request: "Reduced from request",
  license_hold: "Held: license not active",
  milestone_not_funded: "No funded milestone yet",
  exceeds_remaining_authorization: "Exceeds remaining authorization",
  nothing_approved: "Nothing approved",
};

function flagText(flag: string): string {
  if (flag.startsWith("license_") && flag !== "license_hold") return `License ${flag.slice("license_".length).replace("_", " ")}`;
  return FLAG_TEXT[flag] ?? flag.replace(/_/g, " ");
}

function Attribution({ submittedBy }: { submittedBy: InboxItem["payApp"]["submittedBy"] }) {
  if (submittedBy.actorType === "agent") {
    return (
      <p className="text-sm text-violet-200" data-testid="inbox-attribution" data-actor="agent">
        Submitted by billing agent {submittedBy.agentEmail ?? "(unknown)"} on behalf of {submittedBy.onBehalfOf ?? "(unknown owner)"}
      </p>
    );
  }
  return (
    <p className="text-sm text-slate-300" data-testid="inbox-attribution" data-actor="human">
      Submitted by {submittedBy.userEmail ?? "the subcontractor"} (subcontractor, human)
    </p>
  );
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(readableError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function MoneyProposalActions({ proposal, retainagePercent }: { proposal: Proposal; retainagePercent: number }) {
  const approve = useMutation(api.payApps.proposals.approveProposal);
  const edit = useMutation(api.payApps.proposals.editProposal);
  const reject = useMutation(api.payApps.proposals.rejectProposal);
  const { busy, error, run } = useRun();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(() => toDollarString(proposal.editedAmountCents ?? proposal.amountCents ?? 0));
  const [override, setOverride] = useState(false);
  const held = proposal.flags.includes("license_hold");

  async function saveEdit() {
    let cents: number;
    try {
      cents = fromDollars(amount);
    } catch {
      await run(async () => {
        throw new Error("Enter a dollar amount such as 1250.00.");
      });
      return;
    }
    if (await run(() => edit({ proposalId: proposal._id, amountCents: cents }))) setEditing(false);
  }

  return (
    <div className="space-y-2" data-testid="proposal-actions">
      {held ? (
        <label className="flex items-center gap-2 text-xs text-rose-200">
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} data-testid="override-license-hold" />
          Override the license hold and pay anyway (recorded in the audit log)
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || (held && !override)}
          onClick={() => void run(() => approve({ proposalId: proposal._id, ...(override ? { overrideLicenseHold: true } : {}) }))}
          className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          data-testid="approve-proposal"
        >
          {busy ? "Working…" : "Approve capture + payout"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setEditing((e) => !e)}
          className="rounded-lg border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
          data-testid="edit-proposal"
        >
          Edit amount
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => reject({ proposalId: proposal._id }))}
          className="rounded-lg border border-rose-800 px-3 py-1 text-xs text-rose-200 hover:bg-rose-950 disabled:opacity-50"
          data-testid="reject-proposal"
        >
          Reject
        </button>
      </div>
      {editing ? (
        <div className="flex flex-wrap items-end gap-2" data-testid="edit-proposal-form">
          <label className="text-xs text-slate-300">
            New gross amount (USD)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="mt-1 block w-40 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-sm tabular-nums"
              data-testid="edit-proposal-amount"
              aria-label="New gross amount in dollars"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => void saveEdit()}
            className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            data-testid="save-proposal-amount"
          >
            Save amount
          </button>
          <span className="text-xs text-slate-400">Retainage {retainagePercent}% and net are recomputed by code.</span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-red-300" data-testid="proposal-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SimpleProposalActions({ proposal }: { proposal: Proposal }) {
  const approve = useMutation(api.payApps.proposals.approveProposal);
  const reject = useMutation(api.payApps.proposals.rejectProposal);
  const { busy, error, run } = useRun();
  return (
    <div className="space-y-1" data-testid="proposal-actions">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => approve({ proposalId: proposal._id }))}
          className="rounded-lg border border-emerald-700 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-950 disabled:opacity-50"
          data-testid="approve-proposal"
        >
          Accept {proposal.kind}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => reject({ proposalId: proposal._id }))}
          className="rounded-lg border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800 disabled:opacity-50"
          data-testid="reject-proposal"
        >
          Dismiss
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-red-300" data-testid="proposal-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ProposalCard({ proposal, retainagePercent, showActions }: { proposal: Proposal; retainagePercent: number; showActions: boolean }) {
  const isMoney = proposal.kind === "capture" || proposal.kind === "payout";
  const held = proposal.flags.includes("license_hold");
  return (
    <li
      className={`rounded-xl border p-3 space-y-2 ${held ? "border-rose-800" : "border-slate-800"}`}
      data-testid="proposal-card"
      data-kind={proposal.kind}
      data-status={proposal.status}
      data-proposal-id={proposal._id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{KIND_LABEL[proposal.kind] ?? proposal.kind}</span>
          <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLE[proposal.status] ?? ""}`} data-testid="proposal-status">
            {proposal.status}
          </span>
          {held ? (
            <span className="rounded-full border border-rose-800 bg-rose-950 px-2 py-0.5 text-xs text-rose-200" data-testid="proposal-held">
              Held · license {proposal.licenseStatus ?? "unverified"}
            </span>
          ) : null}
          {proposal.licenseStatus ? (
            <LicenseBadge status={(proposal.licenseStatus as LicenseBadgeStatus) ?? "unverified"} />
          ) : null}
        </div>
        <span className="text-xs text-slate-400">
          {proposal.source === "code_policy" ? "Pay agent (code policy)" : "Pay agent"} · {formatDate(proposal.createdAt)}
        </span>
      </div>
      {isMoney && proposal.amountCents !== null ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-slate-400">Proposed (code-computed)</dt>
            <dd className="tabular-nums" data-testid="proposal-amount">{formatCents(proposal.amountCents)}</dd>
          </div>
          {proposal.editedAmountCents !== null ? (
            <div>
              <dt className="text-slate-400">Edited by GC</dt>
              <dd className="tabular-nums text-amber-200" data-testid="proposal-edited-amount">{formatCents(proposal.editedAmountCents)}</dd>
            </div>
          ) : null}
          {proposal.kind === "payout" && proposal.split ? (
            <>
              <div>
                <dt className="text-slate-400">Retainage {retainagePercent}%</dt>
                <dd className="tabular-nums" data-testid="proposal-retainage">{formatCents(proposal.split.retainageCents)}</dd>
              </div>
              <div>
                <dt className="text-slate-400">Net to sub</dt>
                <dd className="tabular-nums" data-testid="proposal-net">{formatCents(proposal.split.netCents)}</dd>
              </div>
            </>
          ) : null}
          {proposal.milestoneName ? (
            <div>
              <dt className="text-slate-400">Milestone</dt>
              <dd>{proposal.milestoneName}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <p className="text-xs text-slate-200" data-testid="proposal-rationale">{proposal.rationale}</p>
      {proposal.flags.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label="Flags">
          {proposal.flags.map((f) => (
            <li key={f} className="rounded-full border border-amber-800 bg-amber-950 px-2 py-0.5 text-[11px] text-amber-200" data-testid="proposal-flag" data-flag={f}>
              {flagText(f)}
            </li>
          ))}
        </ul>
      ) : null}
      {proposal.paypalCaptureId ? (
        <p className="text-xs text-slate-300">
          PayPal capture <span className="font-mono" data-testid="proposal-capture-id">{proposal.paypalCaptureId}</span>
        </p>
      ) : null}
      {proposal.error ? (
        <p className="text-xs text-rose-300" data-testid="proposal-failure">
          {proposal.error}
        </p>
      ) : null}
      {showActions && proposal.status === "pending" ? (
        isMoney ? (
          proposal.kind === "payout" ? <MoneyProposalActions proposal={proposal} retainagePercent={retainagePercent} /> : (
            <p className="text-xs text-slate-400">Approved together with the payout below.</p>
          )
        ) : (
          <SimpleProposalActions proposal={proposal} />
        )
      ) : null}
    </li>
  );
}

function AgentTrace({ payAppId }: { payAppId: string }) {
  const trace = useQuery(api.payApps.proposals.getAgentTrace, { payAppId });
  if (trace === undefined) return <p className="text-xs text-slate-400">Loading trace…</p>;
  if (trace === null) return <p className="text-xs text-slate-400">No pay-agent run recorded yet.</p>;
  const out = (trace.parsedOutput ?? {}) as {
    toolCalls?: { tool: string; source: string; input: string; output: string }[];
    tools?: string[];
  };
  return (
    <div className="space-y-2 text-xs" data-testid="agent-trace">
      <p className="text-slate-300" data-testid="agent-trace-source">
        {trace.provider === "Anthropic" ? `Anthropic · model ${trace.model}` : `${trace.provider} (no AI model ran)`} · {trace.inputTokens} in /{" "}
        {trace.outputTokens} out tokens · {trace.latencyMs} ms · run {trace.runId}
      </p>
      {out.tools ? <p className="text-slate-400">Tools available: {out.tools.join(", ")}</p> : null}
      <ol className="space-y-1">
        {(out.toolCalls ?? []).map((c, i) => (
          <li key={i} className="rounded-lg border border-slate-800 p-2" data-testid="agent-trace-call" data-tool={c.tool}>
            <span className="font-mono text-sky-200">{c.tool}</span>
            {c.source === "code_policy" ? <span className="text-amber-200"> (code policy)</span> : null}
            <pre className="mt-1 whitespace-pre-wrap break-all text-slate-400">in: {c.input}</pre>
            <pre className="whitespace-pre-wrap break-all text-slate-300">out: {c.output}</pre>
          </li>
        ))}
      </ol>
      {trace.rawResponse ? <pre className="whitespace-pre-wrap text-slate-300">{trace.rawResponse}</pre> : null}
    </div>
  );
}

function RejectPayAppButton({ payAppId }: { payAppId: string }) {
  const reject = useMutation(api.payApps.proposals.rejectPayApp);
  const { busy, error, run } = useRun();
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(() => reject({ payAppId }))}
        className="rounded-lg border border-rose-800 px-3 py-1 text-xs text-rose-200 hover:bg-rose-950 disabled:opacity-50"
        data-testid="reject-payapp"
      >
        Reject pay application
      </button>
      {error ? (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function InboxEntry({ item }: { item: InboxItem }) {
  const [showTrace, setShowTrace] = useState(false);
  const decidable = item.payApp.status === "reviewed";
  return (
    <article className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4" data-testid="inbox-entry" data-payapp-id={item.payApp._id}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">
            {item.agreement.subcontractorName} · {item.payApp.periodLabel}
          </h2>
          <p className="text-xs text-slate-400">
            {item.agreement.agreementNumber} · {item.agreement.projectTitle} · status{" "}
            <span data-testid="inbox-payapp-status">{item.payApp.status}</span>
          </p>
          <Attribution submittedBy={item.payApp.submittedBy} />
        </div>
        {["submitted", "under_review", "reviewed"].includes(item.payApp.status) ? <RejectPayAppButton payAppId={item.payApp._id} /> : null}
      </header>

      <LicenseCheckPanel contractorId={item.agreement.contractorId} />

      <section aria-label="Agent proposals" className="space-y-2">
        <h3 className="text-sm font-semibold">Pay agent proposals</h3>
        {item.proposals.length === 0 ? (
          <p className="text-xs text-slate-400" role="status">
            {item.payApp.status === "reviewed" ? "The pay agent is preparing proposals…" : "No proposals yet."}
          </p>
        ) : (
          <ul className="space-y-2">
            {item.proposals.map((p) => (
              <ProposalCard key={p._id} proposal={p} retainagePercent={item.agreement.retainagePercent} showActions={decidable} />
            ))}
          </ul>
        )}
        {item.payment ? (
          <p className="text-xs text-slate-300" data-testid="inbox-payment">
            Payout {item.payment.status}: {formatCents(item.payment.grossCents)} gross, {formatCents(item.payment.retainageCents)} retainage held,{" "}
            {formatCents(item.payment.netCents)} net to {item.payment.receiverEmail ?? "the sub"}
            {item.payment.batchId ? ` · batch ${item.payment.batchId}` : ""}
            {item.payment.error ? ` · ${item.payment.error}` : ""}
          </p>
        ) : null}
        <button type="button" onClick={() => setShowTrace((s) => !s)} className="text-xs text-sky-300 underline" data-testid="toggle-agent-trace">
          {showTrace ? "Hide agent trace" : "View agent trace"}
        </button>
        {showTrace ? <AgentTrace payAppId={item.payApp._id} /> : null}
      </section>

      <PayAppReviewCard payApp={item.payApp} canRerun />
    </article>
  );
}

/** GC approval inbox: the pay agent's proposals per pay application. Nothing moves until the GC approves. */
export function ApprovalInbox() {
  const items = useQuery(api.payApps.proposals.listInbox, {});
  return (
    <div className="max-w-6xl mx-auto p-6 space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Approval inbox</h1>
        <p className="text-sm text-slate-400">
          The pay agent reviews each pay application, checks the contractor's CSLB license and proposes a capture and payout. Amounts are
          computed by code. Nothing is captured or paid until you approve.
        </p>
      </header>
      {items === undefined ? (
        <p className="text-sm text-slate-400" role="status">Loading the inbox…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-400">No pay applications to review.</p>
      ) : (
        items.map((item) => <InboxEntry key={item.payApp._id} item={item} />)
      )}
    </div>
  );
}
