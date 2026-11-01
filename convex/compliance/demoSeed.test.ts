/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../schema";
import { buildTenancyFixture, insertProjectFor } from "../lib/tenancyFixtures";
import { ensureDemoProjectCompliance } from "./demoSeed";
import { complianceForAgreement } from "./status";

const modules = import.meta.glob("/convex/**/*.ts");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  const ids = f.demo.companyIds;
  const subId = ids["sub:rosendin"];
  const project = f.demo.project;
  const { vendorId, memberId } = await t.run(async (ctx) => {
    const vendorId = await ctx.db.insert("vendors", {
      companyId: ids.gc,
      name: "Demo sub fixture",
      trades: ["26 00 00"],
      contactName: "Demo",
      email: "demo@example.invalid",
      linkedCompanyId: subId,
      status: "active",
      createdAt: Date.now(),
    });
    await ctx.db.patch(project.contractorId, { vendorId, linkedCompanyId: subId, licenseNumber: "1000000" });
    const memberId = await ctx.db.insert("projectMembers", {
      projectId: project.projectId, companyId: subId, partyRole: "sub", vendorId,
      contractorId: project.contractorId, status: "active", createdAt: Date.now(),
    });
    return { vendorId, memberId };
  });
  const seed = () => t.run((ctx) => ensureDemoProjectCompliance(ctx, ids, project.projectId, f.demo.gc.userId));
  return { t, f, ids, subId, project, vendorId, memberId, seed };
}

test("seeds only the selected project, labels and audits fileless fixtures, and keeps CSLB unverified", async () => {
  const s = await setup();
  const historical = await s.t.run((ctx) => insertProjectFor(ctx, s.ids.gc, {
    title: "Historical demo", subCompanyId: s.subId,
  }));
  expect(await s.seed()).toEqual({ itemsCreated: 3 });
  const before = await s.t.run((ctx) => ctx.db.query("complianceItems").collect());
  expect(before).toHaveLength(3);
  expect(before.every((r) => r.projectId === s.project.projectId && r.demoRecord === true &&
    r.status === "accepted" && r.documentId === undefined)).toBe(true);
  expect(before.find((r) => r.kind === "license")?.license).toMatchObject({
    licenseNumber: "1000000", state: "CA", verification: "unverified",
  });
  const result = await s.t.run(async (ctx) => ({
    compliance: await complianceForAgreement(ctx, (await ctx.db.get(s.project.agreementId))!),
    historical: await complianceForAgreement(ctx, (await ctx.db.get(historical.agreementId))!),
    checks: await ctx.db.query("licenseChecks").collect(),
    docs: await ctx.db.query("documents").collect(),
    audits: await ctx.db.query("auditLogs").collect(),
  }));
  expect(result.compliance?.result.status).toBe("compliant");
  expect(result.historical?.result.status).toBe("missing");
  expect(result.checks).toHaveLength(0);
  expect(result.docs).toHaveLength(0);
  expect(result.audits).toMatchObject([{
    projectId: s.project.projectId, eventType: "compliance_seeded", actor: "system:demo-seed",
    description: expect.stringContaining("(no files)"),
  }]);
  expect(await s.seed()).toEqual({ itemsCreated: 0 });
  expect(await s.t.run((ctx) => ctx.db.query("complianceItems").collect())).toEqual(before);
  expect(await s.t.run((ctx) => ctx.db.query("auditLogs").collect())).toHaveLength(1);
});

test.each([
  "real GC", "wrong GC key", "wrong GC kind", "other project GC", "unowned project",
  "real sub", "wrong sub key", "wrong sub kind", "removed membership", "owner membership",
  "vendor linked to real sub", "vendor owned by real GC",
] as const)("refuses %s without writing compliance or audit records", async (guard) => {
  const s = await setup();
  await s.t.run(async (ctx) => {
    switch (guard) {
      case "real GC": await ctx.db.patch(s.ids.gc, { isDemo: false }); break;
      case "wrong GC key": await ctx.db.patch(s.ids.gc, { demoKey: "not-gc" }); break;
      case "wrong GC kind": await ctx.db.patch(s.ids.gc, { kind: "sub" }); break;
      case "other project GC": await ctx.db.patch(s.project.projectId, { gcCompanyId: s.f.gcA.companyId }); break;
      case "unowned project": await ctx.db.patch(s.project.projectId, { gcCompanyId: undefined }); break;
      case "real sub": await ctx.db.patch(s.subId, { isDemo: false }); break;
      case "wrong sub key": await ctx.db.patch(s.subId, { demoKey: "sub:other" }); break;
      case "wrong sub kind": await ctx.db.patch(s.subId, { kind: "owner" }); break;
      case "removed membership": await ctx.db.patch(s.memberId, { status: "removed" }); break;
      case "owner membership": await ctx.db.patch(s.memberId, { partyRole: "owner" }); break;
      case "vendor linked to real sub": await ctx.db.patch(s.vendorId, { linkedCompanyId: s.f.sub.companyId }); break;
      case "vendor owned by real GC": await ctx.db.patch(s.vendorId, { companyId: s.f.gcA.companyId }); break;
    }
  });
  expect(await s.seed()).toEqual({ itemsCreated: 0 });
  expect(await s.t.run((ctx) => ctx.db.query("complianceItems").collect())).toHaveLength(0);
  expect(await s.t.run((ctx) => ctx.db.query("auditLogs").collect())).toHaveLength(0);
});

test("never seeds a real project even with demo subs and never changes existing records", async () => {
  const s = await setup();
  await s.t.run(async (ctx) => {
    await ctx.db.insert("projectMembers", {
      projectId: s.f.gcA.project.projectId, companyId: s.subId, partyRole: "sub",
      vendorId: s.vendorId, status: "active", createdAt: Date.now(),
    });
    await ctx.db.insert("complianceItems", {
      projectId: s.project.projectId, vendorId: s.vendorId, companyId: s.subId, gcCompanyId: s.ids.gc,
      kind: "w9", status: "accepted", uploadedByName: "Existing fixture",
      w9: { entityType: "s_corporation", tinLast4: "1234", signedDate: "2026-10-01" },
      createdAt: Date.now(),
    });
  });
  const before = await s.t.run((ctx) => ctx.db.query("complianceItems").collect());
  expect(await s.t.run((ctx) => ensureDemoProjectCompliance(ctx, s.ids, s.f.gcA.project.projectId, null)))
    .toEqual({ itemsCreated: 0 });
  expect(await s.seed()).toEqual({ itemsCreated: 2 });
  expect(await s.t.run((ctx) => ctx.db.get(before[0]._id))).toEqual(before[0]);
  const realItems = await s.t.run((ctx) => ctx.db.query("complianceItems")
    .withIndex("by_projectId_and_vendorId", (q) => q.eq("projectId", s.f.gcA.project.projectId)).collect());
  expect(realItems).toHaveLength(0);
});
