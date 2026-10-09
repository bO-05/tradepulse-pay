import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { CleanBidTerms } from "../../convex/lib/bidTerms";
import { Button, DateInput, Field, MoneyInput, StatusPill, TextInput, focusFirstInvalid } from "../ui";
import { inputClass } from "../ui/Field";
import { checkBidForm, type BidFormState } from "./bidForm";

/**
 * The structured bid form: base bid, alternates (negative = deduct), exclusions, inclusions, unit
 * prices, qualifications, valid-until and a revision note. Used by the bidder in the portal and by
 * the GC to enter a bid on a bidder's behalf or correct an AI-parsed bid.
 */
export function BidTermsForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  serverError,
  showNote = true,
  intro,
}: {
  initial: BidFormState;
  submitLabel: string;
  onSubmit: (terms: CleanBidTerms) => Promise<void>;
  onCancel?: () => void;
  serverError?: string | null;
  showNote?: boolean;
  intro?: ReactNode;
}) {
  const [form, setForm] = useState<BidFormState>(initial);
  const [maskErrors, setMaskErrors] = useState<Record<string, string | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const set = <K extends keyof BidFormState>(key: K, value: BidFormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const maskError = (key: string) => (error: string | null) => setMaskErrors((m) => ({ ...m, [key]: error }));
  const err = (key: string) => errors[key];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = checkBidForm(form, maskErrors);
    if (!result.ok) {
      setErrors(result.errors);
      focusFirstInvalid(formRef.current);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await onSubmit(result.terms);
    } finally {
      setBusy(false);
    }
  };

  const updateAlt = (i: number, patch: Partial<BidFormState["alternates"][number]>) =>
    set("alternates", form.alternates.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const updateUnit = (i: number, patch: Partial<BidFormState["unitPrices"][number]>) =>
    set("unitPrices", form.unitPrices.map((u, j) => (j === i ? { ...u, ...patch } : u)));

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-5" aria-label="Bid form">
      {intro}
      <MoneyInput
        label="Base bid"
        required
        value={form.baseAmountCents}
        onChange={(v) => set("baseAmountCents", v)}
        onInvalidChange={maskError("base")}
        error={err("base")}
        hint="Lump sum for the full scope, in US dollars."
        className="max-w-xs"
      />

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink">Alternates</legend>
        <p className="text-xs text-ink-subtle">Add-on prices the GC may accept. Use a minus sign for a deduct (for example -1,500.00).</p>
        {form.alternates.map((alt, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_12rem_auto] sm:items-start">
            <TextInput
              label={`Alternate ${i + 1} description`}
              value={alt.description}
              onChange={(v) => updateAlt(i, { description: v })}
              error={err(`alternates.${i}.description`)}
            />
            <MoneyInput
              label={
                <span className="inline-flex items-center gap-2">
                  Amount {alt.amountCents !== null && alt.amountCents < 0 && <StatusPill status="deducted" label="Deduct" />}
                </span>
              }
              allowNegative
              value={alt.amountCents}
              onChange={(v) => updateAlt(i, { amountCents: v })}
              onInvalidChange={maskError(`alternates.${i}.amount`)}
              error={err(`alternates.${i}.amount`)}
            />
            <RemoveRow label={`Remove alternate ${i + 1}`} onClick={() => set("alternates", form.alternates.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button size="sm" variant="secondary" leadingIcon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => set("alternates", [...form.alternates, { description: "", amountCents: null }])}>
          Add alternate
        </Button>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <TextArea label="Exclusions" hint="One per line." value={form.exclusions} onChange={(v) => set("exclusions", v)} error={err("exclusions")} />
        <TextArea label="Inclusions" hint="One per line." value={form.inclusions} onChange={(v) => set("inclusions", v)} error={err("inclusions")} />
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink">Unit prices</legend>
        {form.unitPrices.map((up, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem_10rem_auto] sm:items-start">
            <TextInput label={`Unit price ${i + 1} item`} value={up.item} onChange={(v) => updateUnit(i, { item: v })} error={err(`unitPrices.${i}.item`)} />
            <TextInput label="Unit" placeholder="each" value={up.unit} onChange={(v) => updateUnit(i, { unit: v })} error={err(`unitPrices.${i}.unit`)} />
            <MoneyInput
              label="Price per unit"
              value={up.unitPriceCents}
              onChange={(v) => updateUnit(i, { unitPriceCents: v })}
              onInvalidChange={maskError(`unitPrices.${i}.price`)}
              error={err(`unitPrices.${i}.price`)}
            />
            <RemoveRow label={`Remove unit price ${i + 1}`} onClick={() => set("unitPrices", form.unitPrices.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button size="sm" variant="secondary" leadingIcon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => set("unitPrices", [...form.unitPrices, { item: "", unit: "", unitPriceCents: null }])}>
          Add unit price
        </Button>
      </fieldset>

      <TextArea label="Qualifications" value={form.qualifications} onChange={(v) => set("qualifications", v)} error={err("qualifications")} rows={3} />
      <DateInput label="Valid until" value={form.validUntil} onChange={(v) => set("validUntil", v)} error={err("validUntil")} className="max-w-xs" />
      {showNote && (
        <TextInput label="Revision note (optional)" value={form.note} onChange={(v) => set("note", v)} error={err("note")} placeholder="For example: Revised after addendum 1" />
      )}

      {serverError && (
        <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950/50 px-3 py-2 text-sm text-rose-100">
          {serverError}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} loadingLabel="Submitting…">
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function RemoveRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-11 w-11 items-center justify-center self-end rounded-lg border border-line text-ink-subtle hover:text-ink sm:mt-7"
    >
      <Trash2 className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

function TextArea({
  label,
  hint,
  value,
  onChange,
  error,
  rows = 4,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  rows?: number;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => <textarea {...control} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass(Boolean(error))} />}
    </Field>
  );
}
