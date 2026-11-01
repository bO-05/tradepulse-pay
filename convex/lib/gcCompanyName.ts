import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { DEFAULT_GENERAL_CONTRACTOR } from "../validation";
import { PRODUCT_NAME } from "./llmsTxt";
const GENERIC_GC = "the general contractor";

/** The identity line AI prompts open with: the product and the GC company it acts for. */
export function workingOnBehalfOf(gcCompanyName: string | null | undefined): string {
  const name = gcCompanyName?.trim();
  return `${PRODUCT_NAME}, working on behalf of ${name || GENERIC_GC}`;
}

/** Name of the company that owns the project (projects.gcCompanyId), or null. */
export async function projectGcCompanyName(ctx: Pick<QueryCtx, "db">, project: Doc<"projects">): Promise<string | null> {
  if (!project.gcCompanyId) return null;
  const company = await ctx.db.get(project.gcCompanyId);
  return company?.name.trim() || null;
}

/**
 * The general contractor named in generated documents: the project's own GC name, else the owning
 * company's name. The seeded Demo name is only a fallback for Demo-company or legacy unowned projects.
 */
export async function generalContractorNameFor(ctx: Pick<QueryCtx, "db">, project: Doc<"projects">): Promise<string> {
  const explicit = project.generalContractorName?.trim();
  if (explicit) return explicit;
  if (!project.gcCompanyId) return DEFAULT_GENERAL_CONTRACTOR;
  const company = await ctx.db.get(project.gcCompanyId);
  if (!company || company.isDemo) return DEFAULT_GENERAL_CONTRACTOR;
  return company.name.trim() || DEFAULT_GENERAL_CONTRACTOR;
}
