import { useAuthToken } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { Download, ExternalLink } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { BID_INVITATIONS_HASH } from "../auth/navigation";
import { getErrorMessage } from "../lib/errors";
import { fetchAuthenticatedFile } from "../lib/storedFile";
import { Button, Card, DateText, Field, Money, PageHeader, StatusPill, formatCents, useToast } from "../ui";
import { inputClass } from "../ui/Field";
import { BidTermsForm } from "./BidTermsForm";
import { BidTermsSummary } from "./BidTermsSummary";
import { INVITATION_STATUS, bidFormFrom } from "./bidForm";

const CONVEX_ENV = {
  VITE_CONVEX_SITE_URL: import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  VITE_CONVEX_URL: import.meta.env.VITE_CONVEX_URL as string | undefined,
};

const FILE_TYPE_LABEL: Record<string, string> = { blueprint: "Drawing", spec: "Specification", addendum: "Addendum" };

/** One invited package as its bidder sees it: scope, documents, Q&A and the bidder's own bid. */
export function BidPackagePage({ tradePackageId }: { tradePackageId: string }) {
  const view = useQuery(api.bidPortal.getPackageForBidder, { tradePackageId });
  const submit = useMutation(api.bidPortal.submitPortalBid);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  if (view === undefined) {
    return (
      <p role="status" className="text-sm text-ink-subtle">
        Loading the package…
      </p>
    );
  }
  const status = INVITATION_STATUS[view.status] ?? INVITATION_STATUS.closed;
  const bid = view.myBid;
  const canBid = view.closedReason === null;
  const showForm = canBid && (bid === null || editing);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        back={{ href: BID_INVITATIONS_HASH, label: "Bid invitations" }}
        title={
          <>
            <span className="font-mono">{view.package.csiDivision}</span> {view.package.tradeName}
          </>
        }
        description={`${view.project.title}${view.project.location ? ` · ${view.project.location}` : ""} · General contractor: ${view.gcName}`}
        meta={
          <>
            <StatusPill status={view.status} label={status.label} tone={status.tone} />
            <span>Bids due {view.package.dueLabel}</span>
            <span>Bidding as {view.bidderName}</span>
          </>
        }
      />

      <Card title="Scope">
        <p className="whitespace-pre-wrap break-words text-sm">{view.package.scopeSummary}</p>
        {view.package.mandatoryInclusions.length > 0 && (
          <>
            <h3 className="mt-3 text-sm font-semibold">Required inclusions</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
              {view.package.mandatoryInclusions.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card title={`Bid documents (${view.documents.length})`}>
        {view.documents.length === 0 ? (
          <p className="text-sm text-ink-subtle">The general contractor has not uploaded documents for this package yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm" data-testid="bid-documents">
            {view.documents.map((d) => (
              <DocumentRow key={d._id} doc={d} />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Addenda and Q&A">
        {view.addenda.length > 0 && (
          <p className="mb-3 text-sm text-ink-subtle">
            Addenda: {view.addenda.map((a) => a.fileName).join(", ")} (download above).
          </p>
        )}
        {view.questions.length === 0 ? (
          <p className="text-sm text-ink-subtle">No answers published yet.</p>
        ) : (
          <ol className="space-y-3 text-sm" data-testid="published-qa">
            {view.questions.map((q, i) => (
              <li key={q._id} className="rounded-lg border border-line p-3">
                <p className="font-semibold">
                  Q{i + 1}. {q.question}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-ink">{q.answer}</p>
                <p className="mt-1 text-xs text-ink-subtle">
                  Published <DateText value={q.publishedAt} withTime />
                </p>
              </li>
            ))}
          </ol>
        )}
        <AskQuestion tradePackageId={tradePackageId} disabled={!canBid} />
        {view.myQuestions.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold">Your questions</h3>
            <ul className="mt-1 space-y-2 text-sm">
              {view.myQuestions.map((q) => (
                <li key={q._id} className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0 break-words">{q.question}</span>
                  <StatusPill
                    status={q.published ? "clarified" : "pending"}
                    label={q.published ? "Answer published" : "Waiting for the GC's answer"}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Your bid">
        {confirmation && (
          <p role="status" className="mb-3 rounded-lg border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-100">
            {confirmation}
          </p>
        )}
        {view.closedReason && (
          <p className="mb-3 rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm">{view.closedReason}</p>
        )}
        {bid && !editing && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold" data-testid="bid-revision-status">
                {bid.revisionNumber > 1 ? `Revision ${bid.revisionNumber} submitted` : "Bid submitted"}{" "}
                <span className="font-normal text-ink-subtle">
                  <DateText value={bid.lastRevisedAt ?? bid.receivedAt} withTime />
                </span>
              </p>
              {canBid && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setConfirmation(null);
                    setServerError(null);
                    setEditing(true);
                  }}
                >
                  Revise bid
                </Button>
              )}
            </div>
            <BidTermsSummary terms={bid} />
            {bid.revisions.length > 1 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-emerald-300">Your revisions ({bid.revisions.length})</summary>
                <ol className="mt-2 space-y-1">
                  {[...bid.revisions].reverse().map((r) => (
                    <li key={r._id} className="flex flex-wrap justify-between gap-2">
                      <span>
                        Revision {r.revisionNumber} · <DateText value={r.createdAt} withTime />
                        {r.note ? <span className="text-ink-subtle"> · {r.note}</span> : null}
                      </span>
                      <Money cents={r.baseAmountCents} />
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </div>
        )}
        {showForm && (
          <BidTermsForm
            initial={bidFormFrom(bid)}
            submitLabel={bid ? "Submit revision" : "Submit bid"}
            serverError={serverError}
            onCancel={bid ? () => setEditing(false) : undefined}
            showNote={bid !== null}
            onSubmit={async (terms) => {
              setServerError(null);
              try {
                const r = await submit({ tradePackageId, ...terms });
                const total = formatCents(r.baseAmountCents);
                const message = r.revisionNumber > 1 ? `Revision ${r.revisionNumber} submitted. Base bid ${total}.` : `Bid submitted. Base bid ${total}.`;
                setConfirmation(message);
                toast.success(message);
                setEditing(false);
              } catch (err) {
                setServerError(getErrorMessage(err));
              }
            }}
          />
        )}
      </Card>
    </div>
  );
}

type Doc = { _id: string; fileName: string; fileType: string; uploadedAt: number; url: string | null; downloadPath: string | null };

function DocumentRow({ doc }: { doc: Doc }) {
  const token = useAuthToken();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const blob = await fetchAuthenticatedFile(doc, token, CONVEX_ENV);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err, "The download did not complete.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="min-w-0">
        <span className="block break-all font-medium">{doc.fileName}</span>
        <span className="text-xs text-ink-subtle">
          {FILE_TYPE_LABEL[doc.fileType] ?? "Document"} · uploaded <DateText value={doc.uploadedAt} />
        </span>
      </span>
      {doc.downloadPath ? (
        <Button size="sm" variant="secondary" loading={busy} loadingLabel="Downloading…" leadingIcon={<Download className="h-4 w-4" aria-hidden="true" />} onClick={() => void download()}>
          Download
        </Button>
      ) : doc.url ? (
        <a href={doc.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-emerald-300 hover:underline">
          <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open
        </a>
      ) : null}
    </li>
  );
}

function AskQuestion({ tradePackageId, disabled }: { tradePackageId: string; disabled: boolean }) {
  const ask = useMutation(api.bidPortal.askBidQuestion);
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (disabled) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (question.trim().length < 5) {
      setError("Type your question (at least 5 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await ask({ tradePackageId, question });
      setQuestion("");
      toast.success("Question sent to the general contractor. Answers are published to every bidder without your name.");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} noValidate className="mt-4 space-y-2" aria-label="Ask a question">
      <Field label="Ask the general contractor a question" hint="Your company name is visible to the GC only. Published answers go to every bidder without your name." error={error ?? undefined}>
        {(control) => <textarea {...control} rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} className={inputClass(Boolean(error))} />}
      </Field>
      <Button type="submit" size="sm" loading={busy} loadingLabel="Sending…">
        Send question
      </Button>
    </form>
  );
}
