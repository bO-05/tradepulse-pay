import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState, type FormEvent } from "react";
import { MessageSquare, Send } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { getErrorMessage } from "../lib/errors";
import { Button, Card, Field, formatDateTime, useToast } from "../ui";
import { inputClass } from "../ui/Field";

const MAX_BODY_LENGTH = 2_000;

type ThreadView = NonNullable<FunctionReturnType<typeof api.payApps.questions.list>>;
type ThreadEntry = ThreadView["entries"][number];

function roleLabel(role: ThreadEntry["authorRole"]): string {
  return role === "gc" ? "GC" : "Sub";
}

function ThreadEntryRow({ entry }: { entry: ThreadEntry }) {
  const gc = entry.authorRole === "gc";
  return (
    <li
      className={`rounded-xl border px-3 py-2.5 ${gc ? "border-sky-400/30 bg-sky-400/5" : "border-amber-300/25 bg-amber-300/5"}`}
      data-testid="pay-app-thread-entry"
      data-author-role={entry.authorRole}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <span className={`font-semibold uppercase tracking-wide ${gc ? "text-sky-200" : "text-amber-200"}`}>{roleLabel(entry.authorRole)}</span>
        <span className="font-medium text-ink">{entry.authorName}</span>
        <time className="text-ink-subtle" dateTime={new Date(entry.createdAt).toISOString()}>
          {formatDateTime(entry.createdAt)}
        </time>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{entry.body}</p>
    </li>
  );
}

function ThreadComposer({ thread }: { thread: ThreadView }) {
  const post = useMutation(api.payApps.questions.post);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSub = thread.viewerRole === "sub";

  if (!thread.canPost) {
    return thread.postingBlockedReason === null ? null : (
      <p className="text-xs text-ink-subtle" data-testid="pay-app-thread-blocked">
        {thread.postingBlockedReason}
      </p>
    );
  }

  const close = () => {
    if (busy) return;
    setOpen(false);
    setBody("");
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = body.trim();
    if (trimmed.length < 2) {
      setError("Write at least two characters.");
      return;
    }
    if (trimmed.length > MAX_BODY_LENGTH) {
      setError(`Keep the question under ${MAX_BODY_LENGTH.toLocaleString("en-US")} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post({ payAppId: thread.payAppId, body: trimmed });
      setBody("");
      setOpen(false);
      toast.success(isSub ? `Question sent to ${thread.counterpartyName}.` : `Reply sent to ${thread.counterpartyName}.`);
    } catch (err) {
      setError(getErrorMessage(err, "The question could not be sent. Try again."));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3" data-testid="pay-app-thread-composer">
        <Button
          variant={isSub ? "primary" : "secondary"}
          size="sm"
          leadingIcon={<MessageSquare aria-hidden="true" className="h-4 w-4" />}
          onClick={() => setOpen(true)}
          data-testid={isSub ? "pay-app-thread-question" : "pay-app-thread-reply"}
        >
          {isSub ? "Question this amount" : "Reply to the sub"}
        </Button>
        <p className="text-xs text-ink-subtle">
          {isSub ? `Goes to ${thread.counterpartyName}. No change to the pay app or payment.` : "Visible to both companies on this pay app."}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-surface-raised p-3" data-testid="pay-app-thread-form">
      <Field
        label={isSub ? `Question for ${thread.counterpartyName}` : `Reply to ${thread.counterpartyName}`}
        required
        error={error}
        hint={`${body.length.toLocaleString("en-US")} / ${MAX_BODY_LENGTH.toLocaleString("en-US")} characters. Plain language is fine.`}
      >
        {(control) => (
          <textarea
            {...control}
            rows={3}
            maxLength={MAX_BODY_LENGTH}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              if (error !== null) setError(null);
            }}
            placeholder={isSub ? "Which line or amount is unclear? Add the detail the GC needs." : "Answer the sub's question in plain language."}
            className={inputClass(Boolean(error), "min-h-24 resize-y py-2")}
            data-testid="pay-app-thread-input"
          />
        )}
      </Field>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-subtle">The pay app figures stay unchanged.</p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            loading={busy}
            loadingLabel="Sending…"
            leadingIcon={<Send aria-hidden="true" className="h-4 w-4" />}
            disabled={body.trim().length < 2}
            data-testid="pay-app-thread-send"
          >
            {isSub ? "Send question" : "Send reply"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** A plain-language question thread that sits beside the figures and never edits them. */
export function PayAppThread({ payAppId }: { payAppId: string }) {
  const thread = useQuery(api.payApps.questions.list, { payAppId });
  if (thread === undefined || thread === null) return null;
  const isSub = thread.viewerRole === "sub";
  return (
    <Card
      title="Questions about this amount"
      description={
        isSub
          ? `Ask ${thread.counterpartyName} about the amount. This thread does not change the pay app, approval or payment.`
          : `The sub can ask about the amount here. Replies do not change the pay app, approval or payment.`
      }
      actions={
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
          {thread.entries.length} {thread.entries.length === 1 ? "entry" : "entries"}
        </span>
      }
      padded
      data-testid="pay-app-thread"
    >
      {thread.entries.length === 0 ? (
        <p className="text-sm text-ink-muted" data-testid="pay-app-thread-empty">
          {isSub
            ? "No questions yet. If a line or the total is unclear, start the thread below."
            : "No questions from the sub yet. When the sub asks about the amount, the thread appears here."}
        </p>
      ) : (
        <ol className="space-y-2" aria-label="Questions and replies on this pay app" data-testid="pay-app-thread-entries">
          {thread.entries.map((entry) => (
            <ThreadEntryRow key={entry._id} entry={entry} />
          ))}
        </ol>
      )}
      <div className="mt-3 border-t border-line pt-3">
        <ThreadComposer thread={thread} />
      </div>
    </Card>
  );
}
