import { splitTrades, validateVendorInput, type VendorField } from "../../convex/lib/vendorRules";
import { TextInput } from "../ui";

export type VendorFormState = {
  name: string;
  trades: string;
  contactName: string;
  email: string;
  phone: string;
  licenseNumber: string;
  licenseState: string;
};

export type VendorFormErrors = Partial<Record<VendorField | "form", string>>;

export const EMPTY_VENDOR_FORM: VendorFormState = {
  name: "",
  trades: "",
  contactName: "",
  email: "",
  phone: "",
  licenseNumber: "",
  licenseState: "",
};

/** Arguments for createVendor / updateVendor / createVendorBidder, or the inline errors to show. */
export function vendorFormArgs(form: VendorFormState):
  | { ok: true; args: { name: string; trades: string[]; contactName: string; email: string; phone?: string; licenseNumber?: string; licenseState?: string } }
  | { ok: false; errors: VendorFormErrors } {
  const result = validateVendorInput({ ...form, trades: splitTrades(form.trades) });
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, args: result.value };
}

/** Maps a ConvexError with a `field` (for example the duplicate-email check) onto the form. */
export function serverVendorError(err: unknown, message: string): VendorFormErrors {
  const field = (err as { data?: { field?: string } }).data?.field;
  const known: VendorField[] = ["name", "trades", "contactName", "email", "phone", "licenseNumber", "licenseState"];
  if (field && (known as string[]).includes(field)) return { [field]: message } as VendorFormErrors;
  return { form: message };
}

export function VendorFormFields({
  idPrefix,
  form,
  errors,
  onChange,
  tradesHint = "CSI divisions, separated by commas, for example 26 00 00, 27 00 00.",
}: {
  idPrefix: string;
  form: VendorFormState;
  errors: VendorFormErrors;
  onChange: (next: VendorFormState) => void;
  tradesHint?: string;
}) {
  const set = (key: keyof VendorFormState) => (value: string) => onChange({ ...form, [key]: value });
  return (
    <div className="space-y-4">
      <TextInput id={`${idPrefix}-name`} label="Company name" required value={form.name} onChange={set("name")} error={errors.name} maxLength={120} />
      <TextInput
        id={`${idPrefix}-trades`}
        label="Trades"
        required
        value={form.trades}
        onChange={set("trades")}
        error={errors.trades}
        hint={tradesHint}
        placeholder="26 00 00"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput id={`${idPrefix}-contact`} label="Contact name" value={form.contactName} onChange={set("contactName")} error={errors.contactName} maxLength={120} />
        <TextInput id={`${idPrefix}-email`} label="Email" type="email" required value={form.email} onChange={set("email")} error={errors.email} />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextInput id={`${idPrefix}-phone`} label="Phone" type="tel" value={form.phone} onChange={set("phone")} error={errors.phone} placeholder="(510) 555-0142" />
        <TextInput id={`${idPrefix}-license`} label="License number" value={form.licenseNumber} onChange={set("licenseNumber")} error={errors.licenseNumber} maxLength={40} />
        <TextInput
          id={`${idPrefix}-license-state`}
          label="License state"
          value={form.licenseState}
          onChange={set("licenseState")}
          error={errors.licenseState}
          placeholder="CA"
          maxLength={2}
        />
      </div>
      {errors.form && (
        <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
          {errors.form}
        </p>
      )}
    </div>
  );
}
