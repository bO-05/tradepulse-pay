import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { invitedBidderOf } from "./bidPortal";
import { isBidDocumentForPackage } from "./lib/bidDocuments";
import { auditActor, requireDocScope } from "./lib/projectScope";
import { notFound } from "./lib/tenancy";

/** An invited bidder acknowledges receipt of an addendum on a package it bids. Repeat calls keep the first acknowledgment. */
export const acknowledgeAddendum = mutation({
  args: { tradePackageId: v.string(), fileId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["sub"], write: true });
    const { access, pkg, contractor } = await invitedBidderOf(ctx, scope);
    const fileId = ctx.db.normalizeId("projectFiles", args.fileId);
    const file = fileId === null ? null : await ctx.db.get(fileId);
    if (file === null || file.fileType !== "addendum" || !isBidDocumentForPackage(file, pkg)) throw notFound();
    const existing = await ctx.db
      .query("addendumAcknowledgments")
      .withIndex("by_package_and_contractor", (q) => q.eq("tradePackageId", pkg._id).eq("contractorId", contractor._id))
      .take(200);
    const already = existing.find((a) => a.projectFileId === file._id);
    if (already) return { acknowledgedAt: already.acknowledgedAt };
    const actor = auditActor(access);
    const now = Date.now();
    await ctx.db.insert("addendumAcknowledgments", {
      projectId: pkg.projectId,
      projectFileId: file._id,
      tradePackageId: pkg._id,
      contractorId: contractor._id,
      // invitedBidderOf guarantees a sub company.
      companyId: access.company!._id,
      userId: access.user._id,
      userName: actor.actor,
      acknowledgedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      projectId: pkg.projectId,
      tradePackageId: pkg._id,
      eventType: "file_uploaded",
      title: `Addendum acknowledged: ${file.fileName}`,
      description: `${actor.actor} (${contractor.companyName}) acknowledged receipt of ${file.fileName}.`,
      ...actor,
      contractorId: contractor._id,
      timestamp: now,
    });
    return { acknowledgedAt: now };
  },
});

/** GC only: the package's addenda and which bidders acknowledged each. */
export const listPackageAddenda = query({
  args: { tradePackageId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc"] });
    const pkg = access.doc;
    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", pkg.projectId))
      .take(500);
    const acks = await ctx.db
      .query("addendumAcknowledgments")
      .withIndex("by_package", (q) => q.eq("tradePackageId", pkg._id))
      .take(1000);
    const out = [];
    for (const f of files) {
      if (f.fileType !== "addendum" || !isBidDocumentForPackage(f, pkg)) continue;
      const mine = acks.filter((a) => a.projectFileId === f._id);
      const acknowledgments = [];
      for (const a of mine) {
        const contractor = await ctx.db.get(a.contractorId);
        acknowledgments.push({ bidderName: contractor?.companyName ?? "Bidder", userName: a.userName, acknowledgedAt: a.acknowledgedAt });
      }
      out.push({ _id: f._id, fileName: f.fileName, uploadedAt: f.uploadedAt, acknowledgments });
    }
    return out.sort((a, b) => a.uploadedAt - b.uploadedAt);
  },
});
