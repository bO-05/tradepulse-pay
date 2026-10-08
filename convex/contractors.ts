import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { auditActor, requireDocScope, requireProjectScope } from "./lib/projectScope";
import { v, ConvexError } from "convex/values";
import { deleteContractorCascade } from "./payments/cascade";
import { validateEmail, validateProjectText } from "./validation";

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
    await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"], write: true });
    return await ctx.db.insert("contractors", {
      ...args,
      companyName: validateProjectText(args.companyName, "Company name"),
      contactEmail: validateEmail(args.contactEmail),
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
    return await ctx.db.insert("contractors", {
      ...args,
      companyName: validateProjectText(args.companyName, "Company name"),
      contactEmail: validateEmail(args.contactEmail),
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
        const id = await ctx.db.insert("contractors", {
          ...c,
          tradePackageId: args.tradePackageId,
          rfqStatus: "discovered",
        });
        ids.push(id);
      }
    }
    return ids;
  },
});
