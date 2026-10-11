import { useAction, useMutation } from "convex/react";
import { useRef, useState, type FormEvent } from "react";
import { api } from "../../convex/_generated/api";
import type { ComplianceInput, ComplianceKind, W9EntityType } from "../../convex/compliance/validators";
import { US_STATES } from "../../convex/lib/companyProfile";
import {
  COMPLIANCE_KIND_LABEL,
  MAX_COMPLIANCE_FILE_BYTES,
  W9_ENTITY_LABEL,
  fileTooLargeMessage,
  tinLast4,
  todayIso,
  validateComplianceInput,
} from "../../convex/lib/complianceRules";
import { getErrorMessage } from "../lib/errors";
import { Button, DateInput, Dialog, Field, MoneyInput, TextInput, focusFirstInvalid } from "../ui";
import { inputClass } from "../ui/Field";

type Errors = Record<string, string>;

const ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";
const FILE_HINT = "PDF, PNG or JPEG, up to 10 MB. The file type is checked from its contents.";

const MONEY_FIELDS = [
  ["glEachOccurrenceCents", "GL each occurrence"],
  ["glAggregateCents", "GL aggregate"],
  ["autoCents", "Auto liability"],
  ["umbrellaCents", "Umbrella"],
] as const;
type MoneyKey = (typeof MONEY_FIELDS)[number][0];

const FIELD_ORDER = [
  "file",
  "insurer",
  "glPolicyNumber",
  "glEachOccurrenceCents",
  "glAggregateCents",
  "autoPolicyNumber",
  "autoCents",
  "umbrellaPolicyNumber",
  "umbrellaCents",
  "wcPolicyNumber",
  "effectiveDate",
  "expiryDate",
  "entityType",
  "tin",
  "signedDate",
  "licenseNumber",
  "state",
  "classification",
];

function ordered(errors: Errors): Errors {
  const out: Errors = {};
  for (const k of FIELD_ORDER) if (errors[k]) out[k] = errors[k];
  for (const [k, v] of Object.entries(errors)) if (!(k in out)) out[k] = v;
  return out;
}

function YesNo({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Field label={label} required>
      {(control) => (
        <select {...control} value={value ? "yes" : "no"} onChange={(e) => onChange(e.target.value === "yes")} className={inputClass(false)}>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      )}
    </Field>
  );
}

/** Upload form for one compliance record (COI, W-9 or license) on one project, shown in a dialog. */
export function ComplianceUploadDialog({
  open,
  kind,
  projectId,
  onClose,
  onUploaded,
}: {
  open: boolean;
  kind: ComplianceKind;
  projectId: string;
  onClose: () => void;
  onUploaded: (message: string) => void;
}) {
  return (
    <Dialog
      open={open}
      title={`Upload ${COMPLIANCE_KIND_LABEL[kind].toLowerCase().replace(/^w-9$/, "W-9")}`}
      description="Your GC reviews the file and the details you enter here."
      onClose={onClose}
    >
      {open ? <UploadForm key={kind} kind={kind} projectId={projectId} onCancel={onClose} onUploaded={onUploaded} /> : null}
    </Dialog>
  );
}

function UploadForm({
  kind,
  projectId,
  onCancel,
  onUploaded,
}: {
  kind: ComplianceKind;
  projectId: string;
  onCancel: () => void;
  onUploaded: (message: string) => void;
}) {
  const generateUploadUrl = useMutation(api.compliance.items.generateComplianceUploadUrl);
  const submit = useAction(api.compliance.items.submitComplianceItem);
  const formRef = useRef<HTMLFormElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [insurer, setInsurer] = useState("");
  const [glPolicyNumber, setGlPolicyNumber] = useState("");
  const [autoPolicyNumber, setAutoPolicyNumber] = useState("");
  const [umbrellaPolicyNumber, setUmbrellaPolicyNumber] = useState("");
  const [wcPolicyNumber, setWcPolicyNumber] = useState("");
  const [money, setMoney] = useState<Record<MoneyKey, number | null>>({ glEachOccurrenceCents: null, glAggregateCents: null, autoCents: null, umbrellaCents: null });
  const [moneyInvalid, setMoneyInvalid] = useState<Partial<Record<MoneyKey, string | null>>>({});
  const [workersComp, setWorkersComp] = useState(true);
  const [additionalInsured, setAdditionalInsured] = useState(true);
  const [effectiveDate, setEffectiveDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");

  const [entityType, setEntityType] = useState<W9EntityType | "">("");
  const [tin, setTin] = useState("");
  const [signedDate, setSignedDate] = useState("");

  const [licenseNumber, setLicenseNumber] = useState("");
  const [state, setState] = useState("CA");
  const [classification, setClassification] = useState("");

  function build(): { input: ComplianceInput | null; errors: Errors } {
    const errs: Errors = {};
    if (file === null) errs.file = "Choose the file to upload.";
    else if (file.size > MAX_COMPLIANCE_FILE_BYTES) errs.file = fileTooLargeMessage(file.size);
    else if (file.size === 0) errs.file = "This file is empty.";
    let input: ComplianceInput;
    if (kind === "coi") {
      for (const [key, label] of MONEY_FIELDS) {
        if (moneyInvalid[key]) errs[key] = `${label} must be a dollar amount.`;
        else if (money[key] === null) errs[key] = `${label} is required.`;
      }
      input = {
        kind: "coi",
        coi: {
          insurer,
          glPolicyNumber,
          ...(autoPolicyNumber.trim() ? { autoPolicyNumber } : {}),
          ...(umbrellaPolicyNumber.trim() ? { umbrellaPolicyNumber } : {}),
          ...(wcPolicyNumber.trim() ? { wcPolicyNumber } : {}),
          glEachOccurrenceCents: money.glEachOccurrenceCents ?? 0,
          glAggregateCents: money.glAggregateCents ?? 0,
          autoCents: money.autoCents ?? 0,
          umbrellaCents: money.umbrellaCents ?? 0,
          workersComp,
          additionalInsured,
          effectiveDate,
          expiryDate,
        },
      };
    } else if (kind === "w9") {
      const last4 = tinLast4(tin);
      if (last4 === null) errs.tin = "Enter the 9-digit TIN (EIN or SSN).";
      if (entityType === "") errs.entityType = "Entity type is required.";
      input = { kind: "w9", w9: { entityType: (entityType || "other") as W9EntityType, tinLast4: last4 ?? "0000", signedDate } };
    } else {
      input = { kind: "license", license: { licenseNumber, state, classification, expiryDate } };
    }
    const fieldErrors = validateComplianceInput(input, todayIso());
    for (const [k, v] of Object.entries(fieldErrors)) if (!errs[k]) errs[k] = v;
    return { input: Object.keys(errs).length === 0 ? input : null, errors: ordered(errs) };
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const { input, errors: errs } = build();
    setErrors(errs);
    if (input === null || file === null) {
      focusFirstInvalid(formRef.current);
      return;
    }
    setBusy(true);
    try {
      const { uploadUrl, uploadIntentId } = await generateUploadUrl({ projectId });
      const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!res.ok) throw new Error(`The upload failed (HTTP ${res.status}). Please try again.`);
      const { storageId } = (await res.json()) as { storageId: string };
      await submit({ projectId, uploadIntentId, storageId, fileName: file.name, input });
      onUploaded(`${COMPLIANCE_KIND_LABEL[kind]} uploaded. It is pending review by your GC.`);
    } catch (err) {
      const data = (err as { data?: { code?: string; fields?: Errors } }).data;
      const message = getErrorMessage(err, "The upload failed. Please try again.");
      if (data?.fields) {
        setErrors(ordered(data.fields));
        focusFirstInvalid(formRef.current);
      } else if (data?.code === "INVALID_FILE_TYPE" || data?.code === "FILE_TOO_LARGE") {
        setErrors({ file: message });
        focusFirstInvalid(formRef.current);
      } else {
        setFormError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} noValidate onSubmit={(e) => void onSubmit(e)} className="space-y-4" data-testid={`compliance-form-${kind}`}>
      <Field label="File" required hint={FILE_HINT} error={errors.file}>
        {(control) => (
          <input
            {...control}
            type="file"
            accept={ACCEPT}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setErrors((prev) => ({ ...prev, file: "" }));
            }}
            className={inputClass(Boolean(errors.file), "py-2 file:mr-3 file:rounded-md file:border-0 file:bg-surface-raised file:px-3 file:py-1 file:text-ink")}
          />
        )}
      </Field>

      {kind === "coi" ? (
        <>
          <TextInput label="Insurer" required value={insurer} onChange={setInsurer} error={errors.insurer} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput label="GL policy number" required value={glPolicyNumber} onChange={setGlPolicyNumber} error={errors.glPolicyNumber} />
            <TextInput label="Auto policy number" value={autoPolicyNumber} onChange={setAutoPolicyNumber} error={errors.autoPolicyNumber} />
            <TextInput label="Umbrella policy number" value={umbrellaPolicyNumber} onChange={setUmbrellaPolicyNumber} error={errors.umbrellaPolicyNumber} />
            <TextInput label="Workers' comp policy number" value={wcPolicyNumber} onChange={setWcPolicyNumber} error={errors.wcPolicyNumber} />
            {MONEY_FIELDS.map(([key, label]) => (
              <MoneyInput
                key={key}
                label={label}
                required
                value={money[key]}
                onChange={(cents) => setMoney((prev) => ({ ...prev, [key]: cents }))}
                onInvalidChange={(err) => setMoneyInvalid((prev) => ({ ...prev, [key]: err }))}
                error={errors[key]}
              />
            ))}
            <YesNo label="Workers' compensation" value={workersComp} onChange={setWorkersComp} />
            <YesNo label="Additional insured" value={additionalInsured} onChange={setAdditionalInsured} />
            <DateInput label="Effective date" required value={effectiveDate} onChange={setEffectiveDate} error={errors.effectiveDate} />
            <DateInput label="Expiry date" required value={expiryDate} onChange={setExpiryDate} error={errors.expiryDate} />
          </div>
        </>
      ) : null}

      {kind === "w9" ? (
        <>
          <Field label="Entity type" required error={errors.entityType}>
            {(control) => (
              <select {...control} value={entityType} onChange={(e) => setEntityType(e.target.value as W9EntityType | "")} className={inputClass(Boolean(errors.entityType))}>
                <option value="">Choose…</option>
                {(Object.keys(W9_ENTITY_LABEL) as W9EntityType[]).map((k) => (
                  <option key={k} value={k}>
                    {W9_ENTITY_LABEL[k]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <TextInput
            label="Taxpayer identification number (EIN or SSN)"
            required
            value={tin}
            onChange={setTin}
            autoComplete="off"
            inputMode="numeric"
            error={errors.tin}
            hint="Only the last 4 digits are kept. The full number stays in your browser and is never sent or stored."
          />
          <DateInput label="Signed date" required value={signedDate} onChange={setSignedDate} error={errors.signedDate} />
        </>
      ) : null}

      {kind === "license" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="License number" required value={licenseNumber} onChange={setLicenseNumber} error={errors.licenseNumber} />
          <Field
            label="State"
            required
            error={errors.state}
            hint={state === "CA" ? "Your GC can run an advisory California CSLB lookup." : "Licenses outside California are kept as manual records."}
          >
            {(control) => (
              <select {...control} value={state} onChange={(e) => setState(e.target.value)} className={inputClass(Boolean(errors.state))}>
                {US_STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <TextInput label="Classification" required value={classification} onChange={setClassification} error={errors.classification} placeholder="C-10 Electrical" />
          <DateInput label="Expiry date" required value={expiryDate} onChange={setExpiryDate} error={errors.expiryDate} />
        </div>
      ) : null}

      {formError ? (
        <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
          {formError}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} loadingLabel="Uploading…">
          Upload {COMPLIANCE_KIND_LABEL[kind] === "W-9" ? "W-9" : COMPLIANCE_KIND_LABEL[kind].toLowerCase()}
        </Button>
      </div>
    </form>
  );
}
