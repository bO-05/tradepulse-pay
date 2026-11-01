import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { isInterruptedRelease } from "../../convex/payments/retainageMath";
import { readableError } from "./FundMilestone";
import { formatCents, formatDate } from "./format";
import { BADGE, type MilestoneRelease } from "./ReleaseMilestone";
import { ConfirmDialog } from "../ui";

/** Closeout retainage releases recorded on the agreement; GC can refresh a pending one. */
export function RetainageReleaseList({ releases, canRefresh }: { releases: MilestoneRelease[]; canRefresh: boolean }) {
  const refresh = useAction(api.payments.release.refreshPayoutStatus);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (releases.length === 0) return null;

  async function onRefresh(paymentId: Id<"payments">) {
    setBusyId(paymentId);
    setError(null);
    try {
      await refresh({ paymentId });
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-1 text-xs" data-testid="retainage-releases">
      {releases.map((r) => {
        const badge = BADGE[r.status] ?? { label: r.status, cls: "bg-slate-800 text-slate-200 border-slate-600" };
        return (
          <div key={r.paymentId} className="rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1.5 space-y-0.5" data-testid="retainage-release">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2 py-0.5 font-semibold ${badge.cls}`} data-testid="retainage-release-status">
                {badge.label}
              </span>
              <span className="tabular-nums">Retainage release {formatCents(r.netCents)}</span>
              <span className="text-slate-500">{formatDate(r.createdAt)}</span>
            </div>
            {(r.paypalPayoutBatchId || r.receiverEmail) && (
              <div className="text-slate-500">
                {r.receiverEmail ? `To ${r.receiverEmail}` : ""}
                {r.paypalPayoutBatchId ? ` · batch ${r.paypalPayoutBatchId}` : ""}
                {r.paypalItemStatus ? ` · PayPal item ${r.paypalItemStatus}` : ""}
              </div>
            )}
            {r.error && <p className={r.status === "success" ? "text-slate-400" : "text-rose-300"}>{r.error}</p>}
            {canRefresh && (r.status === "pending" || r.status === "unclaimed") && (
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => void onRefresh(r.paymentId)}
                className="rounded px-2 py-0.5 border border-slate-600 text-slate-200 disabled:opacity-50"
              >
                {busyId === r.paymentId ? "Refreshing…" : "Refresh status"}
              </button>
            )}
          </div>
        );
      })}
      {error && (
        <p className="text-rose-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Re-renders every 15 s while `active`, so a created release flips to resumable without a data change. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * GC-only closeout control: pays the sub the releasable retainage once. Disabled when nothing is releasable.
 * A release interrupted before PayPal answered gets "Resume release", which re-sends the same batch.
 */
export function RetainageReleaseControl({
  agreementId,
  balanceCents,
  releasableCents,
  releases,
}: {
  agreementId: Id<"agreements">;
  balanceCents: number;
  releasableCents: number;
  releases: MilestoneRelease[];
}) {
  const releaseRetainage = useAction(api.payments.retainage.releaseRetainage);
  const resumeRelease = useAction(api.payments.retainage.resumeRetainageRelease);
  const [busy, setBusy] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const created = releases.filter((r) => r.status === "created");
  const now = useNow(created.length > 0);
  const interrupted = created.find((r) => isInterruptedRelease(r, now));
  const inFlight = created.length > 0;
  const disabled = busy || inFlight || releasableCents <= 0;
  const waitingCents = balanceCents - releasableCents;

  async function run(call: () => Promise<{ message: string }>) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const out = await call();
      setNotice(out.message);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  function hint(): string {
    if (interrupted) return `A ${formatCents(interrupted.netCents)} retainage release was interrupted before PayPal answered. Resume it to send the same batch; it is never paid twice.`;
    if (inFlight) return "A retainage release is being processed.";
    if (balanceCents <= 0) return "Nothing to release: no retainage is held.";
    if (releasableCents <= 0) return `${formatCents(balanceCents)} held, none releasable yet: it waits for the sub payouts it came from to succeed at PayPal.`;
    if (waitingCents > 0) {
      return `${formatCents(balanceCents)} held, ${formatCents(releasableCents)} releasable now. ${formatCents(waitingCents)} waits for pending or unclaimed sub payouts to succeed.`;
    }
    return `Closeout: pays the sub ${formatCents(releasableCents)} in one PayPal payout.`;
  }

  return (
    <div className="space-y-1.5" data-testid="retainage-release-control">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="release-retainage-button"
          disabled={disabled}
          onClick={() => void (disabled ? undefined : run(() => releaseRetainage({ agreementId })))}
          className="rounded-lg px-3 py-1.5 text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy && !interrupted ? "Releasing…" : "Release retainage"}
        </button>
        {interrupted && (
          <button
            type="button"
            data-testid="resume-retainage-button"
            disabled={busy}
            onClick={() => setConfirmResume(true)}
            className="rounded-lg px-3 py-1.5 text-sm font-semibold border border-amber-500 text-amber-200 hover:bg-amber-500/10 disabled:opacity-50"
          >
            {busy ? "Resuming…" : "Resume release"}
          </button>
        )}
        <span className="text-xs text-slate-400" data-testid="retainage-release-hint">
          {hint()}
        </span>
      </div>
      {notice && (
        <p className="text-xs text-slate-300" role="status" data-testid="retainage-release-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-xs text-rose-300 max-w-md" role="alert" data-testid="retainage-release-error">
          {error}
        </p>
      )}
      {interrupted && (
        <ConfirmDialog
          open={confirmResume}
          title="Resume the retainage release?"
          amountCents={interrupted.netCents}
          amountLabel="Retainage payout"
          payee={interrupted.receiverEmail ?? "The sub's confirmed PayPal payee"}
          payeeLabel="Payee (confirmed PayPal email)"
          effect={`Sends the interrupted ${formatCents(interrupted.netCents)} retainage payout to PayPal under the same batch id. If PayPal already received it, PayPal returns that payout instead of paying twice. This can't be undone.`}
          confirmLabel={`Resume ${formatCents(interrupted.netCents)} payout`}
          onCancel={() => setConfirmResume(false)}
          onConfirm={async () => {
            setConfirmResume(false);
            await run(() => resumeRelease({ paymentId: interrupted.paymentId }));
          }}
        />
      )}
    </div>
  );
}
