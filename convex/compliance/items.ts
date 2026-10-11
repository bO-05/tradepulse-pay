import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { action, internalMutation, mutation, query, type QueryCtx } from "../_generated/server";
import { sha256Hex } from "../documents/inputs";
import type { UploadedDocumentKind } from "../documents/kinds";
import { beginCheckInTx } from "../kernel/licenseChecks";
import { CACHEABLE_STATUSES } from "../kernel/cslb";
import {
  COMPLIANCE_KIND_LABEL,
  FILE_TYPE_ERROR,
  MAX_COMPLIANCE_FILE_BYTES,
  REJECTION_REASON_MAX,
  fileTooLargeMessage,
  firstComplianceError,
  normalizeComplianceInput,
  sniffContentType,
  storedFileName,
  todayIso,
  validateComplianceInput,
} from "../lib/complianceRules";
import { notify } from "../lib/notify";
import { auditActor, callerProjects, requireDocScope, requireProjectScope } from "../lib/projectScope";
import { requireProjectScopeInAction } from "../lib/tenancyAction";
import { notFound, requireCompanyMember, type ProjectAccess } from "../lib/tenancy";
import { liveVendor } from "../lib/vendorRead";
import { complianceInputValidator, type ComplianceKind } from "./validators";
import {
  contractorForVendor,
  itemView,
  summaryView,
  subVendorOnProject,
  vendorCompliance,
} from "./status";

/**
 * Compliance records (architecture §17). A sub company member uploads a certificate of insurance,
 * W-9 or contractor license for its vendor record on a project; the file's real type is checked from
 * its bytes and it is stored as a restricted document. The project's GC accepts or rejects each
 * record (a rejection needs a reason). CSLB lookups are advisory and California-only.
 */

export const COMPLIANCE_HASH = "#/compliance";
const UPLOAD_INTENT_TTL_MS = 2 * 60 * 60 * 1000;
const INVALID_UPLOAD_MESSAGE = "This upload could not be verified for this project. Upload the file again.";
const NO_VENDOR_MESSAGE = "Your company isn't linked to a vendor on this project yet, so compliance records can't be added.";

const DOCUMENT_KIND: Record<ComplianceKind, UploadedDocumentKind> = {
  coi: "compliance_coi",
  w9: "compliance_w9",
  license: "compliance_license",
};

/** A human member of the sub company on the project (billing agents never handle compliance records). */
function requireSubCompany(access: ProjectAccess): Doc<"companies"> {
  if (access.partyRole !== "sub" || access.company === null || access.company.kind !== "sub") throw notFound();
  return access.company;
}

async function requireSubVendor(ctx: QueryCtx, access: ProjectAccess): Promise<{ company: Doc<"companies">; vendor: Doc<"vendors"> }> {
  const company = requireSubCompany(access);
  const vendor = await subVendorOnProject(ctx, access.project, company._id);
  if (vendor === null) throw new ConvexError({ code: "NO_VENDOR", message: NO_VENDOR_MESSAGE });
  return { company, vendor };
}

// ---------------------------------------------------------------------------------------------
// Upload

/** Upload URL for one compliance file; the intent binds the stored object to the caller and project. */
export const generateComplianceUploadUrl = mutation({
  args: { projectId: v.string() },
  returns: v.object({ uploadUrl: v.string(), uploadIntentId: v.id("uploadIntents") }),
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["sub"], write: true });
    const { company } = await requireSubVendor(ctx, access);
    const now = Date.now();
    const uploadIntentId = await ctx.db.insert("uploadIntents", {
      userId: access.user._id,
      companyId: company._id,
      projectId: access.project._id,
      createdAt: now,
      expiresAt: now + UPLOAD_INTENT_TTL_MS,
    });
    return { uploadUrl: await ctx.storage.generateUploadUrl(), uploadIntentId };
  },
});

/**
 * Binds a just-uploaded object to the caller's unused intent. Only after this succeeds may the
 * submit action delete the object, so a client-supplied storage id can never remove another file.
 */
export const claimComplianceUpload = internalMutation({
  args: {
    userId: v.id("users"),
    companyId: v.id("companies"),
    projectId: v.id("projects"),
    uploadIntentId: v.string(),
    storageId: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"_storage">> => {
    const invalid = () => new ConvexError({ code: "INVALID_UPLOAD", message: INVALID_UPLOAD_MESSAGE });
    const intentId = ctx.db.normalizeId("uploadIntents", args.uploadIntentId);
    const intent = intentId === null ? null : await ctx.db.get(intentId);
    if (
      intent === null ||
      intent.userId !== args.userId ||
      intent.companyId !== args.companyId ||
      intent.projectId !== args.projectId ||
      intent.usedAt !== undefined ||
      intent.expiresAt < Date.now()
    ) {
      throw invalid();
    }
    const storageId = ctx.db.system.normalizeId("_storage", args.storageId);
    const metadata = storageId === null ? null : await ctx.db.system.get(storageId);
    if (storageId === null || metadata === null || metadata._creationTime < intent._creationTime) throw invalid();
    const claimed = await ctx.db
      .query("uploadIntents")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .first();
    const attached = await ctx.db
      .query("projectFiles")
      .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
      .first();
    if (claimed !== null || attached !== null) throw invalid();
    await ctx.db.patch(intent._id, { storageId, usedAt: Date.now() });
    return storageId;
  },
});

export const recordComplianceItem = internalMutation({
  args: {
    userId: v.id("users"),
    companyId: v.id("companies"),
    projectId: v.id("projects"),
    actor: v.string(),
    storageId: v.id("_storage"),
    sha256: v.string(),
    sizeBytes: v.number(),
    contentType: v.string(),
    fileName: v.string(),
    input: complianceInputValidator,
  },
  handler: async (ctx, args): Promise<Id<"complianceItems">> => {
    const project = await ctx.db.get(args.projectId);
    const intent = await ctx.db
      .query("uploadIntents")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .first();
    if (project === null || project.gcCompanyId === undefined || intent === null || intent.userId !== args.userId) {
      throw new ConvexError({ code: "INVALID_UPLOAD", message: INVALID_UPLOAD_MESSAGE });
    }
    const vendor = await subVendorOnProject(ctx, project, args.companyId);
    if (vendor === null) throw new ConvexError({ code: "NO_VENDOR", message: NO_VENDOR_MESSAGE });
    const input = normalizeComplianceInput(args.input);
    const now = Date.now();
    const base = {
      projectId: project._id,
      vendorId: vendor._id,
      companyId: args.companyId,
      gcCompanyId: project.gcCompanyId,
      kind: input.kind,
      status: "pending_review" as const,
      uploadedByUserId: args.userId,
      uploadedByName: args.actor,
      createdAt: now,
    };
    const itemId =
      input.kind === "coi"
        ? await ctx.db.insert("complianceItems", { ...base, coi: input.coi })
        : input.kind === "w9"
          ? await ctx.db.insert("complianceItems", { ...base, w9: input.w9 })
          : await ctx.db.insert("complianceItems", {
              ...base,
              license: { ...input.license, verification: input.license.state === "CA" ? ("unverified" as const) : ("manual" as const) },
            });
    const documentId = await ctx.db.insert("documents", {
      projectId: project._id,
      kind: DOCUMENT_KIND[input.kind],
      sensitivity: "restricted",
      storageId: args.storageId,
      sha256: args.sha256,
      fileName: args.fileName,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      uploadedByUserId: args.userId,
      createdAt: now,
      relatedId: itemId,
      relatedTable: "complianceItems",
    });
    await ctx.db.patch(itemId, { documentId });
    const label = COMPLIANCE_KIND_LABEL[input.kind];
    const company = await ctx.db.get(args.companyId);
    const subName = company?.name ?? vendor.name;
    await ctx.db.insert("auditLogs", {
      projectId: project._id,
      eventType: "compliance_uploaded",
      title: `${label} uploaded by ${subName}`,
      description: `${args.actor} uploaded a ${label.toLowerCase()} (${args.contentType}, ${args.sizeBytes} bytes) for vendor ${vendor.name}; awaiting GC review.`,
      actor: args.actor,
      actorUserId: args.userId,
      actorCompanyId: args.companyId,
      timestamp: now,
    });
    await notify(ctx, { companyId: project.gcCompanyId }, {
      kind: "compliance_submitted",
      title: `${label} to review from ${subName}`,
      body: `${subName} uploaded a ${label.toLowerCase()} on ${project.title}.`,
      link: COMPLIANCE_HASH,
      projectId: project._id,
    });
    return itemId;
  },
});

/**
 * Stores an uploaded compliance file and its fields. The file must be a real PDF, PNG or JPEG (checked
 * from its first bytes) and at most 10 MB; anything else is deleted and nothing is recorded.
 */
export const submitComplianceItem = action({
  args: {
    projectId: v.string(),
    uploadIntentId: v.string(),
    storageId: v.string(),
    fileName: v.string(),
    input: complianceInputValidator,
  },
  handler: async (ctx, args): Promise<{ itemId: Id<"complianceItems"> }> => {
    const scope = await requireProjectScopeInAction(ctx, { projectId: args.projectId }, { roles: ["sub"], write: true });
    if (scope.companyId === null) throw notFound();
    const storageId = await ctx.runMutation(internal.compliance.items.claimComplianceUpload, {
      userId: scope.userId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      uploadIntentId: args.uploadIntentId,
      storageId: args.storageId,
    });
    const refuse = async (code: string, message: string, fields?: Record<string, string>): Promise<never> => {
      await ctx.storage.delete(storageId).catch(() => undefined);
      throw new ConvexError({ code, message, ...(fields ? { fields } : {}) });
    };
    const errors = validateComplianceInput(args.input, todayIso());
    if (Object.keys(errors).length > 0) return await refuse("INVALID_FIELDS", firstComplianceError(errors) ?? "Check the form.", errors);
    const blob = await ctx.storage.get(storageId);
    if (blob === null) return await refuse("INVALID_UPLOAD", INVALID_UPLOAD_MESSAGE);
    if (blob.size > MAX_COMPLIANCE_FILE_BYTES) return await refuse("FILE_TOO_LARGE", fileTooLargeMessage(blob.size));
    if (blob.size === 0) return await refuse("INVALID_FILE_TYPE", FILE_TYPE_ERROR);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const contentType = sniffContentType(bytes.subarray(0, 16));
    if (contentType === null) return await refuse("INVALID_FILE_TYPE", FILE_TYPE_ERROR);
    const itemId = await ctx.runMutation(internal.compliance.items.recordComplianceItem, {
      userId: scope.userId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      actor: scope.actor,
      storageId,
      sha256: await sha256Hex(bytes),
      sizeBytes: bytes.length,
      contentType,
      fileName: storedFileName(args.fileName, contentType),
      input: args.input,
    });
    return { itemId };
  },
});

// ---------------------------------------------------------------------------------------------
// GC review

export const reviewComplianceItem = mutation({
  args: { itemId: v.string(), decision: v.union(v.literal("accept"), v.literal("reject")), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "complianceItems", args.itemId, { roles: ["gc"], write: true });
    const item = scope.doc;
    if (item.status !== "pending_review") {
      throw new ConvexError({ code: "ALREADY_REVIEWED", message: `This record was already ${item.status === "accepted" ? "accepted" : "rejected"}.` });
    }
    const reason = (args.reason ?? "").trim();
    if (args.decision === "reject") {
      if (reason === "") throw new ConvexError({ code: "REASON_REQUIRED", message: "Enter a reason for the rejection." });
      if (reason.length > REJECTION_REASON_MAX) {
        throw new ConvexError({ code: "REASON_TOO_LONG", message: `Keep the reason under ${REJECTION_REASON_MAX} characters.` });
      }
    }
    const actor = auditActor(scope);
    const now = Date.now();
    const accepted = args.decision === "accept";
    await ctx.db.patch(item._id, {
      status: accepted ? "accepted" : "rejected",
      reviewedByUserId: scope.user._id,
      reviewedByName: actor.actor,
      reviewedAt: now,
      ...(accepted ? {} : { rejectionReason: reason }),
    });
    const vendor = await liveVendor(ctx, item.vendorId);
    const label = COMPLIANCE_KIND_LABEL[item.kind];
    await ctx.db.insert("auditLogs", {
      projectId: scope.project._id,
      eventType: accepted ? "compliance_accepted" : "compliance_rejected",
      title: `${label} ${accepted ? "accepted" : "rejected"} for ${vendor?.name ?? "vendor"}`,
      description: accepted
        ? `${actor.actor} accepted the ${label.toLowerCase()} (${item._id}).`
        : `${actor.actor} rejected the ${label.toLowerCase()} (${item._id}): ${reason}`,
      ...actor,
      timestamp: now,
    });
    await notify(ctx, { companyId: item.companyId }, {
      kind: accepted ? "compliance_accepted" : "compliance_rejected",
      title: `${label} ${accepted ? "accepted" : "rejected"}`,
      body: accepted
        ? `${actor.actor} accepted your ${label.toLowerCase()} on ${scope.project.title}.`
        : `${actor.actor} rejected your ${label.toLowerCase()} on ${scope.project.title}: ${reason}`,
      link: COMPLIANCE_HASH,
      projectId: scope.project._id,
    });
    return { status: accepted ? ("accepted" as const) : ("rejected" as const) };
  },
});

/** GC runs the advisory CSLB lookup on a California license record. It never changes the review decision. */
export const requestCslbLookup = mutation({
  args: { itemId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "complianceItems", args.itemId, { roles: ["gc"], write: true });
    const item = scope.doc;
    if (item.kind !== "license" || item.license === undefined) {
      throw new ConvexError({ code: "NOT_A_LICENSE", message: "CSLB lookups apply to contractor license records only." });
    }
    if (item.license.state !== "CA") {
      throw new ConvexError({
        code: "NOT_CALIFORNIA",
        message: `CSLB lookups are for California licenses only; this ${item.license.state} license is a manual record.`,
      });
    }
    const vendor = await liveVendor(ctx, item.vendorId);
    const contractorId = vendor === null ? null : await contractorForVendor(ctx, scope.project, vendor);
    if (contractorId === null) {
      throw new ConvexError({ code: "NO_BIDDER", message: "This vendor has no bidder record on the project, so no CSLB lookup can be run." });
    }
    const begun = await beginCheckInTx(ctx, contractorId, "compliance", {
      licenseNumber: item.license.licenseNumber,
      complianceItemId: item._id,
    });
    const check = await ctx.db.get(begun.checkId);
    const verification = check !== null && check.phase !== "running" && CACHEABLE_STATUSES.has(check.status) ? "cslb_live" : "unverified";
    await ctx.db.patch(item._id, { cslbCheckId: begun.checkId, license: { ...item.license, verification } });
    if (begun.kind === "started") {
      await ctx.scheduler.runAfter(0, internal.kernel.licenseCheck.performLicenseCheck, {
        checkId: begun.checkId,
        licenseNumber: begun.licenseNumber,
      });
    }
    return { checkId: begun.checkId, kind: begun.kind };
  },
});

// ---------------------------------------------------------------------------------------------
// Reads

async function projectVendorRows(ctx: QueryCtx, project: Doc<"projects">) {
  const members = await ctx.db
    .query("projectMembers")
    .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
    .take(200);
  const rows: { vendor: Doc<"vendors">; company: Doc<"companies"> }[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    if (m.status !== "active" || m.partyRole !== "sub") continue;
    const company = await ctx.db.get(m.companyId);
    if (company === null || company.kind !== "sub") continue;
    const vendor = await subVendorOnProject(ctx, project, company._id);
    if (vendor === null || seen.has(vendor._id)) continue;
    seen.add(vendor._id);
    rows.push({ vendor, company });
  }
  return rows;
}

/** GC: every sub vendor on the caller's projects with its computed state and records. */
export const gcComplianceWorklist = query({
  args: {},
  handler: async (ctx) => {
    const member = await requireCompanyMember(ctx);
    if (member.company.kind !== "gc") throw notFound();
    const projects = (await callerProjects(ctx)).filter((p) => p.gcCompanyId === member.company._id).slice(0, 100);
    const now = Date.now();
    const rows = [];
    for (const project of projects) {
      for (const { vendor, company } of await projectVendorRows(ctx, project)) {
        const vc = await vendorCompliance(ctx, project, vendor, now);
        const items = [];
        for (const item of vc.items.slice(0, 50)) items.push(await itemView(ctx, item));
        rows.push({
          projectId: project._id,
          projectTitle: project.title,
          projectState: project.state ?? null,
          vendorId: vendor._id,
          vendorName: vendor.name,
          companyName: company.name,
          ...summaryView(vc),
          items,
        });
      }
    }
    return { companyName: member.company.name, today: new Date(now).toISOString().slice(0, 10), rows };
  },
});

/** Sub: the caller's projects with its company's computed compliance state on each. */
export const subComplianceOverview = query({
  args: {},
  handler: async (ctx) => {
    const member = await requireCompanyMember(ctx);
    if (member.company.kind !== "sub") throw notFound();
    const projects = (await callerProjects(ctx)).slice(0, 100);
    const now = Date.now();
    const rows = [];
    for (const project of projects) {
      const vendor = await subVendorOnProject(ctx, project, member.company._id);
      if (vendor === null) continue;
      const vc = await vendorCompliance(ctx, project, vendor, now);
      rows.push({ projectId: project._id, projectTitle: project.title, gcName: project.generalContractorName ?? null, status: vc.result.status, pendingCount: summaryView(vc).pendingCount });
    }
    return { companyName: member.company.name, rows };
  },
});

/** Sub: its own records and computed state on one project. */
export const subProjectCompliance = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["sub"] });
    const { company, vendor } = await requireSubVendor(ctx, access);
    const vc = await vendorCompliance(ctx, access.project, vendor);
    const items = [];
    for (const item of vc.items) {
      if (item.companyId !== company._id) continue;
      items.push(await itemView(ctx, item));
    }
    return {
      projectId: access.project._id,
      projectTitle: access.project.title,
      projectState: access.project.state ?? null,
      companyName: company.name,
      ...summaryView(vc),
      items,
    };
  },
});

/** One record the caller may see (GC of the project, or a member of the sub company that uploaded it). */
export const getComplianceItem = query({
  args: { itemId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, "complianceItems", args.itemId, { roles: ["gc", "sub"] });
    return await itemView(ctx, scope.doc);
  },
});
