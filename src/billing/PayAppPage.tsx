import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import {
  formatPercentHundredths,
  g702Summary,
  g703Line,
  g703LineErrors,
  lineIncrementCents,
  percentHundredths,
  type G702Summary,
} from "../../convex/payApps/g703Math";
import { getErrorMessage } from "../lib/errors";
import { Button, Card, ConfirmDialog, MoneyInput, PageHeader, StatusPill, TextInput, formatCents, formatDate, formatDateTime } from "../ui";

type PayAppView = FunctionReturnType<typeof api.payApps.g703.getPayApp>;
type SheetLine = PayAppView["lines"][number];
type Entry = { workThisPeriodCents: number; storedCents: number; note: string };

const AUTOSAVE_DELAY_MS = 700;

export function payAppTitle(p: { applicationNo: number | null; periodLabel: string }): string {
  return p.applicationNo !== null ? `Pay app #${p.applicationNo}` : p.periodLabel;
}

/** One pay application: the sub edits its draft G703 (autosaved); everyone allowed reads G703 and G702. */
export function PayAppPage({ payAppId, backHash, backLabel }: { payAppId: string; backHash: string; backLabel: string }) {
  const view = useQuery(api.payApps.g703.getPayApp, { payAppId });
  if (view === undefined) {
    return (
      <p className="text-sm text-slate-400" role="status">
        Loading pay application…
      </p>
    );
  }
  return <PayAppScreen key={view._id} view={view} backHash={backHash} backLabel={backLabel} />;
}

function entriesFrom(lines: readonly SheetLine[]): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const l of lines) out[l.sovLineId] = { workThisPeriodCents: l.workThisPeriodCents, storedCents: l.storedCents, note: l.note ?? "" };
  return out;
}

function PayAppScreen({ view, backHash, backLabel }: { view: PayAppView; backHash: string; backLabel: string }) {
  const saveDraft = useMutation(api.payApps.g703.saveDraft);
  const submit = useMutation(api.payApps.g703.submitPayApp);
  const withdraw = useMutation(api.payApps.submit.withdrawPayApplication);
  const editable = view.editable;
  const [entries, setEntries] = useState<Record<string, Entry>>(() => entriesFrom(view.lines));
  const [saveState, setSaveState] = useState<{ kind: "idle" | "saving" | "saved" | "error"; at?: number; message?: string }>(
    view.savedAt !== null && editable ? { kind: "saved", at: view.savedAt } : { kind: "idle" },
  );
  const [confirm, setConfirm] = useState<"submit" | "withdraw" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Record<string, Entry> | null>(null);

  const linesPayload = (e: Record<string, Entry>) =>
    Object.entries(e).map(([sovLineId, x]) => ({
      sovLineId,
      workThisPeriodCents: x.workThisPeriodCents,
      storedCents: x.storedCents,
      ...(x.note.trim() ? { note: x.note.trim() } : {}),
    }));

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const e = pending.current;
    if (e === null) return;
    pending.current = null;
    setSaveState({ kind: "saving" });
    try {
      const res = await saveDraft({ payAppId: view._id, lines: linesPayload(e) });
      setSaveState({ kind: "saved", at: res.savedAt });
    } catch (err) {
      setSaveState({ kind: "error", message: getErrorMessage(err, "The draft could not be saved.") });
    }
  }, [saveDraft, view._id]);

  useEffect(
    () => () => {
      // Leaving the page saves what was typed last.
      if (pending.current !== null) void flush();
    },
    [flush],
  );

  const entriesRef = useRef(entries);
  const update = (sovLineId: string, patch: Partial<Entry>) => {
    const line = view.lines.find((l) => l.sovLineId === sovLineId);
    const base = entriesRef.current[sovLineId] ?? {
      workThisPeriodCents: 0,
      storedCents: line?.previousStoredCents ?? 0,
      note: "",
    };
    const next = { ...entriesRef.current, [sovLineId]: { ...base, ...patch } };
    entriesRef.current = next;
    setEntries(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    setSaveState((s) => (s.kind === "saving" ? s : { kind: "idle" }));
  };

  const lines: SheetLine[] = useMemo(
    () =>
      editable
        ? view.lines.map((l) => {
            const e = entries[l.sovLineId];
            return e ? { ...l, workThisPeriodCents: e.workThisPeriodCents, storedCents: e.storedCents, note: e.note || null } : l;
          })
        : view.lines,
    [editable, entries, view.lines],
  );
  const summary: G702Summary = useMemo(
    () =>
      editable
        ? g702Summary(lines, {
            originalContractSumCents: view.summary.originalContractSumCents,
            previousCertificatesCents: view.summary.previousCertificatesCents,
          })
        : view.summary,
    [editable, lines, view.summary],
  );
  const errors = useMemo(() => {
    if (!editable) return new Map<string, string>();
    const list = g703LineErrors(
      lines.map((l) => ({
        sovLineId: l.sovLineId,
        lineNo: l.lineNo,
        scheduledValueCents: l.scheduledValueCents,
        previousWorkCents: l.previousWorkCents,
        previousStoredCents: l.previousStoredCents,
        pendingCents: l.pendingCents,
        workThisPeriodCents: l.workThisPeriodCents,
        storedCents: l.storedCents,
        note: l.note ?? undefined,
      })),
    );
    return new Map(list.map((e) => [e.sovLineId, e.message]));
  }, [editable, lines]);
  const claimed = lines.reduce((acc, l) => acc + lineIncrementCents(l), 0);
  const canSubmit = editable && errors.size === 0 && claimed > 0;
  const title = payAppTitle(view);

  return (
    <div className="max-w-6xl space-y-4">
      <PageHeader
        back={{ href: backHash, label: backLabel }}
        title={title}
        description={`${view.agreement.subcontractorName} · ${view.agreement.projectTitle} · ${view.agreement.agreementNumber}`}
        meta={<StatusPill status={view.status} />}
        actions={
          editable ? (
            <Button onClick={() => setConfirm("submit")} disabled={!canSubmit} data-testid="payapp-submit">
              Submit pay app
            </Button>
          ) : view.canWithdraw ? (
            <Button variant="secondary" onClick={() => setConfirm("withdraw")} data-testid="payapp-withdraw">
              Withdraw
            </Button>
          ) : null
        }
      />

      <Card padded>
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-ink-subtle">Application No.</dt>
            <dd className="font-semibold" data-testid="payapp-number">
              {view.applicationNo ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-subtle">Period</dt>
            <dd className="font-semibold" data-testid="payapp-period">
              {view.periodStart && view.periodEnd ? `${formatDate(view.periodStart)} – ${formatDate(view.periodEnd)}` : view.periodLabel}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-subtle">Due date</dt>
            <dd className="font-semibold" data-testid="payapp-due">
              {formatDate(view.dueDate)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-subtle">{view.status === "draft" ? "Draft" : "Submitted"}</dt>
            <dd className="font-semibold" aria-live="polite" data-testid="payapp-save-state">
              {view.status !== "draft" ? (
                formatDateTime(view.submittedAt)
              ) : saveState.kind === "saving" ? (
                "Saving…"
              ) : saveState.kind === "saved" ? (
                `Draft saved ${formatDateTime(saveState.at)}`
              ) : saveState.kind === "error" ? (
                <span className="text-rose-300">{saveState.message}</span>
              ) : (
                "Unsaved changes"
              )}
            </dd>
          </div>
        </dl>
        {view.status === "draft" ? (
          <p className="mt-3 text-xs text-ink-subtle">
            Not submitted. Entries save automatically; the GC sees this pay app only after you submit it.
          </p>
        ) : null}
        {view.basis === "approved" ? (
          <p className="mt-3 text-xs text-ink-subtle">Figures below are the GC-approved amounts.</p>
        ) : null}
        {view.rejectionReason ? (
          <p className="mt-3 text-sm text-rose-300" data-testid="payapp-rejection-reason">
            Rejected: {view.rejectionReason}
          </p>
        ) : null}
      </Card>

      <ContinuationSheet lines={lines} editable={editable} errors={errors} onChange={update} summary={summary} />
      <G702Card summary={summary} retainageBps={view.retainageBps} />

      <ConfirmDialog
        open={confirm === "submit"}
        title={`Submit ${title}?`}
        amountCents={summary.currentPaymentDueCents}
        amountLabel="Current payment due"
        payee={view.agreement.subcontractorName}
        payeeLabel="Billing as"
        details={[
          { label: "Completed & stored to date", value: formatCents(summary.completedAndStoredCents) },
          { label: "Retainage", value: formatCents(summary.retainageCents) },
        ]}
        effect="Sends this pay app to the GC for review and locks your entries. You can withdraw it until the GC decides."
        confirmLabel="Submit pay app"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (timer.current) clearTimeout(timer.current);
          pending.current = null;
          await submit({ payAppId: view._id, lines: linesPayload(entries) });
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "withdraw"}
        title={`Withdraw ${title}?`}
        tone="danger"
        effect="Takes the pay app out of the GC's review and cancels its pending payment proposals. No money moves. You can start a new pay app for the same period."
        confirmLabel="Withdraw pay app"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await withdraw({ payAppId: view._id });
          setConfirm(null);
        }}
      />
    </div>
  );
}

function ContinuationSheet({
  lines,
  editable,
  errors,
  onChange,
  summary,
}: {
  lines: SheetLine[];
  editable: boolean;
  errors: Map<string, string>;
  onChange: (sovLineId: string, patch: Partial<Entry>) => void;
  summary: G702Summary;
}) {
  const th = "px-2 py-2 font-medium align-bottom";
  const num = "px-2 py-2 text-right tabular-nums align-top whitespace-nowrap";
  return (
    <Card title="Continuation sheet (G703)" padded>
      <div className="overflow-x-auto" data-testid="g703-sheet">
        <table className="w-full min-w-[960px] text-sm">
          <caption className="sr-only">G703 continuation sheet, columns A to I</caption>
          <thead className="text-left text-xs text-ink-subtle">
            <tr>
              <th className={th} scope="col">A · Item</th>
              <th className={th} scope="col">B · Description</th>
              <th className={`${th} text-right`} scope="col">C · Scheduled value</th>
              <th className={`${th} text-right`} scope="col">D · From previous applications</th>
              <th className={`${th} text-right`} scope="col">E · This period</th>
              <th className={`${th} text-right`} scope="col">F · Materials presently stored</th>
              <th className={`${th} text-right`} scope="col">G · Completed &amp; stored to date</th>
              <th className={`${th} text-right`} scope="col">% (G ÷ C)</th>
              <th className={`${th} text-right`} scope="col">H · Balance to finish</th>
              <th className={`${th} text-right`} scope="col">I · Retainage</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const f = g703Line(l);
              const error = errors.get(l.sovLineId);
              return (
                <tr key={l.sovLineId} className="border-t border-line" data-testid="g703-line" data-line-no={l.lineNo}>
                  <td className="px-2 py-2 align-top">{l.lineNo}</td>
                  <td className="px-2 py-2 align-top">
                    <span className="block">{l.description}</span>
                    {l.csiCode ? <span className="block text-xs text-ink-subtle">{l.csiCode}</span> : null}
                    {editable && l.storedCents > 0 ? (
                      <TextInput
                        className="mt-2"
                        label={<span className="text-xs">Stored material note (line {l.lineNo})</span>}
                        value={l.note ?? ""}
                        maxLength={500}
                        onChange={(note) => onChange(l.sovLineId, { note })}
                      />
                    ) : l.note ? (
                      <span className="mt-1 block text-xs text-ink-muted">Stored: {l.note}</span>
                    ) : null}
                    {error ? (
                      <p className="mt-1 text-xs text-rose-300" role="alert" data-testid="g703-line-error">
                        {error}
                      </p>
                    ) : null}
                  </td>
                  <td className={num}>{formatCents(l.scheduledValueCents)}</td>
                  <td className={num}>{formatCents(l.previousWorkCents)}</td>
                  <td className={num}>
                    {editable ? (
                      <MoneyInput
                        className="min-w-[8.5rem]"
                        label={<span className="sr-only">Line {l.lineNo} work this period (E)</span>}
                        value={l.workThisPeriodCents}
                        error={error ? " " : undefined}
                        onChange={(cents) => onChange(l.sovLineId, { workThisPeriodCents: cents ?? 0 })}
                      />
                    ) : (
                      <Requested value={l.workThisPeriodCents} requested={l.requestedWorkCents} />
                    )}
                  </td>
                  <td className={num}>
                    {editable ? (
                      <MoneyInput
                        className="min-w-[8.5rem]"
                        label={<span className="sr-only">Line {l.lineNo} materials presently stored (F)</span>}
                        value={l.storedCents}
                        error={error ? " " : undefined}
                        onChange={(cents) => onChange(l.sovLineId, { storedCents: cents ?? 0 })}
                      />
                    ) : (
                      <Requested value={l.storedCents} requested={l.requestedStoredCents} />
                    )}
                  </td>
                  <td className={num}>{formatCents(f.totalCents)}</td>
                  <td className={num}>{f.totalCents === 0 ? "" : formatPercentHundredths(f.percentHundredths)}</td>
                  <td className={num}>{formatCents(f.balanceCents)}</td>
                  <td className={num}>{formatCents(f.retainageCents)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 border-line-strong font-semibold">
            <tr data-testid="g703-totals">
              <th scope="row" className="px-2 py-2 text-left" colSpan={2}>
                Totals
              </th>
              <td className={num}>{formatCents(summary.scheduledValueCents)}</td>
              <td className={num}>{formatCents(summary.previousWorkCents)}</td>
              <td className={num}>{formatCents(summary.workThisPeriodCents)}</td>
              <td className={num}>{formatCents(summary.storedCents)}</td>
              <td className={num}>{formatCents(summary.completedAndStoredCents)}</td>
              <td className={num}>{formatPercentHundredths(percentHundredths(summary.completedAndStoredCents, summary.scheduledValueCents))}</td>
              <td className={num}>{formatCents(summary.balanceToFinishCents)}</td>
              <td className={num}>{formatCents(summary.retainageCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

function Requested({ value, requested }: { value: number; requested: number | null }) {
  return (
    <span>
      {formatCents(value)}
      {requested !== null ? <span className="block text-xs text-ink-subtle">Requested {formatCents(requested)}</span> : null}
    </span>
  );
}

function G702Card({ summary, retainageBps }: { summary: G702Summary; retainageBps: number }) {
  const rows: [string, string, string?][] = [
    ["1", "Original contract sum", formatCents(summary.originalContractSumCents)],
    ["2", "Net change by change orders", formatCents(summary.netChangeOrdersCents, { showPlus: true })],
    ["3", "Contract sum to date", formatCents(summary.contractSumToDateCents)],
    ["4", "Total completed & stored to date", formatCents(summary.completedAndStoredCents)],
    ["5", `Retainage (${retainageBps / 100}% by line, rounded per line)`, formatCents(summary.retainageCents)],
    ["5a", "On completed work", formatCents(summary.retainageWorkCents)],
    ["5b", "On stored material", formatCents(summary.retainageStoredCents)],
    ["6", "Total earned less retainage", formatCents(summary.earnedLessRetainageCents)],
    ["7", "Less previous certificates for payment", formatCents(summary.previousCertificatesCents)],
    ["8", "Current payment due", formatCents(summary.currentPaymentDueCents)],
    ["9", "Balance to finish, including retainage", formatCents(summary.balanceToFinishInclRetainageCents)],
  ];
  return (
    <Card title="Application summary (G702)" padded>
      <dl className="divide-y divide-line text-sm" data-testid="g702-summary">
        {rows.map(([no, label, value]) => (
          <div key={no} className={`flex items-baseline justify-between gap-4 py-2 ${no.length > 1 ? "pl-6 text-ink-muted" : ""}`} data-g702-line={no}>
            <dt>
              <span className="mr-2 text-ink-subtle">({no})</span>
              {label}
            </dt>
            <dd className={`tabular-nums ${no === "8" ? "text-base font-bold" : "font-semibold"}`}>{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
