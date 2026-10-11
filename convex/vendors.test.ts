/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";
import { withSession } from "./lib/testIdentity";

const modules = import.meta.glob("./**/*.ts");

const EASTBAY = {
  name: "Eastbay Electric",
  trades: ["26 00 00"],
  contactName: "Kim Tran",
  email: "kim.tran@eastbay-mail.com",
  phone: "(510) 555-0142",
  licenseNumber: "1098765",
  licenseState: "CA",
};

async function setup() {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  const fx = await buildTenancyFixture(t);
  return { t, fx };
}

type T = Awaited<ReturnType<typeof setup>>["t"];

async function vendorCount(t: T, companyId: Id<"companies">) {
  return await t.run(async (ctx) => (await ctx.db.query("vendors").withIndex("by_companyId", (q) => q.eq("companyId", companyId)).collect()).length);
}

describe("vendor directory CRUD", () => {
  test("a GC member adds a vendor; it is stored for the caller's company only, active and unlinked", async () => {
    const { t, fx } = await setup();
    expect(await fx.gcA.member.as.query(api.vendors.listVendors, {})).toEqual([]);
    const { vendorId } = await fx.gcA.member.as.mutation(api.vendors.createVendor, EASTBAY);
    const row = await t.run((ctx) => ctx.db.get(vendorId));
    expect(row).toMatchObject({ companyId: fx.gcA.companyId, status: "active", email: EASTBAY.email, trades: ["26 00 00"] });
    expect(row?.linkedCompanyId).toBeUndefined();
    const list = await fx.gcA.admin.as.query(api.vendors.listVendors, {});
    expect(list).toEqual([expect.objectContaining({ name: "Eastbay Electric", phone: "(510) 555-0142", licenseNumber: "1098765", licenseState: "CA", linked: false, status: "active" })]);
    expect((await fx.gcB.admin.as.query(api.vendors.listVendors, {})).map((v) => v._id)).not.toContain(vendorId);
    expect((await fx.demo.gc.as.query(api.vendors.listVendors, {})).map((v) => v._id)).not.toContain(vendorId);
  });

  test("invalid input and duplicate email are refused with a field and nothing is written", async () => {
    const { t, fx } = await setup();
    await fx.gcA.admin.as.mutation(api.vendors.createVendor, EASTBAY);
    const before = await vendorCount(t, fx.gcA.companyId);
    const cases: [Partial<typeof EASTBAY>, RegExp, string][] = [
      [{ name: "" }, /company name/, "name"],
      [{ email: "kim@" }, /valid email/, "email"],
      [{ trades: ["Electric"] }, /not a CSI division/, "trades"],
      [{ name: "Eastbay Two", email: "KIM.TRAN@eastbay-mail.com" }, /A vendor with this email already exists/, "email"],
    ];
    for (const [patch, message, field] of cases) {
      const err = await fx.gcA.admin.as.mutation(api.vendors.createVendor, { ...EASTBAY, ...patch }).catch((e) => e);
      expect(String(err.data?.message ?? err)).toMatch(message);
      expect(err.data?.field).toBe(field);
    }
    expect(await vendorCount(t, fx.gcA.companyId)).toBe(before);
    // Another company may list the same email in its own directory.
    await fx.gcB.admin.as.mutation(api.vendors.createVendor, EASTBAY);
  });

  test("edit persists; deactivation hides from the default list but keeps the row and its bidders", async () => {
    const { t, fx } = await setup();
    const { vendorId } = await fx.gcA.admin.as.mutation(api.vendors.createVendor, EASTBAY);
    await fx.gcA.admin.as.mutation(api.vendors.updateVendor, { vendorId, ...EASTBAY, phone: "(510) 555-0199", trades: ["26 00 00", "27 00 00"] });
    expect(await t.run((ctx) => ctx.db.get(vendorId))).toMatchObject({ phone: "(510) 555-0199", trades: ["26 00 00", "27 00 00"] });

    const pkg = fx.gcA.project.tradePackageId;
    const { contractorIds } = await fx.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg, vendorIds: [vendorId] });
    await fx.gcA.admin.as.mutation(api.vendors.setVendorStatus, { vendorId, status: "inactive" });
    expect(await fx.gcA.admin.as.query(api.vendors.listVendors, {})).toEqual([]);
    expect((await fx.gcA.admin.as.query(api.vendors.listVendors, { includeInactive: true }))[0]).toMatchObject({ _id: vendorId, status: "inactive" });
    const bidders = await fx.gcA.admin.as.query(api.contractors.listByPackage, { tradePackageId: pkg });
    expect(bidders.map((b) => b._id)).toContain(contractorIds[0]);
    // An inactive vendor cannot be added as a new bidder.
    const other = await t.run((ctx) => ctx.db.insert("tradePackages", {
      projectId: fx.gcA.project.projectId,
      csiDivision: "27 00 00",
      tradeName: "Communications",
      budgetEstimate: 1000,
      agentMailbox: "x@example.invalid",
      agentMailboxId: "x",
      scopeSummary: "Comms",
      mandatoryInclusions: [],
      bidDeadline: "2026-12-01",
      status: "draft",
    }));
    await expect(fx.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: other, vendorIds: [vendorId] })).rejects.toThrow(/inactive/);
  });

  test("another GC, a sub, an owner and a no-company user cannot read or change Bayview's vendors", async () => {
    const { t, fx } = await setup();
    const { vendorId } = await fx.gcA.admin.as.mutation(api.vendors.createVendor, EASTBAY);
    const before = await t.run((ctx) => ctx.db.get(vendorId));
    await expect(fx.gcB.admin.as.mutation(api.vendors.updateVendor, { vendorId, ...EASTBAY, name: "Hijacked" })).rejects.toThrow(/Not found/);
    await expect(fx.gcB.admin.as.mutation(api.vendors.setVendorStatus, { vendorId, status: "inactive" })).rejects.toThrow(/Not found/);
    await expect(fx.demo.gc.as.mutation(api.vendors.updateVendor, { vendorId, ...EASTBAY })).rejects.toThrow(/Not found/);
    for (const who of [fx.sub.admin, fx.owner.admin]) {
      await expect(who.as.query(api.vendors.listVendors, {})).rejects.toThrow(/Forbidden/);
      await expect(who.as.mutation(api.vendors.createVendor, EASTBAY)).rejects.toThrow(/Forbidden/);
      await expect(who.as.mutation(api.vendors.updateVendor, { vendorId, ...EASTBAY })).rejects.toThrow(/Forbidden/);
      await expect(who.as.mutation(api.vendors.importVendors, { rows: [{ row: 1, ...EASTBAY }] })).rejects.toThrow(/Forbidden/);
    }
    await expect(fx.noCompany.as.query(api.vendors.listVendors, {})).rejects.toThrow(/company/);
    await expect(t.query(api.vendors.listVendors, {})).rejects.toThrow(/Not authenticated/);
    expect(await t.run((ctx) => ctx.db.get(vendorId))).toEqual(before);
  });
});

describe("CSV import", () => {
  const rows = [
    { row: 1, name: "Bay Area Mechanical", trades: ["23 00 00"], contactName: "Ana", email: "ana@bam.example.com" },
    { row: 2, name: "Peninsula Plumbing", trades: ["22 00 00"], contactName: "Raj", email: "raj@pp.example.com" },
    { row: 3, name: '=HYPERLINK("http://evil.example","x")', trades: ["09 00 00"], contactName: "Eve", email: "eve@evil.example.com" },
    { row: 4, name: "No Email Co", trades: ["26 00 00"], contactName: "N", email: "" },
    { row: 5, name: "Vague HVAC", trades: ["HVAC stuff"], contactName: "V", email: "v@vh.example.com" },
  ];

  test("imports only valid rows, reports row errors, and a re-import creates no duplicates", async () => {
    const { t, fx } = await setup();
    const first = await fx.gcA.admin.as.mutation(api.vendors.importVendors, { rows });
    expect(first.created).toBe(3);
    expect(first.errors).toEqual([
      { row: 4, message: "Row 4: email is required." },
      { row: 5, message: expect.stringContaining('Row 5: "HVAC stuff" is not a CSI division') },
    ]);
    expect(await vendorCount(t, fx.gcA.companyId)).toBe(3);
    const again = await fx.gcA.admin.as.mutation(api.vendors.importVendors, { rows });
    expect(again.created).toBe(0);
    expect(again.duplicates.map((d) => d.row)).toEqual([1, 2, 3]);
    expect(await vendorCount(t, fx.gcA.companyId)).toBe(3);
    const evil = (await fx.gcA.admin.as.query(api.vendors.listVendors, {})).find((v) => v.email === "eve@evil.example.com");
    expect(evil?.name).toBe('=HYPERLINK("http://evil.example","x")');
  });

  test("more than 1000 rows is refused", async () => {
    const { fx } = await setup();
    const many = Array.from({ length: 1001 }, (_, i) => ({ row: i + 1, name: `Co ${i}`, trades: ["26 00 00"], email: `c${i}@example.com` }));
    await expect(fx.gcA.admin.as.mutation(api.vendors.importVendors, { rows: many })).rejects.toThrow(/at most 1000 rows/);
  });
});

describe("bidders from the directory", () => {
  test("adding from the directory and creating a new vendor both give the bidder a vendorId; duplicates are refused", async () => {
    const { t, fx } = await setup();
    const pkg = fx.gcA.project.tradePackageId;
    const { vendorId: eastbay } = await fx.gcA.admin.as.mutation(api.vendors.createVendor, { ...EASTBAY, email: "kim@eastbay.test" });
    const { vendorId: oakland } = await fx.gcA.admin.as.mutation(api.vendors.createVendor, { ...EASTBAY, name: "Oakland Power & Light", email: "bids@opl.example.com" });
    const added = await fx.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg, vendorIds: [eastbay, oakland] });
    const created = await fx.gcA.admin.as.mutation(api.contractors.createVendorBidder, {
      tradePackageId: pkg,
      name: "Golden Gate Electric",
      trades: [],
      email: "estimating@gge.example.com",
    });
    const rows = await t.run(async (ctx) => Promise.all([...added.contractorIds, created.contractorId].map((id) => ctx.db.get(id))));
    expect(rows.map((r) => r?.vendorId)).toEqual([eastbay, oakland, created.vendorId]);
    // The vendor is not linked to a sub company, so neither is its bidder row.
    expect(rows[0]?.linkedCompanyId).toBeUndefined();
    const dir = await fx.gcA.admin.as.query(api.vendors.listVendors, {});
    expect(dir.find((v) => v._id === created.vendorId)).toMatchObject({ name: "Golden Gate Electric", trades: ["26 00 00"] });
    await expect(fx.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg, vendorIds: [eastbay] })).rejects.toThrow(
      /Eastbay Electric is already a bidder on this package/,
    );
    // Creating a "new" vendor whose email is already in the directory is refused, so no duplicate vendor appears.
    await expect(
      fx.gcA.admin.as.mutation(api.contractors.createVendorBidder, { tradePackageId: pkg, name: "GGE again", trades: [], email: "estimating@gge.example.com" }),
    ).rejects.toThrow(/already exists/);
  });

  test("a vendor already linked to a sub company on the project yields a linked bidder row", async () => {
    const { t, fx } = await setup();
    const vendorId = await t.run((ctx) =>
      ctx.db.insert("vendors", { companyId: fx.gcA.companyId, ...EASTBAY, linkedCompanyId: fx.sub.companyId, status: "active", createdAt: Date.now() }),
    );
    const pkg = await t.run((ctx) => ctx.db.insert("tradePackages", {
      projectId: fx.gcA.project.projectId,
      csiDivision: "27 00 00",
      tradeName: "Communications",
      budgetEstimate: 1000,
      agentMailbox: "x@example.invalid",
      agentMailboxId: "x",
      scopeSummary: "Comms",
      mandatoryInclusions: [],
      bidDeadline: "2026-12-01",
      status: "draft",
    }));
    const { contractorIds } = await fx.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg, vendorIds: [vendorId] });
    expect(await t.run((ctx) => ctx.db.get(contractorIds[0]))).toMatchObject({ vendorId, linkedCompanyId: fx.sub.companyId });
  });

  test("another company cannot add bidders to Bayview's package or use Bayview's vendors", async () => {
    const { t, fx } = await setup();
    const { vendorId } = await fx.gcA.admin.as.mutation(api.vendors.createVendor, EASTBAY);
    const { vendorId: sonoranVendor } = await fx.gcB.admin.as.mutation(api.vendors.createVendor, EASTBAY);
    const before = await t.run(async (ctx) => (await ctx.db.query("contractors").collect()).length);
    const pkgA = fx.gcA.project.tradePackageId;
    for (const who of [fx.gcB.admin, fx.sub.admin, fx.owner.admin, fx.demo.gc]) {
      await expect(who.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkgA, vendorIds: [vendorId] })).rejects.toThrow(/Not found|Forbidden/);
      await expect(who.as.mutation(api.contractors.createVendorBidder, { tradePackageId: pkgA, ...EASTBAY, email: "x@y.example.com" })).rejects.toThrow(/Not found|Forbidden/);
    }
    await expect(t.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkgA, vendorIds: [vendorId] })).rejects.toThrow(/Not authenticated/);
    // Bayview cannot pick Sonoran's vendor for its own package.
    await expect(fx.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkgA, vendorIds: [sonoranVendor] })).rejects.toThrow(/Not found/);
    expect(await t.run(async (ctx) => (await ctx.db.query("contractors").collect()).length)).toBe(before);
  });

  test("manual bidders and the backfill carry vendorId and reuse vendors by email", async () => {
    const { t, fx } = await setup();
    const pkg = fx.gcA.project.tradePackageId;
    const id = await fx.gcA.admin.as.mutation(api.contractors.createContractor, {
      tradePackageId: pkg,
      companyName: "Manual Electric",
      contactEmail: "Manual@Example.com",
      licenseNumber: "123",
      licenseStatus: "Unverified",
      sourceUrl: "",
      rfqStatus: "discovered",
    });
    const manual = await t.run((ctx) => ctx.db.get(id));
    expect(manual?.vendorId).toBeDefined();
    expect(await t.run((ctx) => ctx.db.get(manual!.vendorId!))).toMatchObject({ companyId: fx.gcA.companyId, email: "manual@example.com", trades: ["26 00 00"] });

    // Fixture bidders were inserted directly (no vendorId); the backfill links them, and is idempotent.
    const first = await t.mutation(internal.vendors.backfillBidderVendors, {});
    expect(first.contractorsLinked).toBeGreaterThanOrEqual(3);
    const second = await t.mutation(internal.vendors.backfillBidderVendors, {});
    expect(second).toMatchObject({ contractorsLinked: 0, vendorsCreated: 0 });
    const all = await t.run((ctx) => ctx.db.query("contractors").collect());
    expect(all.every((c) => c.vendorId !== undefined)).toBe(true);
    const demoBidder = all.find((c) => c._id === fx.demo.project.contractorId)!;
    expect((await t.run((ctx) => ctx.db.get(demoBidder.vendorId!)))?.companyId).toBe(fx.demo.companyIds.gc);
    // A bidder already linked to a sub company passes the link to its new vendor.
    const eastbayBidder = all.find((c) => c._id === fx.gcA.project.contractorId)!;
    expect((await t.run((ctx) => ctx.db.get(eastbayBidder.vendorId!)))?.linkedCompanyId).toBe(fx.sub.companyId);
  });
});

describe("every live bidder path enforces the vendor rules", () => {
  const manual = (pkg: Id<"tradePackages">, email: string) => ({
    tradePackageId: pkg,
    companyName: "Eastbay Electric",
    contactEmail: email,
    licenseNumber: "1098765",
    licenseStatus: "Unverified",
    sourceUrl: "",
    rfqStatus: "discovered" as const,
  });
  const bidderCount = (t: T, pkg: Id<"tradePackages">) =>
    t.run(async (ctx) => (await ctx.db.query("contractors").withIndex("by_package", (q) => q.eq("tradePackageId", pkg)).collect()).length);

  test("Add Contractor Manually refuses an inactive vendor and a vendor already bidding on the package", async () => {
    const { t, fx } = await setup();
    const pkg = fx.gcA.project.tradePackageId;
    const { vendorId } = await fx.gcA.admin.as.mutation(api.vendors.createVendor, EASTBAY);
    await fx.gcA.admin.as.mutation(api.vendors.setVendorStatus, { vendorId, status: "inactive" });
    const before = await bidderCount(t, pkg);
    await expect(fx.gcA.admin.as.mutation(api.contractors.createContractor, manual(pkg, "KIM.TRAN@eastbay-mail.com"))).rejects.toThrow(
      /Eastbay Electric is inactive in the vendor directory/,
    );
    expect(await bidderCount(t, pkg)).toBe(before);

    await fx.gcA.admin.as.mutation(api.vendors.setVendorStatus, { vendorId, status: "active" });
    const id = await fx.gcA.admin.as.mutation(api.contractors.createContractor, manual(pkg, EASTBAY.email));
    expect((await t.run((ctx) => ctx.db.get(id)))?.vendorId).toBe(vendorId);
    await expect(fx.gcA.admin.as.mutation(api.contractors.createContractor, manual(pkg, EASTBAY.email))).rejects.toThrow(
      /already a bidder on this package/,
    );
    await expect(fx.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg, vendorIds: [vendorId] })).rejects.toThrow(
      /already a bidder on this package/,
    );
    expect(await bidderCount(t, pkg)).toBe(before + 1);
  });

  test("discovery imports skip inactive vendors and vendors already bidding; quote intake reuses the existing bidder", async () => {
    const { t, fx } = await setup();
    const pkg = fx.gcA.project.tradePackageId;
    const { vendorId: inactive } = await fx.gcA.admin.as.mutation(api.vendors.createVendor, { ...EASTBAY, name: "Dormant Electric", email: "dormant@example.com" });
    await fx.gcA.admin.as.mutation(api.vendors.setVendorStatus, { vendorId: inactive, status: "inactive" });
    const existing = await fx.gcA.admin.as.mutation(api.contractors.createContractor, manual(pkg, EASTBAY.email));
    const discovered = (c: { companyName: string; contactEmail: string; sourceUrl: string }) => ({ ...c, licenseNumber: "", licenseStatus: "Unverified" });
    const ids = await t.mutation(internal.contractors.batchInsertContractors, {
      tradePackageId: pkg,
      contractors: [
        discovered({ companyName: "Dormant Electric", contactEmail: "dormant@example.com", sourceUrl: "https://a.example" }),
        discovered({ companyName: "Eastbay Electric", contactEmail: EASTBAY.email, sourceUrl: "https://b.example" }),
        discovered({ companyName: "Fresh Electric", contactEmail: "fresh@example.com", sourceUrl: "https://c.example" }),
      ],
    });
    expect(ids).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(ids[0])))?.companyName).toBe("Fresh Electric");

    const quote = { tradePackageId: pkg, companyName: "Eastbay Electric", contactEmail: EASTBAY.email, licenseNumber: "", licenseStatus: "x", sourceUrl: "", rfqStatus: "bid_received" as const };
    expect(await t.mutation(internal.contractors.createContractorInternal, quote)).toBe(existing);
    await expect(
      t.mutation(internal.contractors.createContractorInternal, { ...quote, companyName: "Dormant Electric", contactEmail: "dormant@example.com" }),
    ).rejects.toThrow(/inactive/);
  });
});

describe("directories larger than 2000 vendors", () => {
  test("paged list, search and the active export include vendors beyond the first 2000 rows", async () => {
    const { t, fx } = await setup();
    const batch = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ row: i + 1, name: `Vendor ${String(from + i).padStart(5, "0")}`, trades: ["26 00 00"], email: `v${from + i}@bulk.example.com` }));
    await fx.gcA.admin.as.mutation(api.vendors.importVendors, { rows: batch(0, 1000) });
    await fx.gcA.admin.as.mutation(api.vendors.importVendors, { rows: batch(1000, 1000) });
    await fx.gcA.admin.as.mutation(api.vendors.importVendors, {
      rows: [
        ...batch(2000, 20),
        { row: 21, name: "Zephyr Late Electric", trades: ["26 00 00"], email: "late@zephyr.example.com" },
        { row: 22, name: "Bayside Plumbing", trades: ["22 00 00"], email: "office@bayside.example.com" },
      ],
    });
    const lastId = (await t.run((ctx) => ctx.db.query("vendors").withIndex("by_companyId_and_email", (q) => q.eq("companyId", fx.gcA.companyId).eq("email", "late@zephyr.example.com")).first()))!._id;
    await fx.gcA.admin.as.mutation(api.vendors.setVendorStatus, { vendorId: lastId, status: "inactive" });

    async function all(status: "active" | "inactive" | "all", search?: string) {
      const out: { _id: string; name: string; status: string }[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page: { page: { _id: string; name: string; status: string }[]; isDone: boolean; continueCursor: string } = await fx.gcA.admin.as.query(
          api.vendors.listVendorsPage,
          { paginationOpts: { numItems: 400, cursor }, status, ...(search ? { search } : {}) },
        );
        out.push(...page.page);
        if (page.isDone) return out;
        cursor = page.continueCursor;
      }
    }
    const active = await all("active");
    expect(active).toHaveLength(2021);
    expect(active.some((v) => v.name === "Vendor 02019")).toBe(true);
    expect(active.map((v) => v.name)).toEqual([...active.map((v) => v.name)].sort((a, b) => a.localeCompare(b)));
    expect(await all("all")).toHaveLength(2022);
    // A CSI division is one search term, so "22 00 00" does not match every "xx 00 00" vendor.
    expect((await all("active", "22 00 00")).map((v) => v.name)).toEqual(["Bayside Plumbing"]);
    expect((await all("inactive")).map((v) => v._id)).toEqual([lastId]);
    expect((await all("inactive", "zephyr")).map((v) => v._id)).toEqual([lastId]);
    expect(await all("active", "zephyr")).toEqual([]);
    expect((await all("all", "late@zephyr.example.com")).map((v) => v._id)).toEqual([lastId]);

    expect(await fx.gcA.admin.as.query(api.vendors.directorySummary, {})).toEqual({ hasVendors: true, hasActive: true });
    expect(await fx.gcB.admin.as.query(api.vendors.directorySummary, {})).toEqual({ hasVendors: false, hasActive: false });
    const exists = await fx.gcA.admin.as.query(api.vendors.existingVendorEmails, { emails: ["V2019@bulk.example.com", "nobody@example.com"] });
    expect(exists).toEqual(["v2019@bulk.example.com"]);
    // Another company sees none of it.
    expect((await fx.gcB.admin.as.query(api.vendors.listVendorsPage, { paginationOpts: { numItems: 50, cursor: null }, status: "all" })).page).toEqual([]);
    expect(await fx.gcB.admin.as.query(api.vendors.existingVendorEmails, { emails: ["v1@bulk.example.com"] })).toEqual([]);
    await expect(fx.sub.admin.as.query(api.vendors.listVendorsPage, { paginationOpts: { numItems: 50, cursor: null }, status: "all" })).rejects.toThrow(/Forbidden/);
    const summaries = await fx.gcA.admin.as.query(api.vendors.vendorSummaries, { vendorIds: [lastId] });
    expect(summaries).toEqual([expect.objectContaining({ _id: lastId, name: "Zephyr Late Electric", status: "inactive" })]);
    expect(await fx.gcB.admin.as.query(api.vendors.vendorSummaries, { vendorIds: [lastId] })).toEqual([]);
  }, 120_000);
});

describe("sub view of GC relationships", () => {
  test("a linked sub sees only its own vendor rows and its projects per GC", async () => {
    const { t, fx } = await setup();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("vendors", { companyId: fx.gcA.companyId, ...EASTBAY, linkedCompanyId: fx.sub.companyId, status: "active", createdAt: now });
      await ctx.db.insert("vendors", { companyId: fx.gcA.companyId, ...EASTBAY, name: "Lakeshore Mechanical", email: "ray@lakeshore.test", status: "active", createdAt: now });
    });
    const rel = await fx.sub.admin.as.query(api.vendors.myGcRelationships, {});
    expect(rel).toEqual([
      expect.objectContaining({ gcCompanyName: "Bayview Builders Inc.", listedAs: "Eastbay Electric", projects: [{ projectId: fx.gcA.project.projectId, title: "Harbor Point Dental Office TI" }] }),
    ]);
    expect(JSON.stringify(rel)).not.toContain("Lakeshore");
    await expect(fx.sub.admin.as.query(api.vendors.listVendors, {})).rejects.toThrow(/Forbidden/);
    expect(await fx.gcA.admin.as.query(api.vendors.myGcRelationships, {})).toEqual([]);
  });

  test("a second sub invite for the same vendor reuses the linked company", async () => {
    const { t, fx } = await setup();
    const res = await fx.gcA.admin.as.action(api.invites.create, {
      kind: "sub",
      email: "kim.new@eastbay-mail.com",
      projectId: fx.gcA.project.projectId,
      newVendor: { name: "Eastbay Electric North", trade: "26 00 00", contactName: "Kim Tran" },
      sendEmail: false,
    });
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "kim.new@eastbay-mail.com", emailVerificationTime: Date.now() }));
    const kim = await withSession(t, userId, "kim.new@eastbay-mail.com");
    const token = res.link.match(/#\/invite\/([A-Za-z0-9_-]+)$/)![1];
    const accepted = await kim.mutation(api.invites.accept, { token });
    const invite = await t.run((ctx) => ctx.db.get(res.inviteId));
    expect((await t.run((ctx) => ctx.db.get(invite!.vendorId!)))?.linkedCompanyId).toBe(accepted.companyId);
    const before = await t.run(async (ctx) => (await ctx.db.query("companies").collect()).length);
    const second = await fx.gcB.admin.as.action(api.invites.create, {
      kind: "sub",
      email: "kim.new@eastbay-mail.com",
      projectId: fx.gcB.project.projectId,
      newVendor: { name: "Eastbay Electric North", trade: "26 00 00", contactName: "Kim Tran" },
      sendEmail: false,
    });
    const again = await kim.mutation(api.invites.accept, { token: second.link.match(/#\/invite\/([A-Za-z0-9_-]+)$/)![1] });
    expect(again.companyId).toBe(accepted.companyId);
    expect(await t.run(async (ctx) => (await ctx.db.query("companies").collect()).length)).toBe(before);
  });
});
