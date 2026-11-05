import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FormEvent, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { getErrorMessage } from "../lib/errors";
import { Button, Card, Dialog, TextInput, formatCents, formatDate, formatDateTime, useToast } from "../ui";

type Kind = "conditional" | "unconditional";
type WaiverState = NonNullable<FunctionReturnType<typeof api.lienWaivers.payAppState>>;
type Slot = NonNullable<WaiverState["current"]>;

function SignedLine({ slot }: { slot: Slot }) {
  if (slot.signed === null) return null;
  const stale = slot.signed.amountCents !== slot.amountCents;
  return (
    <>
      <p className={`text-xs ${stale ? "text-amber-200" : "text-emerald-300"}`} data-testid={`lien-waiver-signed-${slot.signed.waiverId}`}>
        Signed by {slot.signed.signedByName}
        {slot.signed.signerTitle ? `, ${slot.signed.signerTitle}` : ""} · {formatDateTime(slot.signed.signedAt)} UTC
        {slot.signed.note ? ` · ${slot.signed.note}` : ""}
      </p>
      {stale ? (
        <p className="text-xs text-amber-200" data-testid="lien-waiver-amount-changed">
          This signature covers {formatCents(slot.signed.amountCents)}, but the payment is now {formatCents(slot.amountCents)}.
          Sign a new waiver for the current amount; the earlier signature stays on record.
        </p>
      ) : null}
    </>
  );
}

function statusLabel(slot: Slot | null, waitingForApproval: boolean): string {
  if (slot === null) return waitingForApproval ? "After approval" : "Not available";
  if (slot.signed === null) return waitingForApproval ? "After approval" : "Not signed";
  return slot.signed.amountCents === slot.amountCents ? "Signed" : "Amount changed";
}

function SlotRows({ slot, recipientName }: { slot: Slot; recipientName: string }) {
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      <div className="flex justify-between gap-3 border-b border-line/60 py-1">
        <dt className="text-ink-subtle">Amount</dt>
        <dd className="font-semibold tabular-nums">{formatCents(slot.amountCents)}</dd>
      </div>
      <div className="flex justify-between gap-3 border-b border-line/60 py-1">
        <dt className="text-ink-subtle">Through</dt>
        <dd className="font-semibold">{formatDate(slot.throughDate)}</dd>
      </div>
      <div className="flex justify-between gap-3 border-b border-line/60 py-1 sm:col-span-2">
        <dt className="text-ink-subtle">Recipient</dt>
        <dd className="text-right font-semibold">{recipientName}</dd>
      </div>
    </dl>
  );
}

/** Conditional waiver for this payment, plus the unconditional waiver for the prior paid payment. */
export function LienWaiverPanel({ payAppId }: { payAppId: string }) {
  const data = useQuery(api.lienWaivers.payAppState, { payAppId });
  const sign = useMutation(api.lienWaivers.signWaiver);
  const toast = useToast();
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (data === undefined || data === null) return null;
  const slot = kind === "conditional" ? data.current : kind === "unconditional" ? data.prior : null;
  const canSignKind = kind === "conditional" ? data.canSignCurrent : kind === "unconditional" ? data.canSignPrior : false;

  const open = (next: Kind) => {
    setKind(next);
    setName("");
    setTitle("");
    setNote("");
    setAcknowledged(false);
    setError(null);
  };

  const close = () => {
    if (busy) return;
    setKind(null);
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (kind === null || busy) return;
    if (name.trim().length < 2) {
      setError("Enter the full name of the person signing.");
      return;
    }
    if (!acknowledged) {
      setError("Confirm the waiver statement before signing.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sign({
        payAppId,
        kind,
        signedByName: name,
        ...(title.trim() ? { signerTitle: title.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        acknowledged,
      });
      toast.success(kind === "conditional" ? "Conditional waiver signed." : "Unconditional waiver signed.");
      setKind(null);
    } catch (err) {
      setError(getErrorMessage(err, "The waiver could not be signed. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const priorRequired = data.requirePriorUnconditional && data.prior !== null;
  return (
    <Card
      title="Lien waivers"
      description="The GC enabled the opt-in lien-waiver gate on this subcontract. A payout waits for the signatures below."
      padded
      data-testid="lien-waiver-panel"
    >
      <div className="space-y-4">
        <section aria-labelledby="waiver-current" className="space-y-2" data-testid="lien-waiver-current">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="waiver-current" className="text-sm font-semibold text-ink">
              Conditional waiver for this payment
            </h3>
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
              {statusLabel(data.current, data.waitingForApproval)}
            </span>
          </div>
          {data.current ? (
            <>
              <SlotRows slot={data.current} recipientName={data.recipientName} />
              <SignedLine slot={data.current} />
              {data.canSignCurrent ? (
                <Button size="sm" leadingIcon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />} onClick={() => open("conditional")} data-testid="lien-waiver-sign-conditional">
                  {data.current.signed === null ? "Sign conditional waiver" : "Sign a new conditional waiver"}
                </Button>
              ) : data.current.signed !== null && data.current.signed.amountCents !== data.current.amountCents ? (
                <p className="text-xs text-ink-subtle">Waiting for the sub to sign a waiver for the current amount. The payout stays blocked until then.</p>
              ) : data.current.signed === null && data.viewerRole === "sub" ? (
                <p className="text-xs text-ink-subtle">Signing opens after the GC approves the payment.</p>
              ) : data.current.signed === null ? (
                <p className="text-xs text-ink-subtle">Waiting for the sub to sign. The payout stays blocked until then.</p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-ink-muted">{data.noAmountMessage}</p>
          )}
        </section>

        {priorRequired ? (
          <section aria-labelledby="waiver-prior" className="space-y-2 border-t border-line pt-4" data-testid="lien-waiver-prior">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id="waiver-prior" className="text-sm font-semibold text-ink">
                Unconditional waiver for the prior payment
              </h3>
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                {statusLabel(data.prior, false)}
              </span>
            </div>
            <p className="text-xs text-ink-muted">
              Pay app {data.prior?.label} was approved after the gate was enabled, so its unconditional waiver is required before this
              payment.
            </p>
            {data.prior ? (
              <>
                <SlotRows slot={data.prior} recipientName={data.recipientName} />
                <SignedLine slot={data.prior} />
                {data.canSignPrior ? (
                  <Button size="sm" variant="secondary" leadingIcon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />} onClick={() => open("unconditional")} data-testid="lien-waiver-sign-prior">
                    {data.prior.signed === null ? "Sign unconditional waiver" : "Sign a new unconditional waiver"}
                  </Button>
                ) : data.prior.signed !== null && data.prior.signed.amountCents !== data.prior.amountCents ? (
                  <p className="text-xs text-ink-subtle">Waiting for the sub to sign a waiver for the current prior-payment amount.</p>
                ) : data.prior.signed === null && data.viewerRole === "gc" ? (
                  <p className="text-xs text-ink-subtle">Waiting for the sub to sign.</p>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}

        <p className="text-xs text-ink-subtle">{data.disclaimer}</p>
      </div>

      <Dialog
        open={kind !== null}
        title={kind === "conditional" ? "Sign the conditional waiver" : "Sign the unconditional waiver"}
        description={
          slot
            ? `${formatCents(slot.amountCents)} through ${formatDate(slot.throughDate)}, recipient ${data.recipientName}. The amount and date come from the pay app; this form cannot change them.`
            : undefined
        }
        onClose={close}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="lien-waiver-form" loading={busy} loadingLabel="Signing…" disabled={!canSignKind}>
              Sign waiver
            </Button>
          </>
        }
      >
        <form id="lien-waiver-form" className="space-y-4" onSubmit={submit}>
          <TextInput label="Full name of signer" required value={name} maxLength={120} onChange={setName} />
          <TextInput label="Title (optional)" value={title} maxLength={120} onChange={setTitle} />
          <TextInput label="Note (optional)" value={note} maxLength={500} onChange={setNote} />
          <label className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              I am authorized to sign for the subcontractor and I sign this waiver voluntarily. I understand it is an in-app
              attestation, not a state-specific statutory form.
            </span>
          </label>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
      </Dialog>
    </Card>
  );
}
