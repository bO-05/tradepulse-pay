import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FormEvent, useState } from "react";
import { api } from "../../convex/_generated/api";
import { COMPANY_KIND_LABEL } from "../../convex/lib/inviteRules";
import { getErrorMessage } from "../lib/errors";
import { InviteDialog } from "../people/InviteDialog";
import { InviteList } from "../people/InviteList";
import { formatRetainagePercent } from "../../convex/lib/retainageRules";
import { US_STATES } from "../../convex/lib/companyProfile";
import { Button, Card, ConfirmDialog, DateText, Field, PageHeader, PercentInput, StatusPill, TextInput, useToast } from "../ui";
import { inputClass } from "../ui/Field";
import { GcRelationshipsCard } from "../vendors/GcRelationshipsCard";

type Company = FunctionReturnType<typeof api.companies.myCompany>;

/** Company settings (user menu): profile, project defaults (GC) and members. Only admins can change anything. */
export function CompanySettingsPage() {
  const data = useQuery(api.companies.myCompany, {});
  if (data === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading company…</p>;
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="Company settings"
        description={`${data.company.name} · ${COMPANY_KIND_LABEL[data.company.kind]}`}
      />
      <ProfileCard
        key={`${data.company._id}-${data.company.name}-${data.company.phone}-${data.company.website}-${JSON.stringify(data.company.address ?? null)}`}
        data={data}
      />
      {data.company.kind === "sub" && <PayoutEmailCard key={`payout-${data.company.payoutPaypalEmail}`} data={data} />}
      {data.company.kind === "owner" && <BillingEmailCard key={`billing-${data.company.billingEmail}`} data={data} />}
      {data.company.kind === "gc" && <DefaultsCard key={`defaults-${data.company.defaultRetainageBps}`} data={data} />}
      {data.company.kind === "sub" && <GcRelationshipsCard />}
      <MembersCard data={data} />
    </div>
  );
}

function ProfileCard({ data }: { data: Company }) {
  const update = useMutation(api.companies.updateProfile);
  const toast = useToast();
  const { company, isAdmin } = data;
  const [name, setName] = useState(company.name);
  const [legalName, setLegalName] = useState(company.legalName);
  const [phone, setPhone] = useState(company.phone);
  const [website, setWebsite] = useState(company.website);
  const [line1, setLine1] = useState(company.address?.line1 ?? "");
  const [line2, setLine2] = useState(company.address?.line2 ?? "");
  const [city, setCity] = useState(company.address?.city ?? "");
  const [state, setState] = useState(company.address?.state ?? "");
  const [zip, setZip] = useState(company.address?.zip ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!isAdmin) {
    const rows: [string, string][] = [
      ["Company name", company.name],
      ["Legal name", company.legalName || "—"],
      ["Phone", company.phone || "—"],
      ["Website", company.website || "—"],
      ["Address", company.address ? `${company.address.line1}, ${company.address.city}, ${company.address.state} ${company.address.zip}` : "—"],
    ];
    return (
      <Card title="Profile" description="Only company admins can change these settings.">
        <dl className="divide-y divide-line text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 py-2">
              <dt className="text-ink-subtle">{label}</dt>
              <dd className="text-right break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    );
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setErrors({});
    setFormError(null);
    setSaving(true);
    try {
      const hasAddress = [line1, line2, city, state, zip].some((x) => x.trim() !== "");
      await update({
        name,
        legalName,
        phone,
        website,
        ...(hasAddress || company.address ? { address: { line1, ...(line2.trim() ? { line2 } : {}), city, state, zip } } : {}),
      });
      toast.success("Company settings saved.");
    } catch (err) {
      const field = (err as { data?: { field?: string } }).data?.field;
      const message = getErrorMessage(err, "We couldn't save the settings. Try again.");
      if (field) setErrors({ [field]: message });
      else setFormError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Profile">
      <form onSubmit={onSubmit} noValidate aria-label="Company profile" className="space-y-4">
        <TextInput id="company-settings-name" label="Company name" required value={name} onChange={setName} error={errors.name} />
        <TextInput id="company-settings-legal" label="Legal name" value={legalName} onChange={setLegalName} error={errors.legalName} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput id="company-settings-phone" label="Phone" type="tel" value={phone} onChange={setPhone} error={errors.phone} placeholder="(510) 555-0187" />
          <TextInput
            id="company-settings-website"
            label="Website"
            type="url"
            value={website}
            onChange={setWebsite}
            error={errors.website}
            placeholder="https://example.com"
          />
        </div>
        <TextInput id="company-settings-line1" label="Street address" value={line1} onChange={setLine1} error={errors.line1} autoComplete="address-line1" />
        <TextInput id="company-settings-line2" label="Suite or unit" value={line2} onChange={setLine2} autoComplete="address-line2" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem_7rem]">
          <TextInput id="company-settings-city" label="City" value={city} onChange={setCity} error={errors.city} autoComplete="address-level2" />
          <Field id="company-settings-state" label="State" error={errors.state}>
            {(control) => (
              <select
                {...control}
                value={state}
                onChange={(e) => setState(e.target.value)}
                autoComplete="address-level1"
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
          <TextInput id="company-settings-zip" label="ZIP" value={zip} onChange={setZip} error={errors.zip} inputMode="numeric" autoComplete="postal-code" />
        </div>
        {formError && (
          <p role="alert" className="rounded-lg border border-rose-800 bg-rose-950 px-3 py-2 text-sm text-rose-200">
            {formError}
          </p>
        )}
        <Button type="submit" loading={saving} loadingLabel="Saving…">
          Save changes
        </Button>
      </form>
    </Card>
  );
}

function useEmailSetting(save: (email: string) => Promise<unknown>, initial: string | null, successMessage: string) {
  const toast = useToast();
  const [email, setEmail] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address, like name@company.com.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await save(email);
      toast.success(successMessage);
    } catch (err) {
      setError(getErrorMessage(err, "We couldn't save the email. Try again."));
    } finally {
      setSaving(false);
    }
  };
  return { email, setEmail: (next: string) => { setError(null); setEmail(next); }, error, saving, onSubmit };
}

function ReadOnlyEmail({ label, value }: { label: string; value: string | null }) {
  return (
    <p className="text-sm">
      {label}: <strong className="break-all">{value ?? "Not set"}</strong>
      <span className="mt-1 block text-ink-subtle">Only company admins can change this.</span>
    </p>
  );
}

/** Sub: the payout PayPal email. Each GC must confirm it before payouts go there. */
function PayoutEmailCard({ data }: { data: Company }) {
  const setPayoutEmail = useMutation(api.payee.setPayoutEmail);
  const status = useQuery(api.payee.myPayoutStatus, {});
  const current = data.company.payoutPaypalEmail ?? null;
  const form = useEmailSetting((email) => setPayoutEmail({ email }), current, "Payout email saved. Each GC must confirm it before paying you there.");
  const description =
    "Where GCs send your payouts. When you change it, each GC must confirm the new email before any payout goes there.";
  return (
    <Card
      title="Payout PayPal email"
      description={description}
      actions={
        current === null ? undefined : status?.overall === "confirmed" ? (
          <StatusPill status="payee_confirmed" />
        ) : status?.overall === "pending" ? (
          <StatusPill status="payee_awaiting_gc" />
        ) : undefined
      }
    >
      {data.isAdmin ? (
        <form onSubmit={(e) => void form.onSubmit(e)} noValidate aria-label="Payout PayPal email" className="space-y-4">
          <div className="max-w-md">
            <TextInput
              id="company-settings-payout-email"
              label="Payout PayPal email"
              type="email"
              value={form.email}
              onChange={form.setEmail}
              error={form.error ?? undefined}
              autoComplete="email"
              placeholder="payouts@yourcompany.com"
            />
          </div>
          <Button type="submit" loading={form.saving} loadingLabel="Saving…">
            Save payout email
          </Button>
        </form>
      ) : (
        <ReadOnlyEmail label="Payout PayPal email" value={current} />
      )}
      {status && status.relationships.length > 0 && current !== null && (
        <ul className="mt-4 divide-y divide-line text-sm" aria-label="Confirmation by GC">
          {status.relationships.map((r) => (
            <li key={r.gcCompanyId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{r.gcCompanyName}</span>
              {r.status === "confirmed" ? (
                <span className="text-ink-subtle">
                  Confirmed <DateText value={r.confirmedAt} />
                </span>
              ) : (
                <StatusPill status="payee_awaiting_gc" />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Owner: the billing email that change-order invoices for the company's projects go to. */
function BillingEmailCard({ data }: { data: Company }) {
  const setBillingEmail = useMutation(api.payee.setBillingEmail);
  const current = data.company.billingEmail ?? null;
  const form = useEmailSetting((email) => setBillingEmail({ email }), current, "Billing email saved.");
  return (
    <Card title="Billing email" description="Change-order invoices for your projects are sent here.">
      {data.isAdmin ? (
        <form onSubmit={(e) => void form.onSubmit(e)} noValidate aria-label="Billing email" className="space-y-4">
          <div className="max-w-md">
            <TextInput
              id="company-settings-billing-email"
              label="Billing email"
              type="email"
              value={form.email}
              onChange={form.setEmail}
              error={form.error ?? undefined}
              autoComplete="email"
              placeholder="ap@yourcompany.com"
            />
          </div>
          <Button type="submit" loading={form.saving} loadingLabel="Saving…">
            Save billing email
          </Button>
        </form>
      ) : (
        <ReadOnlyEmail label="Billing email" value={current} />
      )}
    </Card>
  );
}

function DefaultsCard({ data }: { data: Company }) {
  const update = useMutation(api.companies.updateDefaults);
  const toast = useToast();
  const { company, isAdmin } = data;
  const [bps, setBps] = useState<number | null>(company.defaultRetainageBps);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const description =
    "New projects start with this retainage, lowered automatically to the state's cap where one applies.";

  if (!isAdmin) {
    return (
      <Card title="Defaults" description={description}>
        <p className="text-sm">
          Default retainage: <strong>{formatRetainagePercent(company.defaultRetainageBps)}</strong>
        </p>
        <p className="mt-1 text-sm text-ink-subtle">Only company admins can change this.</p>
      </Card>
    );
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    if (bps === null) {
      setError("Enter a default retainage between 0% and 100%.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await update({ defaultRetainageBps: bps });
      toast.success("Defaults saved.");
    } catch (err) {
      setError(getErrorMessage(err, "We couldn't save the defaults. Try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Defaults" description={description}>
      <form onSubmit={onSubmit} noValidate aria-label="Company defaults" className="space-y-4">
        <div className="max-w-xs">
          <PercentInput
            id="company-settings-default-retainage"
            label="Default retainage %"
            required
            value={bps}
            onChange={(next) => {
              setError(null);
              setBps(next);
            }}
            error={error ?? undefined}
          />
        </div>
        <Button type="submit" loading={saving} loadingLabel="Saving…">
          Save defaults
        </Button>
      </form>
    </Card>
  );
}

function MembersCard({ data }: { data: Company }) {
  const setRole = useMutation(api.companies.setMemberRole);
  const remove = useMutation(api.companies.removeMember);
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<{ membershipId: string; name: string; isYou: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const canInvite = data.isAdmin;

  const changeRole = async (membershipId: string, name: string, role: "admin" | "member") => {
    setBusyId(membershipId);
    try {
      await setRole({ membershipId, role });
      toast.success(`${name} is now ${role === "admin" ? "an Admin" : "a Member"}.`);
    } catch (err) {
      toast.error(err, "We couldn't change the role.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card
      title="Members"
      actions={
        canInvite ? (
          <Button size="sm" onClick={() => setInviting(true)}>
            Invite teammate
          </Button>
        ) : undefined
      }
    >
      <ul className="divide-y divide-line text-sm" aria-label="Company members">
        {data.members.map((m) => (
          <li key={m.membershipId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0">
              <span className="font-medium">{m.name}</span>
              {m.isYou ? <span className="text-ink-subtle"> (you)</span> : null}
              {m.email ? <span className="block text-xs text-ink-subtle break-all">{m.email}</span> : null}
            </span>
            {data.isAdmin ? (
              <span className="flex items-center gap-2">
                <select
                  aria-label={`Role for ${m.name}`}
                  value={m.role}
                  disabled={busyId === m.membershipId}
                  onChange={(e) => void changeRole(m.membershipId, m.name, e.target.value as "admin" | "member")}
                  className={inputClass(false, "min-h-9 w-auto")}
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                </select>
                <Button size="sm" variant="ghost" onClick={() => setRemoving({ membershipId: m.membershipId, name: m.name, isYou: m.isYou })}>
                  Remove
                </Button>
              </span>
            ) : (
              <span className="text-xs text-ink-muted">{m.role === "admin" ? "Admin" : "Member"}</span>
            )}
          </li>
        ))}
      </ul>
      {canInvite && (
        <div className="mt-4 space-y-2">
          <h3 className="text-sm font-semibold">Teammate invites</h3>
          <InviteList invites={data.teammateInvites} showKind={false} emptyText="No teammate invites yet." />
        </div>
      )}
      {inviting && <InviteDialog mode={{ type: "create", kind: "teammate" }} onClose={() => setInviting(false)} />}
      <ConfirmDialog
        open={removing !== null}
        title={removing?.isYou ? "Remove yourself from the company?" : `Remove ${removing?.name ?? ""} from ${data.company.name}?`}
        effect={
          removing?.isYou
            ? "You lose access to all of the company's projects right away."
            : `${removing?.name ?? "They"} lose access to all of ${data.company.name}'s projects on their next request.`
        }
        confirmLabel="Remove"
        tone="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await remove({ membershipId: removing.membershipId });
          toast.success(`${removing.name} was removed.`);
          setRemoving(null);
        }}
      />
    </Card>
  );
}
