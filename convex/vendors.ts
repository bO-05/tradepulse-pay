import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { notFound, requireCompanyMember, requireVerifiedUser, type CompanyMember } from "./lib/tenancy";
import {
  assertVendorEmailFree,
  backfillVendorsForCompany,
  findVendorByEmail,
  gcEnteredEmail,
  insertDirectoryVendor,
  invalidVendor,
  validatedVendor,
  type VendorBackfillCounts,
} from "./lib/vendorDirectory";
import { payeeState } from "./lib/payee";
import { liveVendor, liveVendorByRawId } from "./lib/vendorRead";
import { vendorSearchQuery, vendorSearchText } from "./lib/vendorSearch";
import { addMergeCounts, emptyMergeCounts, mergeDuplicateVendorsForCompany } from "./lib/vendorMerge";
import { VENDOR_IMPORT_MAX_ROWS, firstVendorError, isPlaceholderEmail, validateVendorInput } from "./lib/vendorRules";

/**
 * The GC company vendor directory (architecture §14). The company always comes from the session;
 * a vendor of another company reads as "Not found.". Sub, owner and agent callers have no directory.
 */

const vendorFieldsValidator = {
  name: v.string(),
  trades: v.array(v.string()),
  contactName: v.optional(v.string()),
  email: v.string(),
  phone: v.optional(v.string()),
  licenseNumber: v.optional(v.string()),
  licenseState: v.optional(v.string()),
};

function gcDirectoryMember(member: CompanyMember): CompanyMember {
  if (member.company.kind !== "gc" || member.user.actorType === "agent") {
    throw new ConvexError({ code: "FORBIDDEN", message: "Forbidden: the vendor directory belongs to general contractor companies." });
  }
  return member;
}

async function ownVendor(ctx: QueryCtx, companyId: Id<"companies">, vendorId: string): Promise<Doc<"vendors">> {
  const vendor = await liveVendorByRawId(ctx, vendorId);
  if (vendor === null || vendor.companyId !== companyId) throw notFound();
  return vendor;
}

async function vendorViews(ctx: QueryCtx, rows: Doc<"vendors">[]) {
  const linkedCompanies = new Map<Id<"companies">, Doc<"companies"> | null>();
  for (const r of rows) {
    if (r.linkedCompanyId !== undefined && !linkedCompanies.has(r.linkedCompanyId)) {
      linkedCompanies.set(r.linkedCompanyId, await ctx.db.get(r.linkedCompanyId));
    }
  }
  return rows.map((r) => {
    const linkedCompany = r.linkedCompanyId !== undefined ? (linkedCompanies.get(r.linkedCompanyId) ?? null) : null;
    const payee = payeeState(r, linkedCompany);
    return {
      _id: r._id,
      name: r.name,
      trades: r.trades,
      contactName: r.contactName,
      email: r.email,
      phone: r.phone ?? "",
      licenseNumber: r.licenseNumber ?? "",
      licenseState: r.licenseState ?? "",
      linked: r.linkedCompanyId !== undefined,
      linkedCompanyName: linkedCompany?.name || null,
      payeeStatus: payee.status,
      payeeEmail: payee.currentEmail,
      status: r.status,
      createdAt: r.createdAt,
    };
  });
}

/**
 * At most the first 2000 vendors of the caller's directory by name; inactive only when asked. Not a
 * complete listing: every screen and the CSV export page through listVendorsPage instead.
 */
export const listVendors = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const { company } = gcDirectoryMember(await requireCompanyMember(ctx));
    const rows = args.includeInactive === true
      ? await ctx.db.query("vendors").withIndex("by_companyId_and_name", (q) => q.eq("companyId", company._id)).take(2000)
      : await ctx.db
          .query("vendors")
          .withIndex("by_companyId_and_status_and_name", (q) => q.eq("companyId", company._id).eq("status", "active"))
          .take(2000);
    return (await vendorViews(ctx, rows.filter((r) => r.status !== "merged"))).sort((a, b) => a.name.localeCompare(b.name));
  },
});

const directoryStatusValidator = v.union(v.literal("active"), v.literal("inactive"), v.literal("all"));

/**
 * One page of the caller's directory: by name, or by search relevance when `search` is given
 * (name, contact, email and trades).
 */
export const listVendorsPage = query({
  args: { paginationOpts: paginationOptsValidator, status: directoryStatusValidator, search: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { company } = gcDirectoryMember(await requireCompanyMember(ctx));
    const search = vendorSearchQuery(args.search ?? "");
    const status = args.status;
    const result =
      search !== ""
        ? await ctx.db
            .query("vendors")
            .withSearchIndex("search_text", (q) => {
              const base = q.search("searchText", search).eq("companyId", company._id);
              return status === "all" ? base : base.eq("status", status);
            })
            .paginate(args.paginationOpts)
        : status === "all"
          ? await ctx.db
              .query("vendors")
              .withIndex("by_companyId_and_name", (q) => q.eq("companyId", company._id))
              .paginate(args.paginationOpts)
          : await ctx.db
              .query("vendors")
              .withIndex("by_companyId_and_status_and_name", (q) => q.eq("companyId", company._id).eq("status", status))
              .paginate(args.paginationOpts);
    // Merged tombstones only appear in the unfiltered ("all") reads; a page can come back short.
    return { ...result, page: await vendorViews(ctx, result.page.filter((r) => r.status !== "merged")) };
  },
});

/** Whether the caller's directory has any vendor, and any active one (empty states). */
export const directorySummary = query({
  args: {},
  handler: async (ctx) => {
    const { company } = gcDirectoryMember(await requireCompanyMember(ctx));
    const any = await ctx.db.query("vendors").withIndex("by_companyId", (q) => q.eq("companyId", company._id)).first();
    const active = await ctx.db
      .query("vendors")
      .withIndex("by_companyId_and_status_and_name", (q) => q.eq("companyId", company._id).eq("status", "active"))
      .first();
    return { hasVendors: any !== null, hasActive: active !== null };
  },
});

/**
 * Directory entries of the given ids that belong to the caller's company (bidder lists). An id of a
 * merged row returns the row it was merged into, with `requestedId` naming the id asked for.
 */
export const vendorSummaries = query({
  args: { vendorIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { company } = gcDirectoryMember(await requireCompanyMember(ctx));
    if (args.vendorIds.length > 500) throw invalidVendor("Ask for at most 500 vendors at a time.", "vendor");
    const rows: Doc<"vendors">[] = [];
    const requested: string[] = [];
    for (const raw of new Set(args.vendorIds)) {
      const row = await liveVendorByRawId(ctx, raw);
      if (row !== null && row.companyId === company._id) {
        rows.push(row);
        requested.push(raw);
      }
    }
    return (await vendorViews(ctx, rows)).map((view, i) => ({ ...view, requestedId: requested[i] }));
  },
});

/** Which of these emails (lowercased) already exist in the caller's directory (CSV import preview). */
export const existingVendorEmails = query({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { company } = gcDirectoryMember(await requireCompanyMember(ctx));
    if (args.emails.length > VENDOR_IMPORT_MAX_ROWS) {
      throw invalidVendor(`A CSV import can hold at most ${VENDOR_IMPORT_MAX_ROWS} rows.`, "vendor");
    }
    const found: string[] = [];
    for (const email of new Set(args.emails.map((e) => e.trim().toLowerCase()))) {
      if (email === "" || isPlaceholderEmail(email)) continue;
      if ((await findVendorByEmail(ctx, company._id, email)) !== null) found.push(email);
    }
    return found;
  },
});

export const createVendor = mutation({
  args: vendorFieldsValidator,
  handler: async (ctx, args) => {
    await requireVerifiedUser(ctx);
    const { company } = gcDirectoryMember(await requireCompanyMember(ctx));
    const vendor = await insertDirectoryVendor(ctx, company._id, args);
    return { vendorId: vendor._id };
  },
});

export const updateVendor = mutation({
  args: { vendorId: v.string(), ...vendorFieldsValidator },
  handler: async (ctx, args) => {
    await requireVerifiedUser(ctx);
    const { company } = gcDirectoryMember(await requireCompanyMember(ctx));
    const { vendorId, ...fields } = args;
    const vendor = await ownVendor(ctx, company._id, vendorId);
    const input = validatedVendor(fields);
    await assertVendorEmailFree(ctx, company._id, input.email, vendor._id);
    await ctx.db.replace(vendor._id, {
      ...input,
      searchText: vendorSearchText(input),
      companyId: vendor.companyId,
      status: vendor.status,
      createdAt: vendor.createdAt,
      ...(vendor.linkedCompanyId !== undefined ? { linkedCompanyId: vendor.linkedCompanyId } : {}),
      ...(vendor.payoutEmailConfirmed !== undefined ? { payoutEmailConfirmed: vendor.payoutEmailConfirmed } : {}),
      // Saving the form unchanged keeps a discovered address unconfirmed; typing a new one confirms it.
      ...(input.email === vendor.email
        ? {
            ...(vendor.discoveredEmail !== undefined ? { discoveredEmail: vendor.discoveredEmail } : {}),
            ...(vendor.emailConfirmedAt !== undefined ? { emailConfirmedAt: vendor.emailConfirmedAt } : {}),
            ...(vendor.emailConfirmedFor !== undefined ? { emailConfirmedFor: vendor.emailConfirmedFor } : {}),
          }
        : gcEnteredEmail(input.email)),
    });
    return { vendorId: vendor._id };
  },
});

/** Deactivating hides a vendor from the directory and the bidder picker; existing bidders and history stay. */
export const setVendorStatus = mutation({
  args: { vendorId: v.string(), status: v.union(v.literal("active"), v.literal("inactive")) },
  handler: async (ctx, args) => {
    await requireVerifiedUser(ctx);
    const { company } = gcDirectoryMember(await requireCompanyMember(ctx));
    const vendor = await ownVendor(ctx, company._id, args.vendorId);
    if (vendor.status !== args.status) await ctx.db.patch(vendor._id, { status: args.status });
    return { vendorId: vendor._id, status: args.status };
  },
});

/**
 * CSV import (rows already parsed by the client). Every row is validated again here; vendors whose
 * email already exists in the directory are reported as duplicates and never inserted twice.
 */
export const importVendors = mutation({
  args: {
    rows: v.array(
      v.object({
        row: v.number(),
        name: v.string(),
        trades: v.array(v.string()),
        contactName: v.optional(v.string()),
        email: v.string(),
        phone: v.optional(v.string()),
        licenseNumber: v.optional(v.string()),
        licenseState: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await requireVerifiedUser(ctx);
    const { company } = gcDirectoryMember(await requireCompanyMember(ctx));
    if (args.rows.length === 0) throw invalidVendor("The file has no vendor rows to import.", "vendor");
    if (args.rows.length > VENDOR_IMPORT_MAX_ROWS) {
      throw invalidVendor(`A CSV import can hold at most ${VENDOR_IMPORT_MAX_ROWS} rows.`, "vendor");
    }
    const created: { row: number; vendorId: Id<"vendors"> }[] = [];
    const duplicates: { row: number; name: string; email: string }[] = [];
    const errors: { row: number; message: string }[] = [];
    for (const { row, ...fields } of args.rows) {
      const result = validateVendorInput(fields);
      if (!result.ok) {
        const message = firstVendorError(result.errors);
        errors.push({ row, message: `Row ${row}: ${message.charAt(0).toLowerCase()}${message.slice(1)}` });
        continue;
      }
      const existing = isPlaceholderEmail(result.value.email) ? null : await findVendorByEmail(ctx, company._id, result.value.email);
      if (existing !== null) {
        duplicates.push({ row, name: result.value.name, email: result.value.email });
        continue;
      }
      const vendorId = await ctx.db.insert("vendors", {
        companyId: company._id,
        ...result.value,
        ...gcEnteredEmail(result.value.email),
        status: "active",
        createdAt: Date.now(),
        searchText: vendorSearchText(result.value),
      });
      created.push({ row, vendorId });
    }
    return { created: created.length, duplicates, errors };
  },
});

/**
 * Company → GC relationships for a sub company: the GC directories that list this company (only
 * its own vendor row in each) and the projects it is on for that GC.
 */
export const myGcRelationships = query({
  args: {},
  handler: async (ctx) => {
    const { company } = await requireCompanyMember(ctx);
    if (company.kind !== "sub") return [];
    const vendorRows = await ctx.db
      .query("vendors")
      .withIndex("by_linkedCompanyId", (q) => q.eq("linkedCompanyId", company._id))
      .take(200);
    const memberships = await ctx.db
      .query("projectMembers")
      .withIndex("by_companyId", (q) => q.eq("companyId", company._id))
      .take(500);
    const memberVendor = new Map<Id<"vendors">, Id<"vendors"> | null>();
    for (const m of memberships) {
      if (m.vendorId !== undefined && !memberVendor.has(m.vendorId)) memberVendor.set(m.vendorId, (await liveVendor(ctx, m.vendorId))?._id ?? null);
    }
    const out = [];
    for (const vendor of vendorRows) {
      if (vendor.status === "merged") continue;
      const gc = await ctx.db.get(vendor.companyId);
      if (gc === null) continue;
      const projects: { projectId: Id<"projects">; title: string }[] = [];
      for (const m of memberships) {
        if (m.status !== "active" || m.partyRole !== "sub") continue;
        if (m.vendorId !== undefined && memberVendor.get(m.vendorId) !== vendor._id) continue;
        const project = await ctx.db.get(m.projectId);
        if (project === null || project.gcCompanyId !== gc._id || project.archived === true) continue;
        if (!projects.some((p) => p.projectId === project._id)) projects.push({ projectId: project._id, title: project.title });
      }
      out.push({
        vendorId: vendor._id,
        gcCompanyName: gc.name,
        listedAs: vendor.name,
        trades: vendor.trades,
        status: vendor.status,
        projects,
      });
    }
    return out.sort((a, b) => a.gcCompanyName.localeCompare(b.gcCompanyName));
  },
});

/**
 * Merges complete duplicate groups of vendor rows (same normalized email or same linked company, never
 * across two linked companies) of every GC company, or one, into the oldest row; merged rows stay as
 * tombstones pointing at it. Idempotent: a second run reports all zeros.
 */
export const mergeDuplicateVendors = internalMutation({
  args: { gcCompanyId: v.optional(v.id("companies")) },
  handler: async (ctx, args) => {
    const companies = args.gcCompanyId
      ? [await ctx.db.get(args.gcCompanyId)].filter((c): c is Doc<"companies"> => c !== null)
      : await ctx.db
          .query("companies")
          .withIndex("by_kind", (q) => q.eq("kind", "gc"))
          .take(1000);
    const total = { ...emptyMergeCounts(), companies: 0, truncatedCompanies: 0 };
    for (const c of companies) {
      if (c.kind !== "gc") continue;
      const counts = await mergeDuplicateVendorsForCompany(ctx, c._id);
      addMergeCounts(total, counts);
      if (counts.truncated) total.truncatedCompanies++;
      total.companies++;
    }
    return total;
  },
});

/** Backfills vendorId on every bidder (all GC companies, or one). Idempotent; run once after deploy. */
export const backfillBidderVendors = internalMutation({
  args: { gcCompanyId: v.optional(v.id("companies")) },
  handler: async (ctx, args) => {
    const companies = args.gcCompanyId
      ? [await ctx.db.get(args.gcCompanyId)].filter((c): c is Doc<"companies"> => c !== null)
      : await ctx.db
          .query("companies")
          .withIndex("by_kind", (q) => q.eq("kind", "gc"))
          .take(1000);
    const total: VendorBackfillCounts & { companies: number } = { contractorsLinked: 0, vendorsCreated: 0, companies: 0 };
    for (const c of companies) {
      if (c.kind !== "gc") continue;
      const counts = await backfillVendorsForCompany(ctx, c._id);
      total.contractorsLinked += counts.contractorsLinked;
      total.vendorsCreated += counts.vendorsCreated;
      total.companies++;
    }
    return total;
  },
});

/** Fills `searchText` on vendors written before the directory search index. Idempotent; page through. */
export const backfillVendorSearchText = internalMutation({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("vendors").paginate(args.paginationOpts);
    let updated = 0;
    for (const vendor of page.page) {
      const searchText = vendorSearchText(vendor);
      if (vendor.searchText === searchText) continue;
      await ctx.db.patch(vendor._id, { searchText });
      updated++;
    }
    return { updated, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
