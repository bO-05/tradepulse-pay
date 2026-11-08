import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * The residential/commercial discriminator (architecture §3.1). It is the only switch for
 * vocabulary: no title matching, no `projectType` parsing.
 *
 * The field is optional because every project that predates it is commercial. Absent must read
 * as commercial everywhere — never as residential, and never as an error — so the default lives
 * in this one helper instead of being repeated (and eventually diverging) in each view model.
 */
export const projectKindValidator = v.union(v.literal("residential"), v.literal("commercial"));

export type ProjectKind = "residential" | "commercial";

/** Absent means commercial: the project model predates the residential vocabulary. */
export const DEFAULT_PROJECT_KIND: ProjectKind = "commercial";

export function projectKindOf(project: { projectKind?: ProjectKind } | null | undefined): ProjectKind {
  return project?.projectKind ?? DEFAULT_PROJECT_KIND;
}

/** The kind of a project by id. A missing project also reads commercial so a view never throws. */
export async function projectKindById(ctx: QueryCtx, projectId: Id<"projects">): Promise<ProjectKind> {
  return projectKindOf(await ctx.db.get(projectId));
}
