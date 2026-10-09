import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { auditActor, requireDocScope, requireProjectScope } from "./lib/projectScope";
import { v, ConvexError } from "convex/values";
import { deleteContractorCascade } from "./payments/cascade";
import { validateEmail, validateProjectText } from "./validation";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { liveVendorByRawId } from "./lib/vendorRead";
import {
  alreadyBidderError,
  existingBidderFor,
  inactiveVendorError,
  insertDirectoryVendor,
  packageBidders,
  vendorForNewBidder,
} from "./lib/vendorDirectory";

export const listByPackage = query({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"] });
    return await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
  },
});

export const listByPackageInternal = internalQuery({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("contractors")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .collect();
  },
});

export const getContractorInternal = internalQuery({
  args: { contractorId: v.id("contractors") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.contractorId);
  },
});

export const createContractor = mutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    companyName: v.string(),
    contactEmail: v.string(),
    phone: v.optional(v.string()),
    licenseNumber: v.string(),
    licenseStatus: v.string(),
    sourceUrl: v.string(),
    rfqStatus: v.union(
      v.literal("discovered"),
      v.literal("invited"),
      v.literal("rfi_submitted"),
      v.literal("bid_received")
    ),
  },
  handler: async (ctx, args) => {
    const { doc: pkg } = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"], write: true });
    const fields = {
      ...args,
      companyName: validateProjectText(args.companyName, "Company name"),
      contactEmail: validateEmail(args.contactEmail),
    };
    const resolved = await vendorForNewBidder(ctx, pkg, fields);
    if (resolved !== null) {
      if (resolved.vendor.status !== "active") throw inactiveVendorError(resolved.vendor.name);
      if (resolved.existingBidder !== null) throw alreadyBidderError(resolved.vendor.name);
    }
    return await ctx.db.insert("contractors", {
      ...fields,
      ...(resolved !== null ? { vendorId: resolved.vendor._id } : {}),
      dispatchedAt: args.rfqStatus === "invited" ? Date.now() : undefined,
      updatedAt: Date.now(),
    });
  },
});

export const createContractorInternal = internalMutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    companyName: v.string(),
    contactEmail: v.string(),
    phone: v.optional(v.string()),
    licenseNumber: v.string(),
    licenseStatus: v.string(),
    sourceUrl: v.string(),
    rfqStatus: v.union(
      v.literal("discovered"),
      v.literal("invited"),
      v.literal("rfi_submitted"),
      v.literal("bid_received")
    ),
  },
  handler: async (ctx, args) => {
    const tradePackage = await ctx.db.get(args.tradePackageId);
    if (!tradePackage) throw new Error("Trade package not found");
    const fields = {
      ...args,
      companyName: validateProjectText(args.companyName, "Company name"),
      contactEmail: validateEmail(args.contactEmail),
    };
    const resolved = await vendorForNewBidder(ctx, tradePackage, fields);
    if (resolved !== null) {
      if (resolved.vendor.status !== "active") throw inactiveVendorError(resolved.vendor.name);
      // A quote from a vendor that already bids on the package belongs to that bidder.
      if (resolved.existingBidder !== null) return resolved.existingBidder._id;
    }
    return await ctx.db.insert("contractors", {
      ...fields,
      ...(resolved !== null ? { vendorId: resolved.vendor._id } : {}),
      dispatchedAt: args.rfqStatus === "invited" ? Date.now() : undefined,
      updatedAt: Date.now(),
    });
  },
});

export const updateRfqStatus = mutation({
  args: {
    contractorId: v.id("contractors"),
    rfqStatus: v.union(
      v.literal("discovered"),
      v.literal("invited"),
      v.literal("rfi_submitted"),
      v.literal("bid_received")
    ),
  },
  handler: async (ctx, args) => {
    await requireDocScope(ctx, "contractors", args.contractorId, { roles: ["gc"], write: true });
    const patchData: { rfqStatus: any; dispatchedAt?: number } = {
      rfqStatus: args.rfqStatus,
    };
    if (args.rfqStatus === "invited") {
      patchData.dispatchedAt = Date.now();
    }
    await ctx.db.patch(args.contractorId, patchData);
  },
});

export const updateRfqStatusInternal = internalMutation({
  args: {
    contractorId: v.id("contractors"),
    rfqStatus: v.union(
      v.literal("discovered"),
      v.literal("invited"),
      v.literal("rfi_submitted"),
      v.literal("bid_received")
    ),
  },
  handler: async (ctx, args) => {
    const patchData: { rfqStatus: any; dispatchedAt?: number } = {
      rfqStatus: args.rfqStatus,
    };
    if (args.rfqStatus === "invited") {
      patchData.dispatchedAt = Date.now();
    }
    await ctx.db.patch(args.contractorId, patchData);
  },
});

export const updateContractor = mutation({
  args: {
    contractorId: v.id("contractors"),
    companyName: v.string(),
    contactEmail: v.string(),
    phone: v.optional(v.string()),
    licenseNumber: v.string(),
    licenseStatus: v.string(),
    sourceUrl: v.string(),
    rfqStatus: v.optional(
      v.union(
        v.literal("discovered"),
        v.literal("invited"),
        v.literal("rfi_submitted"),
        v.literal("bid_received")
      )
    ),
    // A14-02: when supplied, the write is refused if the record changed since
    // the form was opened, instead of silently clobbering a newer edit.
    expectedUpdatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { contractorId, expectedUpdatedAt, ...fields } = args;
    const { doc: contractor } = await requireDocScope(ctx, "contractors", contractorId, { roles: ["gc"], write: true });
    if (
      expectedUpdatedAt !== undefined &&
      (contractor.updatedAt ?? contractor._creationTime) !== expectedUpdatedAt
    ) {
      throw new ConvexError(
        "This contractor was changed in another session, so your edit was not saved. Reload the record and re-apply your change."
      );
    }
    await ctx.db.patch(contractorId, {
      ...fields,
      companyName: validateProjectText(args.companyName, "Company name"),
      contactEmail: validateEmail(args.contactEmail),
      updatedAt: Date.now(),
    });
    return { success: true };
  },
});

export const deleteContractor = mutation({
  args: {
    contractorId: v.id("contractors"),
  },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "contractors", args.contractorId, { roles: ["gc"], write: true });
    const contractor = access.doc;

    const tradePkg = await ctx.db.get(contractor.tradePackageId);

    // Cascade delete any agreements and bids associated with this contractor
    const contractorBids = await ctx.db
      .query("bids")
      .withIndex("by_contractor", (q) => q.eq("contractorId", args.contractorId))
      .collect();

    // A1-03/A3-03: never silently destroy proposals or an executed subcontract
    // through a contractor cleanup action.
    if (contractorBids.length > 0) {
      const hasExecuted = (
        await Promise.all(
          contractorBids.map((b) =>
            ctx.db
              .query("agreements")
              .withIndex("by_bid", (q) => q.eq("bidId", b._id))
              .collect()
          )
        )
      )
        .flat()
        .some((a) => a.status === "executed");
      throw new ConvexError(
        hasExecuted
          ? "This contractor holds an executed subcontract and cannot be deleted. Void or amend the executed agreement first."
          : "This contractor has submitted proposal(s) on file. Remove the proposal(s) from Bid Leveling before deleting the contractor."
      );
    }

    // Cascade delete any conversations associated with this contractor
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_contractor", (q) => q.eq("contractorId", args.contractorId))
      .collect();
    for (const c of conversations) {
      await ctx.db.delete(c._id);
    }

    await deleteContractorCascade(ctx, args.contractorId);

    if (tradePkg) {
      await ctx.db.insert("auditLogs", {
        projectId: tradePkg.projectId,
        tradePackageId: tradePkg._id,
        eventType: "compliance_audit",
        title: `Contractor Removed: ${contractor.companyName}`,
        description: `Removed contractor ${contractor.companyName} (${contractor.licenseNumber}) and cascaded cleanup of associated bids and RFIs.`,
        ...auditActor(access),
        timestamp: Date.now(),
      });
    }

    return { success: true };
  },
});

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProjectScope(ctx, args.projectId, { roles: ["gc"] });
    const packages = await ctx.db
      .query("tradePackages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const allContractors = [];
    for (const pkg of packages) {
      const contractors = await ctx.db
        .query("contractors")
        .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
        .collect();
      for (const c of contractors) {
        allContractors.push({
          ...c,
          csiDivision: pkg.csiDivision,
          tradeName: pkg.tradeName,
        });
      }
    }
    return allContractors;
  },
});

export const batchInsertContractors = internalMutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    contractors: v.array(
      v.object({
        companyName: v.string(),
        contactEmail: v.string(),
        phone: v.optional(v.string()),
        licenseNumber: v.string(),
        licenseStatus: v.string(),
        sourceUrl: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const pkg = await ctx.db.get(args.tradePackageId);
    if (!pkg) throw new Error("Trade package not found");
    const ids = [];
    for (const c of args.contractors) {
      // Dedupe by source page: two discovered records can legitimately share the
      // "contact not published" placeholder address, so email is not a safe key.
      const existing = await ctx.db
        .query("contractors")
        .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
        .filter((q) => q.eq(q.field("sourceUrl"), c.sourceUrl))
        .first();

      if (!existing) {
        const resolved = await vendorForNewBidder(ctx, pkg, c);
        // Discovery results never re-add an inactive vendor or a vendor already bidding here.
        if (resolved !== null && (resolved.vendor.status !== "active" || resolved.existingBidder !== null)) continue;
        const id = await ctx.db.insert("contractors", {
          ...c,
          tradePackageId: args.tradePackageId,
          rfqStatus: "discovered",
          ...(resolved !== null ? { vendorId: resolved.vendor._id } : {}),
        });
        ids.push(id);
      }
    }
    return ids;
  },
});

/** A new bidder row for a directory vendor, linked to the vendor's sub company when it is already on the project. */
async function insertVendorBidder(
  ctx: MutationCtx,
  pkg: Doc<"tradePackages">,
  vendor: Doc<"vendors">,
): Promise<Id<"contractors">> {
  let linkedCompanyId: Id<"companies"> | undefined;
  if (vendor.linkedCompanyId !== undefined) {
    const companyId = vendor.linkedCompanyId;
    const member = await ctx.db
      .query("projectMembers")
      .withIndex("by_project_company_and_status", (q) =>
        q.eq("projectId", pkg.projectId).eq("companyId", companyId).eq("status", "active"),
      )
      .first();
    if (member !== null) linkedCompanyId = companyId;
  }
  return await ctx.db.insert("contractors", {
    tradePackageId: pkg._id,
    companyName: vendor.name,
    contactEmail: vendor.email,
    ...(vendor.phone ? { phone: vendor.phone } : {}),
    licenseNumber: vendor.licenseNumber ?? "",
    licenseStatus: vendor.licenseNumber
      ? `Not checked — ${vendor.licenseState ? `${vendor.licenseState} ` : ""}license on file in the vendor directory`
      : "No license on file",
    sourceUrl: "",
    rfqStatus: "discovered",
    vendorId: vendor._id,
    ...(linkedCompanyId !== undefined ? { linkedCompanyId } : {}),
    updatedAt: Date.now(),
  });
}

/** "Add bidders from directory": active vendors of the project's GC company become bidders with vendorId. */
export const addBiddersFromDirectory = mutation({
  args: { tradePackageId: v.id("tradePackages"), vendorIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { doc: pkg, project } = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"], write: true });
    if (args.vendorIds.length === 0) throw new ConvexError({ code: "INVALID" as const, message: "Choose at least one vendor.", field: "vendor" });
    if (args.vendorIds.length > 50) throw new ConvexError({ code: "INVALID" as const, message: "Add at most 50 bidders at a time.", field: "vendor" });
    const existing = await packageBidders(ctx, pkg);
    const vendors: Doc<"vendors">[] = [];
    for (const raw of args.vendorIds) {
      const vendor = await liveVendorByRawId(ctx, raw);
      if (vendor === null || vendor.companyId !== project.gcCompanyId) throw new ConvexError({ code: "NOT_FOUND" as const, message: "Not found." });
      if (vendor.status !== "active") throw inactiveVendorError(vendor.name);
      if (existingBidderFor(existing, vendor) !== null || vendors.some((x) => x._id === vendor._id)) throw alreadyBidderError(vendor.name);
      vendors.push(vendor);
    }
    const contractorIds = [];
    for (const vendor of vendors) contractorIds.push(await insertVendorBidder(ctx, pkg, vendor));
    return { contractorIds };
  },
});

/** "New vendor" in the bidder dialog: creates the vendor in the GC directory and adds it as a bidder. */
export const createVendorBidder = mutation({
  args: {
    tradePackageId: v.id("tradePackages"),
    name: v.string(),
    trades: v.array(v.string()),
    contactName: v.optional(v.string()),
    email: v.string(),
    phone: v.optional(v.string()),
    licenseNumber: v.optional(v.string()),
    licenseState: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { doc: pkg, project } = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"], write: true });
    if (project.gcCompanyId === undefined) throw new ConvexError({ code: "NOT_FOUND" as const, message: "Not found." });
    const { tradePackageId: _pkg, ...fields } = args;
    const trades = fields.trades.length > 0 ? fields.trades : [pkg.csiDivision];
    const vendor = await insertDirectoryVendor(ctx, project.gcCompanyId, { ...fields, trades });
    const contractorId = await insertVendorBidder(ctx, pkg, vendor);
    return { vendorId: vendor._id, contractorId };
  },
});
