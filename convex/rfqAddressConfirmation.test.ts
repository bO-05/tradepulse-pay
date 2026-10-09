/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildTenancyFixture } from "./lib/tenancyFixtures";
import { bidderAddressConfirmed, vendorAddressConfirmed } from "./lib/rfqEmail";

/**
 * RFQ email is default-deny (PROC-SCRUTINY-001): a real company's bidder is emailed only when a GC
 * member typed, edited or confirmed that exact address on the bidder or on its directory vendor.
 * Checked by the preview and again by the send.
 */

const modules = import.meta.glob("./**/*.ts");
const DISCOVERED = "estimating-desk@maxxspace.com";

type T = ReturnType<typeof convexTest>;
type Fixture = Awaited<ReturnType<typeof buildTenancyFixture>>;

function agentmailStub() {
  const calls: { to: string[] }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ message_id: `<rfq-${calls.length}@ses>`, thread_id: `thread-rfq-${calls.length}` }), { status: 200 });
  });
  return calls;
}

async function setup() {
  const t = convexTest(schema, modules);
  const f = await buildTenancyFixture(t);
  await t.run(async (ctx) => {
    await ctx.db.patch(f.gcA.project.projectId, { state: "CA", location: "Oakland, CA" });
    await ctx.db.patch(f.gcA.project.tradePackageId, { status: "draft", bidDeadline: "2026-10-30T14:00" });
  });
  return { t, f };
}

async function newPackage(t: T, f: Fixture) {
  return await t.run(async (ctx) => {
    const pkg = (await ctx.db.get(f.gcA.project.tradePackageId))!;
    const { _id, _creationTime, ...fields } = pkg;
    return await ctx.db.insert("tradePackages", { ...fields, invitedContractorIds: [], status: "draft" });
  });
}

async function discover(t: T, f: Fixture) {
  const [contractorId] = await t.mutation(internal.contractors.batchInsertContractors, {
    tradePackageId: f.gcA.project.tradePackageId,
    contractors: [
      { companyName: "Lakeside Electrical", contactEmail: DISCOVERED, licenseNumber: "1000001", licenseStatus: "Unverified — from web search result", sourceUrl: "https://lakeside.example/contact" },
    ],
  });
  const row = (await t.run((ctx) => ctx.db.get(contractorId)))!;
  return { contractorId, vendorId: row.vendorId as Id<"vendors"> };
}

const preview = (f: Fixture, tradePackageId: Id<"tradePackages">) =>
  f.gcA.admin.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId });
const send = (f: Fixture, tradePackageId: Id<"tradePackages">, contractorId: Id<"contractors">, email: string) =>
  f.gcA.admin.as.action(api.rfqActions.dispatchRfqsWithNotification, { tradePackageId, recipients: [{ contractorId, email }] }) as Promise<any>;
const outboxRows = (t: T) => t.run((ctx) => ctx.db.query("emailOutbox").collect());

async function directoryVendor(f: Fixture, email: string) {
  const { vendorId } = await f.gcA.admin.as.mutation(api.vendors.createVendor, { name: "Harbor Electric", trades: ["26 00 00"], contactName: "Pat", email });
  return vendorId as Id<"vendors">;
}

beforeEach(() => {
  vi.stubEnv("AGENTMAIL_API_KEY", "test-agentmail-key");
  vi.stubEnv("EMAIL_DAILY_BUDGET", "60");
  vi.stubEnv("SITE_URL", "https://app.tradepulse.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("confirmation rules", () => {
  test("a bidder is confirmed only for the exact address recorded; legacy rows only with a GC record", () => {
    const base = { contactEmail: "Bids@Acme.test", licenseStatus: "" };
    expect(bidderAddressConfirmed({ ...base, emailConfirmedFor: "bids@acme.test" })).toBe(true);
    expect(bidderAddressConfirmed({ ...base, emailConfirmedFor: "old@acme.test", emailConfirmedAt: 1, emailSource: "gc" })).toBe(false);
    expect(bidderAddressConfirmed({ ...base, emailSource: "gc" })).toBe(true);
    expect(bidderAddressConfirmed({ ...base, emailConfirmedAt: 1 })).toBe(true);
    for (const emailSource of [undefined, "directory", "document", "web_discovery"] as const) {
      expect(bidderAddressConfirmed({ ...base, emailSource })).toBe(false);
    }
  });

  test("a vendor confirms only its current email, never a discovered one", () => {
    expect(vendorAddressConfirmed({ email: "a@x.test", emailConfirmedFor: "a@x.test", emailConfirmedAt: 1 }, "A@x.test")).toBe(true);
    expect(vendorAddressConfirmed({ email: "b@x.test", emailConfirmedFor: "a@x.test", emailConfirmedAt: 1 }, "a@x.test")).toBe(false);
    expect(vendorAddressConfirmed({ email: "a@x.test", emailConfirmedFor: "b@x.test", emailConfirmedAt: 1 }, "a@x.test")).toBe(false);
    expect(vendorAddressConfirmed({ email: "a@x.test", emailConfirmedAt: 1 }, "a@x.test")).toBe(true);
    expect(vendorAddressConfirmed({ email: "a@x.test", discoveredEmail: "a@x.test", emailConfirmedAt: 1 }, "a@x.test")).toBe(false);
    expect(vendorAddressConfirmed({ email: "a@x.test" }, "a@x.test")).toBe(false);
  });
});

describe("RFQ preview and send are default-deny", () => {
  test("a pre-fix directory clone with no provenance fields is 'email not confirmed' and never sent", async () => {
    const { t, f } = await setup();
    const calls = agentmailStub();
    const { vendorId } = await discover(t, f);
    const pkg2 = await newPackage(t, f);
    // Records written before provenance existed: the vendor carries no discovery or confirmation
    // marker, and the cloned bidders say "directory" or nothing at all.
    const [asDirectory, noSource] = await t.run(async (ctx) => {
      await ctx.db.patch(vendorId, { discoveredEmail: undefined, emailConfirmedAt: undefined, emailConfirmedFor: undefined });
      const base = {
        tradePackageId: pkg2,
        companyName: "Lakeside Electrical",
        contactEmail: DISCOVERED,
        licenseNumber: "1000001",
        licenseStatus: "Not checked — license on file in the vendor directory",
        sourceUrl: "",
        rfqStatus: "discovered" as const,
        vendorId,
      };
      return [
        await ctx.db.insert("contractors", { ...base, emailSource: "directory" }),
        await ctx.db.insert("contractors", { ...base, companyName: "Lakeside Electrical (2)" }),
      ];
    });
    const states = (await preview(f, pkg2)).recipients.map((r) => [r.contractorId, r.state, r.note]);
    expect(states).toEqual([
      [asDirectory, "email_unconfirmed", expect.stringMatching(/^Email not confirmed/)],
      [noSource, "email_unconfirmed", expect.stringMatching(/^Email not confirmed/)],
    ]);
    for (const id of [asDirectory, noSource]) {
      expect((await send(f, pkg2, id, DISCOVERED)).deliveryResults).toMatchObject([{ status: "email_unconfirmed" }]);
    }
    expect(calls).toHaveLength(0);
    expect(await outboxRows(t)).toHaveLength(0);
  });

  test("a discovered vendor whose source bidder was edited and then removed is still unconfirmed when reused", async () => {
    const { t, f } = await setup();
    const calls = agentmailStub();
    const { contractorId, vendorId } = await discover(t, f);
    await t.run((ctx) => ctx.db.patch(vendorId, { discoveredEmail: undefined }));
    const source = (await t.run((ctx) => ctx.db.get(contractorId)))!;
    await f.gcA.admin.as.mutation(api.contractors.updateContractor, {
      contractorId,
      companyName: source.companyName,
      contactEmail: "owner-mobile@maxxspace.com",
      licenseNumber: source.licenseNumber,
      licenseStatus: source.licenseStatus,
      sourceUrl: source.sourceUrl,
    });
    await f.gcA.admin.as.mutation(api.contractors.deleteContractor, { contractorId });
    expect((await t.run((ctx) => ctx.db.get(vendorId)))!.email).toBe(DISCOVERED);

    const pkg2 = await newPackage(t, f);
    const { contractorIds } = await f.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg2, vendorIds: [vendorId] });
    expect((await preview(f, pkg2)).recipients).toMatchObject([{ contractorId: contractorIds[0], email: DISCOVERED, state: "email_unconfirmed" }]);
    expect((await send(f, pkg2, contractorIds[0], DISCOVERED)).deliveryResults).toMatchObject([{ status: "email_unconfirmed" }]);
    expect(calls).toHaveLength(0);

    // Once the GC confirms the address it is sendable, and the directory entry carries that confirmation.
    await f.gcA.admin.as.mutation(api.rfqRecipients.confirmBidderEmail, { contractorId: contractorIds[0], email: DISCOVERED });
    expect((await preview(f, pkg2)).recipients[0].state).toBe("ready");
    expect((await t.run((ctx) => ctx.db.get(vendorId)))!.emailConfirmedFor).toBe(DISCOVERED);
  });

  test("a directory address the GC entered is ready when reused on a new package, and is sent", async () => {
    const { t, f } = await setup();
    const calls = agentmailStub();
    const vendorId = await directoryVendor(f, "Bids@MaxxSpace.com");
    const pkg2 = await newPackage(t, f);
    const { contractorIds } = await f.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg2, vendorIds: [vendorId] });
    expect((await preview(f, pkg2)).recipients).toMatchObject([{ contractorId: contractorIds[0], email: "bids@maxxspace.com", state: "ready" }]);
    expect((await send(f, pkg2, contractorIds[0], "bids@maxxspace.com")).deliveryResults).toMatchObject([{ status: "sent" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toEqual(["bids@maxxspace.com"]);
  });

  test("a bidder the GC typed in is ready; one whose address was later written outside the GC paths is not", async () => {
    const { t, f } = await setup();
    const calls = agentmailStub();
    const pkg2 = await newPackage(t, f);
    const typed = await f.gcA.admin.as.mutation(api.contractors.createContractor, {
      tradePackageId: pkg2,
      companyName: "Typed Electric",
      contactEmail: "typed@maxxspace.com",
      licenseNumber: "2",
      licenseStatus: "Unverified",
      sourceUrl: "",
      rfqStatus: "discovered",
    });
    expect((await preview(f, pkg2)).recipients).toMatchObject([{ contractorId: typed, state: "ready" }]);
    await t.run((ctx) => ctx.db.patch(typed, { contactEmail: "other@maxxspace.com" }));
    expect((await preview(f, pkg2)).recipients[0].state).toBe("email_unconfirmed");
    expect((await send(f, pkg2, typed, "other@maxxspace.com")).deliveryResults).toMatchObject([{ status: "email_unconfirmed" }]);
    expect(calls).toHaveLength(0);
  });

  test("the send re-checks confirmation: a ready preview followed by an address change sends nothing", async () => {
    const { t, f } = await setup();
    const calls = agentmailStub();
    const vendorId = await directoryVendor(f, "bids@maxxspace.com");
    const pkg2 = await newPackage(t, f);
    const { contractorIds } = await f.gcA.admin.as.mutation(api.contractors.addBiddersFromDirectory, { tradePackageId: pkg2, vendorIds: [vendorId] });
    const bidder = contractorIds[0];
    expect((await preview(f, pkg2)).recipients[0]).toMatchObject({ email: "bids@maxxspace.com", state: "ready" });

    // The directory entry moves to a new address, so it no longer confirms the bidder's old one.
    const vendor = (await t.run((ctx) => ctx.db.get(vendorId)))!;
    await f.gcA.admin.as.mutation(api.vendors.updateVendor, {
      vendorId,
      name: vendor.name,
      trades: vendor.trades,
      contactName: vendor.contactName,
      email: "estimating@maxxspace.com",
    });
    expect((await send(f, pkg2, bidder, "bids@maxxspace.com")).deliveryResults).toMatchObject([{ status: "email_unconfirmed" }]);

    // The bidder's address changes after the review: the reviewed address is refused.
    await t.run((ctx) => ctx.db.patch(bidder, { contactEmail: "estimating@maxxspace.com" }));
    expect((await send(f, pkg2, bidder, "bids@maxxspace.com")).deliveryResults).toMatchObject([{ status: "email_changed" }]);
    expect(calls).toHaveLength(0);
    expect(await outboxRows(t)).toHaveLength(0);
  });

  test("the Demo company's seeded bidders keep their previous preview state", async () => {
    const { t, f } = await setup();
    await t.run((ctx) => ctx.db.patch(f.demo.project.contractorId, { contactEmail: "estimating@rosendin.example", rfqStatus: "discovered" }));
    const demo = await f.demo.gc.as.query(api.rfqRecipients.previewRfqRecipients, { tradePackageId: f.demo.project.tradePackageId });
    expect(demo.isDemo).toBe(true);
    expect(demo.recipients[0].state).not.toBe("email_unconfirmed");
  });
});
