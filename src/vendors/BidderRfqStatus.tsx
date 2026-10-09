import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Button, DateText, StatusPill, useToast } from "../ui";
import { RETRYABLE_RFQ_STATUSES, RFQ_BUDGET_MESSAGE, RFQ_EMAIL_LABELS, copyRfqLink } from "./rfqLabels";

/** The bidder's real RFQ email outcome: status, send time, reason, and Retry / Copy RFQ link. */
export function BidderRfqStatus({
  bidder,
  readOnly,
  onRetry,
}: {
  bidder: Doc<"contractors">;
  readOnly?: boolean;
  onRetry: () => void;
}) {
  const toast = useToast();
  const status = bidder.rfqEmailStatus;
  if (!status) return null;
  const meta = RFQ_EMAIL_LABELS[status];
  const retryable = RETRYABLE_RFQ_STATUSES.has(status);
  const reason = status === "skipped_budget" ? RFQ_BUDGET_MESSAGE : bidder.rfqEmailError;
  return (
    <div className="flex w-full flex-col gap-1 text-xs" data-testid="bidder-rfq-status">
      <span className="flex flex-wrap items-center gap-2">
        <StatusPill status={status} label={meta?.label} tone={meta?.tone} />
        {status === "sent" && bidder.rfqSentAt && (
          <span className="text-ink-subtle">
            Sent <DateText value={bidder.rfqSentAt} withTime />
            {bidder.rfqEmailTo ? ` to ${bidder.rfqEmailTo}` : ""}
          </span>
        )}
        {status === "replied" && bidder.rfqRepliedAt && (
          <span className="text-ink-subtle">
            Replied <DateText value={bidder.rfqRepliedAt} withTime />
          </span>
        )}
        {bidder.rfqRef && <span className="font-mono text-ink-subtle">[TP-{bidder.rfqRef}]</span>}
      </span>
      {retryable && reason && <span className="text-ink-subtle">{reason}</span>}
      {retryable && !readOnly && (
        <span className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                const link = await copyRfqLink();
                toast.success(`RFQ link copied: ${link}`);
              } catch {
                toast.error("Couldn't copy the link to the clipboard.");
              }
            }}
          >
            Copy RFQ link
          </Button>
        </span>
      )}
    </div>
  );
}

const MATCH_LABEL: Record<string, string> = { thread: "Matched by thread", token: "Matched by [TP-ref] token" };

/** Replies routed to this package, grouped under the bidder they were matched to. */
export function PackageBidderMessages({
  tradePackageId,
  bidders,
}: {
  tradePackageId: Id<"tradePackages">;
  bidders: Doc<"contractors">[];
}) {
  const messages = useQuery(api.rfqRecipients.listPackageMessages, { tradePackageId });
  if (messages === undefined) return null;
  const nameOf = (id: string | null) => (id ? bidders.find((b) => b._id === id)?.companyName : undefined) ?? "GC triage (no bidder match)";
  return (
    <section aria-label="Bidder messages" className="space-y-2">
      <h4 className="text-sm font-semibold">Bidder messages ({messages.length})</h4>
      {messages.length === 0 ? (
        <p className="text-xs text-ink-subtle">No replies yet. Replies to the RFQ email appear here.</p>
      ) : (
        <ul className="divide-y divide-line text-sm" data-testid="bidder-messages">
          {messages.map((m) => (
            <li key={m.id} id={`bidder-message-${m.id}`} tabIndex={-1} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{nameOf(m.contractorId)}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-ink-subtle">
                  {m.matchMethod && <StatusPill status={m.matchMethod} label={MATCH_LABEL[m.matchMethod]} tone="info" />}
                  <DateText value={m.receivedAt} withTime />
                </span>
              </div>
              <p className="break-all text-xs text-ink-subtle">
                From {m.fromName ? `${m.fromName} <${m.from}>` : m.from}
              </p>
              <p className="break-words text-xs font-medium">{m.subject}</p>
              <p className="whitespace-pre-wrap break-words text-xs text-ink-subtle">{m.excerpt}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
