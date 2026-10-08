import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export const NO_PROJECT_OWNER_REASON =
  "No owner has joined this project yet, so change orders cannot be invoiced. Invite the project owner first.";
export const NO_OWNER_EMAIL_REASON =
  "The project owner has no billing email on file, so change orders cannot be invoiced yet.";

export type InvoiceRecipient =
  | { ok: true; email: string; ownerCompanyId: Id<"companies">; ownerCompanyName: string }
  | { ok: false; reason: string };

function clean(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function ownerCompanyEmail(ctx: QueryCtx, company: Doc<"companies">, isDemoProject: boolean): Promise<string | undefined> {
  const billing = clean(company.billingEmail);
  if (billing) return billing;
  const members = await ctx.db
    .query("companyMembers")
    .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
    .take(50);
  const active = members.filter((m) => m.status === "active");
  for (const m of active) {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", m.userId))
      .unique();
    const paypal = clean(profile?.paypalEmail);
    if (paypal) return paypal;
  }
  // Demo owner accounts use made-up addresses, so Demo projects bill the PayPal sandbox owner account.
  if (isDemoProject) {
    const sandbox = clean(process.env.PAYPAL_SANDBOX_OWNER_EMAIL);
    if (sandbox) return sandbox;
  }
  const admin = active.find((m) => m.role === "admin") ?? active[0];
  const user = admin ? await ctx.db.get(admin.userId) : null;
  return clean(user?.email);
}

/**
 * The change-order invoice recipient for one project: the owner company that is an active member
 * of THAT project (its billing email, else a member's PayPal or sign-in email). Never an owner of
 * another project. With no owner on the project, invoicing is disabled with the reason.
 */
export async function invoiceRecipientForProject(ctx: QueryCtx, projectId: Id<"projects">): Promise<InvoiceRecipient> {
  const project = await ctx.db.get(projectId);
  if (project === null) return { ok: false, reason: NO_PROJECT_OWNER_REASON };
  const gc = project.gcCompanyId ? await ctx.db.get(project.gcCompanyId) : null;
  const isDemoProject = gc?.isDemo === true;
  const members = await ctx.db
    .query("projectMembers")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .take(200);
  const owners = members.filter((m) => m.partyRole === "owner" && m.status === "active");
  if (owners.length === 0) return { ok: false, reason: NO_PROJECT_OWNER_REASON };
  for (const m of owners) {
    const company = await ctx.db.get(m.companyId);
    if (company === null) continue;
    const email = await ownerCompanyEmail(ctx, company, isDemoProject);
    if (email) return { ok: true, email, ownerCompanyId: company._id, ownerCompanyName: company.name };
  }
  return { ok: false, reason: NO_OWNER_EMAIL_REASON };
}
