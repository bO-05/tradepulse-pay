/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { ensureDemoCompanies } from "./lib/demoTenancy";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { agentIdProfile, syncAgentProfile } from "./lib/agentAccess";
import { payoutReceiverForContractor, PAYEE_REASON } from "./lib/payee";
import { buildTenancyFixture, type FixtureUser } from "./lib/tenancyFixtures";
import { withSession } from "./lib/testIdentity";
import { invoiceRecipientForProject, NO_PROJECT_OWNER_REASON, noOwnerEmailReason } from "./payments/changeOrderRecipient";

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;
const TABLES = Object.keys(schema.tables) as (keyof typeof schema.tables)[];

async function snapshot(t: T): Promise<string> {
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) out[table] = await ctx.db.query(table).collect();
    return JSON.stringify(out);
  });
}

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const data = (err as { data?: { message?: string; code?: string } }).data;
    return data?.message ?? String(err);
  }
  throw new Error("expected the call to fail");
}

async function member(t: T, companyId: Id<"companies">, email: string, role: "admin" | "member"): Promise<FixtureUser> {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email, name: email.split("@")[0], emailVerificationTime: Date.now() });
    await ctx.db.insert("companyMembers", { companyId, userId: id, role, status: "active", createdAt: Date.now() });
    return id;
  });
  return { userId, email, as: await withSession(t, userId, email) };
}

/** Bayview lists Eastbay as a linked vendor; Sonoran lists it too unless `sonoranLinked` is false. */
async function setup(opts: { sonoranLinked?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const fx = await buildTenancyFixture(t);
  const ids = await t.run(async (ctx) => {
    const vendor = (companyId: Id<"companies">, linked: boolean) =>
      ctx.db.insert("vendors", {
        companyId,
        name: "Eastbay Electric",
        trades: ["26 00 00"],
        contactName: "Kim Tran",
        email: "kim@eastbay.test",
        ...(linked ? { linkedCompanyId: fx.sub.companyId } : {}),
        status: "active",
        createdAt: Date.now(),
      });
    const bayviewVendor = await vendor(fx.gcA.companyId, true);
    const sonoranVendor = await vendor(fx.gcB.companyId, opts.sonoranLinked !== false);
    await ctx.db.patch(fx.gcA.project.contractorId, { vendorId: bayviewVendor });
    return { bayviewVendor, sonoranVendor };
  });
  return { t, fx, ...ids };
}

async function notificationsOf(t: T, companyId: Id<"companies">) {
  return await t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.companyId === companyId));
}

describe("payout PayPal email (sub company admins only)", () => {
  test("the sub admin's email is stored lowercased, pending for every GC, and each GC is notified for its own vendor row", async () => {
    const { t, fx, bayviewVendor, sonoranVendor } = await setup();
    await fx.sub.admin.as.mutation(api.payee.setPayoutEmail, { email: "  Kim.Payouts@Example.com " });
    const company = await t.run((ctx) => ctx.db.get(fx.sub.companyId));
    expect(company?.payoutPaypalEmail).toBe("kim.payouts@example.com");

    const status = await fx.sub.admin.as.query(api.payee.myPayoutStatus, {});
    expect(status).toMatchObject({ email: "kim.payouts@example.com", overall: "pending" });
    expect(status!.relationships.map((r) => [r.gcCompanyName, r.status])).toEqual([
      ["Bayview Builders Inc.", "pending"],
      ["Sonoran Interiors GC", "pending"],
    ]);

    const list = await fx.gcA.admin.as.query(api.vendors.listVendors, {});
    expect(list[0]).toMatchObject({ payeeStatus: "pending", payeeEmail: "kim.payouts@example.com" });
    const detail = await fx.gcA.member.as.query(api.partyProfiles.getVendor, { vendorId: bayviewVendor });
    expect(detail.payee).toMatchObject({ status: "pending", currentEmail: "kim.payouts@example.com", confirmedEmail: null });

    const bay = await notificationsOf(t, fx.gcA.companyId);
    expect(bay.map((n) => [n.userId, n.kind, n.title, n.link]).sort()).toEqual(
      [
        [fx.gcA.admin.userId, "payee_change_pending", "Payee change pending for Eastbay Electric", `#/vendors/${bayviewVendor}`],
        [fx.gcA.member.userId, "payee_change_pending", "Payee change pending for Eastbay Electric", `#/vendors/${bayviewVendor}`],
      ].sort(),
    );
    const son = await notificationsOf(t, fx.gcB.companyId);
    expect(son.map((n) => n.link)).toEqual([`#/vendors/${sonoranVendor}`]);
    // The email itself never goes into a notification.
    for (const n of [...bay, ...son]) expect(`${n.title} ${n.body}`).not.toMatch(/@/);
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).filter((a) => a.eventType === "payee_change"));
    expect(audit).toHaveLength(2);
    expect(audit[0].description).toContain("to kim.payouts@example.com");
  });

  test("a GC with no relationship to the sub gets no notification and sees nothing", async () => {
    const { t, fx } = await setup({ sonoranLinked: false });
    await fx.sub.admin.as.mutation(api.payee.setPayoutEmail, { email: "kim.payouts@example.com" });
    expect(await notificationsOf(t, fx.gcB.companyId)).toEqual([]);
    const son = await fx.gcB.admin.as.query(api.vendors.listVendors, {});
    expect(son[0]).toMatchObject({ linked: false, payeeStatus: "none", payeeEmail: null });
  });

  test("invalid emails, non-admins, GCs and owners are refused and nothing changes", async () => {
    const { t, fx } = await setup();
    const kimMember = await member(t, fx.sub.companyId, "estimator@eastbay.test", "member");
    const before = await snapshot(t);
    expect(await errorOf(fx.sub.admin.as.mutation(api.payee.setPayoutEmail, { email: "pay@pal" }))).toMatch(/valid email/);
    expect(await errorOf(kimMember.as.mutation(api.payee.setPayoutEmail, { email: "x@example.com" }))).toMatch(/admin required/);
    expect(await errorOf(fx.gcA.admin.as.mutation(api.payee.setPayoutEmail, { email: "x@example.com" }))).toMatch(/Forbidden/);
    expect(await errorOf(fx.owner.admin.as.mutation(api.payee.setPayoutEmail, { email: "x@example.com" }))).toMatch(/Forbidden/);
    expect(await snapshot(t)).toBe(before);
  });
});

describe("confirming the payee (GC of the relationship only)", () => {
  test("a GC member confirms: vendor row, audit log and the sub's notification are written", async () => {
    const { t, fx, bayviewVendor } = await setup();
    await fx.sub.admin.as.mutation(api.payee.setPayoutEmail, { email: "kim.payouts@example.com" });
    await fx.gcA.member.as.mutation(api.payee.confirmPayee, { vendorId: bayviewVendor, email: "kim.payouts@example.com" });
    const vendor = await t.run((ctx) => ctx.db.get(bayviewVendor));
    expect(vendor?.payoutEmailConfirmed).toMatchObject({ email: "kim.payouts@example.com", confirmedByUserId: fx.gcA.member.userId });
    const detail = await fx.gcA.admin.as.query(api.partyProfiles.getVendor, { vendorId: bayviewVendor });
    expect(detail.payee).toMatchObject({ status: "confirmed", confirmedEmail: "kim.payouts@example.com", confirmedByName: "luis@bayview.test" });
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).filter((a) => a.eventType === "payee_confirmed"));
    expect(audit).toEqual([expect.objectContaining({ actorUserId: fx.gcA.member.userId, actorCompanyId: fx.gcA.companyId })]);
    expect(audit[0].description).toContain(`confirmed kim.payouts@example.com`);
    expect(audit[0].description).toContain(String(bayviewVendor));
    const sub = await notificationsOf(t, fx.sub.companyId);
    expect(sub.map((n) => [n.userId, n.kind, n.title, n.readAt])).toEqual([
      [fx.sub.admin.userId, "payee_confirmed", "Payee confirmed by Bayview Builders Inc.", undefined],
    ]);
    // Sonoran's relationship is still pending: confirmation is per GC.
    const status = await fx.sub.admin.as.query(api.payee.myPayoutStatus, {});
    expect(status!.relationships.map((r) => r.status)).toEqual(["confirmed", "pending"]);
    expect(status!.overall).toBe("pending");
  });

  test("a GC listing the company on two vendor rows confirms both at once; the sub sees one line per GC", async () => {
    const { t, fx, bayviewVendor } = await setup();
    const duplicate = await t.run((ctx) =>
      ctx.db.insert("vendors", {
        companyId: fx.gcA.companyId,
        name: "Eastbay Electric Co",
        trades: [],
        contactName: "",
        email: "office@eastbay.test",
        linkedCompanyId: fx.sub.companyId,
        status: "active",
        createdAt: Date.now(),
      }),
    );
    await fx.sub.admin.as.mutation(api.payee.setPayoutEmail, { email: "kim.payouts@example.com" });
    const bay = await notificationsOf(t, fx.gcA.companyId);
    expect(bay.map((n) => n.userId).sort()).toEqual([fx.gcA.admin.userId, fx.gcA.member.userId].sort());
    let status = await fx.sub.admin.as.query(api.payee.myPayoutStatus, {});
    expect(status!.relationships.map((r) => [r.gcCompanyName, r.status])).toEqual([
      ["Bayview Builders Inc.", "pending"],
      ["Sonoran Interiors GC", "pending"],
    ]);
    await fx.gcA.admin.as.mutation(api.payee.confirmPayee, { vendorId: bayviewVendor, email: "kim.payouts@example.com" });
    const dup = await t.run((ctx) => ctx.db.get(duplicate));
    expect(dup?.payoutEmailConfirmed?.email).toBe("kim.payouts@example.com");
    status = await fx.sub.admin.as.query(api.payee.myPayoutStatus, {});
    expect(status!.relationships.map((r) => r.status)).toEqual(["confirmed", "pending"]);
  });

  test("the sub, another GC, the owner and a billing agent cannot confirm; a stale email is refused", async () => {
    const { t, fx, bayviewVendor } = await setup();
    await fx.sub.admin.as.mutation(api.payee.setPayoutEmail, { email: "kim.payouts@example.com" });
    const agentId = await t.run(async (ctx) => {
      const { id, ...fields } = agentIdProfile({ sub: "agent-sub-1", email: "boldlevel182@agentmail.to", name: "Agent" });
      const userId = await ctx.db.insert("users", fields);
      await syncAgentProfile(ctx, userId, { duringAgentIdSignIn: true });
      await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: id });
      return userId;
    });
    const agent = await withSession(t, agentId, "boldlevel182@agentmail.to");
    const before = await snapshot(t);
    const args = { vendorId: bayviewVendor, email: "kim.payouts@example.com" };
    expect(await errorOf(fx.sub.admin.as.mutation(api.payee.confirmPayee, args))).toBe("Not found.");
    expect(await errorOf(fx.gcB.admin.as.mutation(api.payee.confirmPayee, args))).toBe("Not found.");
    expect(await errorOf(fx.owner.admin.as.mutation(api.payee.confirmPayee, args))).toBe("Not found.");
    expect(await errorOf(agent.mutation(api.payee.confirmPayee, args))).toMatch(/company/i);
    expect(await errorOf(fx.gcA.admin.as.mutation(api.payee.confirmPayee, { vendorId: bayviewVendor, email: "old@example.com" }))).toMatch(
      /changed its payout email again/,
    );
    expect(await errorOf(fx.gcA.admin.as.mutation(api.payee.confirmPayee, { vendorId: "not-an-id", email: "x@example.com" }))).toBe("Not found.");
    expect(await snapshot(t)).toBe(before);
    expect(await errorOf(fx.gcB.admin.as.query(api.partyProfiles.getVendor, { vendorId: bayviewVendor }))).toBe("Not found.");
    expect(await errorOf(fx.sub.admin.as.query(api.partyProfiles.getVendor, { vendorId: bayviewVendor }))).toBe("Not found.");
  });

  test("changing the email clears every confirmation and the old address is never paid", async () => {
    const { t, fx, bayviewVendor, sonoranVendor } = await setup();
    await fx.sub.admin.as.mutation(api.payee.setPayoutEmail, { email: "kim.payouts@example.com" });
    await fx.gcA.admin.as.mutation(api.payee.confirmPayee, { vendorId: bayviewVendor, email: "kim.payouts@example.com" });
    await fx.gcB.admin.as.mutation(api.payee.confirmPayee, { vendorId: sonoranVendor, email: "kim.payouts@example.com" });
    const paid = await t.run((ctx) => payoutReceiverForContractor(ctx, fx.gcA.project.contractorId));
    expect(paid).toEqual({ ok: true, email: "kim.payouts@example.com", vendorId: bayviewVendor });

    await fx.sub.admin.as.mutation(api.payee.setPayoutEmail, { email: "kim.new@example.com" });
    const vendors = await t.run(async (ctx) => [await ctx.db.get(bayviewVendor), await ctx.db.get(sonoranVendor)]);
    expect(vendors.map((v) => v?.payoutEmailConfirmed)).toEqual([undefined, undefined]);
    const detail = await fx.gcA.admin.as.query(api.partyProfiles.getVendor, { vendorId: bayviewVendor });
    expect(detail.payee).toMatchObject({ status: "pending", currentEmail: "kim.new@example.com" });
    const blocked = await t.run((ctx) => payoutReceiverForContractor(ctx, fx.gcA.project.contractorId));
    expect(blocked).toEqual({ ok: false, reason: PAYEE_REASON.pending });
    const pending = (await notificationsOf(t, fx.gcA.companyId)).filter((n) => n.kind === "payee_change_pending");
    expect(pending).toHaveLength(4);
  });

  test("no payout without a linked company or a payout email", async () => {
    const { t, fx, bayviewVendor } = await setup();
    expect(await t.run((ctx) => payoutReceiverForContractor(ctx, fx.gcA.project.contractorId))).toEqual({ ok: false, reason: PAYEE_REASON.noEmail });
    await t.run((ctx) => ctx.db.patch(bayviewVendor, { linkedCompanyId: undefined }));
    expect(await t.run((ctx) => payoutReceiverForContractor(ctx, fx.gcA.project.contractorId))).toEqual({ ok: false, reason: PAYEE_REASON.notLinked });
  });
});

describe("owner billing email", () => {
  test("only owner admins set it; it is the project's invoice recipient and the GC sees it on the project", async () => {
    const { t, fx } = await setup();
    const ownerMember = await member(t, fx.owner.companyId, "frontdesk@harborpoint.test", "member");
    await t.run((ctx) => ctx.db.patch(fx.gcA.project.projectId, { ownerCompanyId: fx.owner.companyId, ownerName: "Harbor Point Dental LLC" }));
    expect(await t.run((ctx) => invoiceRecipientForProject(ctx, fx.gcA.project.projectId))).toEqual({
      ok: false,
      reason: noOwnerEmailReason("Harbor Point Dental LLC"),
    });

    const before = await snapshot(t);
    expect(await errorOf(fx.owner.admin.as.mutation(api.payee.setBillingEmail, { email: "ap@harbor" }))).toMatch(/valid email/);
    expect(await errorOf(ownerMember.as.mutation(api.payee.setBillingEmail, { email: "ap@harbor.test" }))).toMatch(/admin required/);
    expect(await errorOf(fx.gcA.admin.as.mutation(api.payee.setBillingEmail, { email: "ap@harbor.test" }))).toMatch(/Forbidden/);
    expect(await errorOf(fx.sub.admin.as.mutation(api.payee.setBillingEmail, { email: "ap@harbor.test" }))).toMatch(/Forbidden/);
    expect(await snapshot(t)).toBe(before);

    await fx.owner.admin.as.mutation(api.payee.setBillingEmail, { email: "AP@Harbor.test" });
    expect(await t.run((ctx) => invoiceRecipientForProject(ctx, fx.gcA.project.projectId))).toEqual({
      ok: true,
      email: "ap@harbor.test",
      ownerCompanyId: fx.owner.companyId,
      ownerCompanyName: "Harbor Point Dental LLC",
    });
    const owner = await fx.gcA.admin.as.query(api.partyProfiles.getProjectOwner, { projectId: fx.gcA.project.projectId });
    expect(owner.company).toMatchObject({ name: "Harbor Point Dental LLC", billingEmail: "ap@harbor.test" });
    expect(owner.invoicing).toEqual({ enabled: true, reason: null });
    expect(await errorOf(fx.gcB.admin.as.query(api.partyProfiles.getProjectOwner, { projectId: fx.gcA.project.projectId }))).toBe("Not found.");
    expect(await errorOf(fx.owner.admin.as.query(api.partyProfiles.getProjectOwner, { projectId: fx.gcA.project.projectId }))).toBe("Not found.");
  });

  test("a project without an owner company has invoicing disabled with the reason", async () => {
    const { fx } = await setup();
    const owner = await fx.gcB.admin.as.query(api.partyProfiles.getProjectOwner, { projectId: fx.gcB.project.projectId });
    expect(owner).toMatchObject({ company: null, invoicing: { enabled: false, reason: NO_PROJECT_OWNER_REASON } });
    expect(NO_PROJECT_OWNER_REASON).toMatch(/Invite the owner and set a billing email before invoicing/);
  });
});

describe("demo seed", () => {
  test("Demo subs get confirmed payees from PAYPAL_SANDBOX_SUB*_EMAIL and the Demo Owner bills PAYPAL_SANDBOX_OWNER_EMAIL", async () => {
    vi.stubEnv("PAYPAL_SANDBOX_SUB1_EMAIL", "Sub1-Sandbox@Personal.example.com");
    vi.stubEnv("PAYPAL_SANDBOX_OWNER_EMAIL", "owner-sandbox@business.example.com");
    try {
      const t = convexTest(schema, modules);
      await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
      await t.run(async (ctx) => {
        for (const email of ["gc@demo.tradepulse", "sub1@demo.tradepulse", "owner@demo.tradepulse"]) {
          await ctx.db.insert("users", { email, emailVerificationTime: Date.now() });
        }
      });
      await t.mutation(internal.demoAccounts.linkDemoProfilesInternal, {});
      await t.mutation(internal.demoAccounts.linkDemoProfilesInternal, {});
      const state = await t.run(async (ctx) => {
        const ids = await ensureDemoCompanies(ctx);
        const profile = await ctx.db
          .query("userProfiles")
          .collect()
          .then((rows) => rows.find((p) => p.displayName.includes("Rosendin")));
        const receiver = await payoutReceiverForContractor(ctx, profile!.contractorId!);
        return {
          owner: await ctx.db.get(ids.owner),
          rosendin: await ctx.db.get(ids["sub:rosendin"]),
          tdi: await ctx.db.get(ids["sub:tdindustries"]),
          receiver,
          demoProject: (await ctx.db.query("projects").collect()).find((p) => p.isDemoProject)!._id,
        };
      });
      expect(state.owner?.billingEmail).toBe("owner-sandbox@business.example.com");
      expect(state.rosendin?.payoutPaypalEmail).toBe("sub1-sandbox@personal.example.com");
      expect(state.tdi?.payoutPaypalEmail).toBeUndefined();
      expect(state.receiver).toMatchObject({ ok: true, email: "sub1-sandbox@personal.example.com" });
      const recipient = await t.run((ctx) => invoiceRecipientForProject(ctx, state.demoProject));
      expect(recipient).toMatchObject({ ok: true, email: "owner-sandbox@business.example.com" });

      // Each confirmation the seed makes is audited once (the unchanged rerun adds none), without the email.
      const confirmed = async () =>
        await t.run(async (ctx) => {
          const ids = await ensureDemoCompanies(ctx);
          return (await ctx.db.query("vendors").collect()).filter((v) => v.companyId === ids.gc && v.payoutEmailConfirmed !== undefined);
        });
      const audits = async () =>
        await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).filter((a) => a.eventType === "payee_confirmed"));
      const vendors = await confirmed();
      expect(vendors.length).toBeGreaterThan(0);
      let entries = await audits();
      expect(entries).toHaveLength(vendors.length);
      const gcUser = await t.run(async (ctx) => (await ctx.db.query("users").collect()).find((u) => u.email === "gc@demo.tradepulse")!);
      for (const e of entries) {
        expect(e).toMatchObject({ actorUserId: gcUser._id, actorCompanyId: vendors[0].companyId });
        expect(e.description).toContain("demo seed");
        expect(e.description).not.toMatch(/sandbox@/i);
      }
      // A reset that restores a cleared confirmation audits that restoration.
      await t.run((ctx) => ctx.db.patch(vendors[0]._id, { payoutEmailConfirmed: undefined }));
      await t.mutation(internal.demoAccounts.linkDemoProfilesInternal, {});
      entries = await audits();
      expect(entries).toHaveLength(vendors.length + 1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("company profiles are edited by their own admins only", () => {
  test("sub and owner admins edit their profile; the GC sees it; a GC edit changes only the GC's own company", async () => {
    const { t, fx, bayviewVendor } = await setup();
    const address = { line1: "1200 Mandela Pkwy", city: "Oakland", state: "ca", zip: "94607" };
    await fx.sub.admin.as.mutation(api.companies.updateProfile, { name: "Eastbay Electric", legalName: "Eastbay Electric Inc.", phone: "5105550187", address });
    await fx.owner.admin.as.mutation(api.companies.updateProfile, { name: "Harbor Point Dental LLC", legalName: "Harbor Point Dental, LLC", phone: "5105550100" });
    const detail = await fx.gcA.admin.as.query(api.partyProfiles.getVendor, { vendorId: bayviewVendor });
    expect(detail.linkedCompany).toMatchObject({ legalName: "Eastbay Electric Inc.", phone: "(510) 555-0187", address: { line1: "1200 Mandela Pkwy", state: "CA" } });

    await fx.gcA.admin.as.mutation(api.companies.updateProfile, { name: "Bayview Builders Inc.", legalName: "Bayview Builders, Inc." });
    const companies = await t.run(async (ctx) => [await ctx.db.get(fx.sub.companyId), await ctx.db.get(fx.gcA.companyId)]);
    expect(companies[0]?.legalName).toBe("Eastbay Electric Inc.");
    expect(companies[1]?.legalName).toBe("Bayview Builders, Inc.");
    // The company always comes from the session; there is no way to name another company.
    await expect(
      fx.gcA.admin.as.mutation(api.companies.updateProfile, { name: "Hacked", companyId: fx.sub.companyId } as never),
    ).rejects.toThrow();
    const kimMember = await member(t, fx.sub.companyId, "estimator@eastbay.test", "member");
    expect(await errorOf(kimMember.as.mutation(api.companies.updateProfile, { name: "Hacked" }))).toMatch(/admin required/);
  });
});
