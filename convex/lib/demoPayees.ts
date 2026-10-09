import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeInviteEmail } from "./inviteRules";
import type { DemoCompanyIds, DemoCompanyKey } from "./demoTenancy";
import { attachBidderVendor, backfillVendorsForCompany } from "./vendorDirectory";

/** Demo sub company → Convex env var with its PayPal sandbox personal account (values never committed). */
export const DEMO_SUB_PAYEE_ENV: ReadonlyArray<{ key: DemoCompanyKey; env: string }> = [
  { key: "sub:rosendin", env: "PAYPAL_SANDBOX_SUB1_EMAIL" },
  { key: "sub:tdindustries", env: "PAYPAL_SANDBOX_SUB2_EMAIL" },
  { key: "sub:clarke-kent", env: "PAYPAL_SANDBOX_SUB3_EMAIL" },
];
export const DEMO_OWNER_BILLING_ENV = "PAYPAL_SANDBOX_OWNER_EMAIL";

export type DemoPayeeCounts = { payeesConfirmed: number; companiesUpdated: number; vendorsLinked: number };

function envEmail(name: string): string | null {
  const raw = process.env[name];
  return raw ? normalizeInviteEmail(raw) : null;
}

/**
 * Keeps the Phase-1 demo payouts and invoices working under payee control: each Demo sub company's
 * payout email comes from its PAYPAL_SANDBOX_SUB*_EMAIL and is confirmed on every Demo GC vendor row
 * linked to it (confirmed by the Demo GC account), and the Demo Owner's billing email is
 * PAYPAL_SANDBOX_OWNER_EMAIL. Only Demo companies (by id) and the Demo GC's own directory are touched.
 * Idempotent; skipped until the Demo GC account exists.
 */
export async function ensureDemoPayees(ctx: MutationCtx, ids: DemoCompanyIds, demoGcUserId: Id<"users"> | null): Promise<DemoPayeeCounts> {
  const counts: DemoPayeeCounts = { payeesConfirmed: 0, companiesUpdated: 0, vendorsLinked: 0 };
  const ownerEmail = envEmail(DEMO_OWNER_BILLING_ENV);
  const owner = await ctx.db.get(ids.owner);
  if (owner !== null && ownerEmail !== null && owner.billingEmail !== ownerEmail) {
    await ctx.db.patch(owner._id, { billingEmail: ownerEmail });
    counts.companiesUpdated++;
  }
  if (demoGcUserId === null) return counts;
  await backfillVendorsForCompany(ctx, ids.gc);

  for (const { key, env } of DEMO_SUB_PAYEE_ENV) {
    const email = envEmail(env);
    const sub = await ctx.db.get(ids[key]);
    if (email === null || sub === null) continue;
    if (sub.payoutPaypalEmail !== email) {
      await ctx.db.patch(sub._id, { payoutPaypalEmail: email });
      counts.companiesUpdated++;
    }
    // Demo bidder rows linked to this company point their vendor at it too.
    const contractors = await ctx.db
      .query("contractors")
      .withIndex("by_linkedCompanyId", (q) => q.eq("linkedCompanyId", sub._id))
      .take(200);
    for (const c of contractors) {
      const vendorId = await attachBidderVendor(ctx, c._id);
      const vendor = vendorId === null ? null : await ctx.db.get(vendorId);
      if (vendor === null || vendor.companyId !== ids.gc || vendor.linkedCompanyId !== undefined) continue;
      await ctx.db.patch(vendor._id, { linkedCompanyId: sub._id });
      counts.vendorsLinked++;
    }
    const vendors = await ctx.db
      .query("vendors")
      .withIndex("by_linkedCompanyId", (q) => q.eq("linkedCompanyId", sub._id))
      .take(200);
    for (const vendor of vendors) {
      if (vendor.companyId !== ids.gc || vendor.payoutEmailConfirmed?.email === email) continue;
      await ctx.db.patch(vendor._id, { payoutEmailConfirmed: { email, confirmedByUserId: demoGcUserId, confirmedAt: Date.now() } });
      counts.payeesConfirmed++;
    }
  }
  return counts;
}
