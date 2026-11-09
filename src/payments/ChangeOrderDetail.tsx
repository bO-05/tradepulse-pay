import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { maskSandboxEmail } from "../lib/demoPrivacy";
import { termsForKind } from "../lib/terms";
import { Card, CommercialReferenceBadge, LinkButton, Money, PageHeader, StatusPill } from "../ui";
import { formatDateTime } from "../ui/format";
import { ReceiptId } from "./ReceiptId";

/** PayPal's hosted invoice page, sandbox or live; anything else is not a link we will render. */
const PAYPAL_INVOICE_URL = /^https:\/\/(?:www\.)?(?:sandbox\.)?paypal\.com\//;

/** Uses the existing party-scoped read, never a subcontract ledger for an Owner. */
export function ChangeOrderDetail({ changeOrderId }: { changeOrderId: string }) {
  const co = useQuery(api.billing.changeOrders.getChangeOrder, { changeOrderId });
  if (co === undefined) {
    return (
      <p className="text-sm text-ink-subtle" role="status">
        Loading change order…
      </p>
    );
  }
  if (co === null) {
    return (
      <div role="alert" data-testid="not-found" className="max-w-xl rounded-2xl border border-slate-700 bg-slate-900/60 p-6">
        <h1 className="text-lg font-semibold text-slate-100">Not found</h1>
        <p className="mt-2 text-sm text-slate-300">This change order does not exist or you don't have access to it.</p>
        <a href="#/change-orders" className="mt-3 inline-block text-sm text-emerald-300 underline">
          Back to change orders
        </a>
      </div>
    );
  }

  const terms = termsForKind(co.projectKind);
  const residential = terms.kind === "residential";
  const scopeLabel = co.scope === "prime" ? (residential ? "Contract" : "Prime contract") : "Subcontract";
  const payerLink = co.payerViewUrl !== null && PAYPAL_INVOICE_URL.test(co.payerViewUrl) ? co.payerViewUrl : null;
  const timeline = (
    [
      ["Created", co.createdAt],
      ["Submitted", co.submittedAt],
      ["Approved", co.approvedAt],
      ["Invoiced", co.invoicedAt],
      ["Payment recorded", co.paidAt],
    ] as const
  ).filter(([, at]) => at !== null);
  const who = co.scope === "prime" ? "Requested by the GC" : co.requestedByParty === "sub" ? "Requested by the sub" : "Requested by the GC";
  const agreement = co.agreementNumber ?? "Project-level change order";

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        back={{ href: "#/change-orders", label: "Back to change orders" }}
        title={`${co.label} · ${co.title}`}
        description={
          <>
            {scopeLabel} change order · {agreement}
            {co.subcontractorName !== null ? ` · ${co.subcontractorName}` : ""}
          </>
        }
        meta={
          <>
            <StatusPill status={co.status} kind={co.projectKind} />
            <CommercialReferenceBadge kind={co.projectKind} />
            <span className="text-sm text-ink-subtle">{who}</span>
          </>
        }
        actions={
          payerLink !== null ? (
            <LinkButton
              variant="primary"
              href={payerLink}
              target="_blank"
              rel="noreferrer"
              data-testid="change-order-invoice-link"
            >
              Open the PayPal invoice
            </LinkButton>
          ) : undefined
        }
      />

      <Card title="Amount">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-3xl font-bold leading-tight tabular-nums text-ink" data-testid="change-order-amount">
            <Money cents={co.amountCents} />
          </p>
          <p className="text-sm text-ink-subtle">
            {scopeLabel} change order{co.sovLineNo !== null ? ` · SOV line ${co.sovLineNo}` : ""}
          </p>
        </div>
        {co.description ? <p className="mt-3 whitespace-pre-wrap text-sm text-ink-muted [overflow-wrap:anywhere]">{co.description}</p> : null}
      </Card>

      <Card title="Details">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-ink-subtle">Associated agreement</dt>
            <dd className="[overflow-wrap:anywhere]">{agreement}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-subtle">Schedule impact</dt>
            <dd>{co.scheduleDays === null ? "Not specified" : `${co.scheduleDays} days`}</dd>
          </div>
          {co.linkedLabel !== null ? (
            <div>
              <dt className="text-xs text-ink-subtle">Linked change order</dt>
              <dd>{co.linkedLabel}</dd>
            </div>
          ) : null}
        </dl>
        {co.rejectionReason !== null ? (
          <p role="alert" className="mt-3 rounded-lg border border-rose-700 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
            Rejected: {co.rejectionReason}
          </p>
        ) : null}
        {co.error !== null ? (
          <p role="alert" className="mt-3 text-sm text-rose-300">
            {co.error}
          </p>
        ) : null}
        {co.judgeDemoApproval !== null ? (
          <p className="mt-3 text-sm text-amber-200">
            Approved in the guided demo for {co.judgeDemoApproval}. This is not an independent owner approval.
          </p>
        ) : null}
      </Card>

      <Card title="Timeline">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {timeline.map(([label, at]) => (
            <div key={label}>
              <dt className="text-xs text-ink-subtle">{label}</dt>
              <dd>{formatDateTime(at, { timeZone: "UTC" })} UTC</dd>
            </div>
          ))}
        </dl>
        {co.paidAt !== null ? <p className="mt-2 text-xs text-ink-subtle">Payment recorded is when this app first observed the paid invoice, not PayPal's transaction timestamp.</p> : null}
      </Card>

      {co.paypalInvoiceId !== null || co.paypalInvoiceStatus !== null ? (
        <Card title="PayPal invoice">
          <div className="space-y-2 text-sm">
            <ReceiptId label="PayPal invoice ID" value={co.paypalInvoiceId} />
            <div className="flex flex-wrap items-center gap-2 text-ink-subtle">
              <span>Invoice status</span>
              {co.paypalInvoiceStatus !== null ? <StatusPill status={co.paypalInvoiceStatus} /> : <span>Not sent yet</span>}
              {co.recipientEmail !== null ? <span>Sent to {maskSandboxEmail(co.recipientEmail)}</span> : null}
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
