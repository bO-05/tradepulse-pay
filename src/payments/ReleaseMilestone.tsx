import { useAction } from "convex/react";
import { useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { fromDollars, percentageOfCents } from "../../convex/lib/money";
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
};

export type ReleasableMilestone = {
  _id: Id<"milestones">;
  name: string;
  status: string;
  funding: { status: string; grossCents: number; capturedCents: number; paypalAuthorizationId: string | null } | null;
  releases: MilestoneRelease[];
};

const CAPTURABLE = new Set(["authorized", "partially_captured"]);

function newRequestKey(): string {
  return `rel_${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 40);
}

export const BADGE: Record<string, { label: string; cls: string }> = {
  created: { label: "Processing", cls: "bg-slate-800 text-slate-200 border-slate-600" },
  pending: { label: "Payout pending", cls: "bg-amber-950 text-amber-200 border-amber-800" },
  success: { label: "Paid", cls: "bg-emerald-950 text-emerald-300 border-emerald-800" },
  unclaimed: { label: "Unclaimed", cls: "bg-orange-950 text-orange-200 border-orange-800" },
  returned: { label: "Returned", cls: "bg-rose-950 text-rose-200 border-rose-800" },
  failed: { label: "Failed", cls: "bg-rose-950 text-rose-200 border-rose-800" },
};

/** Releases (capture + payout) recorded for a milestone; GC gets refresh/retry controls. */
export function ReleaseList({ milestone, canRelease }: { milestone: ReleasableMilestone; canRelease: boolean }) {
  const refresh = useAction(api.payments.release.refreshPayoutStatus);
  const resume = useAction(api.payments.release.resumeRelease);
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
            {canRelease && r.status === "created" && Date.now() - r.createdAt > 60_000 && (
              <button
                type="button"
                data-testid="resume-release-button"
                disabled={busyId !== null}
                onClick={() => void run(r.paymentId, () => resume({ paymentId: r.paymentId }))}
                className="rounded px-2 py-0.5 border border-amber-700 text-amber-200 disabled:opacity-50"
              >
                {busyId === r.paymentId ? "Retrying…" : "Retry release"}
              </button>
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

/** GC-only "Release & pay": capture an amount from the milestone's authorization and pay the sub net of retainage. */
export function ReleaseControl({ milestone, retainagePercent }: { milestone: ReleasableMilestone; retainagePercent: number }) {
  const releaseAndPay = useAction(api.payments.release.releaseAndPay);
  const closeMilestone = useAction(api.payments.release.closeMilestone);
  const funding = milestone.funding;
  const remainingCents = funding ? funding.grossCents - funding.capturedCents : 0;
  const [amount, setAmount] = useState(() => (remainingCents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestKey = useRef(newRequestKey());
  const inFlight = busy || milestone.releases.some((r) => r.status === "created");

  if (!funding || !funding.paypalAuthorizationId || !CAPTURABLE.has(funding.status)) return null;

  let amountCents: number | null = null;
  try {
    amountCents = amount.trim() === "" ? null : fromDollars(amount);
  } catch {
    amountCents = null;
  }
  const valid = amountCents !== null && amountCents > 0 && amountCents <= remainingCents;
  const retainageCents = valid ? percentageOfCents(amountCents!, retainagePercent) : 0;

  async function release() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const out = await releaseAndPay({ milestoneId: milestone._id, amountCents: amountCents!, requestKey: requestKey.current });
      if (out.state === "busy") setNotice("Already processing this release.");
      else if (out.state === "already_processed") setNotice("Already processed.");
      else setNotice(out.message ?? "Captured and sent to PayPal. The status updates here when PayPal settles the payout.");
      if (out.state !== "busy") requestKey.current = newRequestKey();
    } catch (e) {
      setError(readableError(e));
      requestKey.current = newRequestKey();
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await closeMilestone({ milestoneId: milestone._id });
      setNotice("Milestone closed; the uncaptured remainder was voided.");
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5 pt-1" data-testid="release-control">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-400" htmlFor={`release-amount-${milestone._id}`}>
          Approved amount $
        </label>
        <input
          id={`release-amount-${milestone._id}`}
          data-testid="release-amount-input"
          inputMode="decimal"
          value={amount}
          disabled={busy}
          onChange={(e) => setAmount(e.target.value)}
          className="w-32 rounded-md bg-slate-950 border border-slate-700 px-2 py-1 text-xs tabular-nums"
        />
        <button
          type="button"
          data-testid="release-pay-button"
          disabled={!valid || inFlight}
          onClick={() => void release()}
          className="text-xs font-semibold rounded-lg px-3 py-1.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Releasing…" : "Release & pay"}
        </button>
        {funding.status === "partially_captured" && (
          <button
            type="button"
            data-testid="close-milestone-button"
            disabled={inFlight}
            onClick={() => void close()}
            className="text-xs rounded-lg px-3 py-1.5 border border-slate-600 text-slate-200 disabled:opacity-50"
          >
            Close milestone (void remainder)
          </button>
        )}
      </div>
      <p className="text-xs text-slate-400" data-testid="release-preview">
        {valid
          ? `Retainage ${retainagePercent}%: ${formatCents(retainageCents)} held · sub receives ${formatCents(amountCents! - retainageCents)}`
          : `Enter an amount up to ${formatCents(remainingCents)} still authorized.`}
      </p>
      {notice && (
        <p className="text-xs text-slate-300" role="status" data-testid="release-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-xs text-rose-300 max-w-md" role="alert" data-testid="release-error-message">
          {error}
        </p>
      )}
    </div>
  );
}
