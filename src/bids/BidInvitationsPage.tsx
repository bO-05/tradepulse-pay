import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { bidPackageHash } from "../auth/navigation";
import { Card, DateText, EmptyState, PageHeader, StatusPill } from "../ui";
import { INVITATION_STATUS } from "./bidForm";

/** The sub company's bid invitations: one row per package one of its bidder records is invited to. */
export function BidInvitationsPage() {
  const rows = useQuery(api.bidPortal.listMyBidInvitations, {});
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Bid invitations" description="Packages general contractors invited your company to bid on. Open one to read the documents and submit your bid." />
      {rows === undefined ? (
        <p role="status" className="text-sm text-ink-subtle">
          Loading bid invitations…
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No bid invitations yet"
          description="When a general contractor invites your company to bid on a package, it appears here."
        />
      ) : (
        <ul className="space-y-3" data-testid="bid-invitations">
          {rows.map((r) => {
            const status = INVITATION_STATUS[r.status] ?? INVITATION_STATUS.closed;
            return (
              <li key={r.tradePackageId}>
                <Card padded>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <a href={bidPackageHash(r.tradePackageId)} className="text-base font-semibold text-emerald-300 hover:underline">
                        <span className="font-mono">{r.csiDivision}</span> {r.tradeName}
                      </a>
                      <p className="text-sm text-ink">
                        {r.projectTitle}
                        {r.projectLocation ? <span className="text-ink-subtle"> · {r.projectLocation}</span> : null}
                      </p>
                      <p className="text-sm text-ink-subtle">General contractor: {r.gcName}</p>
                      <p className="text-sm text-ink-subtle">Bids due {r.dueLabel}</p>
                      {r.status !== "not_submitted" && r.lastSubmittedAt !== null && (
                        <p className="text-xs text-ink-subtle">
                          {r.revisionNumber > 1 ? `Revision ${r.revisionNumber}` : "Bid"} submitted <DateText value={r.lastSubmittedAt} withTime />
                        </p>
                      )}
                    </div>
                    <StatusPill status={r.status} label={status.label} tone={status.tone} />
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
