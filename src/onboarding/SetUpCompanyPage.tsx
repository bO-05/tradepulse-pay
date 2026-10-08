import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { FormEvent, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import {
  US_STATES,
  validateCompanyProfile,
  type CompanyProfileErrors,
  type CompanyProfileField,
} from "../../convex/lib/companyProfile";
import { FormAlert } from "../auth/AuthLayout";
import { describeAuthError } from "../auth/authErrors";
import { Button, Field, focusFirstInvalid, TextInput } from "../ui";
import { inputClass } from "../ui/Field";

/**
 * First screen for a verified person with no company and no invite: they create their general
 * contractor company and become its admin (onboarding.createCompany). Nothing else of the app shows.
 */
export function SetUpCompanyPage({ email }: { email: string | null }) {
  const createCompany = useMutation(api.onboarding.createCompany);
  const { signOut } = useAuthActions();
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState("");
  const [line1, setLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<CompanyProfileErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const input = { name, address: { line1, city, state, zip }, phone };
    const next = validateCompanyProfile(input);
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) {
      focusFirstInvalid(formRef.current);
      return;
    }
    setSubmitting(true);
    try {
      await createCompany(input);
      // profiles.me now reports the company, and the AuthGate opens the app shell.
    } catch (err) {
      const fields = (err as { data?: { fields?: CompanyProfileErrors } }).data?.fields;
      if (fields && Object.keys(fields).length > 0) {
        setErrors(fields);
        focusFirstInvalid(formRef.current);
      } else {
        const info = describeAuthError(err, "signUp");
        setFormError(info.code === "UNKNOWN" ? "We couldn't create the company. Try again." : info.message);
      }
      setSubmitting(false);
    }
  };

  const err = (field: CompanyProfileField) => errors[field];

  return (
    <div className="min-h-screen bg-surface-sunken text-ink flex items-center justify-center px-4 py-10 font-sans">
      <div className="w-full max-w-lg">
        <p className="text-lg font-bold tracking-tight mb-6">TradePulse Pay</p>
        <main className="bg-surface border border-line rounded-2xl p-6 shadow-xl">
          <h1 className="text-xl font-semibold">Set up your company</h1>
          <p className="mt-1 text-sm text-ink-subtle">
            Create your general contractor company. You'll be its admin and can invite your team, subcontractors and
            owners next.
          </p>
          <form ref={formRef} onSubmit={onSubmit} noValidate aria-label="Set up your company" className="mt-5 space-y-4">
            <TextInput id="company-name" label="Company name" required value={name} onChange={setName} error={err("name")} autoComplete="organization" />
            <TextInput id="company-line1" label="Street address" required value={line1} onChange={setLine1} error={err("line1")} autoComplete="address-line1" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem_7rem]">
              <TextInput id="company-city" label="City" required value={city} onChange={setCity} error={err("city")} autoComplete="address-level2" />
              <Field id="company-state" label="State" required error={err("state")}>
                {(control) => (
                  <select
                    {...control}
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    autoComplete="address-level1"
                    className={inputClass(Boolean(err("state")))}
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
              <TextInput id="company-zip" label="ZIP" required value={zip} onChange={setZip} error={err("zip")} inputMode="numeric" autoComplete="postal-code" />
            </div>
            <TextInput id="company-phone" label="Phone" type="tel" required value={phone} onChange={setPhone} error={err("phone")} autoComplete="tel" placeholder="(510) 555-0187" />
            {formError && <FormAlert>{formError}</FormAlert>}
            <Button type="submit" className="w-full" loading={submitting} loadingLabel="Creating company…">
              Create company
            </Button>
          </form>
        </main>
        <p className="mt-4 text-center text-sm text-ink-subtle">
          Signed in as {email ?? "your account"}.{" "}
          <button type="button" onClick={() => void signOut()} className="font-medium text-emerald-300 hover:underline">
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
