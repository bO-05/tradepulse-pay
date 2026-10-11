import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export const NO_PROJECT_OWNER_REASON = "No owner on this project – invite the owner to enable invoicing";
export function noOwnerEmailReason(ownerCompanyName: string): string {
  return `Invoicing is disabled: ${ownerCompanyName} has no billing email. An admin of ${ownerCompanyName} must set one in Company settings before invoicing.`;
}

export type InvoiceRecipient =
  | { ok: true; email: string; ownerCompanyId: Id<"companies">; ownerCompanyName: string }
  | { ok: false; reason: string };

/**
 * The invoice recipient for one project (architecture §14): the billing email of THAT project's owner
 * company (`projects.ownerCompanyId`, which must still be an active owner member). Never another
 * project's owner, a member's sign-in email or an environment fallback. Without one, invoicing is
 * disabled with the reason.
 */
export async function invoiceRecipientForProject(ctx: QueryCtx, projectId: Id<"projects">): Promise<InvoiceRecipient> {
  const project = await ctx.db.get(projectId);
  if (project === null) return { ok: false, reason: NO_PROJECT_OWNER_REASON };
  const members = await ctx.db
    .query("projectMembers")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .take(200);
  const owners = members.filter((m) => m.partyRole === "owner" && m.status === "active");
  const owner =
    owners.find((m) => project.ownerCompanyId !== undefined && m.companyId === project.ownerCompanyId) ??
    (project.ownerCompanyId === undefined ? owners[0] : undefined);
  const company = owner ? await ctx.db.get(owner.companyId) : null;
  if (company === null) return { ok: false, reason: NO_PROJECT_OWNER_REASON };
  const email = company.billingEmail?.trim();
  if (!email) return { ok: false, reason: noOwnerEmailReason(company.name) };
  return { ok: true, email, ownerCompanyId: company._id, ownerCompanyName: company.name };
}
