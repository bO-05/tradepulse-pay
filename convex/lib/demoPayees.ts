import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizeInviteEmail } from "./inviteRules";
import type { DemoCompanyIds, DemoCompanyKey } from "./demoTenancy";
import { attachBidderVendor, backfillVendorsForCompany } from "./vendorDirectory";
import { liveVendor } from "./vendorRead";

/** Demo sub company → Convex env var with its PayPal sandbox personal account (values never committed). */
export type DemoSubPayeeEnv = {
  key: DemoCompanyKey;
  env: string;
  /** Used only when `env` is unset; the resolution records which variable actually supplied the address. */
  fallbackEnv?: string;
};

export const DEMO_SUB_PAYEE_ENV: ReadonlyArray<DemoSubPayeeEnv> = [
  { key: "sub:rosendin", env: "PAYPAL_SANDBOX_SUB1_EMAIL" },
  { key: "sub:tdindustries", env: "PAYPAL_SANDBOX_SUB2_EMAIL" },
  { key: "sub:clarke-kent", env: "PAYPAL_SANDBOX_SUB3_EMAIL" },
  // Ortiz ships with the mission and may not have its own sandbox payee yet. Falling back to the
  // sandbox SUB3 address keeps the payout path executable; the company row records which variable
  // was used, so the fallback is visible instead of being an invented address.
  { key: "sub:ortiz", env: "PAYPAL_SANDBOX_SUB4_EMAIL", fallbackEnv: "PAYPAL_SANDBOX_SUB3_EMAIL" },
];
export const DEMO_OWNER_BILLING_ENV = "PAYPAL_SANDBOX_OWNER_EMAIL";

export type DemoPayeeCounts = { payeesConfirmed: number; companiesUpdated: number; vendorsLinked: number };

function envEmail(name: string): string | null {
  const raw = process.env[name];
  return raw ? normalizeInviteEmail(raw) : null;
}

export type ResolvedDemoPayee = { email: string; envName: string };

/** The first set variable in [env, fallbackEnv] that holds a usable address, with the name used. */
export function resolveDemoPayee(envName: string, fallbackEnvName?: string): ResolvedDemoPayee | null {
  for (const name of [envName, fallbackEnvName]) {
    if (!name) continue;
    const email = envEmail(name);
    if (email !== null) return { email, envName: name };
  }
  return null;
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

  for (const { key, env, fallbackEnv } of DEMO_SUB_PAYEE_ENV) {
    const resolved = resolveDemoPayee(env, fallbackEnv);
    const sub = await ctx.db.get(ids[key]);
    if (resolved === null || sub === null) continue;
    const email = resolved.email;
    const companyPatch: Partial<Doc<"companies">> = {};
    if (sub.payoutPaypalEmail !== email) companyPatch.payoutPaypalEmail = email;
    if (sub.payoutEmailSourceEnv !== resolved.envName) companyPatch.payoutEmailSourceEnv = resolved.envName;
    if (Object.keys(companyPatch).length > 0) {
      await ctx.db.patch(sub._id, companyPatch);
      counts.companiesUpdated++;
    }
    // Demo bidder rows linked to this company point their vendor at it too.
    const contractors = await ctx.db
      .query("contractors")
      .withIndex("by_linkedCompanyId", (q) => q.eq("linkedCompanyId", sub._id))
      .take(200);
    for (const c of contractors) {
      const vendorId = await attachBidderVendor(ctx, c._id);
      const vendor = vendorId === null ? null : await liveVendor(ctx, vendorId);
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
      const now = Date.now();
      await ctx.db.patch(vendor._id, { payoutEmailConfirmed: { email, confirmedByUserId: demoGcUserId, confirmedAt: now } });
      // The sandbox payee address comes from a deployment env var, so the entry does not repeat it.
      await ctx.db.insert("auditLogs", {
        eventType: "payee_confirmed",
        title: `Payee confirmed for ${vendor.name}`,
        description: `The demo seed confirmed ${sub.name}'s PayPal sandbox payout email (from ${resolved.envName}) for vendor ${vendor.name} (${vendor._id}) on behalf of the Demo GC; previously confirmed: ${vendor.payoutEmailConfirmed ? "a different email" : "(none)"}.`,
        actor: "system:demo-seed",
        actorUserId: demoGcUserId,
        actorCompanyId: ids.gc,
        timestamp: now,
      });
      counts.payeesConfirmed++;
    }
  }
  return counts;
}
