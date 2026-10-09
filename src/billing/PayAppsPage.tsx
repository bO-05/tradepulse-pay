import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { payAppHash } from "../auth/navigation";
import { getErrorMessage } from "../lib/errors";
import { Button, Card, EmptyState, PageHeader, StatusPill, formatCents, formatDate } from "../ui";
import { payAppTitle } from "./PayAppPage";

type AgreementRow = FunctionReturnType<typeof api.payApps.g703.mySubPayAppAgreements>[number];

/** Sub: pay applications per executed agreement, with "New pay app" for the next billing period. */
export function PayAppsPage() {
  const rows = useQuery(api.payApps.g703.mySubPayAppAgreements, {});
  if (rows === undefined) {
    return (
      <p className="text-sm text-slate-400" role="status">
        Loading pay apps…
      </p>
    );
  }
  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader
        title="Pay apps"
        description="Bill each billing period on the G702/G703 continuation sheet. A new period opens as soon as the previous pay app is approved."
      />
      {rows.length === 0 ? (
        <EmptyState title="No agreements yet" description="Pay apps open once the GC executes your subcontract and approves its schedule of values." />
      ) : (
        rows.map((a) => <AgreementPayApps key={a.agreementId} row={a} />)
      )}
    </div>
  );
}

function AgreementPayApps({ row }: { row: AgreementRow }) {
  const start = useMutation(api.payApps.g703.startPayApp);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = row.openPayApp;
  const next = row.nextApplication;

  const onNew = async () => {
    setBusy(true);
    setError(null);
    try {
      const { payAppId } = await start({ agreementId: row.agreementId });
      window.location.hash = payAppHash(payAppId);
    } catch (err) {
      setError(getErrorMessage(err, "The pay app could not be started."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={`${row.agreementNumber} · ${row.projectTitle}`}
      description={`${row.tradeName} · contract sum ${formatCents(row.contractSumCents)}`}
      actions={
        open ? (
          <a className="text-sm font-semibold text-emerald-400 hover:text-emerald-300" href={payAppHash(open._id)}>
            {open.status === "draft" ? "Continue" : "Open"} {payAppTitle(open)}
          </a>
        ) : next ? (
          <Button onClick={() => void onNew()} loading={busy} data-testid="new-pay-app">
            New pay app
          </Button>
        ) : null
      }
    >
      {row.blockedReason ? <p className="text-sm text-amber-200">{row.blockedReason}</p> : null}
      {!open && next ? (
        <p className="text-sm text-ink-muted" data-testid="next-pay-app">
          Next: Application No. {next.applicationNo}, period {formatDate(next.periodStart)} – {formatDate(next.periodEnd)}, due{" "}
          {formatDate(next.dueDate)}.
        </p>
      ) : null}
      {open && open.status !== "draft" ? (
        <p className="text-sm text-ink-muted">
          {payAppTitle(open)} is with the GC. The next period opens once it is approved.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-rose-300">
          {error}
        </p>
      ) : null}
      {row.payApps.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Pay apps on {row.agreementNumber}</caption>
            <thead className="text-left text-xs text-ink-subtle">
              <tr>
                <th className="py-2 pr-3 font-medium" scope="col">Pay app</th>
                <th className="py-2 pr-3 font-medium" scope="col">Due</th>
                <th className="py-2 pr-3 font-medium" scope="col">Status</th>
                <th className="py-2 pr-3 text-right font-medium" scope="col">Current payment due</th>
                <th className="py-2 pr-3 font-medium" scope="col">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {row.payApps.map((p) => (
                <tr key={p._id} className="border-t border-line" data-testid="sub-pay-app-row">
                  <td className="py-2 pr-3">
                    <a className="text-emerald-400 hover:text-emerald-300" href={payAppHash(p._id)}>
                      {payAppTitle(p)}
                    </a>
                  </td>
                  <td className="py-2 pr-3">{formatDate(p.dueDate)}</td>
                  <td className="py-2 pr-3">
                    <StatusPill status={p.status} />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {p.currentPaymentDueCents !== null ? formatCents(p.currentPaymentDueCents) : formatCents(p.requestedTotalCents)}
                  </td>
                  <td className="py-2 pr-3">{p.submittedAt ? formatDate(p.submittedAt) : "Not submitted"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
