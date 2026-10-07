import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { fromDollars, toDollarString } from "../../../convex/lib/money";
import { readableError } from "../FundMilestone";
import { formatCents, formatDate } from "../format";

/**
 * Sandbox-only setup, GC only: a CAPTURE order paid with the guest card adds funds to the platform's
 * sandbox account, because PayPal capture fees leave it short of the retainage it owes.
 */
export function SandboxTopUpPanel({ suggestedCents }: { suggestedCents: number }) {
  const topUps = useQuery(api.payments.sandboxTopUpDb.listTopUps, {});
  const createOrder = useAction(api.payments.sandboxTopUp.createTopUpOrder);
  const captureOrder = useAction(api.payments.sandboxTopUp.captureTopUpOrder);
  const suggested = toDollarString(Math.max(100_00, suggestedCents));
  const [typed, setAmount] = useState<string | null>(null);
  const amount = typed ?? suggested;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  const open = topUps?.find((t) => t.status === "created") ?? null;

  return (
    <section className="rounded-xl border border-amber-800/70 bg-amber-950/20 p-4 space-y-3" data-testid="sandbox-top-up" aria-label="Sandbox platform top-up">
      <div>
        <h3 className="text-sm font-semibold text-amber-200">Sandbox setup: top up the platform balance</h3>
        <p className="text-xs text-slate-300 mt-1">
          Sandbox only. PayPal keeps about 3.5% + $0.49 of every capture, so after paying subs 90% the platform account holds less
          than the retainage it owes. This creates a PayPal CAPTURE order for the platform; pay it with the sandbox guest card in
          the PayPal tab, then capture it here. It is not linked to any agreement and is not counted in any total.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-300">
          Amount (USD)
          <input
            className="mt-1 block w-32 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            data-testid="sandbox-top-up-amount"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          data-testid="sandbox-top-up-create"
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-500 disabled:opacity-50"
          onClick={() =>
            void run(async () => {
              let cents: number;
              try {
                cents = fromDollars(amount.trim());
              } catch {
                throw new Error("Enter an amount like 250.00.");
              }
              const res = await createOrder({ amountCents: cents });
              window.open(res.approveUrl, "_blank", "noopener");
              setNote("PayPal checkout opened in a new tab. Pay as guest with the sandbox card, then click Capture top-up.");
            })
          }
        >
          Create top-up order
        </button>
      </div>
      {open && (
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs space-y-2" data-testid="sandbox-top-up-open">
          <p>
            Order <span className="font-mono">{open.paypalOrderId}</span> for {formatCents(open.amountCents)} is waiting for payment.{" "}
            {open.approveUrl && (
              <a href={open.approveUrl} target="_blank" rel="noreferrer" className="text-emerald-300 underline" data-testid="sandbox-top-up-approve-link">
                Open PayPal checkout
              </a>
            )}
          </p>
          <button
            type="button"
            disabled={busy}
            data-testid="sandbox-top-up-capture"
            className="rounded-lg border border-emerald-700 px-3 py-1.5 text-emerald-200 hover:bg-emerald-950 disabled:opacity-50"
            onClick={() =>
              void run(async () => {
                const res = await captureOrder({ paypalOrderId: open.paypalOrderId });
                setNote(res.message);
              })
            }
          >
            Capture top-up
          </button>
        </div>
      )}
      {note && <p className="text-xs text-emerald-300" role="status">{note}</p>}
      {error && <p className="text-xs text-rose-300" role="alert">{error}</p>}
      {topUps && topUps.length > 0 && (
        <ul className="text-xs text-slate-400 space-y-0.5" data-testid="sandbox-top-up-history">
          {topUps.slice(0, 3).map((t) => (
            <li key={t._id}>
              {formatDate(t.createdAt)} · {formatCents(t.amountCents)} · {t.status}
              {t.paypalCaptureId ? ` · capture ${t.paypalCaptureId}` : ""}
              {t.error ? ` · ${t.error}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
