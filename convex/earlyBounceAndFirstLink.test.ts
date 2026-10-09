/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { buildTenancyFixture, insertProjectFor } from "./lib/tenancyFixtures";

const modules = import.meta.glob("./**/*.ts");
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("a rejection recorded before the send's ids are stored never becomes an RFQ success", async () => {
  vi.stubEnv("AGENTMAIL_API_KEY", "test-fake-key");
  vi.stubEnv("EMAIL_DAILY_BUDGET", "60");
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  await t.run((ctx) => ctx.db.patch(f.gcA.project.contractorId, { contactEmail: "bidder@example.test" }));
  vi.stubGlobal("fetch", async () => {
    await t.mutation(internal.emailOutbox.recordDeliveryEvent, {
      agentmailMessageId: "<early@example.test>",
      event: "rejected",
    });
    return new Response(JSON.stringify({ message_id: "<early@example.test>", thread_id: "early-thread" }), { status: 200 });
  });
  const result = await f.gcA.admin.as.action(api.rfqActions.dispatchSingleRfqWithNotification, {
    contractorId: f.gcA.project.contractorId,
  });
  expect(result.emailSent).toBe(false);
  expect(result.emailStatus).toBe("failed");
  expect(result.emailError).toMatch(/rejected/);

  const outbox = await t.query(internal.emailOutbox.listForDay, {});
  expect(outbox.rows).toMatchObject([{ status: "delivery_failed" }]);
  const status = await f.gcA.admin.as.query(api.rfq.getProjectDeliveryStatus, { projectId: f.gcA.project.projectId });
  expect(Object.values(status).map((s) => s.sent)).toEqual([0]);
  const titles = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).map((l) => l.title));
  expect(titles.some((title) => /^AgentMail Delivery: 1 of/.test(title))).toBe(false);
});

test("first sub-company link stamps every historical pay application", async () => {
  vi.stubEnv("SITE_URL", "http://localhost:3150");
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const f = await buildTenancyFixture(t);
  const total = 522;
  const fresh = await t.run(async (ctx) => {
    const p = await insertProjectFor(ctx, f.gcA.companyId, { title: "First human link", bidderName: "Eastbay Electric" });
    await ctx.db.patch(p.contractorId, { contactEmail: f.sub.admin.email });
    for (let i = 0; i < total; i++) {
      await ctx.db.insert("payApplications", {
        agreementId: p.agreementId,
        contractorId: p.contractorId,
        subUserId: f.sub.admin.userId,
        periodLabel: `Historical #${i}`,
        lines: [],
        requestedTotalCents: 0,
        notes: "",
        lienWaiver: true,
        status: "rejected",
        submittedBy: { userId: f.sub.admin.userId, actorType: "agent" },
        createdAt: Date.now() + i,
      });
    }
    return p;
  });
  // Before the contractor has a company the migration cannot fill subCompanyId.
  await t.mutation(internal.payApps.backfill.backfillPayAppContractorIds, {});
  await t.finishAllScheduledFunctions(() => {});
  const invite = await f.gcA.admin.as.action(api.invites.create, {
    kind: "sub",
    email: f.sub.admin.email,
    projectId: fresh.projectId,
    newVendor: { name: "Eastbay Electric", contactName: "Kim", trade: "26 00 00" },
    sendEmail: false,
  });
  const token = invite.link.split("#/invite/")[1];
  await f.sub.admin.as.mutation(api.invites.accept, { token });
  await t.finishAllScheduledFunctions(() => {});

  let cursor: string | null = null;
  let count = 0;
  for (let i = 0; i < 30; i++) {
    const page: { page: unknown[]; isDone: boolean; continueCursor: string } = await f.sub.admin.as.query(api.portal.mySubPayApps, { paginationOpts: { cursor, numItems: 25 } });
    count += page.page.length;
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  const unstamped = await t.run(async (ctx) => (await ctx.db.query("payApplications").collect())
    .filter((p) => p.agreementId === fresh.agreementId && p.subCompanyId === undefined).length);
  expect(unstamped).toBe(0);
  expect(count).toBe(total);
});
