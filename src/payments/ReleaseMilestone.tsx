import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { readableError } from "./FundMilestone";
import { formatCents, formatDate } from "./format";

export type MilestoneRelease = {
  paymentId: Id<"payments">;
  status: string;
  grossCents: number;
  retainageCents: number;
  netCents: number;
  paypalPayoutBatchId: string | null;
  paypalPayoutItemId: string | null;
  paypalItemStatus: string | null;
  receiverEmail: string | null;
  error: string | null;
  createdAt: number;
  updatedAt?: number;
  retryOfPaymentId?: Id<"payments"> | null;
  captured?: boolean;
  canRetryPayout?: boolean;
};

export type ReleasableMilestone = {
  _id: Id<"milestones">;
  name: string;
  status: string;
  funding: { status: string; grossCents: number; capturedCents: number; paypalAuthorizationId: string | null } | null;
  releases: MilestoneRelease[];
};

export const BADGE: Record<string, { label: string; cls: string }> = {
  created: { label: "Processing", cls: "bg-slate-800 text-slate-200 border-slate-600" },
  capture_pending: { label: "Capture pending", cls: "bg-amber-950 text-amber-200 border-amber-800" },
  pending: { label: "Payout pending", cls: "bg-amber-950 text-amber-200 border-amber-800" },
  success: { label: "Paid", cls: "bg-emerald-950 text-emerald-300 border-emerald-800" },
  unclaimed: { label: "Unclaimed", cls: "bg-orange-950 text-orange-200 border-orange-800" },
  returned: { label: "Returned", cls: "bg-rose-950 text-rose-200 border-rose-800" },
  failed: { label: "Failed", cls: "bg-rose-950 text-rose-200 border-rose-800" },
};

/**
 * Releases (capture + payout) recorded for a funding tranche. Read-only apart from status refreshes:
 * subcontract payments are started and retried only from the approved pay app's Payment panel.
 */
export function ReleaseList({ milestone, canRelease }: { milestone: ReleasableMilestone; canRelease: boolean }) {
  const refresh = useAction(api.payments.release.refreshPayoutStatus);
  const refreshCapture = useAction(api.payments.release.refreshCaptureStatus);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (milestone.releases.length === 0) return null;

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-1" data-testid="milestone-releases">
      {milestone.releases.map((r) => {
        const badge = BADGE[r.status] ?? { label: r.status, cls: "bg-slate-800 text-slate-200 border-slate-600" };
        return (
          <div key={r.paymentId} className="text-xs space-y-0.5" data-testid="release-row" data-status={r.status}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 border font-semibold ${badge.cls}`} data-testid="release-status">
                {badge.label}
              </span>
              <span className="tabular-nums text-slate-300">
                Gross {formatCents(r.grossCents)} · retainage {formatCents(r.retainageCents)} · net {formatCents(r.netCents)}
              </span>
              <span className="text-slate-500">{formatDate(r.createdAt)}</span>
              {r.retryOfPaymentId && (
                <span className="text-slate-400" data-testid="release-retry-tag">
                  Payout retry
                </span>
              )}
              {r.captured && r.status !== "success" && !r.retryOfPaymentId && (
                <span className="text-amber-300" data-testid="release-captured-not-paid">
                  Captured
                </span>
              )}
            </div>
            {(r.paypalPayoutBatchId || r.receiverEmail) && (
              <div className="text-slate-500">
                {r.receiverEmail ? `To ${r.receiverEmail}` : ""}
                {r.paypalPayoutBatchId ? ` · batch ${r.paypalPayoutBatchId}` : ""}
                {r.paypalItemStatus ? ` · PayPal item ${r.paypalItemStatus}` : ""}
              </div>
            )}
            {r.error && (
              <p className={r.status === "success" ? "text-slate-400" : "text-rose-300"} data-testid="release-error">
                {r.error}
              </p>
            )}
            {canRelease && (r.status === "pending" || r.status === "unclaimed") && (
              <button
                type="button"
                data-testid="refresh-payout-button"
                disabled={busyId !== null}
                onClick={() => void run(r.paymentId, () => refresh({ paymentId: r.paymentId }))}
                className="rounded px-2 py-0.5 border border-slate-600 text-slate-200 disabled:opacity-50"
              >
                {busyId === r.paymentId ? "Refreshing…" : "Refresh status"}
              </button>
            )}
            {canRelease && r.status === "capture_pending" && (
              <button
                type="button"
                data-testid="refresh-capture-button"
                disabled={busyId !== null}
                onClick={() => void run(r.paymentId, () => refreshCapture({ paymentId: r.paymentId }))}
                className="rounded px-2 py-0.5 border border-slate-600 text-slate-200 disabled:opacity-50"
              >
                {busyId === r.paymentId ? "Refreshing…" : "Refresh status"}
              </button>
            )}
            {canRelease && (r.canRetryPayout || r.status === "created") && (
              <p className="text-slate-400" data-testid="release-recovery-hint">
                Retry this payment from the approved pay app&apos;s Payment panel.
              </p>
            )}
          </div>
        );
      })}
      {error && (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
