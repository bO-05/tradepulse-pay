/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture, insertProjectFor, type FixtureUser } from "../lib/tenancyFixtures";
import { insertTestSession } from "../lib/testIdentity";
import { ensureDemoCompliance } from "./demoSeed";
import type { ComplianceInput } from "./validators";

const modules = import.meta.glob("/convex/**/*.ts");
type T = TestConvex<typeof schema>;
type Caller = FixtureUser["as"];
const NOT_FOUND = /Not found/;
const DAY = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T18:00:00Z"));
  vi.stubEnv("KERNEL_API_KEY", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in tests");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

const PDF = new TextEncoder().encode("%PDF-1.4\n% fake coi for tests\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
const TEXT = new TextEncoder().encode("meeting notes, not a pdf");

const coi = (over: Partial<Extract<ComplianceInput, { kind: "coi" }>["coi"]> = {}): ComplianceInput => ({
  kind: "coi",
  coi: {
    insurer: "Golden State Mutual Insurance Co.",
    glPolicyNumber: "GL-448812",
    glEachOccurrenceCents: 100_000_000,
    glAggregateCents: 200_000_000,
    autoCents: 100_000_000,
    umbrellaCents: 500_000_000,
    workersComp: true,
    additionalInsured: true,
    effectiveDate: iso(-30),
    expiryDate: iso(335),
    ...over,
  },
});
const W9: ComplianceInput = { kind: "w9", w9: { entityType: "s_corporation", tinLast4: "4567", signedDate: iso(-2) } };
const caLicense = (licenseNumber = "142881"): ComplianceInput => ({
  kind: "license",
  license: { licenseNumber, state: "CA", classification: "C-10 Electrical", expiryDate: iso(400) },
});

async function addUser(t: T, companyId: Id<"companies">, email: string, role: "gc" | "sub" | "owner") {
  const { userId, session } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email, emailVerificationTime: Date.now() });
    await ctx.db.insert("userProfiles", { userId, role, displayName: email, actorType: "human", companyId, createdAt: Date.now() });
    await ctx.db.insert("companyMembers", { companyId, userId, role: "admin", status: "active", createdAt: Date.now() });
    return { userId, session: await insertTestSession(ctx, userId) };
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|${session}`, email }) };
}

async function setup() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  const a = f.gcA.project;
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.patch(a.projectId, { state: "CA" });
    const vendorId = await ctx.db.insert("vendors", {
      companyId: f.gcA.companyId,
      name: "Eastbay Electric",
      trades: ["26 00 00"],
      contactName: "Kim",
      email: "kim@eastbay.test",
      licenseNumber: "142881",
      licenseState: "CA",
      linkedCompanyId: f.sub.companyId,
      status: "active",
      createdAt: now,
    });
    await ctx.db.patch(a.contractorId, { vendorId, licenseNumber: "142881" });
    const member = (await ctx.db.query("projectMembers").withIndex("by_projectId", (q) => q.eq("projectId", a.projectId)).collect()).find(
      (m) => m.companyId === f.sub.companyId,
    )!;
    await ctx.db.patch(member._id, { vendorId });
    const lakeshore = await ctx.db.insert("companies", { name: "Lakeshore Mechanical", kind: "sub", isDemo: false, createdAt: now });
    const lakeshoreVendor = await ctx.db.insert("vendors", {
      companyId: f.gcA.companyId,
      name: "Lakeshore Mechanical",
      trades: ["22 00 00"],
      contactName: "Ray",
      email: "ray@lakeshore.test",
      linkedCompanyId: lakeshore,
      status: "active",
      createdAt: now,
    });
    await ctx.db.insert("projectMembers", { projectId: a.projectId, companyId: lakeshore, partyRole: "sub", vendorId: lakeshoreVendor, status: "active", createdAt: now });
    // Sonoran's AZ project with its own sub (Saguaro Electric).
    const saguaro = await ctx.db.insert("companies", { name: "Saguaro Electric", kind: "sub", isDemo: false, createdAt: now });
    const az = await insertProjectFor(ctx, f.gcB.companyId, { title: "Camelback AZ", subCompanyId: saguaro, bidderName: "Saguaro Electric" });
    await ctx.db.patch(az.projectId, { state: "AZ" });
    await ctx.db.insert("vendors", {
      companyId: f.gcB.companyId,
      name: "Saguaro Electric",
      trades: ["26 00 00"],
      contactName: "Sal",
      email: "sal@saguaro.test",
      linkedCompanyId: saguaro,
      status: "active",
      createdAt: now,
    });
    return { vendorId, lakeshore, saguaro, azProjectId: az.projectId };
  });
  const ray = await addUser(t, ids.lakeshore, "ray@lakeshore.test", "sub");
  const sal = await addUser(t, ids.saguaro, "sal@saguaro.test", "sub");
  return {
    t,
    f,
    ...ids,
    projectId: a.projectId,
    dana: f.gcA.admin.as,
    kim: f.sub.admin.as,
    alicia: f.owner.admin.as,
    priya: f.gcB.admin.as,
    ray: ray.as,
    sal: sal.as,
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** The client's upload path: an intent from the mutation, the bytes in storage, then the submit action. */
async function upload(s: Setup, who: Caller, projectId: Id<"projects">, bytes: Uint8Array, input: ComplianceInput, fileName = "coi-eastbay.pdf") {
  const { uploadIntentId } = await who.mutation(api.compliance.items.generateComplianceUploadUrl, { projectId });
  const storageId = await s.t.run(async (ctx) => await ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: "application/pdf" })));
  const run = () => who.action(api.compliance.items.submitComplianceItem, { projectId, uploadIntentId, storageId, fileName, input });
  return { storageId, run };
}

async function submit(s: Setup, who: Caller, bytes: Uint8Array, input: ComplianceInput, fileName?: string) {
  const { run } = await upload(s, who, s.projectId, bytes, input, fileName);
  return (await run()).itemId;
}

async function errorData(p: Promise<unknown>): Promise<{ code?: string; message?: string; fields?: Record<string, string> }> {
  try {
    await p;
  } catch (err) {
    return ((err as { data?: unknown }).data ?? { message: (err as Error).message }) as { code?: string; message?: string };
  }
  throw new Error("expected the call to fail");
}

const counts = (t: T) =>
  t.run(async (ctx) => ({
    items: (await ctx.db.query("complianceItems").collect()).length,
    docs: (await ctx.db.query("documents").collect()).length,
  }));

async function acceptAll(s: Setup, ids: Id<"complianceItems">[]) {
  for (const itemId of ids) await s.dana.mutation(api.compliance.items.reviewComplianceItem, { itemId, decision: "accept" });
}

describe("compliance uploads", () => {
  test("a COI PDF is stored as a restricted document with its fields in cents and awaits review", async () => {
    const s = await setup();
    const itemId = await submit(s, s.kim, PDF, coi());
    const { item, doc, audit, notes } = await s.t.run(async (ctx) => {
      const item = (await ctx.db.get(itemId))!;
      return {
        item,
        doc: (await ctx.db.get(item.documentId!))!,
        audit: (await ctx.db.query("auditLogs").collect()).filter((l) => l.eventType === "compliance_uploaded"),
        notes: (await ctx.db.query("notifications").collect()).filter((n) => n.kind === "compliance_submitted"),
      };
    });
    expect(item).toMatchObject({ kind: "coi", status: "pending_review", companyId: s.f.sub.companyId, vendorId: s.vendorId, gcCompanyId: s.f.gcA.companyId });
    expect(item.coi).toMatchObject({ glEachOccurrenceCents: 100_000_000, glAggregateCents: 200_000_000, autoCents: 100_000_000, insurer: "Golden State Mutual Insurance Co." });
    expect(doc).toMatchObject({ kind: "compliance_coi", sensitivity: "restricted", contentType: "application/pdf", sizeBytes: PDF.length, relatedId: itemId });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(audit).toHaveLength(1);
    expect(notes.length).toBeGreaterThan(0);

    const mine = await s.kim.query(api.compliance.items.subProjectCompliance, { projectId: s.projectId });
    expect(mine.items.map((i) => i.status)).toEqual(["pending_review"]);
    expect(mine.items[0].document?.downloadPath).toBe(`/api/documents/${doc._id}`);
    expect(JSON.stringify(mine)).not.toMatch(/api\/storage|storageId/);
  });

  test("renamed executables and text files are refused and their blobs deleted; oversize is refused; JPEG and PNG are accepted", async () => {
    const s = await setup();
    const before = await counts(s.t);
    for (const bytes of [EXE, TEXT]) {
      const { storageId, run } = await upload(s, s.kim, s.projectId, bytes, coi(), "coi.pdf");
      const err = await errorData(run());
      expect(err.code).toBe("INVALID_FILE_TYPE");
      expect(err.message).toContain("isn't a valid PDF, PNG or JPEG");
      expect(await s.t.run(async (ctx) => await ctx.db.system.get(storageId))).toBeNull();
    }
    const big = new Uint8Array(12 * 1024 * 1024);
    big.set(PDF);
    const { storageId: bigId, run: bigRun } = await upload(s, s.kim, s.projectId, big, coi(), "big.pdf");
    const bigErr = await errorData(bigRun());
    expect(bigErr.code).toBe("FILE_TOO_LARGE");
    expect(bigErr.message).toContain("The limit is 10 MB");
    expect(await s.t.run(async (ctx) => await ctx.db.system.get(bigId))).toBeNull();
    expect(await counts(s.t)).toEqual(before);
    const worklist = await s.dana.query(api.compliance.items.gcComplianceWorklist, {});
    expect(worklist.rows.flatMap((r) => r.items)).toEqual([]);

    const jpg = await submit(s, s.kim, JPEG, coi(), "photo.jpg");
    const png = await submit(s, s.kim, PNG, caLicense(), "license-eastbay.png");
    const types = await s.t.run(async (ctx) => {
      const out = [];
      for (const id of [jpg, png]) out.push((await ctx.db.get((await ctx.db.get(id))!.documentId!))!.contentType);
      return out;
    });
    expect(types).toEqual(["image/jpeg", "image/png"]);
  });

  test("invalid fields are refused with per-field errors and leave no rows", async () => {
    const s = await setup();
    const before = await counts(s.t);
    const { run } = await upload(s, s.kim, s.projectId, PDF, coi({ insurer: "", effectiveDate: iso(10), expiryDate: iso(5) }));
    const err = await errorData(run());
    expect(err.code).toBe("INVALID_FIELDS");
    expect(Object.keys(err.fields ?? {})).toEqual(expect.arrayContaining(["insurer", "expiryDate"]));
    expect(await counts(s.t)).toEqual(before);
  });

  test("a W-9 keeps only the TIN's last four digits and shows it masked", async () => {
    const s = await setup();
    const itemId = await submit(s, s.kim, PDF, W9, "w9-eastbay.pdf");
    const item = await s.t.run(async (ctx) => (await ctx.db.get(itemId))!);
    expect(item.w9).toEqual({ entityType: "s_corporation", tinLast4: "4567", signedDate: iso(-2) });
    const bad = await upload(s, s.kim, s.projectId, PDF, { kind: "w9", w9: { entityType: "s_corporation", tinLast4: "941234567", signedDate: iso(-2) } });
    expect((await errorData(bad.run())).code).toBe("INVALID_FIELDS");
    const view = await s.kim.query(api.compliance.items.getComplianceItem, { itemId });
    expect(view.w9?.tinMasked).toBe("•••-••-4567");
  });

  test("a non-CA license is a manual record; a CA license starts unverified", async () => {
    const s = await setup();
    const ca = await submit(s, s.kim, PNG, caLicense(), "license.png");
    const azProject = s.azProjectId;
    const { run } = await upload(s, s.sal, azProject, PDF, {
      kind: "license",
      license: { licenseNumber: "ROC 312345", state: "AZ", classification: "CR-11", expiryDate: iso(200) },
    });
    const { itemId: az } = await run();
    const rows = await s.t.run(async (ctx) => [(await ctx.db.get(ca))!, (await ctx.db.get(az))!]);
    expect(rows.map((r) => r.license?.verification)).toEqual(["unverified", "manual"]);
  });

  test("only a sub member linked to a vendor on the project may upload", async () => {
    const s = await setup();
    for (const who of [s.dana, s.alicia, s.priya, s.sal, s.f.noCompany.as]) {
      await expect(who.mutation(api.compliance.items.generateComplianceUploadUrl, { projectId: s.projectId })).rejects.toThrow(NOT_FOUND);
    }
  });
});

describe("GC review", () => {
  test("accept and reject (reason required) are recorded, audited and notified to the sub", async () => {
    const s = await setup();
    const coiId = await submit(s, s.kim, PDF, coi());
    const w9Id = await submit(s, s.kim, PDF, W9);
    await s.dana.mutation(api.compliance.items.reviewComplianceItem, { itemId: coiId, decision: "accept" });
    expect((await errorData(s.dana.mutation(api.compliance.items.reviewComplianceItem, { itemId: w9Id, decision: "reject", reason: "  " }))).code).toBe("REASON_REQUIRED");
    await s.dana.mutation(api.compliance.items.reviewComplianceItem, { itemId: w9Id, decision: "reject", reason: "Signature date missing on page 1" });
    expect((await errorData(s.dana.mutation(api.compliance.items.reviewComplianceItem, { itemId: coiId, decision: "reject", reason: "x" }))).code).toBe("ALREADY_REVIEWED");

    const rows = await s.t.run(async (ctx) => ({
      coi: (await ctx.db.get(coiId))!,
      w9: (await ctx.db.get(w9Id))!,
      audit: (await ctx.db.query("auditLogs").collect()).filter((l) => l.eventType.startsWith("compliance_")).map((l) => l.eventType),
      notes: (await ctx.db.query("notifications").collect()).filter((n) => n.kind === "compliance_accepted" || n.kind === "compliance_rejected"),
    }));
    expect(rows.coi).toMatchObject({ status: "accepted", reviewedByUserId: s.f.gcA.admin.userId });
    expect(rows.w9).toMatchObject({ status: "rejected", rejectionReason: "Signature date missing on page 1" });
    expect(rows.audit).toEqual(expect.arrayContaining(["compliance_accepted", "compliance_rejected"]));
    expect(rows.notes.map((n) => n.kind).sort()).toEqual(["compliance_accepted", "compliance_rejected"]);

    const mine = await s.kim.query(api.compliance.items.subProjectCompliance, { projectId: s.projectId });
    expect(mine.items.find((i) => i._id === w9Id)?.rejectionReason).toBe("Signature date missing on page 1");
    expect(mine.byKind.w9).toBe("missing");

    const replacement = await submit(s, s.kim, PDF, W9);
    const after = await s.kim.query(api.compliance.items.subProjectCompliance, { projectId: s.projectId });
    expect(after.items.filter((i) => i.kind === "w9").map((i) => [i._id, i.status])).toEqual([
      [replacement, "pending_review"],
      [w9Id, "rejected"],
    ]);
  });

  test("subs, other subs, the owner and another GC cannot review: Not found and the row is unchanged", async () => {
    const s = await setup();
    const itemId = await submit(s, s.kim, PDF, coi());
    for (const who of [s.kim, s.ray, s.alicia, s.priya, s.f.demo.gc.as, s.f.noCompany.as]) {
      for (const decision of ["accept", "reject"] as const) {
        await expect(who.mutation(api.compliance.items.reviewComplianceItem, { itemId, decision, reason: "nope" })).rejects.toThrow(NOT_FOUND);
      }
    }
    expect((await s.t.run(async (ctx) => await ctx.db.get(itemId)))!.status).toBe("pending_review");
  });
});

describe("computed status", () => {
  test("all accepted and meeting terms is compliant; a below-limit COI or no additional insured is not", async () => {
    const s = await setup();
    await acceptAll(s, [await submit(s, s.kim, PDF, coi()), await submit(s, s.kim, PDF, W9), await submit(s, s.kim, PNG, caLicense())]);
    const ok = await s.kim.query(api.compliance.items.subProjectCompliance, { projectId: s.projectId });
    expect(ok.status).toBe("compliant");
    const gcRow = (await s.dana.query(api.compliance.items.gcComplianceWorklist, {})).rows.find((r) => r.vendorId === s.vendorId)!;
    expect(gcRow.status).toBe("compliant");

    vi.setSystemTime(Date.now() + 1000);
    await acceptAll(s, [await submit(s, s.kim, PDF, coi({ glEachOccurrenceCents: 50_000_000 }))]);
    const low = await s.kim.query(api.compliance.items.subProjectCompliance, { projectId: s.projectId });
    expect(low.status).toBe("non_compliant");
    expect(low.reasons.map((r) => r.message).join(" ")).toContain("GL each occurrence $500,000.00 is below the required $1,000,000.00.");

    vi.setSystemTime(Date.now() + 1000);
    await acceptAll(s, [await submit(s, s.kim, PDF, coi({ additionalInsured: false }))]);
    const ai = await s.kim.query(api.compliance.items.subProjectCompliance, { projectId: s.projectId });
    expect(ai.status).toBe("non_compliant");
    expect(ai.reasons.map((r) => r.message).join(" ")).toMatch(/Additional insured/);
  });

  test("expiring within 30 days, compliant at 31, expired yesterday, missing with only a pending W-9", async () => {
    const s = await setup();
    await acceptAll(s, [await submit(s, s.kim, PDF, W9), await submit(s, s.kim, PNG, caLicense())]);
    const statusAfterCoi = async (expiryDays: number) => {
      vi.setSystemTime(Date.now() + 1000);
      await acceptAll(s, [await submit(s, s.kim, PDF, coi({ effectiveDate: iso(-60), expiryDate: iso(expiryDays) }))]);
      return await s.kim.query(api.compliance.items.subProjectCompliance, { projectId: s.projectId });
    };
    const twenty = await statusAfterCoi(20);
    expect(twenty.status).toBe("expiring");
    expect(twenty.reasons.map((r) => r.message).join(" ")).toMatch(/expires in 20 days/i);
    expect((await statusAfterCoi(30)).status).toBe("expiring");
    expect((await statusAfterCoi(31)).status).toBe("compliant");
    const expired = await statusAfterCoi(-1);
    expect(expired.status).toBe("expired");
    expect(expired.reasons.map((r) => r.message).join(" ")).toMatch(/Certificate of insurance expired on/);

    const fresh = await setup();
    await acceptAll(fresh, [await submit(fresh, fresh.kim, PDF, coi()), await submit(fresh, fresh.kim, PNG, caLicense())]);
    await submit(fresh, fresh.kim, PDF, W9);
    const missing = await fresh.kim.query(api.compliance.items.subProjectCompliance, { projectId: fresh.projectId });
    expect(missing.status).toBe("missing");
    expect(missing.reasons.map((r) => r.message).join(" ")).toContain("Missing: W-9.");
  });
});

describe("CSLB lookups", () => {
  test("only CA license records can be looked up; the lookup links a licenseChecks row and never accepts the item", async () => {
    const s = await setup();
    const ca = await submit(s, s.kim, PNG, caLicense());
    const { run } = await upload(s, s.sal, s.azProjectId, PDF, {
      kind: "license",
      license: { licenseNumber: "ROC 312345", state: "AZ", classification: "CR-11", expiryDate: iso(200) },
    });
    const { itemId: az } = await run();
    expect((await errorData(s.priya.mutation(api.compliance.items.requestCslbLookup, { itemId: az }))).code).toBe("NOT_CALIFORNIA");
    await expect(s.dana.mutation(api.compliance.items.requestCslbLookup, { itemId: az })).rejects.toThrow(NOT_FOUND);
    await expect(s.kim.mutation(api.compliance.items.requestCslbLookup, { itemId: ca })).rejects.toThrow(NOT_FOUND);
    await expect(s.priya.mutation(api.compliance.items.requestCslbLookup, { itemId: ca })).rejects.toThrow(NOT_FOUND);

    const res = await s.dana.mutation(api.compliance.items.requestCslbLookup, { itemId: ca });
    expect(res.kind).toBe("started");
    vi.advanceTimersByTime(1);
    await s.t.finishInProgressScheduledFunctions();
    const { item, checks } = await s.t.run(async (ctx) => ({
      item: (await ctx.db.get(ca))!,
      checks: await ctx.db.query("licenseChecks").collect(),
    }));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ complianceItemId: ca, licenseNumber: "142881", phase: "done", status: "unverified" });
    expect(item.status).toBe("pending_review");
    expect(item.license?.verification).toBe("unverified");
    const view = await s.dana.query(api.compliance.items.getComplianceItem, { itemId: ca });
    expect(view.cslb).toMatchObject({ source: "California CSLB", succeeded: false, phase: "done" });
    expect(JSON.stringify(view)).not.toMatch(/Verified/);
  });
});

describe("isolation and serving", () => {
  test("subs see only their own records; each GC sees only its vendors; owners see none", async () => {
    const s = await setup();
    const kimItem = await submit(s, s.kim, PDF, coi());
    const { run } = await upload(s, s.sal, s.azProjectId, PDF, W9);
    const { itemId: salItem } = await run();

    for (const who of [s.ray, s.alicia, s.priya, s.sal, s.f.demo.gc.as]) {
      await expect(who.query(api.compliance.items.getComplianceItem, { itemId: kimItem })).rejects.toThrow(NOT_FOUND);
    }
    await expect(s.ray.query(api.compliance.items.subProjectCompliance, { projectId: s.projectId })).resolves.toMatchObject({ items: [] });
    await expect(s.alicia.query(api.compliance.items.subProjectCompliance, { projectId: s.projectId })).rejects.toThrow(NOT_FOUND);
    await expect(s.alicia.query(api.compliance.items.gcComplianceWorklist, {})).rejects.toThrow(NOT_FOUND);
    await expect(s.alicia.query(api.compliance.items.subComplianceOverview, {})).rejects.toThrow(NOT_FOUND);
    await expect(s.dana.query(api.compliance.items.getComplianceItem, { itemId: salItem })).rejects.toThrow(NOT_FOUND);

    const bayview = await s.dana.query(api.compliance.items.gcComplianceWorklist, {});
    expect(bayview.rows.map((r) => r.vendorName).sort()).toEqual(["Eastbay Electric", "Lakeshore Mechanical"]);
    const sonoran = await s.priya.query(api.compliance.items.gcComplianceWorklist, {});
    expect(sonoran.rows.map((r) => r.vendorName)).toEqual(["Saguaro Electric"]);
    expect(JSON.stringify([bayview, sonoran])).not.toMatch(/api\/storage/);
    const overview = await s.kim.query(api.compliance.items.subComplianceOverview, {});
    expect(overview.rows.map((r) => r.projectId)).toEqual([s.projectId]);
  });

  test("the file is served only through the authenticated route, to the GC and the uploading sub", async () => {
    const s = await setup();
    const itemId = await submit(s, s.kim, PDF, W9, "w9-eastbay.pdf");
    const view = await s.dana.query(api.compliance.items.getComplianceItem, { itemId });
    const path = view.document!.downloadPath;
    for (const who of [s.dana, s.kim]) {
      const res = await who.fetch(path, { method: "GET" });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="w9-eastbay.pdf"');
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect((await s.t.fetch(path, { method: "GET" })).status).toBe(401);
    for (const who of [s.ray, s.priya, s.alicia, s.sal]) {
      const res = await who.fetch(path, { method: "GET" });
      expect(res.status).toBe(404);
    }
    await expect(s.dana.query(api.documents.documents.getDocument, { documentId: view.document!._id })).rejects.toThrow(NOT_FOUND);
  });
});

describe("demo seed", () => {
  test("adds accepted records for demo subs once and touches nothing else", async () => {
    const s = await setup();
    const demo = s.f.demo;
    await s.t.run(async (ctx) => {
      const rosendin = demo.companyIds["sub:rosendin"];
      const vendorId = await ctx.db.insert("vendors", {
        companyId: demo.companyIds.gc,
        name: "Rosendin Electric, Inc.",
        trades: ["26 00 00"],
        contactName: "Demo",
        email: "rosendin@demo.invalid",
        linkedCompanyId: rosendin,
        status: "active",
        createdAt: Date.now(),
      });
      await ctx.db.patch(demo.project.contractorId, { vendorId, licenseNumber: "1000000", linkedCompanyId: rosendin });
      await ctx.db.insert("projectMembers", { projectId: demo.project.projectId, companyId: rosendin, partyRole: "sub", vendorId, status: "active", createdAt: Date.now() });
    });
    const kimItem = await submit(s, s.kim, PDF, coi());
    const first = await s.t.run(async (ctx) => await ensureDemoCompliance(ctx, demo.companyIds, demo.gc.userId));
    const second = await s.t.run(async (ctx) => await ensureDemoCompliance(ctx, demo.companyIds, demo.gc.userId));
    expect(first.itemsCreated).toBe(3);
    expect(second.itemsCreated).toBe(0);
    const rows = await s.t.run(async (ctx) => await ctx.db.query("complianceItems").collect());
    const demoRows = rows.filter((r) => r.demoRecord === true);
    expect(demoRows.every((r) => r.status === "accepted" && r.gcCompanyId === demo.companyIds.gc)).toBe(true);
    expect(demoRows.find((r) => r.kind === "license")?.license).toMatchObject({ licenseNumber: "1000000", state: "CA", verification: "unverified" });
    expect(rows.find((r) => r._id === kimItem)?.status).toBe("pending_review");
    const status = await demo.gc.as.query(api.compliance.items.gcComplianceWorklist, {});
    expect(status.rows.find((r) => r.vendorName === "Rosendin Electric, Inc.")?.status).toBe("compliant");
  });
});
