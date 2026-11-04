import { useQuery } from "convex/react";
import type { ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { NotFoundState } from "../ui/NotFoundState";
import { AgreementChangeOrders } from "./ChangeOrders";
import { formatCents, formatDate } from "./format";
import { FundingProvider } from "./FundMilestone";
import { AgreementPayAppReviews } from "./PayAppReviews";
import { payAppHash } from "../auth/navigation";
import { FundingTranches } from "../billing/FundingTranches";
import { RetainageReleaseControl, RetainageReleaseList } from "./RetainageRelease";
import { DocumentDownloadButton } from "../documents/DocumentDownload";
import { ReferenceNotice } from "./ReferenceNotice";

const TOTALS: { key: "contractSumCents" | "billedCents" | "paidCents" | "retainageHeldCents" | "balanceCents"; label: string }[] = [
  { key: "contractSumCents", label: "Contract sum to date" },
  { key: "billedCents", label: "Billed" },
  { key: "paidCents", label: "Paid" },
  { key: "retainageHeldCents", label: "Retainage held" },
  { key: "balanceCents", label: "Balance" },
];

const RECONCILIATION: {
  key:
    | "fundedCents"
    | "capturedCents"
    | "capturedNotPaidCents"
    | "retainageReleasedCents"
    | "changeOrdersInvoicedCents"
    | "changeOrdersPaidCents";
  label: string;
}[] = [
  { key: "fundedCents", label: "Remaining authorization" },
  { key: "capturedCents", label: "Captured" },
  { key: "capturedNotPaidCents", label: "Captured, not paid out" },
  { key: "retainageReleasedCents", label: "Retainage released" },
  { key: "changeOrdersInvoicedCents", label: "Owner prime CO invoices unpaid (project income)" },
  { key: "changeOrdersPaidCents", label: "Owner prime CO income paid (not this subcontract)" },
];
const MONEY_DEFINITIONS: Record<string, string> = {
  fundedCents: "Money still authorized at PayPal, after completed captures. This is not a new deposit or a payment to the sub.",
  capturedCents: "Confirmed completed PayPal captures. Pending captures are excluded; a capture is not a successful payout.",
  capturedNotPaidCents: "Captured money whose associated subcontractor payout has not succeeded.",
  retainageReleasedCents: "Previously withheld retainage released, net of reversals. A demo release does not certify project closeout.",
  changeOrdersInvoicedCents: "Separate Owner change-order invoices still awaiting payment.",
  changeOrdersPaidCents: "Separate paid Owner change-order invoices, not subcontractor payouts.",
};

export function AgreementLedgerView({ agreementId, backHash }: { agreementId: string; backHash: string }) {
  const ledger = useQuery(api.payments.ledger.getAgreementLedger, { agreementId });

  if (ledger === undefined) {
    return <p className="text-sm text-slate-400" role="status">Loading ledger…</p>;
  }

  if (ledger === null) return <NotFoundState />;

  const { agreement, sov, milestones, totals, canFund, retainageLedger, canReleaseRetainage, retainageReleases } = ledger;

  return (
    <div className="max-w-5xl space-y-6">
      {ledger.readOnlyReference && <ReferenceNotice />}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
          <div className="min-w-0">
            <a href={backHash} className="text-xs text-emerald-400 hover:text-emerald-300">
              ← Payments
            </a>
            <p className="text-xs text-slate-400 mt-1" data-testid="ledger-agreement-number">
              {agreement.agreementNumber}
            </p>
            <h1 className="text-lg font-semibold">{agreement.subcontractorName} payment ledger</h1>
            <p className="text-sm text-slate-400">
              {agreement.projectTitle} · Division {agreement.csiDivision} {agreement.tradeName} · Retainage{" "}
              {agreement.retainagePercent}%
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
            <span className="text-xs font-semibold uppercase tracking-wide rounded-full px-2.5 py-1 bg-slate-800 border border-slate-700">
              {agreement.status}
            </span>
            <div className="flex flex-wrap justify-end gap-2">
              <DocumentDownloadButton kind="subcontract_pdf" relatedId={agreement._id} label="Subcontract PDF" testId="ledger-subcontract-pdf" />
              <DocumentDownloadButton kind="retainage_ledger_csv" relatedId={agreement._id} label="Retainage CSV" testId="ledger-retainage-csv" />
            </div>
          </div>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm" data-testid="ledger-totals">
          {TOTALS.map((t) => (
            <div key={t.key} className="bg-slate-950/60 border border-slate-800 rounded-xl p-3">
              <dt className="text-xs text-slate-400">{t.label}</dt>
              <dd className="font-semibold tabular-nums" data-testid={`ledger-${t.key}`}>
                {formatCents(totals[t.key])}
              </dd>
              {t.key === "contractSumCents" && agreement.netChangeOrdersCents !== 0 ? (
                <dd className="text-xs text-slate-400" data-testid="ledger-original-contract-sum">
                  Original contract sum <span className="tabular-nums">{formatCents(agreement.originalContractSumCents)}</span>
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
        <p className="text-xs text-slate-400" data-testid="ledger-balance-formula">
          {ledger.balanceFormula}. Paid is the net of successful payouts and retainage releases.
        </p>
        {ledger.billingAttention.length > 0 ? (
          <ul className="text-xs text-amber-200 space-y-1" role="alert" data-testid="ledger-billing-attention">
            {ledger.billingAttention.map((m) => (
              <li key={m}>Billed excludes a pay application that needs attention: {m}</li>
            ))}
          </ul>
        ) : null}
        <dl className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-xs" data-testid="ledger-reconciliation">
          {RECONCILIATION.map((t) => (
            <div key={t.key} className="border border-slate-800 rounded-lg p-2">
              <dt className="text-slate-400">
                <abbr className="cursor-help no-underline" title={MONEY_DEFINITIONS[t.key]}>{t.label}</abbr>
              </dt>
              <dd className="font-semibold tabular-nums text-slate-200" data-testid={`ledger-${t.key}`}>
                {formatCents(totals[t.key])}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-slate-400" data-testid="ledger-definitions">
          Retainage released is previously withheld retainage released, net of reversals. A demo release does not certify project closeout.
        </p>
        <p className="text-xs text-slate-300">Remaining authorization is the PayPal-authorized amount less completed captures, not cash paid to the sub. Captured is confirmed money collected; captured, not paid out is awaiting a successful subcontractor payout.</p>
        <p className="text-xs text-slate-300">Statuses are recorded from PayPal webhooks/API responses at the time shown; this page does not re-query PayPal. Owner prime change-order income belongs to the project, not this subcontract's scope or balance.</p>
      </section>

      <section aria-labelledby="ledger-sov" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 id="ledger-sov" className="text-base font-semibold mb-3">
          Schedule of values
        </h2>
        {sov.length === 0 ? (
          <p className="text-sm text-slate-400">
            {agreement.status === "executed"
              ? "No schedule of values yet."
              : "The schedule of values is created when the agreement is executed."}
          </p>
        ) : (
          <div className="table-scroll" role="region" aria-label="Schedule of values, scroll horizontally on narrow screens" tabIndex={0}>
          <table className="w-full text-sm" data-testid="ledger-sov-table">
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 font-medium">Scope</th>
                <th className="py-2 pr-3 font-medium text-right">Scheduled value</th>
              </tr>
            </thead>
            <tbody>
              {sov.map((line) => (
                <tr key={line._id} className="border-t border-slate-800" data-testid="sov-line">
                  <td className="py-2 pr-3 text-slate-400">{line.lineNo}</td>
                  <td className="py-2 pr-3">{line.description}</td>
                  <td className="py-2 pr-3">
                    {line.excludedScope ? (
                      <span className="text-[11px] font-semibold uppercase rounded-full px-2 py-0.5 bg-amber-950 text-amber-300 border border-amber-800">
                        Excluded scope
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">Base scope</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatCents(line.scheduledValueCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-700 font-semibold">
                <td className="py-2 pr-3" colSpan={3}>
                  Total
                </td>
                <td className="py-2 pr-3 text-right tabular-nums" data-testid="ledger-sov-total">
                  {formatCents(ledger.sovTotalCents)}
                </td>
              </tr>
            </tfoot>
          </table>
          </div>
        )}
        {agreement.excludedScopeNotes.length > 0 && (
          <div className="mt-4" data-testid="ledger-excluded-scope">
            <h3 className="text-sm font-semibold">Excluded scope (not in contract)</h3>
            <p className="text-xs text-slate-400">Excluded in the bid; not billable and not part of the schedule of values.</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-slate-300">
              {agreement.excludedScopeNotes.map((note) => (
                <li key={note}>{note}
                  {ledger.excludedScopeEstimates.find((e) => e.description === note)?.amountCents != null && (
                    <> · estimated excluded-scope value {formatCents(ledger.excludedScopeEstimates.find((e) => e.description === note)!.amountCents!)} (not added to the contract)</>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section aria-labelledby="ledger-milestones" className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 id="ledger-milestones" className="text-base font-semibold mb-3">
          Funding tranches
        </h2>
        <MaybeFundingProvider enabled={canFund}>
          <FundingTranches agreementId={agreement._id} ledgerMilestones={milestones} isGc={canFund} />
        </MaybeFundingProvider>
      </section>

      <section aria-labelledby="ledger-retainage" className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
        <h2 id="ledger-retainage" className="text-base font-semibold">
          Retainage ledger
        </h2>
        <p className="text-sm text-slate-300" data-testid="retainage-summary">
          Retainage held: <span className="font-semibold tabular-nums">{formatCents(totals.retainageHeldCents)}</span> · Released:{" "}
          <span className="font-semibold tabular-nums" data-testid="retainage-released">
            {formatCents(ledger.retainageReleasedCents)}
          </span>
          {ledger.retainageReleasableCents !== totals.retainageHeldCents && (
            <>
              {" "}
              · Releasable now:{" "}
              <span className="font-semibold tabular-nums" data-testid="retainage-releasable">
                {formatCents(ledger.retainageReleasableCents)}
              </span>
            </>
          )}
        </p>
        {canReleaseRetainage && (
          <RetainageReleaseControl
            agreementId={agreement._id}
            balanceCents={totals.retainageHeldCents}
            releasableCents={ledger.retainageReleasableCents}
            payeeEmail={ledger.retainagePayeeEmail}
            releases={retainageReleases}
          />
        )}
        <RetainageReleaseList releases={retainageReleases} canRefresh={canReleaseRetainage} />
        {retainageLedger.length === 0 ? (
          <p className="text-sm text-slate-400">No retainage held yet. Each paid pay app withholds its approved retainage ({agreement.retainagePercent}% per line).</p>
        ) : (
          <div className="table-scroll" role="region" aria-label="Retainage entries, scroll horizontally on narrow screens" tabIndex={0}>
          <table className="w-full text-sm" data-testid="retainage-ledger-table">
            <thead className="text-xs text-slate-400 text-left">
              <tr>
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Reason</th>
                <th className="py-2 pr-3 font-medium text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              {retainageLedger.map((r) => (
                <tr key={r._id} className="border-t border-slate-800" data-testid="retainage-row">
                  <td className="py-2 pr-3 text-slate-400">{formatDate(r.createdAt)}</td>
                  <td className="py-2 pr-3">
                    {r.payAppId ? (
                      <a href={payAppHash(r.payAppId)} className="text-emerald-400 hover:text-emerald-300" data-testid="retainage-row-link">
                        {r.reason}
                      </a>
                    ) : (
                      r.reason
                    )}
                  </td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${r.deltaCents < 0 ? "text-rose-300" : ""}`}>
                    {r.deltaCents > 0 ? "+" : ""}
                    {formatCents(r.deltaCents)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-700 font-semibold">
                <td className="py-2 pr-3" colSpan={2}>
                  Retainage held
                </td>
                <td className="py-2 pr-3 text-right tabular-nums" data-testid="retainage-ledger-balance">
                  {formatCents(totals.retainageHeldCents)}
                </td>
              </tr>
            </tfoot>
          </table>
          </div>
        )}
      </section>

      {ledger.canViewReviews ? <AgreementPayAppReviews agreementId={agreement._id} contractorId={agreement.contractorId} readOnly={ledger.readOnlyReference} /> : null}

      <AgreementChangeOrders agreementId={agreement._id} />
    </div>
  );
}

function MaybeFundingProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return enabled ? <FundingProvider>{children}</FundingProvider> : <>{children}</>;
}
