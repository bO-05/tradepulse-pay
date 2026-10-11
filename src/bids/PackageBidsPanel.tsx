import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { getErrorMessage } from "../lib/errors";
import { Button, DateText, Dialog, Field, Money, StatusPill, useToast } from "../ui";
import { inputClass } from "../ui/Field";
import { BidTermsForm } from "./BidTermsForm";
import { BidTermsSummary } from "./BidTermsSummary";
import { EMPTY_BID_FORM, bidFormFrom, bidSourceLabel } from "./bidForm";

const AI_SOURCES = new Set(["email_ai", "document_ai"]);

function showMessage(inboundEmailId: string) {
  const el = document.getElementById(`bidder-message-${inboundEmailId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus();
}

/** The GC's view of every bid on a package: latest terms, where each came from, and its revision history. */
export function PackageBidsPanel({
  tradePackageId,
  bidders,
  readOnly,
}: {
  tradePackageId: Id<"tradePackages">;
  bidders: Doc<"contractors">[];
  readOnly?: boolean;
}) {
  const bids = useQuery(api.bidPortal.listPackageBidsWithHistory, { tradePackageId });
  const enter = useMutation(api.bidPortal.enterBidOnBehalf);
  const confirm = useMutation(api.bidPortal.confirmParsedBid);
  const toast = useToast();
  const [entering, setEntering] = useState(false);
  const [bidderId, setBidderId] = useState<string>("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  if (bids === undefined) return null;
  const editing = bids.find((b) => b._id === editingId) ?? null;

  return (
    <section aria-label="Bids" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Bids ({bids.length})</h4>
        {!readOnly && bidders.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setServerError(null);
              setBidderId(bidders[0]._id);
              setEntering(true);
            }}
          >
            Enter bid on behalf
          </Button>
        )}
      </div>
      {bids.length === 0 ? (
        <p className="text-xs text-ink-subtle">No bids yet. Bids submitted in the bid portal, parsed from email, or entered here appear in this list.</p>
      ) : (
        <ul className="divide-y divide-line text-sm" data-testid="package-bids">
          {bids.map((b) => {
            const needsReview = AI_SOURCES.has(b.source) && b.confirmedAt === null;
            return (
              <li key={b._id} className="space-y-2 py-2" data-testid={`package-bid-${b._id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{b.subcontractorName}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusPill status={b.source} label={bidSourceLabel(b.source)} tone={AI_SOURCES.has(b.source) ? "warning" : "info"} />
                    {needsReview && <StatusPill status="pending_review" label="Needs GC review" />}
                    {b.isAwarded && <StatusPill status="awarded" />}
                    {!b.isAwarded && b.packageAwarded && <StatusPill status="not_awarded" />}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-subtle">
                  <span>
                    Base <span className="font-semibold text-ink"><Money cents={b.baseAmountCents} /></span>
                  </span>
                  <span>Revision {b.revisionNumber}</span>
                  {b.source === "gc_entered" && b.submittedByName && <span>Entered by GC: {b.submittedByName}</span>}
                  {b.source === "portal" && b.submittedByName && <span>Submitted by {b.submittedByName}</span>}
                  {b.confirmedByName && b.confirmedAt !== null && (
                    <span>
                      Confirmed by {b.confirmedByName} <DateText value={b.confirmedAt} withTime />
                    </span>
                  )}
                  {b.sourceInboundEmail && (
                    <button type="button" className="text-emerald-300 underline-offset-2 hover:underline" onClick={() => showMessage(b.sourceInboundEmail!._id)}>
                      Source email: {b.sourceInboundEmail.subject}
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" aria-expanded={historyOf === b._id} onClick={() => setHistoryOf(historyOf === b._id ? null : b._id)}>
                    History ({b.history.length})
                  </Button>
                  {!readOnly && !b.isAwarded && (
                    <Button
                      size="sm"
                      variant={needsReview ? "primary" : "ghost"}
                      onClick={() => {
                        setServerError(null);
                        setEditingId(b._id);
                      }}
                    >
                      Edit / confirm
                    </Button>
                  )}
                </div>
                {historyOf === b._id && (
                  <ol className="space-y-2 rounded-lg border border-line p-2 text-xs" aria-label={`Revision history for ${b.subcontractorName}`}>
                    {[...b.history].reverse().map((h) => (
                      <li key={h._id} className="space-y-0.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold">
                            Revision {h.revisionNumber}
                            {h.revisionNumber === b.revisionNumber ? " (current)" : ""} · {bidSourceLabel(h.source)} · {h.submittedByName}
                          </span>
                          <span className="font-semibold">
                            <Money cents={h.baseAmountCents} />
                          </span>
                        </div>
                        <p className="text-ink-subtle">
                          <DateText value={h.createdAt} withTime />
                          {h.note ? ` · ${h.note}` : ""}
                        </p>
                        {h.changes.length > 0 && (
                          <ul className="list-disc pl-5 text-ink-subtle">
                            {h.changes.map((c) => (
                              <li key={c}>{c}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {entering && (
        <Dialog open title="Enter bid on behalf of a bidder" description="Use this for a bid received by phone or on paper. It is recorded as entered by you, not by the bidder." onClose={() => setEntering(false)}>
          <BidTermsForm
            initial={EMPTY_BID_FORM}
            submitLabel="Save bid"
            serverError={serverError}
            onCancel={() => setEntering(false)}
            intro={
              <Field label="Bidder" required>
                {(control) => (
                  <select {...control} value={bidderId} onChange={(e) => setBidderId(e.target.value)} className={inputClass(false)}>
                    {bidders.map((c) => (
                      <option key={c._id} value={c._id}>
                        {c.companyName}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            }
            onSubmit={async (terms) => {
              setServerError(null);
              try {
                const r = await enter({ tradePackageId, contractorId: bidderId, ...terms });
                toast.success(`Bid saved as revision ${r.revisionNumber}, entered by GC.`);
                setEntering(false);
              } catch (err) {
                setServerError(getErrorMessage(err));
              }
            }}
          />
        </Dialog>
      )}

      {editing && (
        <Dialog
          open
          title={`Edit / confirm · ${editing.subcontractorName}`}
          description={
            AI_SOURCES.has(editing.source)
              ? "These values were extracted by AI. Correct anything that is wrong, then confirm. A correction is saved as a new revision."
              : "Correct the bid if needed. A correction is saved as a new revision."
          }
          onClose={() => setEditingId(null)}
        >
          <div className="mb-4 rounded-lg border border-line p-3">
            <BidTermsSummary terms={editing} />
          </div>
          <BidTermsForm
            initial={bidFormFrom(editing)}
            submitLabel="Confirm bid"
            showNote={false}
            serverError={serverError}
            onCancel={() => setEditingId(null)}
            onSubmit={async (terms) => {
              setServerError(null);
              try {
                const r = await confirm({ bidId: editing._id, ...terms });
                toast.success(r.changed ? `Bid corrected and confirmed (revision ${r.revisionNumber}).` : "Bid confirmed as parsed.");
                setEditingId(null);
              } catch (err) {
                setServerError(getErrorMessage(err));
              }
            }}
          />
        </Dialog>
      )}
    </section>
  );
}
