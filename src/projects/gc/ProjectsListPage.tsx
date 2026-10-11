import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import { NEW_PROJECT_HASH, gcProjectHash } from "../../auth/navigation";
import { EmptyState, Money, PageHeader, StatusPill } from "../../ui";

const linkButton =
  "inline-flex min-h-touch items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-fg hover:bg-accent-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

/** GC Projects list: active projects by default, archived ones behind "Show archived". */
export function ProjectsListPage() {
  const [showArchived, setShowArchived] = useState(false);
  const projects = useQuery(api.projects.listProjects, showArchived ? { includeArchived: true } : {});
  const newProject = (
    <a href={NEW_PROJECT_HASH} className={linkButton}>
      New project
    </a>
  );

  return (
    <div className="max-w-5xl">
      <PageHeader title="Projects" description="Your company's projects. Archived projects are hidden unless you show them." actions={newProject} />
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
          description="Create your first project to set up trade packages, invite bidders and manage contracts."
          action={
            <a href={NEW_PROJECT_HASH} className={linkButton}>
              Create your first project
            </a>
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
                    <span className="block font-semibold text-ink">{p.title}</span>
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
