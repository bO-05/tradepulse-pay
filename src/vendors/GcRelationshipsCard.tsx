import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { myProjectHash } from "../auth/navigation";
import { Card, EmptyState, StatusPill } from "../ui";

/** Sub company: the general contractors that list it in their vendor directory, and its projects with each. */
export function GcRelationshipsCard() {
  const relationships = useQuery(api.vendors.myGcRelationships, {});
  return (
    <Card title="GC relationships" description="General contractors that list your company in their vendor directory.">
      {relationships === undefined ? (
        <p role="status" className="text-sm text-ink-subtle">
          Loading…
        </p>
      ) : relationships.length === 0 ? (
        <EmptyState headingLevel={3} title="No GC relationships yet" description="When a general contractor invites you to a project, it appears here." />
      ) : (
        <ul className="divide-y divide-line text-sm" data-testid="gc-relationships">
          {relationships.map((r) => (
            <li key={r.vendorId} className="space-y-1 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{r.gcCompanyName}</span>
                <StatusPill status={r.status} />
              </div>
              <p className="text-ink-subtle">
                Listed as {r.listedAs}
                {r.trades.length > 0 ? ` · ${r.trades.join(", ")}` : ""}
              </p>
              {r.projects.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {r.projects.map((p) => (
                    <li key={p.projectId}>
                      <a href={myProjectHash(p.projectId)} className="text-emerald-300 underline-offset-2 hover:underline">
                        {p.title}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-subtle">No active projects.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
