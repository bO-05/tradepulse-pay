import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import {
  DUPLICATE_VENDOR_EMAIL_MESSAGE,
  firstVendorError,
  isPlaceholderEmail,
  normalizeTrade,
  validateVendorInput,
  type VendorField,
  type VendorInput,
} from "./vendorRules";
import { isMergedVendor, liveVendor } from "./vendorRead";
import { searchTextPatch, vendorSearchText } from "./vendorSearch";
import { emailNeedsConfirmation } from "./rfqEmail";

/**
 * Vendor directory helpers for the bidder (contractors) write paths. Every bidder row carries the
 * vendorId of its GC company's directory entry: found by contact email, or by name for bidders
 * whose email is a placeholder, else created.
 */

export async function findVendorByEmail(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  email: string,
): Promise<Doc<"vendors"> | null> {
  const rows = await ctx.db
    .query("vendors")
    .withIndex("by_companyId_and_email", (q) => q.eq("companyId", companyId).eq("email", email.trim().toLowerCase()))
    .take(50);
  return rows.find((r) => !isMergedVendor(r)) ?? null;
}

/** The GC company's oldest vendor row linked to this sub company, if any. */
export async function findVendorByLinkedCompany(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  linkedCompanyId: Id<"companies">,
): Promise<Doc<"vendors"> | null> {
  const rows = await ctx.db
    .query("vendors")
    .withIndex("by_companyId_and_linkedCompanyId", (q) => q.eq("companyId", companyId).eq("linkedCompanyId", linkedCompanyId))
    .take(50);
  return rows.find((r) => !isMergedVendor(r)) ?? null;
}

async function findVendorByName(ctx: QueryCtx, companyId: Id<"companies">, name: string): Promise<Doc<"vendors"> | null> {
  const key = name.trim().toLowerCase();
  const rows = await ctx.db
    .query("vendors")
    .withIndex("by_companyId", (q) => q.eq("companyId", companyId))
    .take(1000);
  return rows.find((r) => !isMergedVendor(r) && r.name.trim().toLowerCase() === key) ?? null;
}

const UNINFORMATIVE_LICENSE = /^(0|not verified|unknown|n\/a|none|pending)$/i;

type BidderFields = Pick<Doc<"contractors">, "companyName" | "contactEmail" | "phone" | "licenseNumber" | "linkedCompanyId"> &
  Partial<Pick<Doc<"contractors">, "licenseStatus" | "emailSource" | "emailConfirmedAt">>;

function bidderEmailUnconfirmed(bidder: BidderFields): boolean {
  return emailNeedsConfirmation({ ...bidder, licenseStatus: bidder.licenseStatus ?? "" });
}

/**
 * True when the vendor's current email came from web discovery and no GC member has confirmed or
 * entered it. Vendors created before provenance was stored are judged by the bidder rows that use
 * the same address: unconfirmed if one still needs confirmation and none was confirmed or GC-entered.
 */
export async function vendorEmailUnconfirmed(ctx: QueryCtx, vendor: Doc<"vendors">): Promise<boolean> {
  const email = vendor.email.trim().toLowerCase();
  if (isPlaceholderEmail(email)) return false;
  if (vendor.discoveredEmail !== undefined) return vendor.discoveredEmail === email;
  if (vendor.emailConfirmedAt !== undefined) return false;
  const bidders = await ctx.db
    .query("contractors")
    .withIndex("by_vendorId", (q) => q.eq("vendorId", vendor._id))
    .take(200);
  const sameAddress = bidders.filter((c) => c.contactEmail.trim().toLowerCase() === email);
  const trusted = sameAddress.some((c) => c.emailConfirmedAt !== undefined || c.emailSource === "gc");
  return !trusted && sameAddress.some((c) => emailNeedsConfirmation(c));
}

/** A GC member confirmed or typed `email` for a bidder of this vendor; the directory entry inherits it when it is the same address. */
export async function confirmVendorEmail(ctx: MutationCtx, vendorId: Id<"vendors"> | undefined, email: string): Promise<void> {
  if (vendorId === undefined) return;
  const vendor = await liveVendor(ctx, vendorId);
  if (vendor === null || vendor.email.trim().toLowerCase() !== email.trim().toLowerCase()) return;
  await ctx.db.patch(vendor._id, { discoveredEmail: undefined, emailConfirmedAt: Date.now() });
}

export async function vendorForBidder(
  ctx: MutationCtx,
  gcCompanyId: Id<"companies">,
  bidder: BidderFields,
  csiDivision?: string,
): Promise<{ vendorId: Id<"vendors">; created: boolean }> {
  const email = bidder.contactEmail.trim().toLowerCase();
  const trade = csiDivision ? normalizeTrade(csiDivision) : null;
  const linked = bidder.linkedCompanyId === undefined ? null : await findVendorByLinkedCompany(ctx, gcCompanyId, bidder.linkedCompanyId);
  const existing =
    linked ??
    (isPlaceholderEmail(email)
      ? await findVendorByName(ctx, gcCompanyId, bidder.companyName)
      : await findVendorByEmail(ctx, gcCompanyId, email));
  if (existing !== null) {
    const patch: Partial<Doc<"vendors">> = {};
    if (trade !== null && !existing.trades.includes(trade)) {
      patch.trades = [...existing.trades, trade];
      Object.assign(patch, searchTextPatch(existing, { trades: patch.trades }));
    }
    if (existing.linkedCompanyId === undefined && bidder.linkedCompanyId !== undefined) patch.linkedCompanyId = bidder.linkedCompanyId;
    if (bidder.emailSource === "gc" && existing.email === email && existing.discoveredEmail !== undefined) {
      patch.discoveredEmail = undefined;
      patch.emailConfirmedAt = Date.now();
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
    return { vendorId: existing._id, created: false };
  }
  const license = (bidder.licenseNumber ?? "").trim();
  const name = bidder.companyName.trim().slice(0, 120);
  const trades = trade !== null ? [trade] : [];
  const vendorId = await ctx.db.insert("vendors", {
    companyId: gcCompanyId,
    name,
    trades,
    contactName: "",
    email,
    ...(!isPlaceholderEmail(email) && bidderEmailUnconfirmed(bidder) ? { discoveredEmail: email } : {}),
    searchText: vendorSearchText({ name, trades, contactName: "", email }),
    ...(bidder.phone?.trim() ? { phone: bidder.phone.trim().slice(0, 30) } : {}),
    ...(license && !UNINFORMATIVE_LICENSE.test(license) ? { licenseNumber: license.slice(0, 40) } : {}),
    ...(bidder.linkedCompanyId !== undefined ? { linkedCompanyId: bidder.linkedCompanyId } : {}),
    status: "active",
    createdAt: Date.now(),
  });
  return { vendorId, created: true };
}

/** Sets vendorId on a freshly inserted bidder row (no-op for projects without a GC company). */
export async function attachBidderVendor(ctx: MutationCtx, contractorId: Id<"contractors">): Promise<Id<"vendors"> | null> {
  const contractor = await ctx.db.get(contractorId);
  if (contractor === null) return null;
  if (contractor.vendorId !== undefined) {
    const live = await liveVendor(ctx, contractor.vendorId);
    if (live !== null && live._id !== contractor.vendorId) await ctx.db.patch(contractorId, { vendorId: live._id });
    return live?._id ?? contractor.vendorId;
  }
  const pkg = await ctx.db.get(contractor.tradePackageId);
  const project = pkg === null ? null : await ctx.db.get(pkg.projectId);
  if (pkg === null || project?.gcCompanyId === undefined) return null;
  const { vendorId } = await vendorForBidder(ctx, project.gcCompanyId, contractor, pkg.csiDivision);
  await ctx.db.patch(contractorId, { vendorId });
  return vendorId;
}

export function inactiveVendorError(name: string) {
  return new ConvexError({ code: "INVALID" as const, message: `${name} is inactive in the vendor directory. Reactivate it first.`, field: "vendor" });
}

export function alreadyBidderError(name: string) {
  return new ConvexError({ code: "INVALID" as const, message: `${name} is already a bidder on this package.`, field: "vendor" });
}

export function existingBidderFor(bidders: Doc<"contractors">[], vendor: Doc<"vendors">): Doc<"contractors"> | null {
  const email = vendor.email.trim().toLowerCase();
  return (
    bidders.find(
      (c) =>
        c.vendorId === vendor._id ||
        (c.vendorId === undefined && !isPlaceholderEmail(email) && c.contactEmail.trim().toLowerCase() === email),
    ) ?? null
  );
}

/**
 * Resolves the directory vendor for a bidder about to be added on a live path (manual add,
 * discovery, quote intake). Backfills of existing rows use attachBidderVendor instead, so history
 * keeps its links even when the vendor is inactive now.
 */
export async function vendorForNewBidder(
  ctx: MutationCtx,
  pkg: Doc<"tradePackages">,
  bidder: BidderFields,
): Promise<{ vendor: Doc<"vendors">; existingBidder: Doc<"contractors"> | null } | null> {
  const project = await ctx.db.get(pkg.projectId);
  if (project?.gcCompanyId === undefined) return null;
  const { vendorId } = await vendorForBidder(ctx, project.gcCompanyId, bidder, pkg.csiDivision);
  const vendor = (await ctx.db.get(vendorId))!;
  return { vendor, existingBidder: existingBidderFor(await packageBidders(ctx, pkg), vendor) };
}

export type VendorBackfillCounts = { contractorsLinked: number; vendorsCreated: number };

/** Gives every bidder on the GC company's projects a vendorId. Idempotent. */
export async function backfillVendorsForCompany(ctx: MutationCtx, gcCompanyId: Id<"companies">): Promise<VendorBackfillCounts> {
  const counts: VendorBackfillCounts = { contractorsLinked: 0, vendorsCreated: 0 };
  const projects = await ctx.db
    .query("projects")
    .withIndex("by_gcCompanyId", (q) => q.eq("gcCompanyId", gcCompanyId))
    .take(500);
  for (const project of projects) {
    const packages = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .take(200);
    for (const pkg of packages) {
      const bidders = await ctx.db
        .query("contractors")
        .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
        .take(500);
      for (const c of bidders) {
        if (c.vendorId !== undefined) continue;
        const { vendorId, created } = await vendorForBidder(ctx, gcCompanyId, c, pkg.csiDivision);
        if (created) counts.vendorsCreated++;
        await ctx.db.patch(c._id, { vendorId });
        counts.contractorsLinked++;
      }
    }
  }
  return counts;
}

/** Bidders of a package (its own rows plus contractors invited from other packages). */
export async function packageBidders(ctx: QueryCtx, pkg: Doc<"tradePackages">): Promise<Doc<"contractors">[]> {
  const own = await ctx.db
    .query("contractors")
    .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
    .take(500);
  const invited = [];
  for (const id of pkg.invitedContractorIds ?? []) {
    const c = await ctx.db.get(id);
    if (c !== null && c.tradePackageId !== pkg._id) invited.push(c);
  }
  return [...own, ...invited];
}

export function invalidVendor(message: string, field: VendorField | "vendor"): ConvexError<{ code: "INVALID"; message: string; field: string }> {
  return new ConvexError({ code: "INVALID" as const, message, field });
}

export function validatedVendor(raw: Parameters<typeof validateVendorInput>[0]): VendorInput {
  const result = validateVendorInput(raw);
  if (!result.ok) {
    const field = (Object.keys(result.errors) as VendorField[])[0];
    throw invalidVendor(firstVendorError(result.errors), field);
  }
  return result.value;
}

export async function assertVendorEmailFree(ctx: QueryCtx, companyId: Id<"companies">, email: string, except?: Id<"vendors">) {
  if (isPlaceholderEmail(email)) return;
  const clash = await findVendorByEmail(ctx, companyId, email);
  if (clash !== null && clash._id !== except) throw invalidVendor(DUPLICATE_VENDOR_EMAIL_MESSAGE, "email");
}

/** Inserts a validated vendor into the caller's directory. Shared with the "New vendor" bidder path. */
export async function insertDirectoryVendor(ctx: MutationCtx, companyId: Id<"companies">, raw: Parameters<typeof validateVendorInput>[0]) {
  const input = validatedVendor(raw);
  await assertVendorEmailFree(ctx, companyId, input.email);
  const vendorId = await ctx.db.insert("vendors", {
    companyId,
    ...input,
    status: "active",
    createdAt: Date.now(),
    searchText: vendorSearchText(input),
  });
  return (await ctx.db.get(vendorId))!;
}
