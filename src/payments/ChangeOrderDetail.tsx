import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { termsForKind } from "../lib/terms";
import { CommercialReferenceBadge } from "../ui";
import { statusLabelFor } from "../ui/statusLabels";
import { formatCents } from "./format";
import { ReceiptId } from "./ReceiptId";
import { formatDateTime } from "../ui/format";

/** Uses the existing party-scoped read, never a subcontract ledger for an Owner. */
export function ChangeOrderDetail({ changeOrderId }: { changeOrderId: string }) {
  const co = useQuery(api.billing.changeOrders.getChangeOrder, { changeOrderId });
  if (co === undefined) return <p role="status">Loading change order…</p>;
  if (co === null) {
    return (
      <div role="alert" data-testid="not-found" className="max-w-xl rounded-2xl border border-slate-700 bg-slate-900/60 p-6">
        <h1 className="text-lg font-semibold text-slate-100">Not found</h1>
        <p className="mt-2 text-sm text-slate-300">This change order does not exist or you don't have access to it.</p>
        <a href="#/change-orders" className="mt-3 inline-block text-sm text-emerald-300 underline">Back to change orders</a>
      </div>
    );
  }
  const terms = termsForKind(co.projectKind);
  const scopeLabel = co.scope === "prime" ? (terms.kind === "residential" ? "Contract" : "Prime contract") : "Subcontract";
  return (
    <article className="mx-auto max-w-3xl space-y-4">
      <a href="#/change-orders" className="text-sm text-emerald-300 underline">Back to change orders</a>
      <header className="space-y-2">
        <CommercialReferenceBadge kind={co.projectKind} />
        <h1 className="text-xl font-semibold">{co.label} · {co.title}</h1>
        <p className="text-slate-300">{formatCents(co.amountCents)} · {statusLabelFor(co.status, co.projectKind)} · {scopeLabel}</p>
      </header>
      {co.description && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{co.description}</p>}
      <dl className="grid gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4 sm:grid-cols-2">
        <div><dt className="text-sm text-slate-400">Associated agreement</dt><dd className="[overflow-wrap:anywhere]">{co.agreementNumber ?? "Project-level change order"}</dd></div>
        <div><dt className="text-sm text-slate-400">Schedule impact</dt><dd>{co.scheduleDays === null ? "Not specified" : `${co.scheduleDays} days`}</dd></div>
        {([["Created", co.createdAt], ["Submitted", co.submittedAt], ["Approved", co.approvedAt], ["Invoiced", co.invoicedAt], ["Payment recorded", co.paidAt]] as const).map(([label, at]) => at !== null && (
          <div key={label}><dt className="text-sm text-slate-400">{label}</dt><dd>{formatDateTime(at, { timeZone: "UTC" })} UTC</dd></div>
        ))}
      </dl>
      {co.judgeDemoApproval && <p className="text-sm text-amber-200">Guided demo driver approved this as a stand-in for the demo Owner. This is not an independent Owner approval.</p>}
      <ReceiptId label="PayPal invoice ID" value={co.paypalInvoiceId} />
      {co.paypalInvoiceStatus && <p className="text-sm">PayPal invoice status: {co.paypalInvoiceStatus}</p>}
      {co.paidAt !== null && <p className="text-xs text-slate-400">Payment recorded is when this app first observed the paid invoice, not PayPal's transaction timestamp.</p>}
      {co.payerViewUrl && /^https:\/\/(?:www\.)?sandbox\.paypal\.com\//.test(co.payerViewUrl) && <a href={co.payerViewUrl} target="_blank" rel="noreferrer" className="inline-block rounded-lg border border-emerald-700 px-3 py-2 text-emerald-200">View sandbox invoice</a>}
    </article>
  );
}
