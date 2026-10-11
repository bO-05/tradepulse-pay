import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { formatRetainagePercent } from "../../../convex/lib/retainageRules";
import { GC_PROJECTS_HASH, gcProjectSettingsHash, peopleHash } from "../../auth/navigation";
import { Button, Card, DateText, Money, PageHeader, StatusPill, useToast } from "../../ui";
import { ownerDetailRows } from "./ownerDetails";
import { openProcurementPackages } from "./specBreakdownRequest";
import { TradePackagesSection } from "./TradePackagesSection";

const secondaryLink =
  "inline-flex min-h-touch items-center rounded-lg border border-line-strong px-4 text-sm font-semibold text-ink hover:bg-surface-raised";

export function ProjectPage({ projectId }: { projectId: string }) {
  const project = useQuery(api.projects.getProject, { projectId });
  if (project === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading project…</p>;
  const archived = project.archived === true;
  return (
    <div className="max-w-5xl space-y-5">
      <ProjectHeader
        project={project}
        actions={
          <>
            <a href={gcProjectSettingsHash(project._id)} className={secondaryLink}>
              Project settings
            </a>
            <a href={peopleHash(project._id)} className={secondaryLink}>
              People
            </a>
            {!archived && (
              <button type="button" className={secondaryLink} onClick={() => openProcurementPackages(project._id)}>
                Open in Procurement
              </button>
            )}
          </>
        }
      />
      {archived && <ArchivedBanner projectId={project._id} />}
      <ProjectDetailsCard project={project} />
      <OwnerCompanyCard projectId={project._id} />
      <TradePackagesSection projectId={project._id} projectTitle={project.title} readOnly={archived} />
    </div>
  );
}

export function ProjectHeader({ project, actions }: { project: Doc<"projects">; actions?: React.ReactNode }) {
  const archived = project.archived === true;
  return (
    <PageHeader
      title={project.title}
      back={{ href: GC_PROJECTS_HASH, label: "All projects" }}
      description={[project.ownerName, project.location].filter(Boolean).join(" · ") || undefined}
      actions={actions}
      meta={
        <>
          <StatusPill status={archived ? "archived" : (project.status ?? "active")} />
          <span>
            Contract value: {project.contractValueCents !== undefined ? <Money cents={project.contractValueCents} /> : "—"}
          </span>
          <span>Retainage: {project.retainageBps !== undefined ? formatRetainagePercent(project.retainageBps) : "—"}</span>
          <span>Billing day: {project.billingDay ?? "—"}</span>
        </>
      }
    />
  );
}

export function ArchivedBanner({ projectId }: { projectId: Id<"projects"> }) {
  const restore = useMutation(api.projects.restoreProject);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-700 bg-amber-950/50 px-4 py-3 text-sm text-amber-100">
      <span>This project is archived. It is read-only and hidden from project lists until you restore it.</span>
      <Button
        size="sm"
        loading={busy}
        loadingLabel="Restoring…"
        onClick={async () => {
          setBusy(true);
          try {
            await restore({ projectId });
            toast.success("Project restored.");
          } catch (err) {
            toast.error(err, "We couldn't restore the project.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Restore
      </Button>
    </div>
  );
}

function ProjectDetailsCard({ project }: { project: Doc<"projects"> }) {
  const a = project.address;
  const rows: [string, React.ReactNode][] = [
    ["Owner", project.ownerName || "—"],
    ["Address", a ? `${a.line1}, ${a.city}, ${a.state} ${a.zip}` : project.location || "—"],
    ["State", project.state ?? "—"],
    ["Contract value", project.contractValueCents !== undefined ? <Money cents={project.contractValueCents} /> : "—"],
    ["Retainage", project.retainageBps !== undefined ? formatRetainagePercent(project.retainageBps) : "—"],
    ["Billing day", project.billingDay !== undefined ? `Day ${project.billingDay} of each month` : "—"],
    ["Start date", <DateText value={project.startDate} />],
    ["Substantial completion", <DateText value={project.substantialCompletionDate} />],
  ];
  return (
    <Card title="Project details">
      <dl className="grid gap-x-6 text-sm sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b border-line py-2">
            <dt className="text-ink-subtle">{label}</dt>
            <dd className="text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** The project's owner company (maintained by the owner's admins) and whether change-order invoices can go out. */
function OwnerCompanyCard({ projectId }: { projectId: Id<"projects"> }) {
  const owner = useQuery(api.partyProfiles.getProjectOwner, { projectId });
  if (owner === undefined) return null;
  const { company, invoicing } = owner;
  return (
    <Card
      title="Owner company"
      description={company ? `Maintained by ${company.name}. Only its admins can change it.` : undefined}
      actions={<StatusPill status={invoicing.enabled ? "active" : "invoicing_disabled"} tone={invoicing.enabled ? "success" : "warning"} label={invoicing.enabled ? "Invoicing ready" : "Invoicing disabled"} />}
    >
      {company ? (
        <dl className="grid gap-x-6 text-sm sm:grid-cols-2">
          {ownerDetailRows(company).map((row) => (
            <div key={row.label} className="flex justify-between gap-4 border-b border-line py-2">
              <dt className="text-ink-subtle">{row.label}</dt>
              <dd className={`break-words text-right${row.value === "Not set" ? " text-ink-muted" : ""}`} data-testid={row.testId}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-ink-muted">No owner company has joined this project yet.</p>
      )}
      {!invoicing.enabled && invoicing.reason && (
        <p role="note" className="mt-3 text-sm text-amber-200">
          {invoicing.reason}
        </p>
      )}
    </Card>
  );
}
