import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { agreementHash, myProjectHash } from "../auth/navigation";
import { formatDollars } from "../payments/format";
import { Card, EmptyState, PageHeader, StatusPill } from "../ui";

/** Project switcher for subs and owners: each project is labeled with its general contractor. */
export function MyProjectsPage({ projectId }: { projectId?: string }) {
  const projects = useQuery(api.people.myProjects, {});
  if (projectId) return <ProjectView projectId={projectId} projects={projects ?? []} />;
  if (projects === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading projects…</p>;
  return (
    <div className="max-w-4xl">
      <PageHeader title="Projects" description="Projects you were invited to, with the general contractor for each." />
      {projects.length === 0 ? (
        <EmptyState title="No projects" description="When a general contractor invites your company to a project, it appears here." />
      ) : (
        <ProjectList projects={projects} />
      )}
    </div>
  );
}

type ProjectSummary = { _id: string; title: string; location: string; gcCompanyName: string | null };

function ProjectList({ projects, current }: { projects: ProjectSummary[]; current?: string }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2" aria-label="Your projects" data-testid="project-switcher">
      {projects.map((p) => (
        <li key={p._id}>
          <a
            href={myProjectHash(p._id)}
            aria-current={p._id === current ? "page" : undefined}
            className={`block rounded-xl border bg-surface p-4 hover:border-emerald-700 ${p._id === current ? "border-emerald-700" : "border-line"}`}
          >
            <span className="font-semibold">{p.title}</span>
            <span className="block text-sm text-ink-subtle">
              {p.gcCompanyName ? `GC: ${p.gcCompanyName}` : "General contractor not set"}
              {p.location ? ` · ${p.location}` : ""}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function ProjectView({ projectId, projects }: { projectId: string; projects: ProjectSummary[] }) {
  const project = useQuery(api.people.projectOverview, { projectId });
  if (project === undefined) return <p role="status" className="text-sm text-ink-subtle">Loading project…</p>;
  if (project === null) {
    return (
      <div className="max-w-4xl space-y-5">
        <PageHeader title="You no longer have access" back={{ href: "#/my-projects", label: "All projects" }} />
        <p role="alert" className="text-sm text-ink-subtle">
          Not found. This project doesn't exist or your company no longer has access to it.
        </p>
        {projects.length > 0 && <ProjectList projects={projects} />}
      </div>
    );
  }
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader
        title={project.title}
        back={{ href: "#/my-projects", label: "All projects" }}
        meta={<span>{project.gcCompanyName ? `General contractor: ${project.gcCompanyName}` : null}{project.location ? ` · ${project.location}` : ""}</span>}
      />
      <Card title="Agreements">
        {project.agreements.length === 0 ? (
          <p className="text-sm text-ink-subtle">No agreements on this project yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {project.agreements.map((a) => (
              <li key={a._id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <a href={agreementHash(a._id)} className="font-medium text-emerald-300 hover:underline">
                  {a.agreementNumber} · {a.subcontractorName} · {a.tradeName}
                </a>
                <span className="flex items-center gap-3">
                  <span className="tabular-nums">{formatDollars(a.contractSum)}</span>
                  <StatusPill status={a.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="People">
        <div className="grid gap-4 sm:grid-cols-2 text-sm">
          <div>
            <h3 className="font-semibold">{project.gcCompanyName ?? "General contractor"}</h3>
            <ul className="mt-1 space-y-1">
              {project.gcContacts.map((m) => (
                <li key={`${m.name}-${m.email}`}>
                  {m.name}
                  {m.email ? <span className="text-ink-subtle"> · {m.email}</span> : null}
                </li>
              ))}
            </ul>
          </div>
          {project.yourCompanyName && (
            <div>
              <h3 className="font-semibold">{project.yourCompanyName} (your company)</h3>
              <ul className="mt-1 space-y-1">
                {project.yourTeam.map((m) => (
                  <li key={`${m.name}-${m.email}`}>
                    {m.name} <span className="text-ink-subtle">· {m.role === "admin" ? "Admin" : "Member"}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>
      {projects.length > 0 && (
        <section aria-labelledby="other-projects">
          <h2 id="other-projects" className="mb-2 text-base font-semibold">
            Your projects
          </h2>
          <ProjectList projects={projects} current={projectId} />
        </section>
      )}
    </div>
  );
}
