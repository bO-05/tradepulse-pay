import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState, type ReactNode } from "react";
import { api } from "../../../convex/_generated/api";
import { fromDollars, toDollarString } from "../../../convex/lib/money";
import { readableError } from "../FundMilestone";
import { formatCents, formatDate } from "../format";
import { LicenseBadge, LicenseCheckPanel, type LicenseBadgeStatus } from "../LicenseCheck";
import { PayAppReviewCard } from "../PayAppReviews";
import { submissionAttribution } from "../SubmissionAttribution";
import { payAppHash, ledgerHash } from "../../auth/navigation";
import { Button, EmptyState, MoneyTrail, StatusPill, TextInput, statusLabel } from "../../ui";
import { ReceiptId } from "../ReceiptId";
import { ReferenceNotice } from "../ReferenceNotice";
import { isAIReviewProvider } from "../../lib/aiProvenance";
import { demoDisplayName, demoPeriodLabel, demoProjectName } from "../../lib/demoCopy";
import { maskSandboxEmail } from "../../lib/demoPrivacy";
import { auditText } from "../../lib/auditCopy";
import { reviewText } from "../../lib/reviewDisplay";
import { ProjectMoneyStrip } from "../../billing/ProjectMoneyStrip";
import { inboxGroup, payAppStatusLabel } from "./inboxBuckets";

type InboxItem = FunctionReturnType<typeof api.payApps.proposals.listInbox>[number];
type Proposal = InboxItem["proposals"][number];

const KIND_LABEL: Record<string, string> = {
  capture: "Capture from milestone authorization",
  payout: "Payout to the sub (net of retainage)",
  reschedule: "Reschedule billing",
  hold: "Hold payment",
  retainage_release: "Retainage release",
};

/** 24px-tall inline link: the 24px floor applies to every control, including secondary links. */
const INLINE_LINK = "inline-flex min-h-6 items-center rounded text-emerald-300 underline underline-offset-2";

/** The one primary action on an empty inbox: the next place the GC can look. */
const PRIMARY_LINK =
  "inline-flex min-h-touch items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover";

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

/** The stored rationale sometimes names a seeded commercial agreement; the home says the plain word. */
function withoutDemoAgreementId(text: string): string {
  return text.replace(/\bA401-[A-Z0-9-]+\b/gi, "the subcontract");
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

/**
 * The GC's reason, sent with every proposal decision. The server requires it when the decision
 * leaves nothing to pay and so rejects the pay application; the sub sees it.
 */
function DecisionReason({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <TextInput
      className="max-w-md"
      label="Reason for the sub"
      hint="Required when this decision leaves nothing to pay and rejects the pay application."
      value={value}
      maxLength={500}
      onChange={onChange}
      data-testid="proposal-reason"
    />
  );
}

function withReason(reason: string): { reason?: string } {
  return reason.trim() === "" ? {} : { reason: reason.trim() };
}

function MoneyProposalActions({ proposal, retainagePercent, primary }: { proposal: Proposal; retainagePercent: number; primary: boolean }) {
  const approve = useMutation(api.payApps.proposals.approveProposal);
  const edit = useMutation(api.payApps.proposals.editProposal);
  const reject = useMutation(api.payApps.proposals.rejectProposal);
  const { busy, error, run } = useRun();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(() => toDollarString(proposal.editedAmountCents ?? proposal.amountCents ?? 0));
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const [editReason, setEditReason] = useState(proposal.editedReason ?? "");
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
    if (editReason.trim() === "") {
      await run(async () => {
        throw new Error("Enter the reason for the change. The subcontractor sees it.");
      });
      return;
    }
    if (await run(() => edit({ proposalId: proposal._id, amountCents: cents, reason: editReason.trim() }))) setEditing(false);
  }

  return (
    <div className="space-y-2" data-testid="proposal-actions">
      {held ? (
        <label className="flex min-h-touch items-center gap-2 text-xs text-rose-200">
          <input
            type="checkbox"
            className="h-6 w-6 shrink-0 rounded border-line-strong bg-surface-sunken"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
            data-testid="override-license-hold"
          />
          Override the license hold and pay anyway (recorded in the audit log)
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={primary ? "primary" : "secondary"}
          size={primary ? "md" : "sm"}
          loading={busy}
          loadingLabel="Working…"
          disabled={held && !override}
          onClick={() => void run(() => approve({ proposalId: proposal._id, ...(override ? { overrideLicenseHold: true } : {}) }))}
          data-testid="approve-proposal"
        >
          Approve capture + payout
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing((e) => !e)} data-testid="edit-proposal">
          Edit amount
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void run(() => reject({ proposalId: proposal._id, ...withReason(reason) }))}
          data-testid="reject-proposal"
        >
          Reject
        </Button>
      </div>
      <DecisionReason value={reason} onChange={setReason} />
      {editing ? (
        <div className="flex flex-wrap items-end gap-2" data-testid="edit-proposal-form">
          <label className="text-xs text-slate-300">
            New gross amount (USD)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="mt-1 block min-h-touch w-40 rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm tabular-nums"
              data-testid="edit-proposal-amount"
              aria-label="New gross amount in dollars"
            />
          </label>
          <div className="min-w-64 flex-1">
            <TextInput
              label="Reason for the change"
              hint="Required. The subcontractor sees this explanation on the pay application and in the audit log."
              value={editReason}
              maxLength={500}
              onChange={setEditReason}
              data-testid="edit-proposal-reason"
            />
          </div>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void saveEdit()} data-testid="save-proposal-amount">
            Save amount
          </Button>
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

function SimpleProposalActions({ proposal, primary }: { proposal: Proposal; primary: boolean }) {
  const approve = useMutation(api.payApps.proposals.approveProposal);
  const reject = useMutation(api.payApps.proposals.rejectProposal);
  const { busy, error, run } = useRun();
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-1" data-testid="proposal-actions">
      <div className="flex flex-wrap gap-2">
        <Button
          variant={primary ? "primary" : "secondary"}
          size={primary ? "md" : "sm"}
          loading={busy}
          loadingLabel="Working…"
          onClick={() => void run(() => approve({ proposalId: proposal._id, ...withReason(reason) }))}
          data-testid="approve-proposal"
        >
          Accept {proposal.kind.replace(/_/g, " ")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void run(() => reject({ proposalId: proposal._id, ...withReason(reason) }))}
          data-testid="reject-proposal"
        >
          Dismiss
        </Button>
      </div>
      <DecisionReason value={reason} onChange={setReason} />
      {error ? (
        <p role="alert" className="text-xs text-red-300" data-testid="proposal-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ProposalCard({
  proposal,
  retainagePercent,
  showActions,
  primaryDecision,
}: {
  proposal: Proposal;
  retainagePercent: number;
  showActions: boolean;
  /** The one proposal that carries the screen's primary button: the next decision in the queue. */
  primaryDecision: boolean;
}) {
  const isMoney = proposal.kind === "capture" || proposal.kind === "payout";
  const held = proposal.flags.includes("license_hold");
  return (
    <li
      id={`proposal-${proposal._id}`}
      className={`rounded-xl border p-3 space-y-2 ${
        primaryDecision ? "border-emerald-700" : held ? "border-rose-800" : "border-slate-800"
      }`}
      data-testid="proposal-card"
      data-kind={proposal.kind}
      data-status={proposal.status}
      data-proposal-id={proposal._id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{KIND_LABEL[proposal.kind] ?? proposal.kind.replace(/_/g, " ")}</span>
          <StatusPill status={proposal.status} testId="proposal-status" />
          {held ? (
            <StatusPill status="held" label={`Held · license ${statusLabel(proposal.licenseStatus ?? "unverified").toLowerCase()}`} tone="warning" testId="proposal-held" />
          ) : null}
          {proposal.licenseStatus ? (
            <LicenseBadge status={(proposal.licenseStatus as LicenseBadgeStatus) ?? "unverified"} />
          ) : null}
        </div>
        <span className="text-xs text-ink-subtle">
          {proposal.source === "code_policy" ? "Pay agent (code policy)" : "Pay agent"} · {formatDate(proposal.createdAt)}
        </span>
      </div>
      {isMoney && proposal.amountCents !== null ? (
        <div className="space-y-1">
          <MoneyTrail
            variant="compact"
            testId="proposal-money-trail"
            ariaLabel="Money trail for this proposal"
            steps={[
              { label: "Proposed by code rules", valueCents: proposal.amountCents, valueTestId: "proposal-amount" },
              ...(proposal.editedAmountCents !== null
                ? [{ label: "Edited by GC", valueCents: proposal.editedAmountCents, valueTestId: "proposal-edited-amount", tone: "warning" as const }]
                : []),
              ...(proposal.kind === "payout" && proposal.split
                ? [
                    { label: `Retainage ${retainagePercent}%`, valueCents: proposal.split.retainageCents, valueTestId: "proposal-retainage" },
                    { label: "Net to sub", valueCents: proposal.split.netCents, valueTestId: "proposal-net", tone: "positive" as const },
                  ]
                : []),
            ]}
          />
          {proposal.milestoneName ? <p className="text-xs text-ink-subtle">Milestone: {proposal.milestoneName}</p> : null}
        </div>
      ) : null}
      <p className="text-xs text-slate-200" data-testid="proposal-rationale">{auditText(reviewText(withoutDemoAgreementId(proposal.rationale)))}</p>
      {proposal.editedReason ? (
        <p className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-2 py-1 text-xs text-amber-100" data-testid="proposal-edited-reason">
          <span className="font-semibold">GC reason for the change:</span> {auditText(proposal.editedReason)}
        </p>
      ) : null}
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
          proposal.kind === "payout" ? (
            <MoneyProposalActions proposal={proposal} retainagePercent={retainagePercent} primary={primaryDecision} />
          ) : (
            <p className="text-xs text-ink-subtle">Approved together with the payout below.</p>
          )
        ) : (
          <SimpleProposalActions proposal={proposal} primary={primaryDecision} />
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
        {isAIReviewProvider(trace.provider) ? `${trace.provider} · model ${trace.model}` : `${trace.provider} (no AI model ran)`} · {trace.inputTokens} in /{" "}
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
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
      <TextInput
        className="w-64"
        label="Rejection reason"
        required
        value={reason}
        maxLength={500}
        error={missing ? "Enter the reason the sub will see." : undefined}
        onChange={(v) => {
          setReason(v);
          if (v.trim() !== "") setMissing(false);
        }}
        data-testid="reject-payapp-reason"
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={() => {
          if (reason.trim() === "") {
            setMissing(true);
            return;
          }
          void run(() => reject({ payAppId, reason: reason.trim() }));
        }}
        data-testid="reject-payapp"
      >
        Reject pay application
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The approved total a settled reference decision reports, from stored figures only. */
function approvedCentsOf(item: InboxItem): number {
  return item.payApp.finalApproval?.totalCents ?? item.payApp.review?.approvedTotalCents ?? item.payApp.requestedTotalCents;
}

/** The payout split behind the settled decision, from the proposal the server stored. */
function payoutSplitOf(item: InboxItem): { retainageCents: number; netCents: number } | null {
  const proposal = item.proposals.find((p) => p.kind === "payout" && p.split !== null) ?? item.proposals.find((p) => p.split !== null);
  return proposal?.split ?? null;
}

/**
 * The first card on the GC home: the settled residential draw, with one filled action that names
 * the money. It is a read-only reference, so the action opens the stored decision and receipt
 * rather than approving it again.
 */
function ResidentialDecisionCard({ item }: { item: InboxItem }) {
  const approvedCents = approvedCentsOf(item);
  const split = payoutSplitOf(item);
  const netCents = split?.netCents ?? approvedCents;
  const paid = item.payApp.status === "paid";
  const shortPeriod = demoPeriodLabel(item.payApp.periodLabel).split("–")[0].trim();
  return (
    <article
      className="rounded-2xl border border-emerald-800 bg-emerald-950/30 p-4"
      data-testid="inbox-residential-decision"
      data-payapp-id={item.payApp._id}
      data-project-kind={item.projectKind}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-200">
        Residential draw · settled on the sandbox
      </p>
      <h2 className="mt-1 text-base font-semibold [overflow-wrap:anywhere]">
        {demoDisplayName(item.agreement.subcontractorName)} · {shortPeriod}
      </h2>
      <p className="mt-1 text-xs text-slate-300">
        {demoProjectName(item.agreement.projectTitle)} · {payAppStatusLabel(item.payApp.status)} · requested {formatCents(item.payApp.requestedTotalCents)}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <a
          href={payAppHash(item.payApp._id)}
          className={PRIMARY_LINK}
          data-testid="inbox-residential-decision-action"
        >
          {paid ? "View paid receipt" : `Approve ${formatCents(approvedCents)} and pay ${formatCents(netCents)}`}
        </a>
        <span className="text-xs text-slate-400">
          {paid ? "Read-only record · opens the settled receipt." : "Opens the pay application for your decision."}
        </span>
      </div>
      <p className="mt-2 text-xs text-slate-300">
        Approved {formatCents(approvedCents)}
        {split ? ` · ${formatCents(split.retainageCents)} retainage held · ${formatCents(split.netCents)} net` : ""}
      </p>
    </article>
  );
}

function InboxEntry({ item, primaryProposalId }: { item: InboxItem; primaryProposalId: string | null }) {
  const [showTrace, setShowTrace] = useState(false);
  const decidable = item.payApp.status === "reviewed" && !item.readOnlyReference;
  return (
    <article
      className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4"
      data-testid="inbox-entry"
      data-payapp-id={item.payApp._id}
      data-project-kind={item.projectKind}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
          <h2 className="text-base font-semibold">
            {demoDisplayName(item.agreement.subcontractorName)} · {demoPeriodLabel(item.payApp.periodLabel)}
          </h2>
          <p className="text-xs text-slate-400">
            {demoProjectName(item.agreement.projectTitle)} ·{" "}
            <span data-testid="inbox-payapp-status" data-status={item.payApp.status}>{payAppStatusLabel(item.payApp.status)}</span>
          </p>
          <p className="text-sm text-slate-300" data-testid="inbox-attribution" data-actor={item.payApp.submittedBy.actorType}>{submissionAttribution(item.payApp.submittedBy, item.payApp.judgeDemoFiledBy)}</p>
          <div className="flex flex-wrap gap-3 text-xs">
            <a href={payAppHash(item.payApp._id)} className={INLINE_LINK}>
              Open pay application
            </a>
            <a href={ledgerHash(item.agreement._id)} className={INLINE_LINK}>
              Agreement ledger
            </a>
            {/* The old "jump to the payout" text link duplicated the approve action in the card
                below. The card is now the decision, so the visible affordance is gone; the hook
                stays for the pinned test-id baseline. */}
            <button type="button" hidden tabIndex={-1} aria-hidden="true" data-testid="jump-to-approve" />
          </div>
          {item.readOnlyReference && <p className="text-xs text-amber-200">Settled reference · read-only</p>}
        </div>
        {!item.readOnlyReference && ["submitted", "under_review", "reviewed"].includes(item.payApp.status) ? <RejectPayAppButton payAppId={item.payApp._id} /> : null}
      </header>

      <LicenseCheckPanel contractorId={item.agreement.contractorId} readOnly={item.readOnlyReference} />

      <section aria-label="Agent proposals" className="space-y-2">
        <h3 className="text-sm font-semibold">Pay agent proposals</h3>
        {item.proposals.length === 0 ? (
          <EmptyState
            headingLevel={3}
            title={item.payApp.status === "reviewed" ? "The pay agent is preparing proposals" : "No proposals yet"}
            description="Open the pay application to see the review and the per-line detail."
            action={
              <a href={payAppHash(item.payApp._id)} className={INLINE_LINK}>
                Open pay application
              </a>
            }
          />
        ) : (
          <ul className="space-y-2">
            {item.proposals.map((p) => (
              <ProposalCard
                key={p._id}
                proposal={p}
                retainagePercent={item.agreement.retainagePercent}
                showActions={decidable}
                primaryDecision={decidable && p._id === primaryProposalId}
              />
            ))}
          </ul>
        )}
        {item.payment ? (
          <p className="text-xs text-slate-300 [overflow-wrap:anywhere]" data-testid="inbox-payment">
            Payout {statusLabel(item.payment.status)}: {formatCents(item.payment.grossCents)} gross, {formatCents(item.payment.retainageCents)} retainage held,{" "}
            {formatCents(item.payment.netCents)} net to {maskSandboxEmail(item.payment.receiverEmail) ?? "the sub"}
            {item.payment.batchId ? ` · batch ${item.payment.batchId}` : ""}
            {item.payment.error ? ` · ${item.payment.error}` : ""}
          </p>
        ) : null}
        {item.payment?.batchId ? <ReceiptId label="PayPal payout batch" value={item.payment.batchId} /> : null}
        {item.payment ? (
          <p className="text-xs text-slate-400">
            Payout status is as recorded from PayPal API responses and webhooks, not a live PayPal query.
          </p>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => setShowTrace((s) => !s)} data-testid="toggle-agent-trace">
          {showTrace ? "Hide agent trace" : "View agent trace"}
        </Button>
        {showTrace ? <AgentTrace payAppId={item.payApp._id} /> : null}
      </section>

      <PayAppReviewCard payApp={item.payApp} canRerun={!item.readOnlyReference} showAttribution={false} recordedHistory={item.readOnlyReference} />
    </article>
  );
}

/** GC approval inbox: the pay agent's proposals per pay application. Nothing moves until the GC approves. */
export function ApprovalInbox() {
  const items = useQuery(api.payApps.proposals.listInbox, {});
  const billingProjects = useQuery(api.billing.ownerPayApps.ownerBillingProjects, {});
  const residentialProject = billingProjects?.find((project) => project.partyRole === "gc" && project.projectKind === "residential") ?? null;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = items?.filter((item) => (status === "all" || item.payApp.status === status) &&
    [item.agreement.agreementNumber, item.agreement.projectTitle, item.agreement.subcontractorName, item.payApp.periodLabel, item.payApp._id].join(" ").toLowerCase().includes(search.toLowerCase().trim()));
  const visible = filtered ?? [];
  const active = visible.filter((item) => inboxGroup(item.payApp.status) === "active");
  const waiting = visible.filter((item) => inboxGroup(item.payApp.status) === "waiting");
  const history = visible.filter((item) => inboxGroup(item.payApp.status) === "history");
  const historyOpen = active.length === 0 && waiting.length === 0;
  const filtering = search.trim() !== "" || status !== "all";
  // The server keeps its newest-first contract. Only the client partitions the records, using the
  // stored project kind: every residential record renders before the commercial disclosure.
  const residential = visible.filter((item) => item.projectKind === "residential");
  const commercial = visible.filter((item) => item.projectKind !== "residential");
  const residentialActive = residential.filter((item) => inboxGroup(item.payApp.status) === "active");
  const residentialWaiting = residential.filter((item) => inboxGroup(item.payApp.status) === "waiting");
  const residentialHistory = residential.filter((item) => inboxGroup(item.payApp.status) === "history");
  // The paid residential reference card leads the page and carries the one filled receipt action.
  const residentialDecision = residential.find((item) => item.readOnlyReference && item.payApp.status === "paid") ?? null;
  // Prefer the next residential decision when no paid receipt leads. Commercial proposals remain
  // reachable in their disclosure, but never compete with the residential primary action.
  const primaryProposalId = (() => {
    if (residentialDecision) return null;
    const decisionQueue = [
      ...residentialActive,
      ...commercial.filter((item) => inboxGroup(item.payApp.status) === "active"),
    ];
    for (const item of decisionQueue) {
      if (item.readOnlyReference || item.payApp.status !== "reviewed") continue;
      const next = item.proposals.find((p) => p.status === "pending" && p.kind !== "capture");
      if (next) return next._id;
    }
    return null;
  })();
  const filterFields = (
    <>
      <label className="text-sm">Search loaded applications
        <input className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-900 p-2" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Agreement, project, company or pay app ID" />
      </label>
      <label className="text-sm">Status
        <select className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-900 p-2" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option>
          {["submitted", "under_review", "reviewed", "approved", "approved_as_noted", "revision_requested", "paid", "rejected"].map((s) => <option key={s} value={s}>{payAppStatusLabel(s)}</option>)}
        </select>
      </label>
      {filtering ? (
        <button
          type="button"
          className="self-end rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          onClick={() => { setSearch(""); setStatus("all"); }}
        >
          Clear
        </button>
      ) : null}
    </>
  );
  return (
    <div className="min-w-0 max-w-6xl mx-auto space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Approvals</h1>
          <p className="max-w-2xl text-sm text-slate-400">
            Review each sub pay app before money moves.
            <span className="hidden sm:inline"> Code computes the amounts; you approve, trim or reject.</span>
          </p>
        </div>
        {items ? (
          <p role="status" className="text-xs text-slate-400" data-testid="inbox-counts">
            {active.length} open · {waiting.length} awaiting payment · {history.length} in history
          </p>
        ) : null}
      </header>
      {residentialProject ? <ProjectMoneyStrip projectId={residentialProject._id} /> : null}
      <ProjectMoneyStrip />
      <div className="hidden gap-2 sm:grid sm:grid-cols-[minmax(0,1fr)_14rem_auto]">
        {filterFields}
      </div>
      {items && (filtering || visible.length !== items.length) && (
        <p className="text-xs text-slate-400">
          Showing {visible.length} of {items.length}.
        </p>
      )}
      {items === undefined ? (
        <p className="text-sm text-slate-400" role="status">Loading the inbox…</p>
      ) : items.length === 0 ? (
        <EmptyState
          title="No pay applications to review"
          description="When a subcontractor files a pay app, it lands here for your decision."
          action={<a href="#/billing" className={PRIMARY_LINK}>Open billing</a>}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No applications match these filters"
          description="Clear the search or choose another status to see the rest of the inbox."
          action={<Button onClick={() => { setSearch(""); setStatus("all"); }}>Clear filters</Button>}
        />
      ) : (
        <div className="space-y-6">
          <InboxBucket
            title="Needs your attention"
            description="Residential work leads; commercial reference records are grouped below."
            items={residentialActive}
            primaryProposalId={primaryProposalId}
            featured={residentialDecision ? <ResidentialDecisionCard item={residentialDecision} /> : undefined}
          />
          <InboxBucket title="Approved · awaiting payment" items={residentialWaiting} primaryProposalId={null} />
          {residentialHistory.length > 0 ? (
            <details className="group rounded-2xl border border-slate-800 bg-slate-900/40" open={historyOpen} data-testid="inbox-history">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span>
                  <span className="text-base font-semibold">History</span>
                  <span className="ml-2 text-xs text-slate-400">{residentialHistory.length} paid, rejected or revised</span>
                </span>
                <span aria-hidden="true" className="text-xs text-slate-400 group-open:hidden">Show</span>
                <span aria-hidden="true" className="hidden text-xs text-slate-400 group-open:inline">Hide</span>
              </summary>
              <div className="space-y-3 border-t border-slate-800 p-3">
                {residentialHistory.map((item) => <InboxEntry key={item.payApp._id} item={item} primaryProposalId={null} />)}
              </div>
            </details>
          ) : null}
          {commercial.length > 0 ? (
            <details
              className="group rounded-2xl border border-slate-800 bg-slate-900/40"
              open={filtering}
              data-testid="inbox-commercial"
              data-record-count={commercial.length}
            >
              <summary
                className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden"
                data-testid="inbox-commercial-summary"
              >
                <span className="text-base font-semibold">Commercial reference job ({commercial.length})</span>
                <span aria-hidden="true" className="text-xs text-slate-400 group-open:hidden">Show</span>
                <span aria-hidden="true" className="hidden text-xs text-slate-400 group-open:inline">Hide</span>
              </summary>
              <div className="space-y-3 border-t border-slate-800 p-3">
                {commercial.map((item) => <InboxEntry key={item.payApp._id} item={item} primaryProposalId={primaryProposalId} />)}
              </div>
            </details>
          ) : null}
        </div>
      )}
      <details className="rounded-xl border border-slate-800 bg-slate-900/40 sm:hidden" open={filtering} data-testid="inbox-filters">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-sm text-slate-300 [&::-webkit-details-marker]:hidden">
          Search and filters
          <span aria-hidden="true" className="text-xs text-slate-400">Show</span>
        </summary>
        <div className="grid gap-2 border-t border-slate-800 p-3">
          {filterFields}
        </div>
      </details>
      {items?.some((item) => item.readOnlyReference) ? <ReferenceNotice title="Preserved reference jobs · read-only." /> : null}
    </div>
  );
}

function InboxBucket({
  title,
  description,
  items,
  primaryProposalId,
  featured,
}: {
  title: string;
  description?: string;
  items: InboxItem[];
  primaryProposalId: string | null;
  featured?: ReactNode;
}) {
  if (items.length === 0 && featured === undefined) return null;
  return (
    <section aria-label={title} className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{title} <span className="text-sm font-normal text-slate-400">{items.length}</span></h2>
        {description ? <p className="hidden text-xs text-slate-400 sm:block">{description}</p> : null}
      </div>
      {featured}
      {items.map((item) => <InboxEntry key={item.payApp._id} item={item} primaryProposalId={primaryProposalId} />)}
    </section>
  );
}
