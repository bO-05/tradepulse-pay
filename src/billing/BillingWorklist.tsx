import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { billingTabHash, payAppHash, type BillingTab } from "../auth/navigation";
import {
  Card,
  CommercialReferenceDisclosure,
  EmptyState,
  PageHeader,
  StatusPill,
  Tabs,
  formatCents,
  formatDate,
} from "../ui";
import { demoPeriodLabel, demoProjectName } from "../lib/demoCopy";
import { GcBillingDocuments, GcOwnerBilling } from "./OwnerBilling";
import { RetainageView } from "./RetainageView";

type Row = FunctionReturnType<typeof api.payApps.g703.gcBillingWorklist>["rows"][number];

function headline(r: Row): string {
  const which = r.applicationNo !== null ? `#${r.applicationNo}` : `"${demoPeriodLabel(r.periodLabel)}"`;
  const amount = r.currentPaymentDueCents ?? r.requestedTotalCents;
  return `${r.subName} submitted pay app ${which} – ${formatCents(amount)}`;
}

/** GC: submitted sub pay apps across the company's projects (drafts stay with the sub), owner billing and retainage. */
export function BillingWorklist({ tab = "pay-apps" }: { tab?: BillingTab }) {
  const data = useQuery(api.payApps.g703.gcBillingWorklist, {});
  if (data === undefined) {
    return (
      <p className="text-sm text-slate-400" role="status">
        Loading pay apps…
      </p>
    );
  }
  // The query already authorized and limited the rows; this split is presentation only. A stored
  // residential kind leads; everything else, including a row from before the field existed, is
  // commercial. Server order is untouched inside each partition and agreement suffixes are never
  // parsed. Awaiting/decided keeps its existing meaning inside both partitions.
  const residential = data.rows.filter((row) => row.projectKind === "residential");
  const commercial = data.rows.filter((row) => row.projectKind !== "residential");
  const awaiting = residential.filter((r) => r.awaitingReview);
  const others = residential.filter((r) => !r.awaitingReview);
  const commercialAwaiting = commercial.filter((r) => r.awaitingReview);
  const commercialOthers = commercial.filter((r) => !r.awaitingReview);
  const payApps = (
    <div className="space-y-4">
      {data.rows.length === 0 ? (
        <Card title="Awaiting review">
          <EmptyState title="Nothing to review" description="Submitted pay apps appear here." headingLevel={3} />
        </Card>
      ) : (
        <>
          {residential.length > 0 ? (
            <>
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
            </>
          ) : null}
          {commercial.length > 0 ? (
            <CommercialReferenceDisclosure
              count={commercial.length}
              testId="billing-commercial"
              summaryTestId="billing-commercial-summary"
              contentClassName="space-y-4"
            >
              <div>
                <h2 className="mb-2 text-base font-semibold text-ink">Awaiting review</h2>
                {commercialAwaiting.length === 0 ? (
                  <EmptyState title="Nothing to review" description="Submitted pay apps appear here." headingLevel={3} />
                ) : (
                  <WorklistTable rows={commercialAwaiting} caption="Pay apps awaiting review" />
                )}
              </div>
              {commercialOthers.length > 0 ? (
                <div>
                  <h2 className="mb-2 text-base font-semibold text-ink">Decided and withdrawn</h2>
                  <WorklistTable rows={commercialOthers} caption="Decided and withdrawn pay apps" />
                </div>
              ) : null}
            </CommercialReferenceDisclosure>
          ) : null}
        </>
      )}
      {data.truncated ? <p className="text-xs text-ink-subtle">Showing the newest pay apps only.</p> : null}
    </div>
  );
  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader title="Billing" description="Sub pay applications, owner billing, the retainage held on each project and billing documents." />
      <Tabs
        label="Billing"
        value={tab}
        onChange={(id) => {
          window.location.hash = billingTabHash(id as BillingTab);
        }}
        tabs={[
          { id: "pay-apps", label: "Pay apps", content: payApps },
          { id: "owner-billing", label: "Owner billing", content: <GcOwnerBilling /> },
          { id: "retainage", label: "Retainage", content: <RetainageView /> },
          { id: "documents", label: "Documents", content: <GcBillingDocuments /> },
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
                {demoProjectName(r.projectTitle)}
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
