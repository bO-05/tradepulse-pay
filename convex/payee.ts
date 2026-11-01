import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { INVALID_EMAIL_MESSAGE, normalizeInviteEmail } from "./lib/inviteRules";
import { notify } from "./lib/notify";
import { clearPayeeConfirmations, payeeState } from "./lib/payee";
import { notFound, requireCompanyMember, requireVerifiedUser } from "./lib/tenancy";
import { liveVendorByRawId } from "./lib/vendorRead";

/**
 * Payee control and owner billing email (architecture §14). Each company's payment addresses are set
 * by its own admins only; a sub's payout email takes effect for a GC only after a member of that GC
 * confirms it on the vendor page.
 */

function invalid(message: string, field: string) {
  return new ConvexError({ code: "INVALID" as const, message, field });
}

function personName(user: Doc<"users">): string {
  return user.name?.trim() || user.email || "A team member";
}

function vendorHash(vendorId: Id<"vendors">): string {
  return `#/vendors/${vendorId}`;
}

async function audit(
  ctx: MutationCtx,
  entry: { eventType: string; title: string; description: string; user: Doc<"users">; companyId: Id<"companies"> },
) {
  await ctx.db.insert("auditLogs", {
    eventType: entry.eventType,
    title: entry.title,
    description: entry.description,
    actor: personName(entry.user),
    actorUserId: entry.user._id,
    actorCompanyId: entry.companyId,
    timestamp: Date.now(),
  });
}

/** Sub company admins set the payout PayPal email. Every GC relationship must confirm it again. */
export const setPayoutEmail = mutation({
  args: { email: v.string() },
  returns: v.object({ changed: v.boolean(), relationships: v.number() }),
  handler: async (ctx, args) => {
    await requireVerifiedUser(ctx);
    const { user, company } = await requireCompanyMember(ctx, { admin: true });
    if (company.kind !== "sub") {
      throw new ConvexError({ code: "FORBIDDEN", message: "Forbidden: only subcontractor companies have a payout PayPal email." });
    }
    const email = normalizeInviteEmail(args.email);
    if (email === null) throw invalid(INVALID_EMAIL_MESSAGE, "payoutPaypalEmail");
    const previous = company.payoutPaypalEmail ?? null;
    if (previous === email) return { changed: false, relationships: 0 };

    await ctx.db.patch(company._id, { payoutPaypalEmail: email });
    const vendors = await clearPayeeConfirmations(ctx, company._id);
    // One notification per GC company even when it lists this company on several vendor rows.
    const notifiedGcs = new Set<Id<"companies">>();
    for (const vendor of vendors) {
      const gc = await ctx.db.get(vendor.companyId);
      if (gc === null) continue;
      await audit(ctx, {
        eventType: "payee_change",
        title: `Payout email changed for ${vendor.name}`,
        description: `${personName(user)} of ${company.name} changed the payout PayPal email from ${previous ?? "(none)"} to ${email}. Payouts from ${gc.name} are on hold until a ${gc.name} member confirms it.`,
        user,
        companyId: company._id,
      });
      if (vendor.status !== "active" || notifiedGcs.has(gc._id)) continue;
      notifiedGcs.add(gc._id);
      await notify(
        ctx,
        { companyId: gc._id },
        {
          kind: "payee_change_pending",
          title: `Payee change pending for ${vendor.name}`,
          body: `${company.name} set a new payout PayPal email. Payouts to ${vendor.name} are on hold until someone at ${gc.name} confirms it on the vendor page.`,
          link: vendorHash(vendor._id),
        },
      );
    }
    return { changed: true, relationships: vendors.length };
  },
});

/** Owner company admins set the billing email that invoices for their projects go to. */
export const setBillingEmail = mutation({
  args: { email: v.string() },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    await requireVerifiedUser(ctx);
    const { user, company } = await requireCompanyMember(ctx, { admin: true });
    if (company.kind !== "owner") {
      throw new ConvexError({ code: "FORBIDDEN", message: "Forbidden: only owner companies have a billing email." });
    }
    const email = normalizeInviteEmail(args.email);
    if (email === null) throw invalid(INVALID_EMAIL_MESSAGE, "billingEmail");
    const previous = company.billingEmail ?? null;
    if (previous === email) return { changed: false };
    await ctx.db.patch(company._id, { billingEmail: email });
    await audit(ctx, {
      eventType: "billing_email_change",
      title: `Billing email changed for ${company.name}`,
      description: `${personName(user)} changed the billing email from ${previous ?? "(none)"} to ${email}.`,
      user,
      companyId: company._id,
    });
    return { changed: true };
  },
});

/** The caller's sub company payout email and its confirmation state with each GC that lists it. */
export const myPayoutStatus = query({
  args: {},
  handler: async (ctx) => {
    const { company } = await requireCompanyMember(ctx);
    if (company.kind !== "sub") return null;
    const vendors = await ctx.db
      .query("vendors")
      .withIndex("by_linkedCompanyId", (q) => q.eq("linkedCompanyId", company._id))
      .take(200);
    // A GC may list the same company on more than one vendor row; the sub sees one line per GC.
    const byGc = new Map<Id<"companies">, { gcCompanyId: Id<"companies">; gcCompanyName: string; status: "none" | "pending" | "confirmed"; confirmedAt: number | null }>();
    for (const vendor of vendors) {
      const gc = await ctx.db.get(vendor.companyId);
      if (gc === null) continue;
      const state = payeeState(vendor, company);
      const prev = byGc.get(gc._id);
      if (prev === undefined) {
        byGc.set(gc._id, { gcCompanyId: gc._id, gcCompanyName: gc.name, status: state.status, confirmedAt: state.confirmedAt });
      } else if (prev.status === "confirmed" && state.status !== "confirmed") {
        byGc.set(gc._id, { ...prev, status: state.status, confirmedAt: null });
      } else if (prev.status === "confirmed" && state.confirmedAt !== null) {
        prev.confirmedAt = Math.max(prev.confirmedAt ?? 0, state.confirmedAt);
      }
    }
    const relationships = [...byGc.values()];
    relationships.sort((a, b) => a.gcCompanyName.localeCompare(b.gcCompanyName));
    const email = company.payoutPaypalEmail ?? null;
    const overall =
      email === null ? "none" : relationships.length > 0 && relationships.every((r) => r.status === "confirmed") ? "confirmed" : "pending";
    return { email, overall, relationships };
  },
});

/**
 * A member of the vendor's GC company confirms the sub's current payout email. `email` is the address
 * shown in the confirm dialog; if the sub changed it since, nothing is confirmed.
 */
export const confirmPayee = mutation({
  args: { vendorId: v.string(), email: v.string() },
  returns: v.object({ email: v.string(), confirmedAt: v.number() }),
  handler: async (ctx, args) => {
    const caller = await requireVerifiedUser(ctx);
    const { user, company } = await requireCompanyMember(ctx);
    const vendor = await liveVendorByRawId(ctx, args.vendorId);
    if (vendor === null || vendor.companyId !== company._id || company.kind !== "gc" || caller.actorType === "agent") throw notFound();
    const sub = vendor.linkedCompanyId ? await ctx.db.get(vendor.linkedCompanyId) : null;
    const current = sub?.payoutPaypalEmail ?? null;
    if (sub === null || current === null) {
      throw new ConvexError({ code: "NO_PAYEE", message: `${vendor.name} has not set a payout PayPal email, so there is nothing to confirm.` });
    }
    if (current !== args.email.trim().toLowerCase()) {
      throw new ConvexError({
        code: "PAYEE_CHANGED",
        message: `${sub.name} changed its payout email again. Review the new email and confirm that one.`,
      });
    }
    const previous = vendor.payoutEmailConfirmed;
    // A GC may list the same company on several vendor rows; confirming covers all of them so no agreement stays blocked.
    const sameCompanyRows = (
      await ctx.db
        .query("vendors")
        .withIndex("by_linkedCompanyId", (q) => q.eq("linkedCompanyId", sub._id))
        .take(200)
    ).filter((row) => row.companyId === company._id);
    const unconfirmed = sameCompanyRows.filter((row) => row.payoutEmailConfirmed?.email !== current);
    if (unconfirmed.length === 0 && previous?.email === current) return { email: current, confirmedAt: previous.confirmedAt };
    const confirmedAt = Date.now();
    for (const row of unconfirmed) {
      await ctx.db.patch(row._id, { payoutEmailConfirmed: { email: current, confirmedByUserId: user._id, confirmedAt } });
    }
    await audit(ctx, {
      eventType: "payee_confirmed",
      title: `Payee confirmed for ${vendor.name}`,
      description: `${personName(user)} of ${company.name} confirmed ${current} as the payout PayPal email for vendor ${vendor.name} (${vendor._id}); previously confirmed: ${previous?.email ?? "(none)"}.`,
      user,
      companyId: company._id,
    });
    await notify(
      ctx,
      { companyId: sub._id },
      {
        kind: "payee_confirmed",
        title: `Payee confirmed by ${company.name}`,
        body: `Future payouts from ${company.name} go to the payout PayPal email on your company profile.`,
        link: "#/company",
      },
    );
    return { email: current, confirmedAt };
  },
});
