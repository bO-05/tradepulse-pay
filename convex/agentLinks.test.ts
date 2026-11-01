/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { agentIdProfile, syncAgentProfile } from "./lib/agentAccess";
import { getViewer } from "./lib/roles";
import { AgentID, AGENTID_SCOPES } from "./auth";
import { withSession, signInAs } from "./lib/testIdentity";

const modules = import.meta.glob("./**/*.ts");

const AGENT_EMAIL = "boldlevel182@agentmail.to";

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const ids = await t.run(async (ctx) => {
    const contractors = await ctx.db.query("contractors").collect();
    const byName = (name: string): Id<"contractors"> => contractors.find((c) => c.companyName === name)!._id;
    return { rosendin: byName("Rosendin Electric, Inc."), tdi: byName("TDIndustries, Inc.") };
  });
  const gc = await signInAs(t, "gc", { email: "gc@test.tradepulse" });
  return { t, gc: gc.as, ...ids };
}

/** Mirrors a completed AgentID sign-in: users row from profile(), authAccounts row, auth callback sync. */
async function signInAgent(t: TestConvex<typeof schema>, email: string, sub = "zJQyRw" + "x".repeat(37)) {
  const userId = await t.run(async (ctx) => {
    const { id, ...fields } = agentIdProfile({
      sub,
      email,
      name: "Billing Agent",
      owner_sub: "owner-sub-1",
      owner_name: "Pat Owner",
      owner_email: "pat@example.com",
    });
    const userId = await ctx.db.insert("users", fields);
    await syncAgentProfile(ctx, userId, { duringAgentIdSignIn: true });
    await ctx.db.insert("authAccounts", { userId, provider: "agentid", providerAccountId: id });
    return userId;
  });
  return { userId, as: await withSession(t, userId, email) };
}

describe("AgentID provider config", () => {
  test("uses the registered OIDC settings", () => {
    expect(AgentID.id).toBe("agentid");
    expect(AgentID.type).toBe("oidc");
    expect(AgentID.issuer).toBe("https://auth.agentid.com");
    expect(AgentID.checks).toEqual(["pkce", "state", "nonce"]);
    expect(AgentID.allowDangerousEmailAccountLinking).toBe(false);
    expect(AGENTID_SCOPES).toBe("openid email profile owner_profile owner_email");
    const auth = AgentID.authorization as { params: { scope: string } };
    expect(auth.params.scope).toBe(AGENTID_SCOPES);
  });
});

describe("agentIdProfile", () => {
  test("maps sub, email, name and owner claims with actorType agent", () => {
    expect(
      agentIdProfile({
        sub: "s1",
        email: "BoldLevel182@AgentMail.to",
        name: "Bold",
        owner_sub: "o1",
        owner_name: "Owner",
        owner_email: "Owner@Example.com",
      }),
    ).toEqual({
      id: "s1",
      email: "boldlevel182@agentmail.to",
      name: "Bold",
      actorType: "agent",
      agentSub: "s1",
      ownerSub: "o1",
      ownerName: "Owner",
      ownerEmail: "owner@example.com",
    });
  });

  test("omits missing or null claims instead of storing null", () => {
    const fields = agentIdProfile({ sub: "s2", email: null, owner_email: null, preferred_username: "inbox" });
    expect(fields).toEqual({ id: "s2", name: "inbox", actorType: "agent", agentSub: "s2" });
    expect(Object.values(fields)).not.toContain(null);
    expect(Object.values(fields)).not.toContain(undefined);
  });
});

describe("billing-agent links", () => {
  test("an unlinked agent has no role and every guarded call is rejected", async () => {
    const { t } = await setup();
    const agent = await signInAgent(t, "dullstreet57@agentmail.to");
    const me = await agent.as.query(api.profiles.me, {});
    expect(me).toMatchObject({ role: null, actorType: "agent", email: "dullstreet57@agentmail.to", ownerName: "Pat Owner" });
    await expect(agent.as.query(api.agentLinks.listAgentLinks, {})).rejects.toThrow(/no TradePulse role/);
    await expect(agent.as.query(api.portal.mySubPortal, {})).rejects.toThrow(/no TradePulse role/);
    const profiles = await t.run((ctx) => ctx.db.query("userProfiles").collect());
    expect(profiles.filter((p) => p.userId === agent.userId)).toHaveLength(0);
  });

  test("a linked agent resolves to role sub for the linked contractor, and revocation applies on the next request", async () => {
    const { t, gc, rosendin } = await setup();
    const linkId = await gc.mutation(api.agentLinks.addAgentLink, { agentEmail: " BoldLevel182@agentmail.to ", contractorId: rosendin });
    const agent = await signInAgent(t, AGENT_EMAIL);

    const me = await agent.as.query(api.profiles.me, {});
    expect(me).toMatchObject({ role: "sub", actorType: "agent", contractorId: rosendin, contractorName: "Rosendin Electric, Inc." });
    const profile = await t.run((ctx) =>
      ctx.db.query("userProfiles").withIndex("by_userId", (q) => q.eq("userId", agent.userId)).unique(),
    );
    expect(profile).toMatchObject({ role: "sub", actorType: "agent", contractorId: rosendin, agentEmail: AGENT_EMAIL, ownerEmail: "pat@example.com", ownerName: "Pat Owner" });

    const links = await gc.query(api.agentLinks.listAgentLinks, {});
    expect(links).toMatchObject([{ agentEmail: AGENT_EMAIL, contractorName: "Rosendin Electric, Inc.", status: "active" }]);

    await gc.mutation(api.agentLinks.revokeAgentLink, { linkId });
    expect(await agent.as.query(api.profiles.me, {})).toMatchObject({ role: null });
    await expect(agent.as.query(api.portal.mySubPortal, {})).rejects.toThrow(/no TradePulse role/);

    await gc.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: rosendin });
    expect(await agent.as.query(api.profiles.me, {})).toMatchObject({ role: "sub", contractorId: rosendin });
  });

  test("revoking the link denies access even if a stale profile row remains", async () => {
    const { t, gc, rosendin } = await setup();
    const linkId = await gc.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: rosendin });
    const agent = await signInAgent(t, AGENT_EMAIL);
    await t.run(async (ctx) => {
      await ctx.db.patch(linkId, { status: "revoked" });
    });
    expect(await agent.as.run((ctx) => getViewer(ctx))).toBeNull();
  });

  test("a link added after the agent signed in grants access on the next request", async () => {
    const { t, gc, tdi } = await setup();
    const agent = await signInAgent(t, AGENT_EMAIL);
    expect(await agent.as.query(api.profiles.me, {})).toMatchObject({ role: null });
    await gc.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: tdi });
    expect(await agent.as.query(api.profiles.me, {})).toMatchObject({ role: "sub", contractorId: tdi });
  });

  test("a password user with a linked email address does not become an agent", async () => {
    const { t, gc, rosendin } = await setup();
    const human = await signInAs(t, null, { email: AGENT_EMAIL });
    await gc.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: rosendin });
    expect(await human.as.query(api.profiles.me, {})).toMatchObject({ role: null });
  });

  test("an agent-typed user without an AgentID account gets no access", async () => {
    const { t, gc, rosendin } = await setup();
    await gc.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: rosendin });
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: AGENT_EMAIL, actorType: "agent" });
      await ctx.db.insert("userProfiles", { userId: id, role: "sub", displayName: "x", contractorId: rosendin, actorType: "agent", createdAt: 0 });
      return id;
    });
    const as = await withSession(t, userId);
    expect(await as.run((ctx) => getViewer(ctx))).toBeNull();
  });

  test("only the GC can add or revoke links", async () => {
    const { t, gc, rosendin } = await setup();
    const linkId = await gc.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: rosendin });
    const sub = await signInAs(t, "sub", { contractorId: rosendin });
    const owner = await signInAs(t, "owner");
    const agent = await signInAgent(t, AGENT_EMAIL);
    for (const caller of [sub.as, owner.as, agent.as]) {
      await expect(caller.mutation(api.agentLinks.addAgentLink, { agentEmail: "x@agentmail.to", contractorId: rosendin })).rejects.toThrow(/Not found/);
      await expect(caller.mutation(api.agentLinks.revokeAgentLink, { linkId })).rejects.toThrow(/Forbidden/);
      await expect(caller.query(api.agentLinks.listAgentLinks, {})).rejects.toThrow(/Forbidden/);
    }
    await expect(t.mutation(api.agentLinks.addAgentLink, { agentEmail: "x@agentmail.to", contractorId: rosendin })).rejects.toThrow(/Not authenticated/);
  });

  test("rejects invalid emails and a second active link for another contractor", async () => {
    const { gc, rosendin, tdi } = await setup();
    await expect(gc.mutation(api.agentLinks.addAgentLink, { agentEmail: "not-an-email", contractorId: rosendin })).rejects.toThrow(/valid agent email/);
    const first = await gc.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: rosendin });
    expect(await gc.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: rosendin })).toBe(first);
    await expect(gc.mutation(api.agentLinks.addAgentLink, { agentEmail: AGENT_EMAIL, contractorId: tdi })).rejects.toThrow(/already authorized/);
  });
});
