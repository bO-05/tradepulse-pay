import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { api } from "../../../convex/_generated/api";
import { OWNER_BILLING_HASH } from "../../auth/navigation";
import { getErrorMessage } from "../../lib/errors";
import { Button, Card, MoneyInput, TextInput, formatCents, useToast } from "../../ui";

type FieldErrors = { description?: string; scheduledValueCents?: string };

function fieldErrorsOf(err: unknown): FieldErrors | null {
  const data = (err as { data?: { fieldErrors?: FieldErrors } }).data;
  return data?.fieldErrors ?? null;
}

function LineRow({ line, readOnly }: { line: { _id: string; lineNo: number; description: string; scheduledValueCents: number }; readOnly: boolean }) {
  const update = useMutation(api.billing.primeLines.updatePrimeLine);
  const remove = useMutation(api.billing.primeLines.deletePrimeLine);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(line.description);
  const [cents, setCents] = useState<number | null>(line.scheduledValueCents);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await update({ primeLineId: line._id, description, scheduledValueCents: cents ?? 0 });
      setEditing(false);
      toast.success("GC line saved.");
    } catch (err) {
      const fe = fieldErrorsOf(err);
      if (fe) setErrors(fe);
      else toast.error(err, "The line could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="border-t border-line py-3">
        <form onSubmit={(e) => void save(e)} className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-start" noValidate>
          <TextInput label="Description" required value={description} onChange={setDescription} error={errors.description} maxLength={200} />
          <MoneyInput label="Scheduled value" required value={cents} onChange={setCents} error={errors.scheduledValueCents} />
          <div className="flex gap-2 sm:pt-7">
            <Button type="submit" size="sm" loading={busy}>
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2 text-sm" data-testid="prime-line-row">
      <span>
        {line.lineNo}. {line.description}
      </span>
      <span className="flex items-center gap-2">
        <span className="tabular-nums">{formatCents(line.scheduledValueCents)}</span>
        {!readOnly ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  await remove({ primeLineId: line._id });
                  toast.success("GC line removed.");
                } catch (err) {
                  toast.error(getErrorMessage(err, "The line could not be removed."));
                }
              }}
            >
              Remove
            </Button>
          </>
        ) : null}
      </span>
    </li>
  );
}

/** Project settings → Prime contract lines: the GC's own lines billed to the owner next to the trade packages. */
export function PrimeLinesCard({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const data = useQuery(api.billing.primeLines.listPrimeLines, { projectId });
  const add = useMutation(api.billing.primeLines.addPrimeLine);
  const toast = useToast();
  const [description, setDescription] = useState("");
  const [cents, setCents] = useState<number | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  if (data === undefined) return <p className="text-sm text-ink-subtle" role="status">Loading prime contract lines…</p>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await add({ projectId, description, scheduledValueCents: cents ?? 0 });
      setDescription("");
      setCents(null);
      toast.success("GC line added.");
    } catch (err) {
      const fe = fieldErrorsOf(err);
      if (fe) setErrors(fe);
      else toast.error(err, "The line could not be added.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Prime contract lines"
      description={
        <>
          Owner pay apps bill each awarded trade package at its subcontract sum plus these GC lines. See{" "}
          <a href={OWNER_BILLING_HASH} className="text-emerald-400 hover:text-emerald-300">
            Billing → Owner billing
          </a>
          .
        </>
      }
    >
      <dl className="mb-3 grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-subtle">Trade packages</dt>
          <dd className="font-semibold tabular-nums">{formatCents(data.tradePackagesCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">GC lines</dt>
          <dd className="font-semibold tabular-nums">{formatCents(data.gcLinesCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-subtle">Not yet allocated of the contract value</dt>
          <dd className="font-semibold tabular-nums">{data.unallocatedCents === null ? "Set a contract value" : formatCents(data.unallocatedCents)}</dd>
        </div>
      </dl>
      {data.lines.length > 0 ? (
        <ul data-testid="prime-lines">
          {data.lines.map((l) => (
            <LineRow key={l._id} line={l} readOnly={readOnly} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-subtle">No GC lines yet.</p>
      )}
      {!readOnly ? (
        <form onSubmit={(e) => void submit(e)} noValidate className="mt-4 grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-start" aria-label="Add a GC line">
          <TextInput
            label="Description"
            required
            value={description}
            onChange={setDescription}
            error={errors.description}
            maxLength={200}
            list="prime-line-suggestions"
            data-testid="prime-line-description"
          />
          <MoneyInput label="Scheduled value" required value={cents} onChange={setCents} error={errors.scheduledValueCents} data-testid="prime-line-amount" />
          <div className="sm:pt-7">
            <Button type="submit" loading={busy} data-testid="prime-line-add">
              Add GC line
            </Button>
          </div>
          <datalist id="prime-line-suggestions">
            {data.suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </form>
      ) : null}
    </Card>
  );
}
