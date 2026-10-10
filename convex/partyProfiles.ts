import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { requireProjectScope } from "./lib/projectScope";
import { payeeState } from "./lib/payee";
import { notFound, requireCompanyMember } from "./lib/tenancy";
import { liveVendorByRawId } from "./lib/vendorRead";
import { invoiceRecipientForProject } from "./payments/changeOrderRecipient";

/**
 * What a GC sees of the other parties' companies: a vendor's linked sub company profile and payee
 * state, and a project's owner company with its billing email. Those companies edit their own
 * profiles; these reads never write.
 */

function profileOf(company: Doc<"companies">) {
  return {
    _id: company._id,
    name: company.name,
    legalName: company.legalName ?? null,
    phone: company.phone ?? null,
    website: company.website ?? null,
    address: company.address ?? null,
  };
}

/** One vendor of the caller's GC directory with its company account and payee state. */
export const getVendor = query({
  args: { vendorId: v.string() },
  handler: async (ctx, args) => {
    const { user, company } = await requireCompanyMember(ctx);
    const vendor = await liveVendorByRawId(ctx, args.vendorId);
    if (vendor === null || vendor.companyId !== company._id || company.kind !== "gc" || user.actorType === "agent") throw notFound();
    const linked = vendor.linkedCompanyId ? await ctx.db.get(vendor.linkedCompanyId) : null;
    const payee = payeeState(vendor, linked);
    const confirmer = payee.confirmedByUserId ? await ctx.db.get(payee.confirmedByUserId) : null;
    return {
      _id: vendor._id,
      name: vendor.name,
      trades: vendor.trades,
      contactName: vendor.contactName,
      email: vendor.email,
      phone: vendor.phone ?? null,
      licenseNumber: vendor.licenseNumber ?? null,
      licenseState: vendor.licenseState ?? null,
      status: vendor.status,
      linkedCompany: linked === null ? null : profileOf(linked),
      payee: {
        status: payee.status,
        currentEmail: payee.currentEmail,
        confirmedEmail: payee.confirmedEmail,
        confirmedAt: payee.confirmedAt,
        confirmedByName: confirmer === null ? null : confirmer.name?.trim() || confirmer.email || "A team member",
      },
    };
  },
});

/** The project's owner company as the GC sees it: profile, billing email and whether invoicing works. */
export const getProjectOwner = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const { project } = await requireProjectScope(ctx, args.projectId, { roles: ["gc"] });
    const recipient = await invoiceRecipientForProject(ctx, project._id);
    const ownerCompany = project.ownerCompanyId ? await ctx.db.get(project.ownerCompanyId) : null;
    const company = recipient.ok ? await ctx.db.get(recipient.ownerCompanyId) : ownerCompany;
    return {
      ownerName: project.ownerName ?? null,
      company: company === null ? null : { ...profileOf(company), billingEmail: company.billingEmail ?? null },
      invoicing: recipient.ok ? { enabled: true as const, reason: null } : { enabled: false as const, reason: recipient.reason },
    };
  },
});
