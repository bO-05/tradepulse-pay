/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { CSLB_FIXTURES } from "./cslbFixtures";

const kernelMock = vi.hoisted(() => ({
  create: vi.fn(),
  execute: vi.fn(),
  deleteByID: vi.fn(),
  constructed: [] as unknown[],
}));

vi.mock("@onkernel/sdk", () => ({
  default: class {
    browsers = {
      create: kernelMock.create,
      deleteByID: kernelMock.deleteByID,
      playwright: { execute: kernelMock.execute },
    };
    constructor(opts: unknown) {
      kernelMock.constructed.push(opts);
    }
  },
}));

const modules = import.meta.glob("/convex/**/*.ts");
const FAKE_KEY = "kernel-test-key-not-real-123";
const LIVE_URL = "https://live.kernel.test/view/abc";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("KERNEL_API_KEY", FAKE_KEY);
  kernelMock.create.mockReset();
  kernelMock.execute.mockReset();
  kernelMock.deleteByID.mockReset();
  kernelMock.constructed.length = 0;
  let n = 0;
  kernelMock.create.mockImplementation(async () => ({ session_id: `sess_${++n}`, browser_live_view_url: LIVE_URL }));
  kernelMock.deleteByID.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setup(licenseNumber = "142881") {
  const t = convexTest(schema, modules);
  await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
  const contractorId = await t.run(async (ctx) => {
    const c = (await ctx.db.query("contractors").collect()).find((x) => x.companyName === "Rosendin Electric, Inc.")!;
    await ctx.db.patch(c._id, { licenseNumber });
    return c._id;
  });
  const gc = await signInAs(t, "gc");
  return { t, gc, contractorId };
}

const rows = (t: ReturnType<typeof convexTest>, contractorId: Id<"contractors">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("licenseChecks").collect()).filter((r) => r.contractorId === contractorId),
  );

/** Runs the scheduled lookup only; the 3-minute stale-check timer stays pending. */
async function runStarted(t: ReturnType<typeof convexTest>) {
  vi.advanceTimersByTime(1);
  await t.finishInProgressScheduledFunctions();
}

function servePage(lic: string) {
  kernelMock.execute.mockImplementation(async () => ({ success: true, result: CSLB_FIXTURES[lic] }));
}

describe("CSLB license check through KERNEL", () => {
  test("GC check runs in a stealth headful browser, stores the live view while running, parses active, deletes the browser", async () => {
    const s = await setup("142881");
    let seenWhileRunning: unknown = null;
    kernelMock.execute.mockImplementation(async (sessionId: string, params: { code: string }) => {
      expect(sessionId).toBe("sess_1");
      expect(params.code).toContain('"142881"');
      const [row] = await rows(s.t, s.contractorId);
      seenWhileRunning = { phase: row.phase, liveViewUrl: row.liveViewUrl, status: row.status };
      return { success: true, result: CSLB_FIXTURES["142881"] };
    });
    const res = await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    expect(res.kind).toBe("started");
    await runStarted(s.t);

    expect(kernelMock.create).toHaveBeenCalledWith(expect.objectContaining({ stealth: true, headless: false }));
    expect(seenWhileRunning).toEqual({ phase: "running", liveViewUrl: LIVE_URL, status: "unverified" });
    expect(kernelMock.deleteByID).toHaveBeenCalledWith("sess_1");
    const [row] = await rows(s.t, s.contractorId);
    expect(row).toMatchObject({ status: "active", state: "CA", licenseNumber: "142881", phase: "done", liveViewUrl: LIVE_URL, kernelSessionId: "sess_1", browserDeleted: true });
    expect(row.rawSummary).toContain("ROSENDIN ELECTRIC INC");
    expect(row.rawSummary).toContain("This license is current and active.");

    const view = await s.gc.as.query(api.kernel.licenseChecks.getContractorLicense, { contractorId: s.contractorId });
    expect(view?.latest).toMatchObject({ status: "active", phase: "done" });
  });

  test.each([
    ["1000000", "expired", "HALA TREE SERVICE INC"],
    ["9999999", "not_found", "License Number does not exist."],
    ["1089556", "suspended", "under suspension"],
  ])("license %s is stored as %s", async (lic, status, text) => {
    const s = await setup(lic);
    servePage(lic);
    await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    await runStarted(s.t);
    const [row] = await rows(s.t, s.contractorId);
    expect(row.status).toBe(status);
    expect(row.rawSummary).toContain(text);
    expect(kernelMock.deleteByID).toHaveBeenCalledTimes(1);
  });

  test("a second check within 24 h reuses the result; after 24 h a new lookup runs", async () => {
    const s = await setup("1000000");
    servePage("1000000");
    await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    await runStarted(s.t);
    const [first] = await rows(s.t, s.contractorId);

    vi.setSystemTime(Date.now() + 23 * 3600_000);
    const again = await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    await runStarted(s.t);
    expect(again).toEqual({ kind: "cached", checkId: first._id });
    expect(kernelMock.create).toHaveBeenCalledTimes(1);
    const afterCached = await rows(s.t, s.contractorId);
    expect(afterCached).toHaveLength(1);
    expect(afterCached[0].checkedAt).toBe(first.checkedAt);

    vi.setSystemTime(Date.now() + 2 * 3600_000);
    const fresh = await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    await runStarted(s.t);
    expect(fresh.kind).toBe("started");
    expect(kernelMock.create).toHaveBeenCalledTimes(2);
    expect(await rows(s.t, s.contractorId)).toHaveLength(2);
  });

  test("a rejected KERNEL key ends unverified with a secret-free reason, and failures are not cached", async () => {
    const s = await setup("142881");
    kernelMock.create.mockRejectedValueOnce(Object.assign(new Error(`401 invalid key ${FAKE_KEY}`), { status: 401 }));
    await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    await runStarted(s.t);
    const [row] = await rows(s.t, s.contractorId);
    expect(row).toMatchObject({ status: "unverified", phase: "done" });
    expect(row.rawSummary).toContain("KERNEL rejected the API key (HTTP 401).");
    expect(JSON.stringify(row)).not.toContain(FAKE_KEY);
    expect(kernelMock.deleteByID).not.toHaveBeenCalled();

    servePage("142881");
    const retry = await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    await runStarted(s.t);
    expect(retry.kind).toBe("started");
    const latest = (await rows(s.t, s.contractorId)).find((r) => r._id === retry.checkId)!;
    expect(latest.status).toBe("active");
  });

  test("a script failure or thrown error is unverified and the browser is still deleted", async () => {
    const s = await setup("142881");
    kernelMock.execute.mockResolvedValueOnce({ success: false, error: "page.goto: Timeout 25000ms exceeded.\nCall log: ..." });
    await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    await runStarted(s.t);
    kernelMock.execute.mockRejectedValueOnce(new Error("socket hang up"));
    await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    await runStarted(s.t);
    const all = await rows(s.t, s.contractorId);
    expect(all.map((r) => r.status)).toEqual(["unverified", "unverified"]);
    expect(all[0].rawSummary).toContain("page.goto: Timeout 25000ms exceeded.");
    expect(all[0].rawSummary).not.toContain("Call log");
    expect(kernelMock.deleteByID).toHaveBeenCalledTimes(2);
    expect(all.every((r) => r.browserDeleted === true)).toBe(true);
  });

  test("without KERNEL_API_KEY no browser is created and the result is unverified", async () => {
    vi.stubEnv("KERNEL_API_KEY", "");
    const s = await setup("142881");
    await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    await runStarted(s.t);
    const [row] = await rows(s.t, s.contractorId);
    expect(row.status).toBe("unverified");
    expect(kernelMock.create).not.toHaveBeenCalled();
  });

  test("a lookup whose action never finishes is closed as unverified after 3 minutes", async () => {
    const s = await setup("142881");
    const begun = await s.t.mutation(internal.kernel.licenseChecks.beginCheck, { contractorId: s.contractorId, trigger: "test" });
    expect(begun.kind).toBe("started");
    vi.advanceTimersByTime(3 * 60_000 + 1);
    await s.t.finishInProgressScheduledFunctions();
    const [row] = await rows(s.t, s.contractorId);
    expect(row).toMatchObject({ phase: "done", status: "unverified" });
    expect(row.rawSummary).toMatch(/did not finish/);
  });

  test("checkLicenseNow waits for the final status and reports cache hits", async () => {
    const s = await setup("142881");
    servePage("142881");
    const first = await s.t.action(internal.kernel.licenseCheck.checkLicenseNow, { contractorId: s.contractorId });
    expect(first).toMatchObject({ status: "active", licenseNumber: "142881", cached: false });
    const second = await s.t.action(internal.kernel.licenseCheck.checkLicenseNow, { contractorId: s.contractorId });
    expect(second).toMatchObject({ status: "active", cached: true, checkId: first.checkId, checkedAt: first.checkedAt });
    expect(kernelMock.create).toHaveBeenCalledTimes(1);
  });

  test("only the GC can request or view license checks", async () => {
    const s = await setup("142881");
    const sub = await signInAs(s.t, "sub", { contractorId: s.contractorId });
    const owner = await signInAs(s.t, "owner");
    for (const who of [sub, owner]) {
      await expect(who.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId })).rejects.toThrow(/Forbidden: role gc/);
      await expect(who.as.query(api.kernel.licenseChecks.getContractorLicense, { contractorId: s.contractorId })).rejects.toThrow(/Forbidden: role gc/);
    }
    await expect(s.t.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId })).rejects.toThrow();
    expect(await rows(s.t, s.contractorId)).toHaveLength(0);
  });
});

describe("demo license seed", () => {
  test("puts the CA license numbers on the demo contractors idempotently", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    await t.mutation(internal.projects.seedInitialDataInternal, { force: false });
    const contractors = await t.run(async (ctx) => await ctx.db.query("contractors").collect());
    const byName = new Map(contractors.map((c) => [c.companyName, c]));
    expect(byName.get("Rosendin Electric, Inc.")?.licenseNumber).toBe("142881");
    expect(byName.get("Bergelectric Corp.")?.licenseNumber).toBe("85046");
    expect(byName.get("TDIndustries, Inc.")?.licenseNumber).toBe("512239");
    expect(byName.get("Alterman, Inc.")?.licenseNumber).toBe("1000000");
    expect(byName.get("Prism Electric, Inc.")?.licenseNumber).toBe("9999999");
    for (const name of ["Rosendin Electric, Inc.", "Alterman, Inc.", "Prism Electric, Inc."]) {
      expect(byName.get(name)!.licenseStatus).not.toMatch(/\b(verified|active)\b/i);
    }
  });
});

describe("cache clearing helper", () => {
  test("clearLicenseCache keeps history but forces the next lookup", async () => {
    const s = await setup("142881");
    servePage("142881");
    await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    await runStarted(s.t);
    expect(await s.t.mutation(internal.kernel.licenseChecks.clearLicenseCache, { contractorId: s.contractorId })).toEqual({ cleared: 1 });
    const next = await s.gc.as.mutation(api.kernel.licenseChecks.requestLicenseCheck, { contractorId: s.contractorId });
    await runStarted(s.t);
    expect(next.kind).toBe("started");
    expect(await rows(s.t, s.contractorId)).toHaveLength(2);
    expect(kernelMock.create).toHaveBeenCalledTimes(2);
  });
});
