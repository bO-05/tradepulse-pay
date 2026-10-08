import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FormEvent, useState } from "react";
import { api } from "../../convex/_generated/api";
import { COMPANY_KIND_LABEL } from "../../convex/lib/inviteRules";
import { getErrorMessage } from "../lib/errors";
import { InviteDialog } from "../people/InviteDialog";
import { InviteList } from "../people/InviteList";
import { Button, Card, ConfirmDialog, PageHeader, TextInput, useToast } from "../ui";
import { inputClass } from "../ui/Field";

type Company = FunctionReturnType<typeof api.companies.myCompany>;

/** Company settings (user menu): profile and members. Only admins can change anything. */
export function CompanySettingsPage() {
  const data = useQuery(api.companies.myCompany, {});
  if (data === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading company…</p>;
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="Company settings"
        description={`${data.company.name} · ${COMPANY_KIND_LABEL[data.company.kind]}`}
      />
      <ProfileCard key={`${data.company._id}-${data.company.name}-${data.company.phone}-${data.company.website}`} data={data} />
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
      await update({ name, legalName, phone, website });
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
        {company.address && (
          <p className="text-sm text-ink-subtle">
            Address: {company.address.line1}, {company.address.city}, {company.address.state} {company.address.zip}
          </p>
        )}
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

function MembersCard({ data }: { data: Company }) {
  const setRole = useMutation(api.companies.setMemberRole);
  const remove = useMutation(api.companies.removeMember);
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<{ membershipId: string; name: string; isYou: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const canInvite = data.isAdmin && data.company.kind === "gc";

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
