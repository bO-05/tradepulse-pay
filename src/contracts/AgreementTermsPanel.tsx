import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { US_STATES } from "../../convex/lib/companyProfile";
import {
  draftFromTerms,
  firstTermsError,
  liquidatedDamagesText,
  paymentTermsText,
  retainageText,
  stateName,
  termsErrorsWithInput,
  termsFromDraft,
  warrantyText,
  type AgreementTerms,
  type TermsDraft,
  type TermsErrors,
  type TermsField,
} from "../../convex/lib/agreementTerms";
import { getErrorMessage } from "../lib/errors";
import { Button, Card, Field, MoneyInput, PercentInput, TextInput, focusFirstInvalid, formatCents, useToast } from "../ui";
import { inputClass } from "../ui/Field";

/** Whole numbers only (a leading minus is kept so "-1" is reported, not silently dropped). */
function parseWhole(text: string): number | null {
  const v = text.trim();
  return /^-?\d{1,6}$/.test(v) ? Number(v) : null;
}

function serverField(err: unknown): { field?: TermsField; message: string } | null {
  const data = (err as { data?: { field?: unknown; message?: unknown } }).data;
  if (data && typeof data.message === "string") {
    return { field: typeof data.field === "string" ? (data.field as TermsField) : undefined, message: data.message };
  }
  return null;
}

/**
 * Agreement terms (architecture §14). The project's GC edits them until execution; afterwards, and
 * for the agreement's sub, they are read-only.
 */
export function AgreementTermsPanel({ agreementId }: { agreementId: string }) {
  const data = useQuery(api.agreementTerms.getAgreementTerms, { agreementId: agreementId as Id<"agreements"> });
  if (data === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading terms…</p>;
  if (data.canEdit) return <TermsEditor key={data.agreementId} data={data} />;
  return (
    <Card
      title="Terms"
      headingLevel={3}
      description={
        data.locked ? (
          <span className="inline-flex items-center gap-1.5">
            <Lock aria-hidden="true" className="h-3.5 w-3.5" /> Locked after execution. Change terms with a formal amendment.
          </span>
        ) : data.superseded ? (
          "This agreement is superseded; its terms are read-only."
        ) : (
          "Read-only. The general contractor sets these terms before execution."
        )
      }
    >
      <TermsSummary terms={data.terms} />
    </Card>
  );
}

export function TermsSummary({ terms }: { terms: AgreementTerms }) {
  const ins = terms.insurance;
  const rows: [string, string][] = [
    ["Retainage", retainageText(terms)],
    ["Payment terms", paymentTermsText(terms.paymentTerms)],
    ["Liquidated damages", liquidatedDamagesText(terms.liquidatedDamagesCentsPerDay)],
    ["GL each occurrence", formatCents(ins.glEachOccurrenceCents)],
    ["GL aggregate", formatCents(ins.glAggregateCents)],
    ["Auto liability", formatCents(ins.autoCents)],
    ["Umbrella", formatCents(ins.umbrellaCents)],
    ["Workers' compensation", ins.workersComp ? "Required" : "Not required"],
    ["Additional insured", ins.additionalInsured ? "Required" : "Not required"],
    ["Warranty", warrantyText(terms.warrantyMonths)],
    ["Governing state", terms.governingState ? `${terms.governingState} · ${stateName(terms.governingState) ?? ""}` : "—"],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 border-b border-line/60 py-1">
          <dt className="text-ink-subtle">{label}</dt>
          <dd className="text-right font-medium text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

type TermsData = FunctionReturnType<typeof api.agreementTerms.getAgreementTerms>;

function TermsEditor({ data }: { data: TermsData }) {
  const save = useMutation(api.agreementTerms.updateAgreementTerms);
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<TermsDraft>(() => draftFromTerms(data.terms));
  const [daysText, setDaysText] = useState(String(data.terms.paymentTerms.days));
  const [warrantyTextValue, setWarrantyTextValue] = useState(String(data.terms.warrantyMonths));
  const [dirty, setDirty] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<{ field?: TermsField; message: string } | null>(null);
  const [inputErrors, setInputErrors] = useState<TermsErrors>({});
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    if (dirty) return;
    setDraft(draftFromTerms(data.terms));
    setDaysText(String(data.terms.paymentTerms.days));
    setWarrantyTextValue(String(data.terms.warrantyMonths));
  }, [data.terms, dirty]);

  const errors = termsErrorsWithInput(draft, data.context, inputErrors);
  const shown: TermsErrors = submitted ? { ...errors } : {};
  if (serverError?.field && !shown[serverError.field]) shown[serverError.field] = serverError.message;

  const update = (patch: (d: TermsDraft) => TermsDraft) => {
    setServerError(null);
    setDirty(true);
    setDraft((d) => patch(d));
  };

  const inputError = (field: TermsField) => (message: string | null) =>
    setInputErrors((prev) => {
      const next = { ...prev };
      if (message) next[field] = message;
      else delete next[field];
      return next;
    });

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    setServerError(null);
    if (firstTermsError(errors)) {
      focusFirstInvalid(formRef.current);
      return;
    }
    setSaving(true);
    try {
      await save({ agreementId: data.agreementId, terms: termsFromDraft(draft) });
      toast.success("Terms saved. The subcontract text was updated.");
      setDirty(false);
      setSubmitted(false);
    } catch (err) {
      setServerError(serverField(err) ?? { message: getErrorMessage(err, "We couldn't save the terms. Try again.") });
      focusFirstInvalid(formRef.current);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setDraft(draftFromTerms(data.terms));
    setDaysText(String(data.terms.paymentTerms.days));
    setWarrantyTextValue(String(data.terms.warrantyMonths));
    setDirty(false);
    setSubmitted(false);
    setServerError(null);
    setInputErrors({});
    setFormKey((k) => k + 1);
  };

  const ins = draft.insurance;
  const id = (f: string) => `terms-${f}`;
  return (
    <Card
      title="Terms"
      headingLevel={3}
      description={`Editable until execution. Defaults come from the project${data.projectStateName ? ` (${data.projectStateName})` : ""} and your company.`}
    >
      <form key={formKey} ref={formRef} onSubmit={onSubmit} noValidate aria-label="Agreement terms" className="space-y-5">
        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold text-ink">Retainage and payment</legend>
          <PercentInput
            id={id("retainage")}
            onInvalidChange={inputError("retainageBps")}
            label="Retainage"
            required
            value={draft.retainageBps}
            onChange={(bps) => update((d) => ({ ...d, retainageBps: bps }))}
            error={shown.retainageBps}
          />
          <PercentInput
            id={id("retainage-reduction")}
            onInvalidChange={inputError("retainageReductionBpsAt50")}
            label="Reduced retainage at 50% complete"
            hint="Optional. Leave empty for no reduction."
            value={draft.retainageReductionBpsAt50}
            onChange={(bps) => update((d) => ({ ...d, retainageReductionBpsAt50: bps }))}
            error={shown.retainageReductionBpsAt50}
          />
          <Field id={id("payment-type")} label="Payment terms" required error={shown.paymentTermsType}>
            {(control) => (
              <select
                {...control}
                value={draft.paymentTerms.type}
                onChange={(e) => update((d) => ({ ...d, paymentTerms: { ...d.paymentTerms, type: e.target.value } }))}
                className={inputClass(Boolean(shown.paymentTermsType))}
              >
                <option value="net">Net (days after approval)</option>
                <option value="pay_when_paid">Pay-when-paid (days after owner payment)</option>
              </select>
            )}
          </Field>
          <TextInput
            id={id("payment-days")}
            label="Payment days"
            required
            inputMode="numeric"
            value={daysText}
            onChange={(text) => {
              setDaysText(text);
              update((d) => ({ ...d, paymentTerms: { ...d.paymentTerms, days: parseWhole(text) } }));
            }}
            error={shown.paymentTermsDays}
          />
          <MoneyInput
            id={id("ld")}
            onInvalidChange={inputError("liquidatedDamagesCentsPerDay")}
            label="Liquidated damages per day"
            hint="Optional. Leave empty for none."
            value={draft.liquidatedDamagesCentsPerDay}
            onChange={(cents) => update((d) => ({ ...d, liquidatedDamagesCentsPerDay: cents }))}
            error={shown.liquidatedDamagesCentsPerDay}
          />
        </fieldset>

        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold text-ink">Insurance</legend>
          <MoneyInput
            id={id("gl-each")}
            onInvalidChange={inputError("glEachOccurrenceCents")}
            label="General liability, each occurrence"
            required
            value={ins.glEachOccurrenceCents}
            onChange={(cents) => update((d) => ({ ...d, insurance: { ...d.insurance, glEachOccurrenceCents: cents } }))}
            error={shown.glEachOccurrenceCents}
          />
          <MoneyInput
            id={id("gl-aggregate")}
            onInvalidChange={inputError("glAggregateCents")}
            label="General liability, aggregate"
            required
            value={ins.glAggregateCents}
            onChange={(cents) => update((d) => ({ ...d, insurance: { ...d.insurance, glAggregateCents: cents } }))}
            error={shown.glAggregateCents}
          />
          <MoneyInput
            id={id("auto")}
            onInvalidChange={inputError("autoCents")}
            label="Auto liability"
            required
            value={ins.autoCents}
            onChange={(cents) => update((d) => ({ ...d, insurance: { ...d.insurance, autoCents: cents } }))}
            error={shown.autoCents}
          />
          <MoneyInput
            id={id("umbrella")}
            onInvalidChange={inputError("umbrellaCents")}
            label="Umbrella"
            required
            value={ins.umbrellaCents}
            onChange={(cents) => update((d) => ({ ...d, insurance: { ...d.insurance, umbrellaCents: cents } }))}
            error={shown.umbrellaCents}
          />
          <label className="flex min-h-touch items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={ins.workersComp}
              onChange={(e) => update((d) => ({ ...d, insurance: { ...d.insurance, workersComp: e.target.checked } }))}
            />
            Workers' compensation required
          </label>
          <label className="flex min-h-touch items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={ins.additionalInsured}
              onChange={(e) => update((d) => ({ ...d, insurance: { ...d.insurance, additionalInsured: e.target.checked } }))}
            />
            Additional insured required
          </label>
        </fieldset>

        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold text-ink">Warranty and law</legend>
          <TextInput
            id={id("warranty")}
            label="Warranty (months)"
            required
            inputMode="numeric"
            value={warrantyTextValue}
            onChange={(text) => {
              setWarrantyTextValue(text);
              update((d) => ({ ...d, warrantyMonths: parseWhole(text) }));
            }}
            error={shown.warrantyMonths}
          />
          <Field id={id("state")} label="Governing state" required error={shown.governingState}>
            {(control) => (
              <select
                {...control}
                value={draft.governingState}
                onChange={(e) => update((d) => ({ ...d, governingState: e.target.value }))}
                className={inputClass(Boolean(shown.governingState))}
              >
                <option value="">Choose…</option>
                {US_STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </fieldset>

        {serverError && !serverError.field && (
          <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
            {serverError.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={saving} loadingLabel="Saving…">
            Save terms
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={reset} disabled={saving}>
              Discard changes
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
