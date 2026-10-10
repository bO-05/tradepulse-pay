import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { getErrorMessage } from "../lib/errors";
import { Button, Dialog, StatusPill, TextInput, useToast } from "../ui";
import { RFQ_RECIPIENT_LABELS, copyRfqLink } from "./rfqLabels";

type Result = { contractorId: Id<"contractors">; email: string; status: string; reason?: string };

function RecipientPill({ state }: { state: string }) {
  const meta = RFQ_RECIPIENT_LABELS[state];
  return <StatusPill status={state} label={meta?.label} tone={meta?.tone} />;
}

/**
 * The GC reviews the exact recipient list, confirms or edits web-discovered addresses, and only then
 * sends. Nothing is emailed until "Confirm and send" is clicked, and only to the checked rows.
 */
export function RfqSendDialog({
  tradePackageId,
  contractorIds,
  title,
  onClose,
}: {
  tradePackageId: Id<"tradePackages">;
  contractorIds?: Id<"contractors">[];
  title?: string;
  onClose: () => void;
}) {
  const preview = useQuery(api.rfqRecipients.previewRfqRecipients, { tradePackageId, contractorIds });
  const confirmEmail = useMutation(api.rfqRecipients.confirmBidderEmail);
  const send = useAction(api.rfqActions.dispatchRfqsWithNotification);
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [editing, setEditing] = useState<{ id: Id<"contractors">; email: string; error?: string } | null>(null);
  const [savingEmail, setSavingEmail] = useState(false);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const recipients = preview?.recipients ?? [];
  const demo = preview?.isDemo === true;
  const readyIds = recipients.filter((r) => r.state === "ready").map((r) => r.contractorId as string);

  useEffect(() => {
    if (preview && selected === null) setSelected(new Set(readyIds));
  }, [preview, selected]);

  const isChecked = (id: string) => selected?.has(id) ?? false;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chosen = recipients.filter((r) => (r.state === "ready" || r.state === "blocked_recipient") && isChecked(r.contractorId));

  const saveEmail = async (id: Id<"contractors">, email: string) => {
    setSavingEmail(true);
    try {
      await confirmEmail({ contractorId: id, email });
      setEditing(null);
      setSelected((prev) => new Set([...(prev ?? []), id]));
      toast.success("Email confirmed.");
    } catch (err) {
      const message = getErrorMessage(err, "We couldn't save that email. Check the address and try again.");
      if (editing?.id === id) setEditing({ id, email, error: message });
      else toast.error(message);
    } finally {
      setSavingEmail(false);
    }
  };

  const onSend = async () => {
    if (chosen.length === 0 || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await send({
        tradePackageId,
        recipients: chosen.map((r) => ({ contractorId: r.contractorId, email: r.email })),
      });
      setResults(res.deliveryResults as Result[]);
      if (res.emailsSent > 0) toast.success(`RFQ sent to ${res.emailsSent} bidder${res.emailsSent === 1 ? "" : "s"}.`);
      else toast.info("No RFQ email was sent. See the result for each bidder.");
    } catch (err) {
      setSendError(getErrorMessage(err, "The RFQs could not be sent. Nothing was emailed."));
    } finally {
      setSending(false);
    }
  };

  const nameOf = (id: string) => recipients.find((r) => r.contractorId === id)?.companyName ?? "Bidder";

  return (
    <Dialog
      open
      title={title ?? "Review RFQ recipients"}
      onClose={onClose}
      description={
        preview ? (
          <span className="block space-y-1">
            <span className="block">
              From <span className="font-mono text-ink">{preview.fromInbox}</span> on behalf of {preview.gcName}.
            </span>
            <span className="block break-words">Subject: {preview.subjectPreview.replace("[TP-XXXXXXXX]", "[TP-reference]")}</span>
            <span className="block">The email says: Bids are due {preview.dueLabel}.</span>
            {preview.isDemo && <span className="block text-amber-200">Demo company: no email is sent; bidders are marked invited in the demo only.</span>}
          </span>
        ) : undefined
      }
      footer={
        results ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={onSend} disabled={chosen.length === 0 || editing !== null} loading={sending} loadingLabel="Sending…">
              {demo
                ? `Confirm ${chosen.length} demo invitation${chosen.length === 1 ? "" : "s"} (no email)`
                : `Confirm and send ${chosen.length} RFQ email${chosen.length === 1 ? "" : "s"}`}
            </Button>
          </>
        )
      }
    >
      {preview === undefined ? (
        <p role="status" className="text-sm text-ink-subtle">
          Loading recipients…
        </p>
      ) : results ? (
        <ul aria-label="RFQ send results" className="divide-y divide-line text-sm">
          {results.map((r) => (
            <li key={r.contractorId} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{nameOf(r.contractorId)}</span>
                <RecipientPill state={r.status} />
              </div>
              <p className="break-all text-xs text-ink-subtle">{r.email}</p>
              {r.status !== "sent" && r.reason && <p className="text-xs text-ink-subtle">{r.reason}</p>}
              {r.status === "skipped_budget" && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    try {
                      await copyRfqLink();
                      toast.success("RFQ link copied.");
                    } catch {
                      toast.error("Couldn't copy the link. Copy it from the bidder row instead.");
                    }
                  }}
                >
                  Copy RFQ link
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : recipients.length === 0 ? (
        <p className="text-sm text-ink-subtle">This package has no bidders yet. Add bidders before sending RFQs.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-subtle">Only the checked bidders below are emailed, at the address shown.</p>
          <ul aria-label="RFQ recipients" className="divide-y divide-line text-sm">
            {recipients.map((r) => {
              const selectable = r.state === "ready" || r.state === "blocked_recipient";
              const isEditing = editing?.id === r.contractorId;
              const checkboxId = `rfq-recipient-${r.contractorId}`;
              return (
                <li key={r.contractorId} className="space-y-2 py-2" data-testid="rfq-recipient">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <label htmlFor={checkboxId} className="flex min-w-0 flex-1 items-start gap-2">
                      <input
                        id={checkboxId}
                        type="checkbox"
                        className="mt-1"
                        disabled={!selectable}
                        checked={selectable && isChecked(r.contractorId)}
                        onChange={() => toggle(r.contractorId)}
                      />
                      <span className="min-w-0">
                        <span className="block font-semibold">{r.companyName}</span>
                        <span className="block break-all text-xs text-ink-subtle">{r.email || "No email on file"}</span>
                      </span>
                    </label>
                    <RecipientPill
                      state={selectable && !isChecked(r.contractorId) ? "not_selected" : demo && r.state === "ready" ? "demo_ready" : r.state}
                    />
                  </div>
                  <p className="text-xs text-ink-subtle">
                    {r.state === "ready" && !isChecked(r.contractorId)
                      ? "Not selected; this bidder will not be emailed."
                      : demo && r.state === "ready"
                        ? "Demo company: marked invited in the demo; no email is sent."
                        : r.note}
                  </p>
                  {isEditing ? (
                    <div className="space-y-2">
                      <TextInput
                        id={`rfq-email-${r.contractorId}`}
                        label={`Email for ${r.companyName}`}
                        type="email"
                        value={editing.email}
                        onChange={(email) => setEditing({ id: r.contractorId, email })}
                        error={editing.error}
                        autoFocus
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" loading={savingEmail} loadingLabel="Saving…" onClick={() => saveEmail(r.contractorId, editing.email)}>
                          Save and confirm email
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    r.state !== "already_sent" && (
                      <div className="flex flex-wrap gap-2">
                        {r.state === "email_unconfirmed" && (
                          <Button size="sm" loading={savingEmail} onClick={() => saveEmail(r.contractorId, r.email)}>
                            Confirm this email
                          </Button>
                        )}
                        <Button size="sm" variant="secondary" onClick={() => setEditing({ id: r.contractorId, email: r.state === "no_email" ? "" : r.email })}>
                          {r.state === "no_email" ? "Add email" : "Edit email"}
                        </Button>
                      </div>
                    )
                  )}
                </li>
              );
            })}
          </ul>
          {sendError && (
            <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
              {sendError}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
