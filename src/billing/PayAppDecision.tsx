import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useMemo, useState } from "react";
import { api } from "../../convex/_generated/api";
import { approvedWorkAndStored, g702Summary } from "../../convex/payApps/g703Math";
import { getErrorMessage } from "../lib/errors";
import { Button, Card, ConfirmDialog, MoneyInput, StatusPill, TextInput, formatCents, formatDateTime } from "../ui";

type PayAppView = FunctionReturnType<typeof api.payApps.g703.getPayApp>;
type Review = NonNullable<PayAppView["review"]>;
type Decision = NonNullable<PayAppView["decision"]>;

export const OVERRIDE_REASON_REQUIRED = "A reason is required for an override";
const REVISION_REASON_REQUIRED = "A reason is required for each line you ask the sub to revise";
const REJECTION_REASON_REQUIRED = "A reason is required to reject a pay app";

type LineChoice = {
  action: "accept" | "override" | "revise";
  amountCents: number | null;
  reason: string;
  /** An override counts only once saved with its reason. */
  saved: boolean;
  error?: string;
};

const ACTION_LABEL: Record<string, string> = { accept: "Accepted", override: "Overridden", revise: "Revise" };

/** Review percents are stored as fractions (0.4 = 40.00%). */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

function engineLabel(r: Review): string {
  return r.provider === "Anthropic" ? `Anthropic · ${r.model}` : "Offline rules engine";
}

/** GC: the AI review per line and the per-line decision (accept, override with reason, or revise), then approve, send back or reject. */
export function GcReviewPanel({ view }: { view: PayAppView }) {
  const review = view.review;
  const decide = useMutation(api.payApps.decisions.decidePayApp);
  const rerun = useAction(api.payApps.review.rerunPayAppReview);
  const [choices, setChoices] = useState<Record<string, LineChoice>>({});
  const [confirm, setConfirm] = useState<"approve" | "revise" | "reject" | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const decidable = view.canApprove || view.canRequestRevision || view.canReject;

  const choiceOf = (id: string): LineChoice => choices[id] ?? { action: "accept", amountCents: null, reason: "", saved: false };
  const setChoice = (id: string, patch: Partial<LineChoice>) =>
    setChoices((c) => ({ ...c, [id]: { ...choiceOf(id), ...patch } }));

  const billed = (review?.lines ?? []).filter((l) => l.requestedCents > 0);
  const savedOverrides = billed.filter((l) => choiceOf(l.sovLineId).action === "override" && choiceOf(l.sovLineId).saved);
  const unsavedOverride = billed.find((l) => choiceOf(l.sovLineId).action === "override" && !choiceOf(l.sovLineId).saved);
  const revising = (review?.lines ?? []).filter((l) => choiceOf(l.sovLineId).action === "revise");

  const approved = useMemo(() => {
    const increments = new Map<string, number>();
    for (const l of review?.lines ?? []) {
      const c = choices[l.sovLineId];
      increments.set(l.sovLineId, c?.action === "override" && c.saved && c.amountCents !== null ? c.amountCents : l.approvedCents);
    }
    const lines = view.lines.map((l) => ({ ...l, ...approvedWorkAndStored(l, increments.get(l.sovLineId) ?? 0) }));
    return {
      totalCents: [...increments.values()].reduce((a, b) => a + b, 0),
      summary: g702Summary(lines, {
        originalContractSumCents: view.summary.originalContractSumCents,
        previousCertificatesCents: view.summary.previousCertificatesCents,
      }),
    };
  }, [choices, review, view.lines, view.summary]);

  if (!decidable && !review) return null;

  const saveOverride = (l: Review["lines"][number]) => {
    const c = choiceOf(l.sovLineId);
    if (c.reason.trim() === "") return setChoice(l.sovLineId, { error: OVERRIDE_REASON_REQUIRED, saved: false });
    if (c.amountCents === null) return setChoice(l.sovLineId, { error: "Enter the approved amount.", saved: false });
    if (c.amountCents > l.requestedCents) {
      return setChoice(l.sovLineId, { error: `The approved amount cannot exceed the ${formatCents(l.requestedCents)} requested.`, saved: false });
    }
    setChoice(l.sovLineId, { error: undefined, saved: true, reason: c.reason.trim() });
  };

  type LinePayload = { sovLineId: string; action: "override" | "revise"; amountCents?: number; reason: string };
  const payloadLines = (): LinePayload[] =>
    (review?.lines ?? []).flatMap((l): LinePayload[] => {
      const c = choices[l.sovLineId];
      if (!c || c.action === "accept") return [];
      if (c.action === "override") return c.saved ? [{ sovLineId: l.sovLineId, action: "override" as const, amountCents: c.amountCents ?? 0, reason: c.reason }] : [];
      return [{ sovLineId: l.sovLineId, action: "revise" as const, reason: c.reason }];
    });

  const startRevision = () => {
    setPanelError(null);
    let ok = true;
    for (const l of revising) {
      if (choiceOf(l.sovLineId).reason.trim() === "") {
        setChoice(l.sovLineId, { error: REVISION_REASON_REQUIRED });
        ok = false;
      }
    }
    if (ok) setConfirm("revise");
  };

  const startReject = () => {
    if (rejectReason.trim() === "") return setRejectError(REJECTION_REASON_REQUIRED);
    setRejectError(null);
    setConfirm("reject");
  };

  const asNoted = savedOverrides.length > 0;
  return (
    <Card
      title="AI review and GC decision"
      description={
        review ? (
          <span data-testid="review-engine">
            Reviewed by {engineLabel(review)} · {formatDateTime(review.reviewedAt)}
            {review.fallbackReason ? ` · ${review.fallbackReason}` : ""}. The AI recommends a percent complete to date per line; the dollars are computed by code.
          </span>
        ) : view.status === "under_review" ? (
          "The AI review is running…"
        ) : (
          "No AI review yet."
        )
      }
      actions={
        view.canApprove || view.status === "submitted" ? (
          <Button
            variant="secondary"
            size="sm"
            loading={rerunning}
            loadingLabel="Reviewing…"
            onClick={async () => {
              setRerunning(true);
              setPanelError(null);
              try {
                await rerun({ payAppId: view._id });
                setChoices({});
              } catch (err) {
                setPanelError(getErrorMessage(err, "The review could not be run."));
              } finally {
                setRerunning(false);
              }
            }}
            data-testid="review-rerun"
          >
            {review ? "Re-run AI review" : "Run AI review"}
          </Button>
        ) : null
      }
      data-testid="gc-review-panel"
    >
      {view.excludedScopeNotes.length > 0 ? (
        <div className="mb-3 rounded-lg border border-line bg-surface-raised p-3 text-xs" data-testid="review-excluded-scope">
          <p className="font-medium text-ink">Excluded scope (not in contract)</p>
          <ul className="mt-1 list-disc pl-4 text-ink-muted">
            {view.excludedScopeNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="mt-1 text-ink-subtle">The review flags any line or note that bills this work.</p>
        </div>
      ) : null}

      {review ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm" data-testid="review-lines">
            <thead className="text-left text-xs text-ink-subtle">
              <tr>
                <th className="px-2 py-2 font-medium">Line</th>
                <th className="px-2 py-2 font-medium">Verdict</th>
                <th className="px-2 py-2 text-right font-medium">Recommended % to date</th>
                <th className="px-2 py-2 text-right font-medium">Requested (E + F)</th>
                <th className="px-2 py-2 text-right font-medium">AI amount</th>
                <th className="px-2 py-2 font-medium">{view.canApprove ? "Your decision" : "Reason"}</th>
              </tr>
            </thead>
            <tbody>
              {review.lines.map((l) => {
                const c = choiceOf(l.sovLineId);
                const isBilled = l.requestedCents > 0;
                return (
                  <tr key={l.sovLineId} className="border-t border-line align-top" data-testid="review-line" data-line-no={l.lineNo}>
                    <td className="px-2 py-2">
                      <span className="block font-medium">
                        {l.lineNo}. {l.description}
                      </span>
                      <span className="mt-1 block text-xs text-ink-muted">{l.reason}</span>
                    </td>
                    <td className="px-2 py-2">
                      <StatusPill status={l.verdict} />
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums" data-testid="review-line-pct">
                      {pct(l.recommendedPctToDate)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatCents(l.requestedCents)}</td>
                    <td className="px-2 py-2 text-right tabular-nums" data-testid="review-line-amount">
                      {formatCents(l.approvedCents)}
                    </td>
                    <td className="px-2 py-2">
                      {!view.canApprove && !view.canRequestRevision ? null : !isBilled ? (
                        <span className="text-xs text-ink-subtle">Not billed this period</span>
                      ) : (
                        <LineDecision
                          line={l}
                          choice={c}
                          canApprove={view.canApprove}
                          canRevise={view.canRequestRevision}
                          onChange={(patch) => setChoice(l.sovLineId, patch)}
                          onSave={() => saveOverride(l)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {decidable ? (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          {view.canApprove ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => {
                  setPanelError(null);
                  setConfirm("approve");
                }}
                disabled={unsavedOverride !== undefined || revising.length > 0}
                data-testid="decision-approve"
              >
                {asNoted ? "Approve as noted" : "Approve"}
              </Button>
              <span className="text-sm text-ink-muted">
                Approves {formatCents(approved.totalCents)} this period; current payment due {formatCents(approved.summary.currentPaymentDueCents)}.
              </span>
              {unsavedOverride ? (
                <span className="text-xs text-amber-300">Save or cancel the override on line {unsavedOverride.lineNo} first.</span>
              ) : null}
            </div>
          ) : null}
          {view.canRequestRevision ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" onClick={startRevision} disabled={revising.length === 0} data-testid="decision-request-revision">
                Request revision{revising.length > 0 ? ` (${revising.length} line${revising.length > 1 ? "s" : ""})` : ""}
              </Button>
              <span className="text-xs text-ink-subtle">Choose "Revise" on the lines the sub must change.</span>
            </div>
          ) : null}
          {view.canReject ? (
            <div className="flex flex-wrap items-end gap-3">
              <TextInput
                className="min-w-[18rem] flex-1"
                label="Rejection reason"
                value={rejectReason}
                maxLength={500}
                error={rejectError ?? undefined}
                onChange={(v) => {
                  setRejectReason(v);
                  if (v.trim() !== "") setRejectError(null);
                }}
                data-testid="decision-reject-reason"
              />
              <Button variant="danger" onClick={startReject} data-testid="decision-reject">
                Reject
              </Button>
            </div>
          ) : null}
          {panelError ? (
            <p className="text-sm text-rose-300" role="alert">
              {panelError}
            </p>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm === "approve"}
        title={asNoted ? "Approve as noted?" : "Approve this pay app?"}
        amountCents={approved.summary.currentPaymentDueCents}
        amountLabel="Net current payment due"
        payee={view.agreement.subcontractorName}
        payeeLabel="Subcontractor"
        details={[
          { label: "Approved gross (completed & stored to date)", value: formatCents(approved.summary.completedAndStoredCents) },
          { label: "Retainage", value: formatCents(approved.summary.retainageCents) },
          { label: "Approved this period", value: formatCents(approved.totalCents) },
          ...(asNoted ? [{ label: "Lines overridden", value: savedOverrides.map((l) => `line ${l.lineNo}`).join(", ") }] : []),
        ]}
        effect="Records your per-line decision and notifies the sub. No money moves yet: the payment is approved separately once the payment checks pass."
        confirmLabel={asNoted ? "Approve as noted" : "Approve"}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await decide({ payAppId: view._id, decision: "approve", lines: payloadLines() });
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "revise"}
        title="Send back for revision?"
        effect={`The sub revises ${revising.map((l) => `line ${l.lineNo}`).join(", ")} and resubmits as a new version; the current version stays in the history. Pending payment proposals are rejected; no money moves.`}
        confirmLabel="Request revision"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await decide({ payAppId: view._id, decision: "request_revision", lines: payloadLines() });
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "reject"}
        title="Reject this pay app?"
        tone="danger"
        details={[{ label: "Reason", value: rejectReason.trim() }]}
        effect="Ends this pay app. Nothing is paid and it counts nothing toward the next application. The sub sees your reason."
        confirmLabel="Reject pay app"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await decide({ payAppId: view._id, decision: "reject", reason: rejectReason.trim() });
          setConfirm(null);
        }}
      />
    </Card>
  );
}

function LineDecision({
  line,
  choice,
  canApprove,
  canRevise,
  onChange,
  onSave,
}: {
  line: Review["lines"][number];
  choice: LineChoice;
  canApprove: boolean;
  canRevise: boolean;
  onChange: (patch: Partial<LineChoice>) => void;
  onSave: () => void;
}) {
  const options: LineChoice["action"][] = [...(canApprove ? (["accept", "override"] as const) : []), ...(canRevise ? (["revise"] as const) : [])];
  const name = `line-${line.sovLineId}-decision`;
  return (
    <div className="min-w-[16rem] space-y-2" data-testid="line-decision">
      <fieldset className="flex flex-wrap gap-3 text-xs">
        <legend className="sr-only">Decision for line {line.lineNo}</legend>
        {options.map((a) => (
          <label key={a} className="inline-flex items-center gap-1">
            <input
              type="radio"
              name={name}
              checked={choice.action === a}
              onChange={() =>
                onChange({
                  action: a,
                  saved: false,
                  error: undefined,
                  ...(a === "override" && choice.amountCents === null ? { amountCents: line.approvedCents } : {}),
                })
              }
            />
            {a === "accept" ? "Accept AI" : a === "override" ? "Override" : "Revise"}
          </label>
        ))}
      </fieldset>
      {choice.action === "override" ? (
        choice.saved ? (
          <div className="text-xs" data-testid="override-saved">
            <p className="font-medium text-ink">Override saved: {formatCents(choice.amountCents)}</p>
            <p className="text-ink-muted">{choice.reason}</p>
            <button type="button" className="text-accent underline" onClick={() => onChange({ saved: false })}>
              Edit override
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <MoneyInput
              label={<span className="text-xs">Approved amount (line {line.lineNo})</span>}
              value={choice.amountCents}
              onChange={(cents) => onChange({ amountCents: cents })}
            />
            <TextInput
              label={<span className="text-xs">Override reason (line {line.lineNo})</span>}
              value={choice.reason}
              maxLength={500}
              error={choice.error}
              onChange={(reason) => onChange({ reason, error: undefined })}
            />
            <Button size="sm" variant="secondary" onClick={onSave} data-testid="override-save">
              Save override
            </Button>
          </div>
        )
      ) : null}
      {choice.action === "revise" ? (
        <TextInput
          label={<span className="text-xs">What should the sub change on line {line.lineNo}?</span>}
          value={choice.reason}
          maxLength={500}
          error={choice.error}
          onChange={(reason) => onChange({ reason, error: undefined })}
        />
      ) : null}
    </div>
  );
}

/** The GC's decision with per-line reasons, as both the GC and the sub see it. */
export function DecisionCard({ decision, title }: { decision: Decision; title?: string }) {
  const noted = decision.lines.filter((l) => l.action !== "accept" || l.reason);
  return (
    <Card
      title={title ?? "GC decision"}
      description={`${decision.decidedByName} · ${formatDateTime(decision.decidedAt)}`}
      actions={<StatusPill status={decision.outcome} />}
      data-testid="payapp-decision"
    >
      {decision.reason ? <p className="mb-2 text-sm" data-testid="payapp-decision-reason">{decision.reason}</p> : null}
      {noted.length > 0 ? (
        <ul className="space-y-2 text-sm">
          {noted.map((l) => (
            <li key={l.sovLineId} className="rounded-lg border border-line p-2" data-testid="payapp-decision-line" data-line-no={l.lineNo}>
              <p className="font-medium">
                Line {l.lineNo}. {l.description} · {ACTION_LABEL[l.action]}
                {l.action === "override" ? `: approved ${formatCents(l.approvedCents)}` : ""}
                {l.action === "override" && l.recommendedCents !== null ? ` (AI ${formatCents(l.recommendedCents)})` : ""}
              </p>
              {l.reason ? <p className="text-ink-muted">Reason: {l.reason}</p> : null}
            </li>
          ))}
        </ul>
      ) : decision.outcome === "approved" ? (
        <p className="text-sm text-ink-muted">Every line was approved as reviewed.</p>
      ) : null}
    </Card>
  );
}

/** Earlier and current versions of a revised pay app, with the fields that changed. */
export function VersionHistory({ versions }: { versions: PayAppView["versions"] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (versions.length === 0) return null;
  return (
    <Card title="Version history" data-testid="payapp-versions">
      <ol className="space-y-3 text-sm">
        {versions.map((v) => (
          <li key={v.version} className="rounded-lg border border-line p-3" data-testid="payapp-version" data-version={v.version}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Version {v.version}</span>
              {v.current ? <StatusPill status="current" label="Current" tone="info" /> : null}
              {v.outcome ? <StatusPill status={v.outcome} /> : null}
              <span className="text-ink-muted">{v.submittedAt !== null ? `Submitted ${formatDateTime(v.submittedAt)}` : "Not submitted yet"}</span>
              {v.currentPaymentDueCents !== null ? <span className="text-ink-muted">· due {formatCents(v.currentPaymentDueCents)}</span> : null}
            </div>
            {v.reason ? <p className="mt-1 text-ink-muted">GC: {v.reason}</p> : null}
            {v.changes.length > 0 ? (
              <ul className="mt-2 list-disc pl-5" data-testid="payapp-version-changes">
                {v.changes.map((c) => (
                  <li key={`${c.sovLineId}-${c.field}`}>
                    Line {c.lineNo}: {c.field === "note" ? `note "${c.from}" → "${c.to}"` : `${c.field} ${formatCents(c.from as number)} → ${formatCents(c.to as number)}`}
                  </li>
                ))}
              </ul>
            ) : null}
            {!v.current ? (
              <button type="button" className="mt-2 text-xs text-accent underline" onClick={() => setOpen(open === v.version ? null : v.version)}>
                {open === v.version ? "Hide" : "Show"} version {v.version} entries
              </button>
            ) : null}
            {open === v.version ? (
              <table className="mt-2 w-full text-xs" data-testid="payapp-version-lines">
                <thead className="text-left text-ink-subtle">
                  <tr>
                    <th className="py-1 font-medium">Line</th>
                    <th className="py-1 text-right font-medium">E · This period</th>
                    <th className="py-1 text-right font-medium">F · Stored</th>
                    <th className="py-1 pl-3 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {v.lines.map((l) => (
                    <tr key={l.sovLineId} className="border-t border-line">
                      <td className="py-1">
                        {l.lineNo}. {l.description}
                      </td>
                      <td className="py-1 text-right tabular-nums">{formatCents(l.workThisPeriodCents)}</td>
                      <td className="py-1 text-right tabular-nums">{formatCents(l.storedCents)}</td>
                      <td className="py-1 pl-3 text-ink-muted">{l.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}
