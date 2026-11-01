/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { extractText, getDocumentProxy } from "unpdf";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTenancyFixture, type FixtureUser } from "../lib/tenancyFixtures";
import { insertTestSession } from "../lib/testIdentity";
import type { DocumentKind } from "./kinds";

const modules = import.meta.glob("/convex/**/*.ts");
type T = TestConvex<typeof schema>;
type Caller = FixtureUser["as"];
const NOT_FOUND = /Not found/;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in tests");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SOV = [
  ["Mobilization & general conditions", "26 01 00", 800_000],
  ["Temporary power & lighting", "26 05 00", 640_000],
  ["Underground & slab conduit rough-in", "26 05 33", 3_150_000],
  ["Branch wiring rough-in", "26 05 19", 3_820_000],
  ["Switchboard & panelboards", "26 24 00", 4_200_000],
  ["Lighting fixtures & controls", "26 51 00", 2_860_000],
  ["Devices & trim-out", "26 27 26", 1_270_000],
  ["Testing, closeout & as-builts", "26 08 00", 500_000],
] as const;

const entry = (sovLineId: Id<"scheduleOfValues">, workThisPeriodCents: number, storedCents = 0) => ({ sovLineId, workThisPeriodCents, storedCents });

async function setup() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  const { agreementId, projectId } = f.gcA.project;
  const extra = await t.run(async (ctx) => {
    await ctx.db.patch(projectId, {
      billingDay: 25,
      startDate: "2026-10-01",
      retainageBps: 500,
      state: "CA",
      contractValueCents: 124_000_000,
      ownerCompanyId: f.owner.companyId,
      address: { line1: "455 Embarcadero W", city: "Oakland", state: "CA", zip: "94607" },
    });
    await ctx.db.patch(agreementId, { contractSum: 172_400, contractSumCents: 17_240_000, retainagePercent: 5, agreementNumber: "SUB-26-001" });
    const sov: Id<"scheduleOfValues">[] = [];
    for (const [i, [description, csiCode, cents]] of SOV.entries()) {
      sov.push(await ctx.db.insert("scheduleOfValues", { agreementId, lineNo: i + 1, description, csiCode, scheduledValueCents: cents, excludedScope: false }));
    }
    const lakeshore = await ctx.db.insert("companies", { name: "Lakeshore Mechanical", kind: "sub", isDemo: false, createdAt: Date.now() });
    const rayId = await ctx.db.insert("users", { email: "ray@lakeshore.test", emailVerificationTime: Date.now() });
    await ctx.db.insert("userProfiles", { userId: rayId, role: "sub", displayName: "Ray", actorType: "human", companyId: lakeshore, createdAt: Date.now() });
    await ctx.db.insert("companyMembers", { companyId: lakeshore, userId: rayId, role: "admin", status: "active", createdAt: Date.now() });
    const contractor = await ctx.db.insert("contractors", {
      tradePackageId: f.gcA.project.tradePackageId,
      companyName: "Lakeshore Mechanical",
      contactEmail: "bids@lakeshore.invalid",
      licenseNumber: "0",
      licenseStatus: "Unverified",
      sourceUrl: "https://example.invalid",
      rfqStatus: "bid_received",
      linkedCompanyId: lakeshore,
    });
    await ctx.db.insert("projectMembers", { projectId, companyId: lakeshore, partyRole: "sub", contractorId: contractor, status: "active", createdAt: Date.now() });
    return { sov, rayId, session: await insertTestSession(ctx, rayId) };
  });
  return {
    t,
    f,
    agreementId,
    projectId,
    sov: extra.sov,
    dana: f.gcA.admin.as,
    kim: f.sub.admin.as,
    alicia: f.owner.admin.as,
    priya: f.gcB.admin.as,
    ray: t.withIdentity({ subject: `${extra.rayId}|${extra.session}`, email: "ray@lakeshore.test" }),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function approveAsRequested(t: T, payAppId: Id<"payApplications">, approvedBy: Id<"users">, override?: Map<string, number>) {
  await t.run(async (ctx) => {
    const p = (await ctx.db.get(payAppId))!;
    const lines = p.lines.map((l) => ({ sovLineId: l.sovLineId, approvedCents: override?.get(l.sovLineId) ?? l.requestedCents }));
    await ctx.db.patch(payAppId, {
      status: "approved",
      finalApproval: { totalCents: lines.reduce((a, l) => a + l.approvedCents, 0), lines, approvedBy, approvedAt: Date.now() },
    });
  });
}

async function subCo(s: Setup, title: string, amountCents: number, scheduleDays?: number) {
  const { changeOrderId } = await s.kim.mutation(api.billing.changeOrders.createChangeOrder, {
    scope: "subcontract",
    agreementId: s.agreementId,
    title,
    amountCents,
    ...(scheduleDays !== undefined ? { scheduleDays } : {}),
  });
  await s.kim.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId });
  await s.dana.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId });
  return changeOrderId;
}

async function payout(t: T, agreementId: Id<"agreements">, payAppId: Id<"payApplications">, grossCents: number, retainageCents: number, reason: string) {
  await t.run(async (ctx) => {
    const paymentId = await ctx.db.insert("payments", {
      agreementId,
      payAppId,
      kind: "payout",
      status: "success",
      grossCents,
      retainageCents,
      netCents: grossCents - retainageCents,
      idempotencyKey: `pay_${payAppId}`,
      createdAt: Date.now(),
    });
    await ctx.db.insert("retainageLedger", { agreementId, paymentId, deltaCents: retainageCents, reason, createdAt: Date.now() });
  });
}

/** The worked example through approved pay app 2, CO #1 and CO #2, and both payouts. */
async function workedExample() {
  const s = await setup();
  const { payAppId: app1 } = await s.kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
  await s.kim.mutation(api.payApps.g703.submitPayApp, {
    payAppId: app1,
    lines: [entry(s.sov[0], 800_000), entry(s.sov[1], 480_010), entry(s.sov[2], 1_400_000), entry(s.sov[4], 0, 1_800_000)],
  });
  await approveAsRequested(s.t, app1, s.f.gcA.admin.userId, new Map([[s.sov[2] as string, 1_261_250]]));
  await payout(s.t, s.agreementId, app1, 4_341_260, 217_064, "Pay app #1: retainage withheld");

  const co1 = await subCo(s, "Add 6 dedicated 20A circuits for dental chairs", 875_000, 3);
  const line9 = await s.t.run(async (ctx) => (await ctx.db.get(co1))!.sovLineId!);
  const { payAppId: app2 } = await s.kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
  await s.kim.mutation(api.payApps.g703.submitPayApp, {
    payAppId: app2,
    lines: [
      entry(s.sov[1], 159_990),
      entry(s.sov[2], 945_000),
      entry(s.sov[3], 1_910_000),
      entry(s.sov[4], 1_500_000, 600_000),
      entry(s.sov[5], 0, 950_000),
      entry(line9, 437_500),
    ],
  });
  await approveAsRequested(s.t, app2, s.f.gcA.admin.userId);
  await payout(s.t, s.agreementId, app2, 4_702_490, 235_124, "Pay app #2: retainage withheld");
  const co2 = await subCo(s, "Delete 2 exterior fixtures", -120_000);
  return { ...s, app1, app2, co1, co2 };
}

/** Requests a document as `who`, runs the scheduled render and returns the ready document. */
async function documentFor(s: { t: T }, who: Caller, kind: DocumentKind, relatedId: string) {
  const first = await who.mutation(api.documents.documents.requestDocument, { kind, relatedId });
  if (first.status === "ready") return first.document;
  await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  const again = await who.mutation(api.documents.documents.requestDocument, { kind, relatedId });
  expect(again.status).toBe("ready");
  return again.document!;
}

async function bytesOf(t: T, documentId: string): Promise<Uint8Array> {
  const buffer = await t.run(async (ctx) => {
    const doc = (await ctx.db.get(documentId as Id<"documents">))!;
    return await (await ctx.storage.get(doc.storageId))!.arrayBuffer();
  });
  return new Uint8Array(buffer);
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

const csvRows = (bytes: Uint8Array) =>
  new TextDecoder()
    .decode(bytes)
    .replace(/^\uFEFF/, "")
    .split("\r\n")
    .filter((r) => r !== "");

describe("billing PDFs", () => {
  test("the sub pay app PDF (G702 + G703) carries the worked-example figures and is recorded with sha256", async () => {
    const s = await workedExample();
    const doc = await documentFor(s, s.dana, "sub_pay_app_pdf", s.app2);
    const bytes = await bytesOf(s.t, doc._id);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const text = await pdfText(bytes);
    for (const needle of [
      "G702-style",
      "G703-style",
      "Eastbay Electric",
      "Bayview Builders Inc.",
      "Harbor Point Dental Office TI",
      "Application No. 2",
      "Period end Nov 25, 2026",
      "Due date Nov 25, 2026",
      "172,400.00",
      "8,750.00",
      "181,150.00",
      "90,437.50",
      "4,521.88",
      "85,915.62",
      "41,241.96",
      "44,673.66",
      "95,234.38",
      "CO #1",
      "21,000.00",
      "6,000.00",
    ]) {
      expect(text, needle).toContain(needle);
    }
    expect(text).not.toMatch(/AIA Document G70[23](?!-style)/);
    for (const [description] of SOV) expect(text).toContain(description);

    const row = await s.t.run(async (ctx) => ctx.db.get(doc._id));
    expect(row).toMatchObject({ kind: "sub_pay_app_pdf", projectId: s.projectId, relatedId: s.app2, sensitivity: "restricted", contentType: "application/pdf" });
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.sizeBytes).toBe(bytes.length);
  });

  test("regenerating with no data change gives identical bytes and reuses the row", async () => {
    const s = await workedExample();
    const doc = await documentFor(s, s.dana, "sub_pay_app_pdf", s.app2);
    const again = await s.t.action(internal.documents.store.renderDocument, { kind: "sub_pay_app_pdf", relatedId: s.app2 });
    expect(again).toMatchObject({ documentId: doc._id, sha256: doc.sha256, reused: true });
    // The sub sees the same current file.
    expect((await documentFor(s, s.kim, "sub_pay_app_pdf", s.app2))._id).toBe(doc._id);
    const rows = await s.t.run(async (ctx) => ctx.db.query("documents").collect());
    expect(rows).toHaveLength(1);
  });

  test("change order PDFs: CO #1, deductive CO #2 and prime PCO #1", async () => {
    const s = await workedExample();
    const co1 = await pdfText(await bytesOf(s.t, (await documentFor(s, s.dana, "change_order_pdf", s.co1))._id));
    for (const needle of ["Change Order No. 1", "Add 6 dedicated 20A circuits for dental chairs", "+8,750.00", "3 days", "172,400.00", "181,150.00", "dana@bayview.test"]) {
      expect(co1, needle).toContain(needle);
    }
    expect(co1).toMatch(/Approved by dana@bayview\.test on [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    const co2 = await pdfText(await bytesOf(s.t, (await documentFor(s, s.kim, "change_order_pdf", s.co2))._id));
    expect(co2).toContain("(1,200.00)");
    expect(co2).toContain("179,950.00");

    const { changeOrderId: pco } = await s.dana.mutation(api.billing.changeOrders.createChangeOrder, {
      scope: "prime",
      projectId: s.projectId,
      title: "Owner-requested outlets",
      amountCents: 997_500,
    });
    await s.dana.mutation(api.billing.changeOrders.submitChangeOrder, { changeOrderId: pco });
    // A prime CO draft or one awaiting the owner is not the sub's to see.
    await expect(s.kim.mutation(api.documents.documents.requestDocument, { kind: "change_order_pdf", relatedId: pco })).rejects.toThrow(NOT_FOUND);
    await s.alicia.mutation(api.billing.changeOrders.approveChangeOrder, { changeOrderId: pco });
    const text = await pdfText(await bytesOf(s.t, (await documentFor(s, s.alicia, "change_order_pdf", pco))._id));
    for (const needle of ["PCO #1", "9,975.00", "1,240,000.00", "1,249,975.00"]) expect(text, needle).toContain(needle);
  });

  test("the subcontract PDF reflects the award and California, never Texas or the plug total", async () => {
    const s = await setup();
    const text = await pdfText(await bytesOf(s.t, (await documentFor(s, s.dana, "subcontract_pdf", s.agreementId))._id));
    for (const needle of ["AIA-style", "Bayview Builders Inc.", "Eastbay Electric", "Harbor Point Dental Office TI", "455 Embarcadero W", "172,400.00", "5%", "California"]) {
      expect(text, needle).toContain(needle);
    }
    expect(text).toMatch(/pay|payment/i);
    expect(text).not.toMatch(/Texas|187,400\.00/);
    expect(text).not.toMatch(/AIA Document A401(?!-style)/);
    await expect(s.alicia.mutation(api.documents.documents.requestDocument, { kind: "subcontract_pdf", relatedId: s.agreementId })).rejects.toThrow(NOT_FOUND);
  });

  test("the owner pay app PDF shows prime lines only", async () => {
    const s = await setup();
    const { payAppId } = await s.kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    await s.kim.mutation(api.payApps.g703.submitPayApp, {
      payAppId,
      lines: [entry(s.sov[0], 800_000), entry(s.sov[1], 480_010), entry(s.sov[2], 1_400_000), entry(s.sov[4], 0, 1_800_000)],
    });
    await approveAsRequested(s.t, payAppId, s.f.gcA.admin.userId, new Map([[s.sov[2] as string, 1_261_250]]));
    const { primeLineId } = await s.dana.mutation(api.billing.primeLines.addPrimeLine, { projectId: s.projectId, description: "General conditions", scheduledValueCents: 9_600_000 });
    const { ownerPayAppId } = await s.dana.mutation(api.billing.ownerPayApps.createOwnerPayApp, { projectId: s.projectId });
    await s.dana.mutation(api.billing.ownerPayApps.saveOwnerPayApp, { ownerPayAppId, entries: [{ key: `gc:${primeLineId}`, workThisPeriodCents: 800_000 }] });
    // An owner pay app draft is the GC's alone.
    await expect(s.alicia.mutation(api.documents.documents.requestDocument, { kind: "owner_pay_app_pdf", relatedId: ownerPayAppId })).rejects.toThrow(NOT_FOUND);
    await s.dana.mutation(api.billing.ownerPayApps.submitOwnerPayApp, { ownerPayAppId });
    await s.t.run(async (ctx) => {
      const app = (await ctx.db.get(ownerPayAppId))!;
      const now = Date.now();
      await ctx.db.patch(ownerPayAppId, {
        status: "approved",
        approvedAt: now,
        history: [...app.history, { status: "approved", at: now, byUserId: s.f.owner.admin.userId, byName: "Alicia Mendez" }],
      });
    });
    const doc = await documentFor(s, s.alicia, "owner_pay_app_pdf", ownerPayAppId);
    const text = await pdfText(await bytesOf(s.t, doc._id));
    for (const needle of ["Harbor Point Dental LLC", "Bayview Builders Inc.", "Application No. 1", "1,240,000.00", "51,412.60", "2,570.63", "48,841.97", "1,191,158.03", "Electrical", "43,412.60", "General conditions", "8,000.00"]) {
      expect(text, needle).toContain(needle);
    }
    for (const subDetail of ["Switchboard", "Underground", "12,612.50", "14,000.00"]) expect(text).not.toContain(subDetail);
    await expect(s.kim.mutation(api.documents.documents.requestDocument, { kind: "owner_pay_app_pdf", relatedId: ownerPayAppId })).rejects.toThrow(NOT_FOUND);

    const res = await s.alicia.fetch(doc.downloadPath, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    const asSub = await s.kim.fetch(doc.downloadPath, { method: "GET" });
    expect(asSub.status).toBe(404);
    expect(await asSub.text()).toBe("Not found.");
  });
});

describe("CSV exports", () => {
  test("SOV, pay app lines and retainage ledger CSVs are exact to the cent", async () => {
    const s = await workedExample();
    const sov = csvRows(await bytesOf(s.t, (await documentFor(s, s.dana, "sov_csv", s.agreementId))._id));
    expect(sov[0]).toBe("line_no,description,csi_code,scheduled_value");
    expect(sov).toHaveLength(11);
    const values = sov.slice(1).map((r) => r.split(",").at(-1)!);
    expect(values).toContain("-1200.00");
    expect(values.reduce((a, v) => a + Math.round(Number(v) * 100), 0)).toBe(17_995_000);

    const lines = csvRows(await bytesOf(s.t, (await documentFor(s, s.kim, "pay_app_lines_csv", s.app2))._id));
    expect(lines[0]).toBe(
      "item,description,scheduled_value_c,from_previous_d,this_period_e,materials_stored_f,total_completed_stored_g,percent_g_over_c,balance_to_finish_h,retainage_i",
    );
    expect(lines).toHaveLength(11);
    expect(lines[5]).toBe('"5","Switchboard & panelboards",42000.00,0.00,15000.00,6000.00,21000.00,50.00,21000.00,1050.00');
    expect(lines[10]).toBe('"Totals","",181150.00,25412.60,49524.90,15500.00,90437.50,49.92,90712.50,4521.88');

    const ledger = csvRows(await bytesOf(s.t, (await documentFor(s, s.dana, "retainage_ledger_csv", s.agreementId))._id));
    expect(ledger[0]).toBe("date,reference,description,amount,balance");
    expect(ledger).toHaveLength(3);
    expect(ledger[1]).toMatch(/^"\d{4}-\d{2}-\d{2}","Pay app #1",".*",2170\.64,2170\.64$/);
    expect(ledger[2]).toMatch(/^"\d{4}-\d{2}-\d{2}","Pay app #2",".*",2351\.24,4521\.88$/);

    // The sub exports its own agreement only; Lakeshore gets Not found.
    await documentFor(s, s.kim, "retainage_ledger_csv", s.agreementId);
    for (const kind of ["retainage_ledger_csv", "sov_csv"] as const) {
      await expect(s.ray.mutation(api.documents.documents.requestDocument, { kind, relatedId: s.agreementId })).rejects.toThrow(NOT_FOUND);
    }
  });

  test("text cells that start like a formula are prefixed with an apostrophe", async () => {
    const s = await setup();
    await subCo(s, "@SUM(1) extra outlets", 10_000);
    const sov = csvRows(await bytesOf(s.t, (await documentFor(s, s.dana, "sov_csv", s.agreementId))._id));
    // The CO line's description starts with its label, so the title alone cannot start a formula.
    expect(sov.find((r) => r.includes("SUM(1)"))).toMatch(/^9,"CO #1 . @SUM\(1\) extra outlets",/);
    await s.t.run(async (ctx) => {
      await ctx.db.insert("scheduleOfValues", { agreementId: s.agreementId, lineNo: 99, description: "=HYPERLINK(\"x\")", csiCode: "+1", scheduledValueCents: 1, excludedScope: false });
    });
    const again = csvRows(await bytesOf(s.t, (await documentFor(s, s.dana, "sov_csv", s.agreementId))._id));
    expect(again.at(-1)).toBe('99,"\'=HYPERLINK(""x"")","\'+1",0.01');
  });
});

describe("document access", () => {
  test("the HTTP download serves authorized parties and gives everyone else the same 404", async () => {
    const s = await workedExample();
    const payApp = await documentFor(s, s.dana, "sub_pay_app_pdf", s.app2);
    const ledger = await documentFor(s, s.dana, "retainage_ledger_csv", s.agreementId);
    const subcontract = await documentFor(s, s.dana, "subcontract_pdf", s.agreementId);
    expect(payApp.downloadPath).toBe(`/api/documents/${payApp._id}`);

    for (const who of [s.dana, s.kim]) {
      const res = await who.fetch(payApp.downloadPath, { method: "GET" });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="${payApp.fileName}"`);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    }
    const csv = await s.kim.fetch(ledger.downloadPath, { method: "GET" });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");

    const missing = await s.dana.fetch("/api/documents/not-a-document-id", { method: "GET" });
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();
    expect(missingBody).toBe("Not found.");
    const denials: [Caller, string][] = [
      [s.priya, payApp.downloadPath],
      [s.priya, ledger.downloadPath],
      [s.ray, payApp.downloadPath],
      [s.ray, ledger.downloadPath],
      [s.alicia, payApp.downloadPath],
      [s.alicia, subcontract.downloadPath],
      [s.alicia, ledger.downloadPath],
      [s.f.demo.gc.as, payApp.downloadPath],
      [s.f.noCompany.as, payApp.downloadPath],
    ];
    for (const [who, path] of denials) {
      const res = await who.fetch(path, { method: "GET" });
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe(missingBody);
    }
    for (const path of [payApp.downloadPath, ledger.downloadPath, subcontract.downloadPath]) {
      const anon = await s.t.fetch(path, { method: "GET" });
      expect(anon.status).toBe(401);
      expect(await anon.text()).not.toContain("%PDF");
      const garbage = await s.t.fetch(path, { method: "GET", headers: { Authorization: "Bearer not.a.jwt" } });
      expect([401, 404]).toContain(garbage.status);
    }
    for (const who of [s.priya, s.ray, s.alicia]) {
      await expect(who.query(api.documents.documents.getDocument, { documentId: payApp._id })).rejects.toThrow(NOT_FOUND);
    }
  });

  test("a sub pay app draft is the sub's alone", async () => {
    const s = await setup();
    const { payAppId } = await s.kim.mutation(api.payApps.g703.startPayApp, { agreementId: s.agreementId });
    await documentFor(s, s.kim, "sub_pay_app_pdf", payAppId);
    await expect(s.dana.mutation(api.documents.documents.requestDocument, { kind: "sub_pay_app_pdf", relatedId: payAppId })).rejects.toThrow(NOT_FOUND);
  });

  test("a draft SOV CSV stays with the GC: the sub cannot generate, list, get or download it", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.agreementId, { sov: { status: "draft" } });
      await ctx.db.patch(s.sov[7], { scheduledValueCents: 499_900, description: "Draft-only closeout" });
    });
    const draft = await documentFor(s, s.dana, "sov_csv", s.agreementId);
    expect(new TextDecoder().decode(await bytesOf(s.t, draft._id))).toContain("Draft-only closeout");
    const subRefusals = [
      () => s.kim.mutation(api.documents.documents.requestDocument, { kind: "sov_csv", relatedId: s.agreementId }),
      () => s.kim.query(api.documents.documents.getDocument, { documentId: draft._id }),
    ];
    for (const call of subRefusals) await expect(call()).rejects.toThrow(NOT_FOUND);
    expect((await s.kim.query(api.documents.documents.listDocuments, { projectId: s.projectId })).documents.map((d) => d.kind)).not.toContain("sov_csv");
    const res = await s.kim.fetch(draft.downloadPath, { method: "GET" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found.");
    expect((await s.kim.query(api.payApps.g703.mySubPayAppAgreements, {}))[0].sovApproved).toBe(false);

    // After approval of different lines, the earlier draft file is still the GC's alone; the sub gets the approved one.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.sov[7], { scheduledValueCents: 500_000, description: "Testing, closeout & as-builts" });
      await ctx.db.patch(s.agreementId, { sov: { status: "approved", approvedAt: Date.now(), approvedByName: "Dana" } });
    });
    await expect(s.kim.query(api.documents.documents.getDocument, { documentId: draft._id })).rejects.toThrow(NOT_FOUND);
    expect((await s.kim.fetch(draft.downloadPath, { method: "GET" })).status).toBe(404);
    expect((await s.kim.query(api.documents.documents.listDocuments, { projectId: s.projectId })).documents).toEqual([]);
    expect((await s.dana.fetch(draft.downloadPath, { method: "GET" })).status).toBe(200);
    const approved = await documentFor(s, s.kim, "sov_csv", s.agreementId);
    expect(approved._id).not.toBe(draft._id);
    const approvedRes = await s.kim.fetch(approved.downloadPath, { method: "GET" });
    expect(approvedRes.status).toBe(200);
    const text = await approvedRes.text();
    expect(text).not.toContain("Draft-only");
    expect(text).toContain("Testing, closeout & as-builts");
    expect((await s.kim.query(api.payApps.g703.mySubPayAppAgreements, {}))[0].sovApproved).toBe(true);
  });

  test("document lists and gets return ids and metadata, never a storage URL", async () => {
    const s = await workedExample();
    await documentFor(s, s.dana, "sub_pay_app_pdf", s.app2);
    await documentFor(s, s.dana, "subcontract_pdf", s.agreementId);
    await documentFor(s, s.dana, "change_order_pdf", s.co1);
    const gc = await s.dana.query(api.documents.documents.listDocuments, { projectId: s.projectId });
    expect(gc.documents.map((d) => d.kind).sort()).toEqual(["change_order_pdf", "sub_pay_app_pdf", "subcontract_pdf"]);
    const one = await s.dana.query(api.documents.documents.getDocument, { documentId: gc.documents[0]._id });
    const serialized = JSON.stringify([gc, one]);
    expect(serialized).not.toMatch(/\/api\/storage\/|storageId|https?:\/\//);
    // The owner sees none of the subcontract documents.
    expect((await s.alicia.query(api.documents.documents.listDocuments, { projectId: s.projectId })).documents).toEqual([]);
    await expect(s.priya.query(api.documents.documents.listDocuments, { projectId: s.projectId })).rejects.toThrow(NOT_FOUND);
    expect((await s.kim.query(api.documents.documents.listDocuments, { projectId: s.projectId })).documents).toHaveLength(3);
    expect((await s.ray.query(api.documents.documents.listDocuments, { projectId: s.projectId })).documents).toEqual([]);
  });
});
