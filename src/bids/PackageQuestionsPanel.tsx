import { useAction, useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { getErrorMessage } from "../lib/errors";
import { Button, ConfirmDialog, DateText, Field, StatusPill, TextInput, useToast } from "../ui";
import { inputClass } from "../ui/Field";

type QuestionView = {
  _id: Id<"conversations">;
  origin: "email" | "portal";
  isDemo: boolean;
  subject: string;
  replyTo: string | null;
  question: string;
  askedAt: number;
  askerCompanyName: string;
  askerName: string | null;
  draft: string;
  aiDraft: string | null;
  answerText: string | null;
  answerEmailStatus: "sending" | "sent" | "uncertain" | "failed" | "skipped_budget" | "demo_not_sent" | null;
  answerEmailError: string | null;
  answeredAt: number | null;
  answeredByName: string | null;
  status: string;
  analysisError: string | null;
  publishedAt: number | null;
  publishedQuestion: string | null;
  publishedAnswer: string | null;
};

/**
 * Bidder questions for the GC: emailed RFIs and bid-portal questions with the AI draft. Nothing is
 * sent by the AI; the GC edits and sends an email reply, or publishes an anonymous answer to every bidder.
 */
export function PackageQuestionsPanel({ tradePackageId, readOnly }: { tradePackageId: Id<"tradePackages">; readOnly?: boolean }) {
  const questions = useQuery(api.bidPortal.listPackageQuestions, { tradePackageId });
  if (questions === undefined) return null;
  const shown = questions;
  return (
    <section aria-label="Bidder questions" className="space-y-2">
      <h4 className="text-sm font-semibold">Bidder Q&A ({shown.length})</h4>
      {shown.length === 0 ? (
        <p className="text-xs text-ink-subtle">No bidder questions yet. Questions from the bid portal and RFIs emailed in the RFQ thread appear here.</p>
      ) : (
        <ul className="divide-y divide-line text-sm" data-testid="package-questions">
          {shown.map((q) => (
            <QuestionRow key={q._id} q={q as QuestionView} readOnly={readOnly} />
          ))}
        </ul>
      )}
    </section>
  );
}

function pillFor(q: QuestionView): { status: string; label: string } {
  if (q.answerEmailStatus === "sent") return { status: "answered", label: "Answered" };
  if (q.answerEmailStatus === "demo_not_sent") return { status: "demo_not_sent", label: "Answered (Demo — not sent)" };
  if (q.publishedAt !== null) return { status: "clarified", label: "Published" };
  if (q.answerEmailStatus === "sending") return { status: "sending", label: "Sending…" };
  if (q.answerEmailStatus === "uncertain") return { status: "uncertain", label: "Send unconfirmed" };
  if (q.answerEmailStatus === "failed") return { status: "failed", label: "Send failed" };
  if (q.answerEmailStatus === "skipped_budget") return { status: "skipped_budget", label: "Not sent (daily email limit)" };
  if (q.status === "pending_analysis") return { status: "pending_analysis", label: "Drafting answer…" };
  if (q.status === "failed_analysis") return { status: "failed_analysis", label: "AI draft failed" };
  return { status: "draft", label: "Draft" };
}

function QuestionRow({ q, readOnly }: { q: QuestionView; readOnly?: boolean }) {
  const answered = q.answerEmailStatus === "sent" || q.answerEmailStatus === "demo_not_sent";
  const published = q.publishedAt !== null;
  const canEmail = q.origin !== "portal" && (q.replyTo !== null || q.isDemo);
  const [mode, setMode] = useState<"none" | "reply" | "publish">("none");
  const pill = pillFor(q);
  const aiDraft = q.aiDraft ?? q.draft;

  return (
    <li className="space-y-1 py-2" data-testid={`question-${q._id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">
          {q.askerCompanyName}
          {q.askerName ? <span className="font-normal text-ink-subtle"> · {q.askerName}</span> : null}
          <span className="font-normal text-ink-subtle"> · {q.origin === "portal" ? "Bid portal" : q.replyTo ? "Email RFI" : "Logged question"}</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-ink-subtle">
          <StatusPill status={pill.status} label={pill.label} />
          <DateText value={q.askedAt} withTime />
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words">{q.question}</p>
      {!answered && !published && q.draft && (
        <p className="whitespace-pre-wrap break-words rounded border border-dashed border-line p-2 text-xs text-ink-subtle" data-testid="ai-draft">
          <span className="font-semibold text-ink">AI draft — not sent: </span>
          {q.draft}
        </p>
      )}
      {answered && (
        <div className="space-y-1 rounded border border-line p-2 text-xs" data-testid="rfi-answer">
          <p className="whitespace-pre-wrap break-words text-ink">{q.answerText}</p>
          <p className="text-ink-subtle">
            Answered by {q.answeredByName}
            {q.answeredAt !== null ? (
              <>
                {" "}
                <DateText value={q.answeredAt} withTime />
              </>
            ) : null}
            {q.answerEmailStatus === "demo_not_sent" ? " · Demo — not sent" : q.replyTo ? ` · emailed to ${q.replyTo}` : ""}
          </p>
        </div>
      )}
      {published && q.publishedAnswer && <p className="whitespace-pre-wrap break-words text-xs text-ink-subtle">Published answer: {q.publishedAnswer}</p>}
      {q.analysisError && !published && !answered && <p className="text-xs text-rose-300">{q.analysisError}</p>}
      {!answered && q.answerEmailError && <p className="text-xs text-rose-300">{q.answerEmailError}</p>}
      {!readOnly && mode === "none" && (
        <div className="flex flex-wrap gap-2">
          {canEmail && !answered && q.status !== "pending_analysis" && (
            <Button size="sm" variant="primary" onClick={() => setMode("reply")}>
              {q.isDemo ? "Review and record answer" : "Review and send reply"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setMode("publish")}>
            {published ? "Edit published answer" : "Review and publish"}
          </Button>
        </div>
      )}
      {mode === "reply" && (
        <ReplyForm q={q} initial={q.answerText ?? aiDraft} onClose={() => setMode("none")} />
      )}
      {mode === "publish" && <PublishForm q={q} onClose={() => setMode("none")} />}
    </li>
  );
}

function ReplyForm({ q, initial, onClose }: { q: QuestionView; initial: string; onClose: () => void }) {
  const send = useAction(api.rfiAnswers.sendRfiAnswer);
  const toast = useToast();
  const [answer, setAnswer] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const review = (e: FormEvent) => {
    e.preventDefault();
    if (answer.trim().length < 2) {
      setError("Enter the answer to send.");
      return;
    }
    setError(null);
    setConfirming(true);
  };

  const confirm = async () => {
    const r = await send({ conversationId: q._id, answer });
    setConfirming(false);
    if (r.status === "sent" || r.status === "already_sent") {
      toast.success(r.status === "sent" ? `Answer sent to ${q.replyTo}.` : "This answer was already sent.");
      onClose();
    } else if (r.status === "demo_not_sent") {
      toast.success("Answer recorded. Demo — not sent.");
      onClose();
    } else {
      setError(r.error ?? "The answer was not sent.");
    }
  };

  return (
    <form onSubmit={review} noValidate className="space-y-2 rounded-lg border border-line p-2" aria-label="Reply to RFI">
      <p className="text-xs text-ink-subtle">
        {q.isDemo
          ? "Demo company: the answer is recorded here and no email is sent."
          : `Edit the AI draft as needed. Only the text below is emailed to ${q.replyTo}, as a reply in the RFQ thread.`}
      </p>
      <Field label="Answer" error={error ?? undefined}>
        {(control) => <textarea {...control} rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} className={inputClass(Boolean(error))} />}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm">
          {q.isDemo ? "Record answer…" : "Send reply…"}
        </Button>
        <Button size="sm" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={q.isDemo ? "Record this answer?" : "Send this answer?"}
        payeeLabel="Recipient"
        payee={q.isDemo ? "Demo — not sent" : `${q.askerCompanyName} (${q.replyTo})`}
        effect={
          q.isDemo
            ? "Records your answer on the RFI. Demo companies send no email."
            : "Emails your text from the RFQ inbox as a reply in this bidder's thread. A sent email can't be recalled."
        }
        details={[{ label: "Question", value: q.subject }]}
        confirmLabel={q.isDemo ? "Record answer" : "Send answer"}
        onConfirm={confirm}
        onCancel={() => setConfirming(false)}
      />
    </form>
  );
}

function PublishForm({ q, onClose }: { q: QuestionView; onClose: () => void }) {
  const publish = useMutation(api.bidPortal.publishQuestion);
  const toast = useToast();
  const [question, setQuestion] = useState(q.publishedQuestion ?? q.question);
  const [answer, setAnswer] = useState(q.publishedAnswer ?? q.answerText ?? q.draft);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await publish({ conversationId: q._id, question, answer });
      toast.success("Published to every invited bidder, without the asker's name.");
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-2 rounded-lg border border-line p-2" aria-label="Publish answer">
      <TextInput label="Question as bidders will see it" value={question} onChange={setQuestion} hint="Remove anything that identifies the asker." />
      <Field label="Answer" error={error ?? undefined}>
        {(control) => <textarea {...control} rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} className={inputClass(Boolean(error))} />}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={busy} loadingLabel="Publishing…">
          Publish to all bidders
        </Button>
        <Button size="sm" variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
