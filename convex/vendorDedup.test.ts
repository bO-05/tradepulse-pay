/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture, insertProjectFor } from "./lib/tenancyFixtures";
import { attachBidderVendor } from "./lib/vendorDirectory";
import { withSession } from "./lib/testIdentity";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const fx = await buildTenancyFixture(t);
  return { t, fx };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

const PAYOUT = "kim.payouts@eastbay-mail.com";

function tokenOf(link: string): string {
  return link.match(/#\/invite\/([A-Za-z0-9_-]+)$/)![1];
}

/** The live (not merged) vendor rows of a GC company. */
async function vendorsOf(t: T, companyId: Id<"companies">) {
  return (await allVendorsOf(t, companyId)).filter((r) => r.status !== "merged");
}

async function allVendorsOf(t: T, companyId: Id<"companies">) {
  return await t.run((ctx) => ctx.db.query("vendors").withIndex("by_companyId", (q) => q.eq("companyId", companyId)).collect());
}

/** Bayview's existing Eastbay vendor row: linked to the sub company, payee confirmed by Dana. */
async function confirmedEastbayVendor(t: T, fx: Awaited<ReturnType<typeof setup>>["fx"]) {
  return await t.run(async (ctx) => {
    await ctx.db.patch(fx.sub.companyId, { payoutPaypalEmail: PAYOUT });
    return await ctx.db.insert("vendors", {
      companyId: fx.gcA.companyId,
      name: "Eastbay Electric",
      trades: ["26 00 00"],
      contactName: "Kim Tran",
      email: "kim@eastbay.test",
      linkedCompanyId: fx.sub.companyId,
      payoutEmailConfirmed: { email: PAYOUT, confirmedByUserId: fx.gcA.admin.userId, confirmedAt: Date.now() },
      status: "active",
      createdAt: Date.now(),
    });
  });
}

beforeEach(() => {
  vi.stubEnv("AGENTMAIL_API_KEY", "test-agentmail-key");
  vi.stubEnv("EMAIL_DAILY_BUDGET", "60");
  vi.stubEnv("SITE_URL", "http://localhost:3150");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("one vendor row per sub for each GC", () => {
  test("accepting a new-vendor sub invite as an already-listed sub reuses the existing vendor row", async () => {
    const { t, fx } = await setup();
    const existingId = await confirmedEastbayVendor(t, fx);
    const fresh = await t.run((ctx) => insertProjectFor(ctx, fx.gcA.companyId, { title: "Harbor Point Phase 2", bidderName: "Eastbay Electric" }));
    await t.run((ctx) => ctx.db.patch(fresh.contractorId, { contactEmail: "estimating@eastbay-mail.com" }));
    const res = await fx.gcA.admin.as.action(api.invites.create, {
      kind: "sub",
      email: "estimating@eastbay-mail.com",
      projectId: fresh.projectId,
      newVendor: { name: "Eastbay Electric (Estimating)", trade: "26 05 00", contactName: "Kim Tran" },
      sendEmail: false,
    });
    // The invite created a second, unlinked row for the same sub (different email).
    expect(await vendorsOf(t, fx.gcA.companyId)).toHaveLength(2);
    const estimator = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "estimating@eastbay-mail.com", name: "Est", emailVerificationTime: Date.now() });
      await ctx.db.insert("companyMembers", { companyId: fx.sub.companyId, userId, role: "member", status: "active", createdAt: Date.now() });
      return userId;
    });
    const est = await withSession(t, estimator, "estimating@eastbay-mail.com");
    const accepted = await est.mutation(api.invites.accept, { token: tokenOf(res.link) });
    expect(accepted.companyId).toBe(fx.sub.companyId);

    const rows = await vendorsOf(t, fx.gcA.companyId);
    expect(rows.map((r) => r._id)).toEqual([existingId]);
    expect(rows[0]).toMatchObject({
      linkedCompanyId: fx.sub.companyId,
      email: "kim@eastbay.test",
      payoutEmailConfirmed: expect.objectContaining({ email: PAYOUT }),
    });
    expect(rows[0].trades.sort()).toEqual(["26 00 00", "26 05 00"]);
    const refs = await t.run(async (ctx) => ({
      invite: await ctx.db.get(res.inviteId),
      contractor: await ctx.db.get(fresh.contractorId),
      member: await ctx.db
        .query("projectMembers")
        .withIndex("by_project_company_and_status", (q) => q.eq("projectId", fresh.projectId).eq("companyId", fx.sub.companyId).eq("status", "active"))
        .first(),
    }));
    expect(refs.invite).toMatchObject({ status: "accepted", vendorId: existingId });
    expect(refs.contractor).toMatchObject({ vendorId: existingId, linkedCompanyId: fx.sub.companyId });
    expect(refs.member?.vendorId).toBe(existingId);
    const list = await fx.gcA.admin.as.query(api.vendors.listVendors, {});
    expect(list).toEqual([expect.objectContaining({ _id: existingId, payeeStatus: "confirmed", linked: true })]);
    // Sonoran's directory is untouched.
    expect(await vendorsOf(t, fx.gcB.companyId)).toEqual([]);
  });

  test("bidder vendor attach and the backfill reuse the row linked to the bidder's sub company", async () => {
    const { t, fx } = await setup();
    const existingId = await confirmedEastbayVendor(t, fx);
    // The fixture's Eastbay bidder is linked to the sub but its email differs from the vendor row's.
    const first = await t.mutation(internal.vendors.backfillBidderVendors, { gcCompanyId: fx.gcA.companyId });
    expect(first.vendorsCreated).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(fx.gcA.project.contractorId)))?.vendorId).toBe(existingId);

    const attached = await t.run(async (ctx) => {
      const contractorId = await ctx.db.insert("contractors", {
        tradePackageId: fx.gcA.project.tradePackageId,
        companyName: "Eastbay Electric Inc.",
        contactEmail: "service@eastbay-mail.com",
        licenseNumber: "0",
        licenseStatus: "Unverified",
        sourceUrl: "",
        rfqStatus: "discovered",
        linkedCompanyId: fx.sub.companyId,
      });
      return await attachBidderVendor(ctx, contractorId);
    });
    expect(attached).toBe(existingId);
    const rows = await vendorsOf(t, fx.gcA.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].payoutEmailConfirmed?.email).toBe(PAYOUT);
  });
});

describe("mergeDuplicateVendors migration", () => {
  test("merges duplicates into the oldest row, repoints references, keeps payee confirmation, and is idempotent", async () => {
    const { t, fx } = await setup();
    const ids = await t.run(async (ctx) => {
      await ctx.db.patch(fx.sub.companyId, { payoutPaypalEmail: PAYOUT });
      const base = { name: "Eastbay Electric", contactName: "", status: "active" as const, createdAt: Date.now() };
      const oldest = await ctx.db.insert("vendors", { ...base, companyId: fx.gcA.companyId, trades: ["26 00 00"], email: "kim@eastbay.test" });
      // Same email, linked and confirmed (the backfill/invite duplicate).
      const sameEmail = await ctx.db.insert("vendors", {
        ...base,
        companyId: fx.gcA.companyId,
        trades: ["26 05 00"],
        email: "kim@eastbay.test",
        contactName: "Kim Tran",
        phone: "(510) 555-0142",
        linkedCompanyId: fx.sub.companyId,
        payoutEmailConfirmed: { email: PAYOUT, confirmedByUserId: fx.gcA.admin.userId, confirmedAt: 1000 },
      });
      // Different email, same linked company.
      const sameLink = await ctx.db.insert("vendors", {
        ...base,
        companyId: fx.gcA.companyId,
        trades: ["26 00 00"],
        email: "estimating@eastbay-mail.com",
        linkedCompanyId: fx.sub.companyId,
        payoutEmailConfirmed: { email: "old@eastbay-mail.com", confirmedByUserId: fx.gcA.admin.userId, confirmedAt: 2000 },
      });
      // Placeholder emails never merge rows of different subs.
      const p1 = await ctx.db.insert("vendors", { ...base, companyId: fx.gcA.companyId, name: "Alpha", trades: [], email: "bids@example.invalid" });
      const p2 = await ctx.db.insert("vendors", { ...base, companyId: fx.gcA.companyId, name: "Beta", trades: [], email: "bids@example.invalid" });
      // Another GC's row for the same sub stays separate.
      const sonoran = await ctx.db.insert("vendors", { ...base, companyId: fx.gcB.companyId, trades: [], email: "kim@eastbay.test", linkedCompanyId: fx.sub.companyId });
      await ctx.db.patch(fx.gcA.project.contractorId, { vendorId: sameEmail });
      const member = await ctx.db
        .query("projectMembers")
        .withIndex("by_project_company_and_status", (q) => q.eq("projectId", fx.gcA.project.projectId).eq("companyId", fx.sub.companyId).eq("status", "active"))
        .first();
      await ctx.db.patch(member!._id, { vendorId: sameLink });
      const inviteId = await ctx.db.insert("invites", {
        tokenHash: "f".repeat(64),
        email: "estimating@eastbay-mail.com",
        kind: "sub",
        inviterCompanyId: fx.gcA.companyId,
        projectId: fx.gcA.project.projectId,
        vendorId: sameLink,
        status: "accepted",
        expiresAt: Date.now(),
        emailStatus: "not_sent",
        tokenVersion: 1,
        createdByUserId: fx.gcA.admin.userId,
        createdAt: Date.now(),
      });
      const notificationId = await ctx.db.insert("notifications", {
        userId: fx.gcA.admin.userId,
        companyId: fx.gcA.companyId,
        kind: "payee_change_pending",
        title: "Payee change pending for Eastbay Electric",
        body: "",
        link: `#/vendors/${sameEmail}`,
        createdAt: Date.now(),
      });
      return { oldest, sameEmail, sameLink, p1, p2, sonoran, memberId: member!._id, inviteId, notificationId };
    });

    const first = await t.mutation(internal.vendors.mergeDuplicateVendors, {});
    expect(first).toMatchObject({ vendorsMerged: 2, contractorsRepointed: 1, projectMembersRepointed: 1, invitesRepointed: 1, notificationsRepointed: 1 });

    const rows = await vendorsOf(t, fx.gcA.companyId);
    expect(rows.map((r) => r._id).sort()).toEqual([ids.oldest, ids.p1, ids.p2].sort());
    // Merged rows are never deleted: they stay as hidden tombstones pointing at the kept row.
    const tombstones = (await allVendorsOf(t, fx.gcA.companyId)).filter((r) => r.status === "merged");
    expect(tombstones.map((r) => r._id).sort()).toEqual([ids.sameEmail, ids.sameLink].sort());
    for (const r of tombstones) {
      expect(r).toMatchObject({ mergedIntoVendorId: ids.oldest });
      expect(r.linkedCompanyId).toBeUndefined();
      expect(r.payoutEmailConfirmed).toBeUndefined();
    }
    const kept = rows.find((r) => r._id === ids.oldest)!;
    expect(kept).toMatchObject({
      email: "kim@eastbay.test",
      linkedCompanyId: fx.sub.companyId,
      contactName: "Kim Tran",
      phone: "(510) 555-0142",
      // The confirmation matching the sub's current payout email wins over the newer stale one.
      payoutEmailConfirmed: expect.objectContaining({ email: PAYOUT, confirmedAt: 1000 }),
    });
    expect(kept.trades.sort()).toEqual(["26 00 00", "26 05 00"]);
    const refs = await t.run(async (ctx) => ({
      contractor: await ctx.db.get(fx.gcA.project.contractorId),
      member: await ctx.db.get(ids.memberId),
      invite: await ctx.db.get(ids.inviteId),
      notification: await ctx.db.get(ids.notificationId),
      sonoran: await ctx.db.get(ids.sonoran),
    }));
    expect(refs.contractor?.vendorId).toBe(ids.oldest);
    expect(refs.member?.vendorId).toBe(ids.oldest);
    expect(refs.invite?.vendorId).toBe(ids.oldest);
    expect(refs.notification?.link).toBe(`#/vendors/${ids.oldest}`);
    expect(refs.sonoran).not.toBeNull();

    const list = await fx.gcA.admin.as.query(api.vendors.listVendors, {});
    expect(list.filter((v) => v.name === "Eastbay Electric")).toEqual([expect.objectContaining({ _id: ids.oldest, payeeStatus: "confirmed" })]);
    const status = await fx.sub.admin.as.query(api.payee.myPayoutStatus, {});
    expect(status?.relationships.find((r) => r.gcCompanyId === fx.gcA.companyId)?.status).toBe("confirmed");

    const second = await t.mutation(internal.vendors.mergeDuplicateVendors, {});
    expect(second).toMatchObject({ vendorsMerged: 0, contractorsRepointed: 0, projectMembersRepointed: 0, invitesRepointed: 0, notificationsRepointed: 0 });
  });
});

describe("mergeDuplicateVendors resolves complete groups", () => {
  test("A (email x, unlinked), B (email y, linked S), C (email x, linked S) collapse into A in one run; a second run is all zero", async () => {
    const { t, fx } = await setup();
    const ids = await t.run(async (ctx) => {
      const base = { name: "Eastbay Electric", contactName: "", status: "active" as const, createdAt: Date.now(), companyId: fx.gcA.companyId };
      const a = await ctx.db.insert("vendors", { ...base, trades: ["26 00 00"], email: "x@eastbay-mail.com" });
      const b = await ctx.db.insert("vendors", { ...base, trades: ["26 05 00"], email: "y@eastbay-mail.com", linkedCompanyId: fx.sub.companyId });
      const c = await ctx.db.insert("vendors", { ...base, trades: ["26 10 00"], email: "x@eastbay-mail.com", linkedCompanyId: fx.sub.companyId });
      return { a, b, c };
    });
    const first = await t.mutation(internal.vendors.mergeDuplicateVendors, { gcCompanyId: fx.gcA.companyId });
    expect(first.vendorsMerged).toBe(2);
    const live = await vendorsOf(t, fx.gcA.companyId);
    expect(live.map((r) => r._id)).toEqual([ids.a]);
    expect(live[0].linkedCompanyId).toBe(fx.sub.companyId);
    expect(live[0].trades.sort()).toEqual(["26 00 00", "26 05 00", "26 10 00"]);
    const linkedRows = await t.run((ctx) =>
      ctx.db
        .query("vendors")
        .withIndex("by_companyId_and_linkedCompanyId", (q) => q.eq("companyId", fx.gcA.companyId).eq("linkedCompanyId", fx.sub.companyId))
        .collect(),
    );
    expect(linkedRows.map((r) => r._id)).toEqual([ids.a]);

    const second = await t.mutation(internal.vendors.mergeDuplicateVendors, { gcCompanyId: fx.gcA.companyId });
    expect(second).toMatchObject({ vendorsMerged: 0, contractorsRepointed: 0, projectMembersRepointed: 0, invitesRepointed: 0, notificationsRepointed: 0 });
  });

  test("rows sharing an email but linked to two different companies are never merged", async () => {
    const { t, fx } = await setup();
    const otherSub = await t.run((ctx) => ctx.db.insert("companies", { name: "Other Electric", kind: "sub", isDemo: false, createdAt: Date.now() }));
    await t.run(async (ctx) => {
      const base = { name: "Shared inbox", contactName: "", trades: [], status: "active" as const, createdAt: Date.now(), companyId: fx.gcA.companyId };
      await ctx.db.insert("vendors", { ...base, email: "bids@shared-mail.com" });
      await ctx.db.insert("vendors", { ...base, email: "bids@shared-mail.com", linkedCompanyId: fx.sub.companyId });
      await ctx.db.insert("vendors", { ...base, email: "bids@shared-mail.com", linkedCompanyId: otherSub });
    });
    const first = await t.mutation(internal.vendors.mergeDuplicateVendors, { gcCompanyId: fx.gcA.companyId });
    expect(first.vendorsMerged).toBe(1);
    const live = await vendorsOf(t, fx.gcA.companyId);
    expect(live.map((r) => r.linkedCompanyId).sort()).toEqual([fx.sub.companyId, otherSub].sort());
    expect((await t.mutation(internal.vendors.mergeDuplicateVendors, { gcCompanyId: fx.gcA.companyId })).vendorsMerged).toBe(0);
  });

  test("a pending invite beyond the invite scan still names the merged row and is accepted onto the surviving row", async () => {
    const { t, fx } = await setup();
    const email = "kim.new@eastbay-mail.com";
    const ids = await t.run(async (ctx) => {
      for (let i = 0; i < 2000; i++) {
        await ctx.db.insert("invites", {
          tokenHash: `h${i}`.padEnd(64, "0"),
          email: `old${i}@history.test`,
          kind: "sub",
          inviterCompanyId: fx.gcA.companyId,
          status: "revoked",
          expiresAt: 0,
          emailStatus: "not_sent",
          tokenVersion: 1,
          createdByUserId: fx.gcA.admin.userId,
          createdAt: i,
        });
      }
      const base = { name: "Eastbay Electric", contactName: "Kim Tran", trades: ["26 00 00"], status: "active" as const, createdAt: Date.now(), companyId: fx.gcA.companyId };
      const keep = await ctx.db.insert("vendors", { ...base, email });
      const dup = await ctx.db.insert("vendors", { ...base, email });
      return { keep, dup };
    });
    const res = await fx.gcA.admin.as.action(api.invites.create, {
      kind: "sub",
      email,
      projectId: fx.gcA.project.projectId,
      vendorId: ids.dup,
      sendEmail: false,
    });
    const merged = await t.mutation(internal.vendors.mergeDuplicateVendors, { gcCompanyId: fx.gcA.companyId });
    expect(merged).toMatchObject({ vendorsMerged: 1, invitesRepointed: 0 });
    // The invite was outside the bounded scan, so it still stores the merged row's id.
    expect((await t.run((ctx) => ctx.db.get(res.inviteId)))?.vendorId).toBe(ids.dup);
    expect(await t.run((ctx) => ctx.db.get(ids.dup))).toMatchObject({ status: "merged", mergedIntoVendorId: ids.keep });

    const kimId = await t.run((ctx) => ctx.db.insert("users", { email, name: "Kim Tran", emailVerificationTime: Date.now() }));
    const kim = await withSession(t, kimId, email);
    const accepted = await kim.mutation(api.invites.accept, { token: tokenOf(res.link) });
    const live = await vendorsOf(t, fx.gcA.companyId);
    expect(live.map((r) => r._id)).toEqual([ids.keep]);
    expect(live[0].linkedCompanyId).toBe(accepted.companyId);
    const member = await t.run((ctx) =>
      ctx.db
        .query("projectMembers")
        .withIndex("by_project_company_and_status", (q) => q.eq("projectId", fx.gcA.project.projectId).eq("companyId", accepted.companyId).eq("status", "active"))
        .first(),
    );
    expect(member?.vendorId).toBe(ids.keep);
    // The GC opening the merged row's id (e.g. an old notification link) sees the surviving vendor.
    const detail = await fx.gcA.admin.as.query(api.partyProfiles.getVendor, { vendorId: ids.dup });
    expect(detail._id).toBe(ids.keep);
    expect((await fx.gcA.admin.as.query(api.vendors.listVendors, { includeInactive: true })).map((v) => v._id)).toEqual([ids.keep]);
  });
});
