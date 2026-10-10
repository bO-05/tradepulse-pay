/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";

/** New project wizard, Project settings and archive/restore (architecture §14, VAL-PROJ / VAL-ISO-003). */

const modules = import.meta.glob("./**/*.ts");
type T = TestConvex<typeof schema>;
type Caller = Pick<T, "query" | "mutation">;
const NOT_FOUND = JSON.stringify({ code: "NOT_FOUND", message: "Not found." });

const CA_PROJECT = {
  title: "Harbor Point Dental Office TI",
  ownerName: "Harbor Point Dental LLC",
  address: { line1: "455 Embarcadero W", city: "Oakland", state: "CA", zip: "94607" },
  state: "CA",
  contractValueCents: 124_000_000,
  retainageBps: 500,
  billingDay: 25,
  startDate: "2026-10-01",
  substantialCompletionDate: "2027-05-28",
};

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "RESOLVED";
  } catch (err) {
    const data = (err as { data?: unknown }).data;
    if (data !== undefined) return typeof data === "string" ? data : JSON.stringify(data);
    return (err as Error).message;
  }
}

async function errorData(p: Promise<unknown>): Promise<{ code?: string; field?: string; message?: string }> {
  try {
    await p;
  } catch (err) {
    return ((err as { data?: unknown }).data ?? {}) as { code?: string; field?: string; message?: string };
  }
  throw new Error("expected the call to fail");
}

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await buildTenancyFixture(t);
  const projectId = (await fx.gcA.admin.as.mutation(api.projects.createProject, CA_PROJECT)) as Id<"projects">;
  return { t, fx, projectId };
}

async function freshProjectId(t: T): Promise<Id<"projects">> {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("projects", {
      title: "gone",
      location: "x",
      projectType: "x",
      estBudget: 1,
      targetCompletionWeeks: 1,
      specDocumentText: "x",
      isDemoProject: false,
      createdAt: Date.now(),
    });
    await ctx.db.delete(id);
    return id;
  });
}

describe("createProject", () => {
  test("stores the wizard values exactly, in cents and basis points, on the caller's company", async () => {
    const { t, fx, projectId } = await setup();
    const row = await t.run((ctx) => ctx.db.get(projectId));
    expect(row).toMatchObject({
      gcCompanyId: fx.gcA.companyId,
      title: "Harbor Point Dental Office TI",
      ownerName: "Harbor Point Dental LLC",
      address: { line1: "455 Embarcadero W", city: "Oakland", state: "CA", zip: "94607" },
      state: "CA",
      contractValueCents: 124_000_000,
      retainageBps: 500,
      billingDay: 25,
      startDate: "2026-10-01",
      substantialCompletionDate: "2027-05-28",
      status: "active",
      location: "Oakland, CA",
    });
    expect(row?.ownerCompanyId).toBeUndefined();
  });

  test("rejects invalid values server-side with a readable, field-tagged error", async () => {
    const { t, fx } = await setup();
    const count = async () => (await t.run((ctx) => ctx.db.query("projects").collect())).length;
    const before = await count();
    const cases: [Record<string, unknown>, string, RegExp][] = [
      [{ billingDay: 31 }, "billingDay", /Billing day must be between 1 and 28/],
      [{ billingDay: 0 }, "billingDay", /Billing day/],
      [{ contractValueCents: -1 }, "contractValueCents", /greater than \$0\.00/],
      [{ contractValueCents: 0 }, "contractValueCents", /greater than \$0\.00/],
      [{ contractValueCents: 1.5 }, "contractValueCents", /whole number of cents/],
      [{ title: "  " }, "title", /project name/],
      [{ state: "" }, "state", /state/],
      [{ address: { ...CA_PROJECT.address, zip: "9460" } }, "zip", /ZIP/],
      [{ substantialCompletionDate: "2026-09-01" }, "substantialCompletionDate", /before the start date/],
      [{ retainageBps: 1000 }, "retainageBps", /Cal\. Civ\. Code §8811.*not legal advice/],
      [{ retainageBps: 12_000 }, "retainageBps", /between 0% and 100%/],
      [{ address: { ...CA_PROJECT.address, state: "NV" } }, "state", /must match/],
    ];
    for (const [patch, field, message] of cases) {
      const data = await errorData(fx.gcA.admin.as.mutation(api.projects.createProject, { ...CA_PROJECT, ...patch } as typeof CA_PROJECT));
      expect(data.field, JSON.stringify(patch)).toBe(field);
      expect(data.message, JSON.stringify(patch)).toMatch(message);
    }
    expect(await count()).toBe(before);
  });

  test.each([
    ["NV", 9_000_000, 600, false],
    ["WA", 9_000_000, 600, false],
    ["OR", 9_000_000, 600, false],
    ["NV", 9_000_000, 500, true],
    ["NY", 14_999_999, 1000, true],
    ["NY", 15_000_000, 1000, false],
    ["NY", 15_000_000, 500, true],
    ["CO", 14_999_999, 1000, true],
    ["CO", 15_000_000, 1000, false],
    ["TX", 61_250_000, 1000, true],
    ["AZ", 61_250_000, 1000, true],
    ["FL", 61_250_000, 1000, true],
  ])("%s, %i cents, %i bps -> accepted %s", async (state, contractValueCents, retainageBps, accepted) => {
    const { fx } = await setup();
    const args = { ...CA_PROJECT, address: { ...CA_PROJECT.address, state }, state, contractValueCents, retainageBps };
    const result = await outcome(fx.gcB.admin.as.mutation(api.projects.createProject, args));
    if (accepted) expect(result).toBe("RESOLVED");
    else expect(result).toMatch(/caps retainage at 5%.*not legal advice/);
  });

  test("a client-supplied gcCompanyId is rejected; the project is the caller's", async () => {
    const { fx } = await setup();
    await expect(
      fx.gcA.admin.as.mutation(api.projects.createProject, { ...CA_PROJECT, gcCompanyId: fx.gcB.companyId } as typeof CA_PROJECT),
    ).rejects.toThrow();
  });
});

describe("updateProject", () => {
  test("the GC saves new settings; a NY contract raised to $150,000.00 is blocked until retainage is 5%", async () => {
    const { t, fx, projectId } = await setup();
    await fx.gcA.admin.as.mutation(api.projects.updateProject, {
      projectId,
      ...CA_PROJECT,
      billingDay: 20,
      contractValueCents: 126_250_000,
      substantialCompletionDate: "2027-06-18",
    });
    expect(await t.run((ctx) => ctx.db.get(projectId))).toMatchObject({
      billingDay: 20,
      contractValueCents: 126_250_000,
      substantialCompletionDate: "2027-06-18",
    });

    const ny = { ...CA_PROJECT, address: { ...CA_PROJECT.address, state: "NY" }, state: "NY", contractValueCents: 14_999_999, retainageBps: 1000 };
    const nyId = (await fx.gcA.admin.as.mutation(api.projects.createProject, ny)) as Id<"projects">;
    const raised = await errorData(fx.gcA.admin.as.mutation(api.projects.updateProject, { projectId: nyId, ...ny, contractValueCents: 15_000_000 }));
    expect(raised.field).toBe("retainageBps");
    expect(raised.message).toContain("N.Y. Gen. Bus. Law §756-c");
    await fx.gcA.admin.as.mutation(api.projects.updateProject, { projectId: nyId, ...ny, contractValueCents: 15_000_000, retainageBps: 500 });
    expect((await t.run((ctx) => ctx.db.get(nyId)))?.retainageBps).toBe(500);
  });

  test("another company, the project's sub and owner, and a missing id all get the same refusal; nothing changes", async () => {
    const { t, fx, projectId } = await setup();
    const missing = await freshProjectId(t);
    const before = JSON.stringify(await t.run((ctx) => ctx.db.get(projectId)));
    const expected = await outcome(fx.gcB.admin.as.mutation(api.projects.updateProject, { projectId: missing, ...CA_PROJECT }));
    expect(expected).toBe(NOT_FOUND);
    const callers: [string, Caller][] = [
      ["other GC", fx.gcB.admin.as],
      ["sub", fx.sub.admin.as],
      ["owner", fx.owner.admin.as],
      ["demo GC", fx.demo.gc.as],
    ];
    for (const [label, caller] of callers) {
      const args = { projectId, ...CA_PROJECT, billingDay: 3 };
      expect(await outcome(caller.mutation(api.projects.updateProject, args)), label).toBe(NOT_FOUND);
      expect(await outcome(caller.mutation(api.projects.archiveProject, { projectId })), label).toBe(NOT_FOUND);
      expect(await outcome(caller.mutation(api.projects.restoreProject, { projectId })), label).toBe(NOT_FOUND);
    }
    expect(await outcome(fx.gcB.admin.as.query(api.projects.getProject, { projectId }))).toBe(NOT_FOUND);
    expect(await outcome(fx.gcB.admin.as.query(api.projects.getProject, { projectId: missing }))).toBe(NOT_FOUND);
    for (const malformed of ["not-an-id", ""]) {
      expect(await outcome(fx.gcB.admin.as.query(api.projects.getProject, { projectId: malformed }))).toBe(NOT_FOUND);
      expect(await outcome(fx.gcB.admin.as.mutation(api.projects.updateProject, { projectId: malformed, ...CA_PROJECT }))).toBe(NOT_FOUND);
      expect(await outcome(fx.gcB.admin.as.mutation(api.projects.archiveProject, { projectId: malformed }))).toBe(NOT_FOUND);
      expect(await outcome(fx.gcB.admin.as.mutation(api.projects.restoreProject, { projectId: malformed }))).toBe(NOT_FOUND);
    }
    expect((await fx.gcB.admin.as.query(api.projects.listProjects, {})).map((p) => p.title)).toEqual(["Camelback Suite 400"]);
    expect(JSON.stringify(await t.run((ctx) => ctx.db.get(projectId)))).toBe(before);
  });
});

describe("archive and restore", () => {
  test("archived projects are hidden by default, read-only, listed with includeArchived, and restorable", async () => {
    const { t, fx, projectId } = await setup();
    await fx.gcA.admin.as.mutation(api.projects.archiveProject, { projectId });
    expect(await t.run((ctx) => ctx.db.get(projectId))).toMatchObject({ archived: true, status: "archived" });
    const ids = async (includeArchived?: boolean) =>
      (await fx.gcA.admin.as.query(api.projects.listProjects, includeArchived ? { includeArchived } : {})).map((p) => p._id);
    expect(await ids()).not.toContain(projectId);
    expect(await ids(true)).toContain(projectId);
    expect((await fx.gcB.admin.as.query(api.projects.listProjects, { includeArchived: true })).map((p) => p.title)).toEqual([
      "Camelback Suite 400",
    ]);
    expect((await fx.gcA.admin.as.query(api.projects.getProject, { projectId }))?.archived).toBe(true);
    const edit = await errorData(fx.gcA.admin.as.mutation(api.projects.updateProject, { projectId, ...CA_PROJECT }));
    expect(edit.code).toBe("ARCHIVED");

    await fx.gcA.admin.as.mutation(api.projects.restoreProject, { projectId });
    expect(await t.run((ctx) => ctx.db.get(projectId))).toMatchObject({ archived: false, status: "active" });
    expect(await ids()).toContain(projectId);
  });
});

describe("company default retainage", () => {
  test("GC admins set it; members, subs and out-of-range values are refused", async () => {
    const { t, fx } = await setup();
    expect((await fx.gcA.admin.as.query(api.companies.myCompany, {})).company.defaultRetainageBps).toBe(1000);
    await fx.gcA.admin.as.mutation(api.companies.updateDefaults, { defaultRetainageBps: 400 });
    expect((await t.run((ctx) => ctx.db.get(fx.gcA.companyId)))?.defaultRetainageBps).toBe(400);
    await expect(fx.gcA.member.as.mutation(api.companies.updateDefaults, { defaultRetainageBps: 500 })).rejects.toThrow();
    await expect(fx.sub.admin.as.mutation(api.companies.updateDefaults, { defaultRetainageBps: 500 })).rejects.toThrow();
    await expect(fx.gcA.admin.as.mutation(api.companies.updateDefaults, { defaultRetainageBps: 10_001 })).rejects.toThrow(/between 0% and 100%/);
    expect((await t.run((ctx) => ctx.db.get(fx.gcB.companyId)))?.defaultRetainageBps).toBeUndefined();
  });
});
