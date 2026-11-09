import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { NEW_PROJECT_HASH, QUICK_START_HASH, gcProjectHash } from "../../auth/navigation";
import { EmptyState, Money, PageHeader, StatusPill } from "../../ui";
import { demoProjectName } from "../../lib/demoCopy";

const linkButton =
  "inline-flex min-h-touch items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const secondaryLink =
  "inline-flex min-h-touch items-center rounded-lg border border-line-strong px-4 text-sm font-semibold text-ink hover:bg-surface-raised";

/** GC Projects list: active projects by default, archived ones behind "Show archived". */
export function ProjectsListPage() {
  const [showArchived, setShowArchived] = useState(false);
  const projects = useQuery(api.projects.listProjects, showArchived ? { includeArchived: true } : {});
  const newProject = (
    <span className="flex flex-wrap gap-2">
      <a href={QUICK_START_HASH} className={linkButton}>
        Quick start
      </a>
      <a href={NEW_PROJECT_HASH} className={secondaryLink}>
        New project
      </a>
    </span>
  );

  return (
    <div className="max-w-5xl">
      <PageHeader title="Projects" description="Your company's projects. Archived projects are hidden unless you show them." actions={newProject} />
      <p className="mb-4 max-w-2xl text-sm text-ink-subtle">
        <strong className="text-ink">Quick start</strong> creates one job, one sub, an approved schedule of values and an invite in a single pass. Use <strong className="text-ink">New project</strong> for a multi-trade setup.
      </p>
      <label className="mb-4 inline-flex items-center gap-2 text-sm text-ink-muted">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="h-4 w-4" />
        Show archived
      </label>
      {projects === undefined ? (
        <p role="status" className="text-sm text-ink-subtle">
          Loading projects…
        </p>
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Start with one job, one sub and an approved schedule of values. You can add more trades later."
          action={
            <span className="flex flex-wrap gap-2">
              <a href={QUICK_START_HASH} className={linkButton}>
                Quick start
              </a>
              <a href={NEW_PROJECT_HASH} className={secondaryLink}>
                Open the full new project setup
              </a>
            </span>
          }
        />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Projects">
          {projects.map((p) => {
            const archived = p.archived === true;
            return (
              <li key={p._id}>
                <a href={gcProjectHash(p._id)} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-raised">
                  <span className="min-w-0">
                    <span className="block font-semibold text-ink">{demoProjectName(p.title)}</span>
                    <span className="block text-sm text-ink-subtle">
                      {[p.ownerName, p.location].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="flex items-center gap-3 text-sm">
                    {p.contractValueCents !== undefined && <Money cents={p.contractValueCents} />}
                    <StatusPill status={archived ? "archived" : (p.status ?? "active")} />
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
