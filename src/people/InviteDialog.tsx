import { useAction, useQuery } from "convex/react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import {
  CSI_DIVISION_OPTIONS,
  INVALID_EMAIL_MESSAGE,
  inviteEmailOutcome,
  normalizeInviteEmail,
  tradeName,
  type InviteEmailStatus,
  type InviteKind,
} from "../../convex/lib/inviteRules";
import { getErrorMessage } from "../lib/errors";
import { Button, Dialog, Field, focusFirstInvalid, TextInput, useToast } from "../ui";
import { inputClass } from "../ui/Field";

export type InviteDialogMode =
  | { type: "create"; kind: InviteKind; projectId?: string; projectTitle?: string; ownerName?: string | null }
  | { type: "resend"; inviteId: string; email: string; sendEmail: boolean };

type Result = { link: string; email: string; emailStatus: InviteEmailStatus; emailError: string | null };

const TITLE: Record<InviteKind, string> = {
  teammate: "Invite teammate",
  sub: "Invite subcontractor",
  owner: "Invite owner",
};

const OUTCOME_STYLE = {
  success: "border-emerald-800 bg-emerald-950/60 text-emerald-100",
  info: "border-sky-800 bg-sky-950/50 text-sky-100",
  warning: "border-amber-700 bg-amber-950/50 text-amber-100",
  danger: "border-rose-800 bg-rose-950/60 text-rose-100",
} as const;

const NEW_VENDOR = "__new__";

/** Copyable link plus an honest line about the email: "Email sent" only when the send went out. */
export function InviteResult({ result }: { result: Result }) {
  const toast = useToast();
  const outcome = inviteEmailOutcome(result.emailStatus, result.emailError);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.link);
      toast.success("Invite link copied.");
    } catch {
      toast.error("Couldn't copy automatically. Select the link and copy it.");
    }
  };
  return (
    <div className="space-y-3">
      <p role="status" data-testid="invite-email-outcome" className={`rounded-lg border px-3 py-2 text-sm ${OUTCOME_STYLE[outcome.tone]}`}>
        {outcome.text}
      </p>
      <Field id="invite-link" label={`Invite link for ${result.email}`} hint="Anyone with this link can see the invite; it works once and expires in 7 days.">
        {(control) => (
          <input {...control} readOnly value={result.link} onFocus={(e) => e.currentTarget.select()} className={inputClass(false, "font-mono text-xs")} data-testid="invite-link" />
        )}
      </Field>
      <Button variant="secondary" onClick={() => void copy()}>
        Copy link
      </Button>
    </div>
  );
}

export function InviteDialog({ mode, onClose }: { mode: InviteDialogMode; onClose: () => void }) {
  const create = useAction(api.invites.create);
  const resend = useAction(api.invites.resend);
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const isSub = mode.type === "create" && mode.kind === "sub";
  const vendors = useQuery(api.vendors.listVendors, isSub ? {} : "skip");
  const [email, setEmail] = useState("");
  const [sendEmail, setSendEmail] = useState(mode.type === "create" ? true : mode.sendEmail);
  const [vendorChoice, setVendorChoice] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [trade, setTrade] = useState("");
  const [contactName, setContactName] = useState("");
  const [companyName, setCompanyName] = useState(mode.type === "create" ? (mode.ownerName ?? "") : "");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!isSub || vendors === undefined || vendorChoice !== "") return;
    setVendorChoice(vendors.length === 0 ? NEW_VENDOR : "");
  }, [isSub, vendors, vendorChoice]);

  const pickVendor = (id: string) => {
    setVendorChoice(id);
    const vendor = vendors?.find((v) => v._id === id);
    if (vendor && email.trim() === "") setEmail(vendor.email);
  };

  const finish = (r: Result) => {
    setResult(r);
    const outcome = inviteEmailOutcome(r.emailStatus, r.emailError);
    if (outcome.tone === "success") toast.success(`Invite ready for ${r.email}. ${outcome.text}.`);
    else toast.info(`Invite ready for ${r.email}. ${outcome.text}.`);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setFormError(null);
    if (mode.type === "resend") {
      setSubmitting(true);
      try {
        finish(await resend({ inviteId: mode.inviteId, sendEmail }));
      } catch (err) {
        setFormError(getErrorMessage(err, "We couldn't create a new link. Try again."));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const next: Record<string, string | undefined> = {};
    const normalized = normalizeInviteEmail(email);
    if (normalized === null) next.email = INVALID_EMAIL_MESSAGE;
    if (isSub) {
      if (vendorChoice === "") next.vendor = "Choose a vendor or add a new one.";
      if (vendorChoice === NEW_VENDOR) {
        if (vendorName.trim().length < 2) next.vendorName = "Enter the subcontractor's company name.";
        if (trade === "") next.trade = "Choose a trade.";
        if (contactName.trim().length < 2) next.contactName = "Enter a contact name.";
      }
    }
    if (mode.kind === "owner" && companyName.trim().length < 2) next.companyName = "Enter the owner's company name.";
    setErrors(next);
    if (Object.values(next).some(Boolean)) {
      focusFirstInvalid(formRef.current);
      return;
    }
    setSubmitting(true);
    try {
      const r = await create({
        kind: mode.kind,
        email: normalized!,
        sendEmail,
        ...(mode.projectId ? { projectId: mode.projectId } : {}),
        ...(isSub && vendorChoice !== NEW_VENDOR ? { vendorId: vendorChoice } : {}),
        ...(isSub && vendorChoice === NEW_VENDOR
          ? { newVendor: { name: vendorName.trim(), trade, contactName: contactName.trim() } }
          : {}),
        ...(mode.kind === "owner" ? { companyName: companyName.trim() } : {}),
      });
      finish(r);
    } catch (err) {
      const data = (err as { data?: { field?: string; message?: string } }).data;
      const message = getErrorMessage(err, "We couldn't create the invite. Try again.");
      if (data?.field === "email") {
        setErrors({ email: message });
        focusFirstInvalid(formRef.current);
      } else setFormError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const title = mode.type === "resend" ? `New invite link for ${mode.email}` : TITLE[mode.kind];
  const description =
    mode.type === "resend"
      ? "A new link replaces the old one; links sent earlier stop working."
      : mode.type === "create" && mode.projectTitle
        ? `For ${mode.projectTitle}.`
        : mode.kind === "teammate"
          ? "Teammates join your company as members and see its projects."
          : undefined;

  return (
    <Dialog
      open
      title={title}
      description={description}
      onClose={onClose}
      footer={
        result ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" form="invite-form" loading={submitting} loadingLabel={mode.type === "resend" ? "Creating link…" : "Creating invite…"}>
              {mode.type === "resend" ? (sendEmail ? "Resend" : "Create new link") : "Create invite"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <InviteResult result={result} />
      ) : (
        <form id="invite-form" ref={formRef} onSubmit={onSubmit} noValidate className="space-y-4" aria-label={title}>
          {mode.type === "create" && isSub && (
            <Field id="invite-vendor" label="Vendor" required error={errors.vendor}>
              {(control) => (
                <select {...control} value={vendorChoice} onChange={(e) => pickVendor(e.target.value)} className={inputClass(Boolean(errors.vendor))}>
                  <option value="">{vendors === undefined ? "Loading vendors…" : "Choose a vendor…"}</option>
                  {(vendors ?? []).map((v) => (
                    <option key={v._id} value={v._id}>
                      {v.name}
                      {v.trades[0] ? ` · ${tradeName(v.trades[0])}` : ""}
                    </option>
                  ))}
                  <option value={NEW_VENDOR}>+ New vendor</option>
                </select>
              )}
            </Field>
          )}
          {mode.type === "create" && isSub && vendorChoice === NEW_VENDOR && (
            <div className="space-y-4 rounded-lg border border-line p-3">
              <TextInput id="invite-vendor-name" label="Company name" required value={vendorName} onChange={setVendorName} error={errors.vendorName} />
              <Field id="invite-vendor-trade" label="Trade" required error={errors.trade}>
                {(control) => (
                  <select {...control} value={trade} onChange={(e) => setTrade(e.target.value)} className={inputClass(Boolean(errors.trade))}>
                    <option value="">Choose a trade…</option>
                    {CSI_DIVISION_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <TextInput id="invite-vendor-contact" label="Contact name" required value={contactName} onChange={setContactName} error={errors.contactName} />
            </div>
          )}
          {mode.type === "create" && (
            <TextInput
              id="invite-email"
              label="Email"
              type="email"
              required
              value={email}
              onChange={setEmail}
              error={errors.email}
              autoComplete="off"
            />
          )}
          {mode.type === "create" && mode.kind === "owner" && (
            <TextInput
              id="invite-owner-company"
              label="Owner company name"
              required
              value={companyName}
              onChange={setCompanyName}
              error={errors.companyName}
              hint="Prefilled from the project; the owner can edit it when accepting."
            />
          )}
          <div className="flex items-start gap-2">
            <input
              id="invite-send-email"
              type="checkbox"
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-green-600"
            />
            <label htmlFor="invite-send-email" className="text-sm text-ink">
              Send email
              <span className="block text-xs text-ink-subtle">You'll get a link to copy either way.</span>
            </label>
          </div>
          {formError && (
            <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
              {formError}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}
