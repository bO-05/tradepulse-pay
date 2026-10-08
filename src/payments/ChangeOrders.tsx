import { useAction, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ChangeOrderView } from "../../convex/payments/changeOrderDb";
import { fromDollars } from "../../convex/lib/money";
import { readableError } from "./FundMilestone";
import { formatCents, formatDate } from "./format";

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-slate-800 text-slate-200 border-slate-600" },
  invoiced: { label: "Invoiced", cls: "bg-sky-950 text-sky-300 border-sky-800" },
  paid: { label: "Paid", cls: "bg-emerald-950 text-emerald-300 border-emerald-800" },
  cancelled: { label: "Cancelled", cls: "bg-rose-950 text-rose-300 border-rose-800" },
};

/**
 * Change-order invoices. The sandbox sends no email, so the "Open PayPal invoice" link is how the Owner
 * reaches the invoice. Refresh reads the invoice status from PayPal (GC and Owner); GC can retry a draft.
 */
export function ChangeOrderList({
  changeOrders,
  canRefresh,
  canResend,
  showAgreement = false,
}: {
  changeOrders: ChangeOrderView[];
  canRefresh: boolean;
  canResend: boolean;
  showAgreement?: boolean;
}) {
  const refresh = useAction(api.payments.invoices.refreshChangeOrderStatus);
  const resend = useAction(api.payments.invoices.sendChangeOrderInvoice);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

  async function run(changeOrderId: Id<"changeOrders">, op: "refresh" | "resend") {
    setBusyId(changeOrderId);
    setError(null);
    setNotice(null);
    try {
      if (op === "refresh") {
        const out = await refresh({ changeOrderId });
        setNotice({
          id: changeOrderId,
          text: out.paypalInvoiceStatus
            ? `PayPal invoice status: ${out.paypalInvoiceStatus}${out.changed ? ` · now ${out.status}` : " · no change"}.`
            : "PayPal returned no status.",
        });
      } else {
        await resend({ changeOrderId });
      }
    } catch (e) {
      setError({ id: changeOrderId, text: readableError(e) });
    } finally {
      setBusyId(null);
    }
  }

  if (changeOrders.length === 0) {
    return <p className="text-sm text-slate-400">No change-order invoices yet.</p>;
  }

  return (
    <ul className="space-y-2 text-sm" data-testid="change-order-list">
      {changeOrders.map((co) => {
        const badge = STATUS_BADGE[co.status] ?? { label: co.status, cls: STATUS_BADGE.draft.cls };
        return (
          <li key={co._id} className="border-t border-slate-800 pt-2 space-y-1" data-testid="change-order-row">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <span className="font-semibold" data-testid="change-order-label">
                  {co.label}
                </span>
                {showAgreement && co.agreementNumber ? ` · ${co.agreementNumber}` : ""} · {co.description}
              </span>
              <span className="flex flex-wrap items-center gap-3">
                <span className="font-semibold tabular-nums" data-testid="change-order-amount">
                  {formatCents(co.amountCents)}
                </span>
                <span
                  className={`text-[11px] font-semibold uppercase rounded-full px-2 py-0.5 border ${badge.cls}`}
                  data-testid="change-order-status"
                >
                  {badge.label}
                </span>
                {co.payerViewUrl && co.status !== "draft" && (
                  <a
                    href={co.payerViewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-400 hover:text-emerald-300"
                    data-testid="change-order-invoice-link"
                  >
                    Open PayPal invoice
                  </a>
                )}
                {canRefresh && co.status === "invoiced" && (
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void run(co._id, "refresh")}
                    className="rounded px-2 py-0.5 border border-slate-600 text-slate-200 text-xs disabled:opacity-50"
                    data-testid="change-order-refresh"
                  >
                    {busyId === co._id ? "Refreshing…" : "Refresh status"}
                  </button>
                )}
                {canResend && co.status === "draft" && (
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void run(co._id, "resend")}
                    className="rounded px-2 py-0.5 border border-slate-600 text-slate-200 text-xs disabled:opacity-50"
                    data-testid="change-order-send"
                  >
                    {busyId === co._id ? "Sending…" : "Send invoice"}
                  </button>
                )}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              {co.recipientEmail ? `To ${co.recipientEmail}` : ""}
              {co.paypalInvoiceId ? ` · invoice ${co.paypalInvoiceId}` : ""}
              {co.paypalInvoiceStatus ? ` · PayPal ${co.paypalInvoiceStatus}` : ""}
              {co.paidAt ? ` · paid ${formatDate(co.paidAt)}` : co.invoicedAt ? ` · sent ${formatDate(co.invoicedAt)}` : ""}
            </div>
            {co.error && co.status === "draft" && <p className="text-xs text-rose-300">{co.error}</p>}
            {notice?.id === co._id && (
              <p className="text-xs text-slate-300" role="status">
                {notice.text}
              </p>
            )}
            {error?.id === co._id && (
              <p className="text-xs text-rose-300" role="alert">
                {error.text}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ChangeOrderForm({ agreementId, nextNumber }: { agreementId: Id<"agreements">; nextNumber: number }) {
  const create = useAction(api.payments.invoices.createChangeOrder);
  const [number, setNumber] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    let amountCents: number;
    try {
      amountCents = fromDollars(amount);
    } catch {
      setError("Enter the amount in dollars, for example 2500.00.");
      return;
    }
    const n = number.trim() === "" ? nextNumber : Number(number.trim().replace(/^CO-?/i, ""));
    if (!Number.isSafeInteger(n) || n < 1) {
      setError("The change order number must be a whole number, for example 1 for CO-001.");
      return;
    }
    setBusy(true);
    try {
      const out = await create({ agreementId, number: n, description, amountCents });
      setNotice(`Invoice ${out.paypalInvoiceId ?? ""} sent to the Owner for ${formatCents(amountCents)}.`);
      setNumber("");
      setDescription("");
      setAmount("");
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2" data-testid="change-order-form">
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Number
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder={String(nextNumber)}
            inputMode="numeric"
            className="w-20 rounded bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-slate-100"
            data-testid="change-order-number"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400 flex-1 min-w-[12rem]">
          Description
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            maxLength={1000}
            className="rounded bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-slate-100"
            data-testid="change-order-description"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Amount (USD)
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            inputMode="decimal"
            placeholder="2500.00"
            className="w-32 rounded bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-slate-100"
            data-testid="change-order-amount-input"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
          data-testid="change-order-submit"
        >
          {busy ? "Sending invoice…" : "Create change order & invoice Owner"}
        </button>
      </div>
      {notice && (
        <p className="text-xs text-slate-300" role="status" data-testid="change-order-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-xs text-rose-300" role="alert" data-testid="change-order-error">
          {error}
        </p>
      )}
    </form>
  );
}

/** Agreement ledger section: GC creates change orders; GC and Owner see the invoices. Hidden for subs. */
export function AgreementChangeOrders({ agreementId }: { agreementId: Id<"agreements"> }) {
  const data = useQuery(api.payments.changeOrderDb.listForAgreement, { agreementId });
  if (data === undefined || data === null) return null;
  if (!data.canCreate && !data.canRefresh) return null;
  return (
    <section aria-labelledby="ledger-change-orders" className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
      <h3 id="ledger-change-orders" className="text-base font-semibold">
        Change orders
      </h3>
      <p className="text-xs text-slate-400">
        Each change order is billed to the Owner as a PayPal invoice. The PayPal sandbox sends no email, so the Owner opens it
        from the link here or in the Owner portal.
      </p>
      {data.invoicing.recipientEmail && (
        <p className="text-xs text-slate-400" data-testid="change-order-recipient">
          Invoices go to the project owner at {data.invoicing.recipientEmail}.
        </p>
      )}
      {data.invoicing.reason && (
        <p className="text-sm text-amber-300" role="status" data-testid="change-order-invoicing-disabled">
          {data.invoicing.reason}
        </p>
      )}
      {data.canCreate && <ChangeOrderForm agreementId={agreementId} nextNumber={data.nextNumber} />}
      <ChangeOrderList changeOrders={data.changeOrders} canRefresh={data.canRefresh} canResend={data.canCreate} />
    </section>
  );
}
