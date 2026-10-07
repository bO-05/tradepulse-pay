import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { readableError } from "./FundMilestone";

/** Two-step withdraw control on the sub's pay-app list. */
export function WithdrawPayAppButton({ payAppId, periodLabel }: { payAppId: string; periodLabel: string }) {
  const withdraw = useMutation(api.payApps.submit.withdrawPayApplication);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await withdraw({ payAppId });
      setConfirming(false);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  const btn = "rounded-lg border px-2 py-1 text-xs disabled:opacity-50";
  return (
    <div className="flex flex-col items-end gap-1">
      {confirming ? (
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy}
            className={`${btn} border-red-700 text-red-200 hover:bg-red-950`}
            aria-label={`Confirm withdraw ${periodLabel}`}
          >
            {busy ? "Withdrawing…" : "Confirm withdraw"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={`${btn} border-slate-700 hover:bg-slate-800`}>
            Keep
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={`${btn} border-slate-700 hover:bg-slate-800`}
          aria-label={`Withdraw ${periodLabel}`}
        >
          Withdraw
        </button>
      )}
      {error ? (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
