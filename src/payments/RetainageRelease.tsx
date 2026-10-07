import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { readableError } from "./FundMilestone";
import { formatCents, formatDate } from "./format";
import { BADGE, type MilestoneRelease } from "./ReleaseMilestone";

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

/** GC-only closeout control: pays the sub the whole retainage balance once. Disabled when nothing is held. */
export function RetainageReleaseControl({
  agreementId,
  balanceCents,
  releases,
}: {
  agreementId: Id<"agreements">;
  balanceCents: number;
  releases: MilestoneRelease[];
}) {
  const releaseRetainage = useAction(api.payments.retainage.releaseRetainage);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = releases.some((r) => r.status === "created");
  const disabled = busy || inFlight || balanceCents <= 0;

  async function release() {
    if (disabled) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const out = await releaseRetainage({ agreementId });
      setNotice(out.message);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5" data-testid="retainage-release-control">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="release-retainage-button"
          disabled={disabled}
          onClick={() => void release()}
          className="rounded-lg px-3 py-1.5 text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Releasing…" : "Release retainage"}
        </button>
        <span className="text-xs text-slate-400" data-testid="retainage-release-hint">
          {balanceCents > 0
            ? inFlight
              ? "A retainage release is being processed."
              : `Closeout: pays the sub ${formatCents(balanceCents)} in one PayPal payout.`
            : "Nothing to release: no retainage is held."}
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
    </div>
  );
}
