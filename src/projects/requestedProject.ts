export type RequestedProjectOutcome =
  | { kind: "loading" }
  /** The URL asked for a project this account cannot see (another company's, deleted, or not a project id). */
  | { kind: "not-found" }
  /** The URL's project is in the list; it no longer needs special handling. */
  | { kind: "confirmed" }
  | { kind: "keep" }
  /** A remembered (not URL-supplied) selection is stale; quietly pick another project. */
  | { kind: "fallback"; projectId: string };

/**
 * Decides what the procurement workspace shows for its project selection. A project id that came
 * from the URL is never silently swapped for another project: foreign and missing ids both resolve
 * to "not-found", so the two are indistinguishable.
 */
export function resolveRequestedProject(args: {
  requestedId: string | null;
  selectedId: string;
  projects: readonly { _id: string; isDemoProject?: boolean }[] | undefined;
}): RequestedProjectOutcome {
  const { requestedId, selectedId, projects } = args;
  if (projects === undefined) return { kind: "loading" };
  const has = (id: string) => projects.some((project) => project._id === id);
  if (requestedId) return has(requestedId) ? { kind: "confirmed" } : { kind: "not-found" };
  if (has(selectedId)) return { kind: "keep" };
  const preferred = projects.find((project) => project.isDemoProject) ?? projects[0];
  return { kind: "fallback", projectId: preferred?._id ?? "" };
}
