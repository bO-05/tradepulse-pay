import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { COMPANY_KIND_LABEL, tradeName } from "../../convex/lib/inviteRules";
import { peopleHash } from "../auth/navigation";
import { Button, Card, ConfirmDialog, EmptyState, PageHeader, useToast } from "../ui";
import { inputClass } from "../ui/Field";
import { InviteDialog, type InviteDialogMode } from "./InviteDialog";
import { InviteList } from "./InviteList";

/** GC People screen: pick a project, then see its companies, members and invites. */
export function PeoplePage({ projectId }: { projectId?: string }) {
  const projects = useQuery(api.people.myProjects, {});
  if (projects === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading projects…</p>;
  const selected = projectId ? projects.find((p) => p._id === projectId) : undefined;

  if (!projectId) {
    return (
      <div className="max-w-4xl">
        <PageHeader title="People" description="Choose a project to see who is on it and to invite subcontractors or the owner." />
        {projects.length === 0 ? (
          <EmptyState title="No projects yet" description="Create a project in Procurement, then invite people to it here." />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <li key={p._id}>
                <a href={peopleHash(p._id)} className="block rounded-xl border border-line bg-surface p-4 hover:border-emerald-700">
                  <span className="font-semibold">{p.title}</span>
                  <span className="block text-sm text-ink-subtle">{p.location}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (selected === undefined) {
    return (
      <div className="max-w-4xl">
        <PageHeader title="Not found" back={{ href: "#/people", label: "All projects" }} />
        <p className="text-sm text-ink-subtle">This project doesn't exist or you don't have access to it.</p>
      </div>
    );
  }
  return <ProjectPeople key={selected._id} projectId={selected._id} projects={projects} />;
}

function ProjectPeople({ projectId, projects }: { projectId: string; projects: { _id: string; title: string }[] }) {
  const data = useQuery(api.people.listForProject, { projectId });
  const removeMember = useMutation(api.people.removeProjectMember);
  const toast = useToast();
  const [dialog, setDialog] = useState<InviteDialogMode | null>(null);
  const [removing, setRemoving] = useState<{ companyId: string; name: string } | null>(null);

  if (data === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading people…</p>;

  const kindLabel = (c: (typeof data.companies)[number]) => {
    const base = COMPANY_KIND_LABEL[c.partyRole === "gc" ? "gc" : c.partyRole === "owner" ? "owner" : "sub"];
    return c.partyRole === "sub" && c.trades.length > 0 ? `${base} · ${c.trades.map(tradeName).join(", ")}` : base;
  };

  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title="People"
        back={{ href: "#/people", label: "All projects" }}
        meta={
          <label className="flex items-center gap-2">
            <span className="text-ink-subtle">Project</span>
            <select
              aria-label="Project"
              value={projectId}
              onChange={(e) => (window.location.hash = peopleHash(e.target.value))}
              className={inputClass(false, "min-h-9 w-auto")}
            >
              {projects.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        }
        actions={
          <>
            <Button onClick={() => setDialog({ type: "create", kind: "sub", projectId, projectTitle: data.project.title })}>
              Invite subcontractor
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                setDialog({ type: "create", kind: "owner", projectId, projectTitle: data.project.title, ownerName: data.project.ownerName })
              }
            >
              Invite owner
            </Button>
          </>
        }
      />

      {data.companies.map((c) => (
        <Card
          key={c.companyId}
          title={c.name}
          description={kindLabel(c)}
          actions={
            c.partyRole !== "gc" ? (
              <Button size="sm" variant="ghost" onClick={() => setRemoving({ companyId: c.companyId, name: c.name })}>
                Remove from project
              </Button>
            ) : undefined
          }
        >
          {c.members.length === 0 ? (
            <p className="text-sm text-ink-subtle">No active members.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {c.members.map((m) => (
                <li key={m.membershipId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium">{m.name}</span>
                    {m.email ? <span className="text-ink-subtle"> · {m.email}</span> : null}
                  </span>
                  <span className="text-xs text-ink-muted">{m.role === "admin" ? "Admin" : "Member"}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}

      <Card title="Invites" description="Subcontractor and owner invites for this project.">
        <InviteList invites={data.invites} emptyText="No invites for this project yet." />
      </Card>

      <Card
        title="Teammate invites"
        description={
          data.canManageTeammateInvites
            ? "People invited to join your company. They get access to all of its projects."
            : "People invited to join your company. Only company admins can resend or revoke these."
        }
        actions={
          data.canManageTeammateInvites ? (
            <Button size="sm" variant="secondary" onClick={() => setDialog({ type: "create", kind: "teammate" })}>
              Invite teammate
            </Button>
          ) : undefined
        }
      >
        <InviteList
          invites={data.teammateInvites}
          showKind={false}
          readOnly={!data.canManageTeammateInvites}
          emptyText="No teammate invites yet."
        />
      </Card>

      {dialog && <InviteDialog mode={dialog} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? ""} from ${data.project.title}?`}
        effect="Their people lose access to this project on their next request. Agreements and pay history stay on the project."
        confirmLabel="Remove from project"
        tone="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await removeMember({ projectId, companyId: removing.companyId });
          toast.success(`${removing.name} was removed from the project.`);
          setRemoving(null);
        }}
      />
    </div>
  );
}
