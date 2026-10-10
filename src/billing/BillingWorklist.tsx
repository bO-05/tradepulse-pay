import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { payAppHash } from "../auth/navigation";
import { Card, EmptyState, PageHeader, StatusPill, Tabs, formatCents, formatDate } from "../ui";
import { RetainageView } from "./RetainageView";

type Row = FunctionReturnType<typeof api.payApps.g703.gcBillingWorklist>["rows"][number];

function headline(r: Row): string {
  const which = r.applicationNo !== null ? `#${r.applicationNo}` : `"${r.periodLabel}"`;
  const amount = r.currentPaymentDueCents ?? r.requestedTotalCents;
  return `${r.subName} submitted pay app ${which} – ${formatCents(amount)}`;
}

/** GC: submitted sub pay apps across the company's projects. Drafts stay with the sub and are not listed. */
export function BillingWorklist() {
  const data = useQuery(api.payApps.g703.gcBillingWorklist, {});
  if (data === undefined) {
    return (
      <p className="text-sm text-slate-400" role="status">
        Loading pay apps…
      </p>
    );
  }
  const awaiting = data.rows.filter((r) => r.awaitingReview);
  const others = data.rows.filter((r) => !r.awaitingReview);
  const payApps = (
    <div className="space-y-4">
      <Card title="Awaiting review">
        {awaiting.length === 0 ? (
          <EmptyState title="Nothing to review" description="Submitted pay apps appear here." headingLevel={3} />
        ) : (
          <WorklistTable rows={awaiting} caption="Pay apps awaiting review" />
        )}
      </Card>
      {others.length > 0 ? (
        <Card title="Decided and withdrawn">
          <WorklistTable rows={others} caption="Decided and withdrawn pay apps" />
        </Card>
      ) : null}
      {data.truncated ? <p className="text-xs text-ink-subtle">Showing the newest pay apps only.</p> : null}
    </div>
  );
  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader title="Billing" description="Sub pay applications and the retainage held on each project." />
      <Tabs
        label="Billing"
        tabs={[
          { id: "pay-apps", label: "Pay apps", content: payApps },
          { id: "retainage", label: "Retainage", content: <RetainageView /> },
        ]}
      />
    </div>
  );
}

function WorklistTable({ rows, caption }: { rows: Row[]; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-left text-xs text-ink-subtle">
          <tr>
            <th className="py-2 pr-3 font-medium" scope="col">Pay app</th>
            <th className="py-2 pr-3 font-medium" scope="col">Project</th>
            <th className="py-2 pr-3 font-medium" scope="col">Period ending</th>
            <th className="py-2 pr-3 font-medium" scope="col">Status</th>
            <th className="py-2 pr-3 font-medium" scope="col">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r._id} className="border-t border-line" data-testid="billing-worklist-row">
              <td className="py-2 pr-3">
                <a className="text-emerald-400 hover:text-emerald-300" href={payAppHash(r._id)}>
                  {headline(r)}
                </a>
              </td>
              <td className="py-2 pr-3">
                {r.projectTitle}
                <span className="block text-xs text-ink-subtle">{r.agreementNumber}</span>
              </td>
              <td className="py-2 pr-3">{formatDate(r.periodEnd)}</td>
              <td className="py-2 pr-3">
                <StatusPill status={r.status} />
              </td>
              <td className="py-2 pr-3">{formatDate(r.submittedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
