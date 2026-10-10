import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import { getErrorMessage } from "../lib/errors";
import { Button, Card, ConfirmDialog, StatusPill, formatCents, formatDateTime } from "../ui";

type Panel = NonNullable<FunctionReturnType<typeof api.billing.canPay.paymentPanel>>;
type Payment = NonNullable<Panel["payment"]>;

const PAYMENT_LABEL: Record<string, string> = {
  created: "Payment processing",
  capture_pending: "Capture pending",
  pending: "Payout pending",
  success: "Paid",
  unclaimed: "Payout unclaimed",
  failed: "Payout failed",
  returned: "Payout returned",
};

function PaymentStatus({ payment }: { payment: Payment }) {
  const label = PAYMENT_LABEL[payment.status] ?? "Payment processing";
  const tone = payment.status === "success" ? "success" : payment.status === "pending" || payment.status === "created" || payment.status === "capture_pending" ? "progress" : "danger";
  return <StatusPill status={payment.status} label={label} tone={tone} />;
}

/**
 * Payment on an approved pay app. The GC sees every unmet canPay condition at once and pays through a
 * ConfirmDialog; the sub sees what was paid and the retainage held. The server re-checks canPay.
 */
export function PaymentPanel({ payAppId }: { payAppId: string }) {
  const panel = useQuery(api.billing.canPay.paymentPanel, { payAppId });
  if (panel === undefined || panel === null) return null;
  return panel.viewerRole === "gc" ? <GcPaymentPanel panel={panel} payAppId={payAppId} /> : <SubPaymentPanel panel={panel} />;
}

function Figures({ panel }: { panel: Panel }) {
  const f = panel.payment ?? panel.figures;
  if (f === null) return null;
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-3" data-testid="payment-figures">
      <div>
        <dt className="text-xs text-ink-subtle">Approved gross</dt>
        <dd className="font-semibold tabular-nums">{formatCents(f.grossCents)}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-subtle">Retainage held</dt>
        <dd className="font-semibold tabular-nums">{formatCents(f.retainageCents)}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-subtle">Net to sub</dt>
        <dd className="font-semibold tabular-nums">{formatCents(f.netCents)}</dd>
      </div>
    </dl>
  );
}

function PaymentDetail({ payment }: { payment: Payment }) {
  return (
    <div className="space-y-1 text-sm" data-testid="payment-status-detail" data-status={payment.status}>
      <div className="flex flex-wrap items-center gap-2">
        <PaymentStatus payment={payment} />
        <span className="text-ink-subtle">{formatDateTime(payment.updatedAt)}</span>
      </div>
      <p className="text-xs text-ink-subtle">
        {payment.receiverEmail ? `To ${payment.receiverEmail}` : null}
        {payment.trancheName ? ` · from ${payment.trancheName}` : null}
        {payment.paypalPayoutBatchId ? ` · PayPal batch ${payment.paypalPayoutBatchId}` : null}
      </p>
      {payment.error && payment.status !== "success" ? (
        <p className="text-sm text-rose-300" role="alert" data-testid="payment-error">
          {payment.error}
        </p>
      ) : null}
    </div>
  );
}

function GcPaymentPanel({ panel, payAppId }: { panel: Panel; payAppId: string }) {
  const pay = useAction(api.billing.pay.payPayApp);
  const refresh = useAction(api.payments.release.refreshPayoutStatus);
  const retry = useAction(api.payments.payoutRetry.retryPayout);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const payment = panel.payment;
  const figures = panel.figures;
  const paid = payment?.status === "success";

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
    } catch (e) {
      setError(getErrorMessage(e, "The request failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Payment" description="Pays the sub's confirmed PayPal payee the approved current payment due, captured from a funded tranche." data-testid="payment-panel">
      <div className="space-y-4">
        <Figures panel={panel} />
        {paid ? (
          <p className="text-sm font-semibold text-emerald-300" data-testid="payment-already-paid">
            Already paid
          </p>
        ) : null}
        {panel.reasons.length > 0 && !paid ? (
          <div data-testid="payment-blockers">
            <p className="text-sm font-medium">Payment is blocked until:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-200" role="list">
              {panel.reasons.map((r) => (
                <li key={r.code} data-testid="payment-blocker" data-code={r.code}>
                  {r.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {panel.ok && panel.tranche && panel.payeeEmail ? (
          <p className="text-sm text-ink-subtle" data-testid="payment-ready">
            Ready: pays {panel.payeeEmail} from {panel.tranche.name} ({formatCents(panel.tranche.availableCents)} available).
          </p>
        ) : null}
        {payment ? <PaymentDetail payment={payment} /> : null}
        <div className="flex flex-wrap gap-2">
          {!paid ? (
            <Button onClick={() => setConfirm(true)} disabled={!panel.canPay || busy} data-testid="pay-sub-button">
              Pay {panel.subcontractorName}
            </Button>
          ) : null}
          {payment && (payment.status === "pending" || payment.status === "unclaimed") ? (
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => void run(() => refresh({ paymentId: payment.paymentId }), "Status refreshed from PayPal.")}
              data-testid="payment-refresh"
            >
              Refresh status
            </Button>
          ) : null}
          {payment?.canRetryPayout ? (
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => void run(() => retry({ paymentId: payment.paymentId }), "Payout sent again.")}
              data-testid="payment-retry"
            >
              Retry payout
            </Button>
          ) : null}
        </div>
        {notice ? (
          <p className="text-sm text-ink-subtle" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-rose-300" role="alert" data-testid="payment-action-error">
            {error}
          </p>
        ) : null}
      </div>
      {figures && panel.tranche ? (
        <ConfirmDialog
          open={confirm}
          title={`Pay ${panel.subcontractorName}?`}
          amountCents={figures.netCents}
          amountLabel="Net to sub"
          payee={panel.payeeEmail}
          payeeLabel="Payee (confirmed PayPal email)"
          details={[
            { label: "Approved gross", value: formatCents(figures.grossCents) },
            { label: "Retainage held", value: formatCents(figures.retainageCents) },
            { label: "Funding source", value: `${panel.tranche.name} (${formatCents(panel.tranche.availableCents)} available)` },
          ]}
          effect={`Captures ${formatCents(figures.grossCents)} from ${panel.tranche.name} and sends a PayPal payout of ${formatCents(figures.netCents)}. This can't be undone.`}
          confirmLabel={`Pay ${formatCents(figures.netCents)}`}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            const out = await pay({ payAppId: payAppId as Id<"payApplications"> });
            setConfirm(false);
            setNotice(
              out.state === "busy"
                ? "This payment is already being processed."
                : out.state === "already_processed"
                  ? "Already paid."
                  : "Captured and sent to PayPal. The status updates here when PayPal settles the payout.",
            );
          }}
        />
      ) : null}
    </Card>
  );
}

function SubPaymentPanel({ panel }: { panel: Panel }) {
  const payment = panel.payment;
  return (
    <Card title="Payment" data-testid="payment-panel">
      <div className="space-y-3">
        {payment ? (
          <>
            <p className="text-sm font-semibold" data-testid="sub-payment-summary">
              {payment.status === "success"
                ? `Paid ${formatCents(payment.netCents)}`
                : `${PAYMENT_LABEL[payment.status] ?? "Payment processing"}: ${formatCents(payment.netCents)}`}
            </p>
            <PaymentDetail payment={payment} />
          </>
        ) : (
          <p className="text-sm text-ink-subtle" data-testid="sub-payment-summary">
            {panel.payAppStatus === "approved" ? "Approved, not paid yet." : "Not paid. Payment follows the GC's approval."}
          </p>
        )}
        <dl className="grid gap-3 text-sm sm:grid-cols-2" data-testid="sub-retainage">
          <div>
            <dt className="text-xs text-ink-subtle">Retainage held this period</dt>
            <dd className="font-semibold tabular-nums">
              {payment ? formatCents(payment.retainageCents) : panel.retainageThisPeriodCents !== null ? formatCents(panel.retainageThisPeriodCents) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-subtle">Total retainage held</dt>
            <dd className="font-semibold tabular-nums">{formatCents(panel.totalRetainageHeldCents)}</dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}
