import { US_STATES } from "../../../convex/lib/companyProfile";
import type { ProjectSetupErrors } from "../../../convex/lib/projectSetup";
import { DateInput, Field, MoneyInput, PercentInput, TextInput } from "../../ui";
import { inputClass } from "../../ui/Field";
import { effectiveRetainageBps, retainageHint, type ProjectSetupFormState } from "./projectSetupForm";

export type ProjectSetupFieldsProps = {
  form: ProjectSetupFormState;
  onChange: (patch: Partial<ProjectSetupFormState>) => void;
  errors: ProjectSetupErrors;
  companyDefaultBps: number | null | undefined;
  idPrefix: string;
  disabled?: boolean;
};

/** Labeled project setup fields shared by the New project wizard and Project settings. */
export function ProjectSetupFields({ form, onChange, errors, companyDefaultBps, idPrefix, disabled }: ProjectSetupFieldsProps) {
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <fieldset disabled={disabled} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput
          id={id("title")}
          label="Project name"
          required
          value={form.title}
          onChange={(title) => onChange({ title })}
          error={errors.title}
          placeholder="e.g. Harbor Point Dental Office TI"
          maxLength={160}
        />
        <TextInput
          id={id("owner")}
          label="Owner name"
          required
          value={form.ownerName}
          onChange={(ownerName) => onChange({ ownerName })}
          error={errors.ownerName}
          hint="The project owner as named in the prime contract."
          placeholder="e.g. Harbor Point Dental LLC"
          maxLength={160}
        />
      </div>

      <fieldset className="space-y-4">
        <legend className="text-sm font-semibold text-ink">Project address</legend>
        <TextInput
          id={id("line1")}
          label="Street address (line 1)"
          required
          value={form.line1}
          onChange={(line1) => onChange({ line1 })}
          error={errors.line1}
          autoComplete="address-line1"
          maxLength={200}
        />
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
          <TextInput
            id={id("city")}
            label="City"
            required
            value={form.city}
            onChange={(city) => onChange({ city })}
            error={errors.city}
            autoComplete="address-level2"
            maxLength={100}
          />
          <Field
            id={id("state")}
            label="State"
            required
            error={errors.state}
            hint="Sets the retainage rules and lien waiver forms."
          >
            {(control) => (
              <select
                {...control}
                value={form.state}
                onChange={(e) => onChange({ state: e.target.value })}
                className={inputClass(Boolean(errors.state))}
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
          <TextInput
            id={id("zip")}
            label="ZIP"
            required
            value={form.zip}
            onChange={(zip) => onChange({ zip })}
            error={errors.zip}
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={10}
            placeholder="94607"
          />
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <MoneyInput
          id={id("contract")}
          label="Contract value"
          required
          value={form.contractValueCents}
          onChange={(contractValueCents) => onChange({ contractValueCents })}
          error={errors.contractValueCents}
          hint="Prime contract sum."
        />
        <PercentInput
          id={id("retainage")}
          label="Retainage %"
          required
          value={effectiveRetainageBps(form, companyDefaultBps)}
          onChange={(retainageBps) => onChange({ retainageBps, retainageTouched: true })}
          error={errors.retainageBps}
          hint={retainageHint(form, companyDefaultBps) ?? undefined}
        />
        <TextInput
          id={id("billing-day")}
          label="Billing day"
          required
          value={form.billingDay}
          onChange={(billingDay) => onChange({ billingDay })}
          error={errors.billingDay}
          inputMode="numeric"
          maxLength={3}
          placeholder="1–28"
          hint="Day of the month pay applications are due (1–28)."
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <DateInput
          id={id("start")}
          label="Start date"
          required
          value={form.startDate}
          onChange={(startDate) => onChange({ startDate })}
          error={errors.startDate}
        />
        <DateInput
          id={id("completion")}
          label="Substantial completion date"
          value={form.substantialCompletionDate}
          onChange={(substantialCompletionDate) => onChange({ substantialCompletionDate })}
          error={errors.substantialCompletionDate}
          hint="Optional."
        />
      </div>
    </fieldset>
  );
}
