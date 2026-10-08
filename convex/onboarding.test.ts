/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";

const modules = import.meta.glob("./**/*.ts");

const BAYVIEW = {
  name: "Bayview Builders Inc.",
  address: { line1: "455 Embarcadero W", city: "Oakland", state: "ca", zip: "94607" },
  phone: "510-555-0187",
};

async function newUser(t: ReturnType<typeof convexTest>, email: string, verified = true) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { email, name: "Dana Whitfield", emailVerificationTime: verified ? Date.now() : undefined }),
  );
  return { userId, as: t.withIdentity({ subject: `${userId}|s1`, email }) };
}

async function companyRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => await ctx.db.query("companies").collect());
}

describe("onboarding.createCompany", () => {
  test("a verified user creates a GC company and becomes its active admin with a gc profile", async () => {
    const t = convexTest(schema, modules);
    const dana = await newUser(t, "dana@bayview-mail.com");
    const { companyId } = await dana.as.mutation(api.onboarding.createCompany, BAYVIEW);
    const rows = await t.run(async (ctx) => ({
      company: await ctx.db.get(companyId),
      members: await ctx.db.query("companyMembers").withIndex("by_companyId", (q) => q.eq("companyId", companyId)).collect(),
      profile: await ctx.db.query("userProfiles").withIndex("by_userId", (q) => q.eq("userId", dana.userId)).unique(),
    }));
    expect(rows.company).toMatchObject({
      name: "Bayview Builders Inc.",
      kind: "gc",
      isDemo: false,
      createdByUserId: dana.userId,
      address: { line1: "455 Embarcadero W", city: "Oakland", state: "CA", zip: "94607" },
      phone: "(510) 555-0187",
    });
    expect(rows.members).toEqual([expect.objectContaining({ userId: dana.userId, role: "admin", status: "active" })]);
    expect(rows.profile).toMatchObject({ role: "gc", companyId, displayName: "Dana Whitfield" });

    const me = await dana.as.query(api.profiles.me, {});
    expect(me).toMatchObject({ role: "gc", emailVerified: true, company: { name: "Bayview Builders Inc.", kind: "gc", memberRole: "admin" } });
  });

  test("runs once: a second call fails and creates nothing", async () => {
    const t = convexTest(schema, modules);
    const dana = await newUser(t, "dana@bayview-mail.com");
    await dana.as.mutation(api.onboarding.createCompany, BAYVIEW);
    await expect(dana.as.mutation(api.onboarding.createCompany, { ...BAYVIEW, name: "Bayview Two" })).rejects.toThrow(
      /You already belong to a company/,
    );
    expect((await companyRows(t)).map((c) => c.name)).toEqual(["Bayview Builders Inc."]);
  });

  test("unverified and signed-out callers are refused", async () => {
    const t = convexTest(schema, modules);
    const unverified = await newUser(t, "pending@bayview-mail.com", false);
    await expect(unverified.as.mutation(api.onboarding.createCompany, BAYVIEW)).rejects.toThrow(/Verify your email/);
    await expect(t.mutation(api.onboarding.createCompany, BAYVIEW)).rejects.toThrow(/Not authenticated/);
    expect(await companyRows(t)).toHaveLength(0);
    const me = await unverified.as.query(api.profiles.me, {});
    expect(me).toMatchObject({ emailVerified: false, company: null, role: null });
  });

  test("invalid fields are rejected with readable messages and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const dana = await newUser(t, "dana@bayview-mail.com");
    for (const [patch, message] of [
      [{ name: "" }, /Enter your company name/],
      [{ name: "B" }, /at least 2 characters/],
      [{ address: { ...BAYVIEW.address, state: "ZZ" } }, /Choose a state/],
      [{ address: { ...BAYVIEW.address, zip: "946" } }, /5-digit ZIP/],
      [{ phone: "555-01" }, /10-digit US phone/],
    ] as const) {
      await expect(dana.as.mutation(api.onboarding.createCompany, { ...BAYVIEW, ...patch })).rejects.toThrow(message);
    }
    expect(await companyRows(t)).toHaveLength(0);
  });

  test("a client-supplied companyId is rejected by validation and other companies stay unchanged", async () => {
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const before = await t.run(async (ctx) => await ctx.db.get(f.gcB.companyId));
    await expect(
      f.noCompany.as.mutation(api.onboarding.createCompany, { ...BAYVIEW, companyId: f.gcB.companyId } as any),
    ).rejects.toThrow(/extra field|Validator|companyId/i);
    // Members of an existing company (another GC, a sub, the Demo GC) can't onboard again.
    for (const user of [f.gcA.admin, f.gcB.admin, f.sub.admin, f.owner.admin, f.demo.gc]) {
      await expect(user.as.mutation(api.onboarding.createCompany, BAYVIEW)).rejects.toThrow(/already belong/);
    }
    expect(await t.run(async (ctx) => await ctx.db.get(f.gcB.companyId))).toEqual(before);

    // The verified fixture user without a company onboards into a new company only.
    const { companyId } = await f.noCompany.as.mutation(api.onboarding.createCompany, BAYVIEW);
    expect([f.gcA.companyId, f.gcB.companyId, f.sub.companyId, f.owner.companyId]).not.toContain(companyId);
    const profile = await t.run(async (ctx) =>
      ctx.db.query("userProfiles").withIndex("by_userId", (q) => q.eq("userId", f.noCompany.userId)).unique(),
    );
    expect(profile).toMatchObject({ role: "gc", companyId });
  });
});
