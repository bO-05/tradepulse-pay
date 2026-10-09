import { mutation, query, action, internalMutation, internalAction, internalQuery } from "./_generated/server";
import { requireRole } from "./lib/roles";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { ProjectAccess } from "./lib/tenancy";
import { auditActor, callerProjects, requireDemoCompany, requireDocOfProject, requireDocScope, requireProjectScope } from "./lib/projectScope";
import { requireProjectScopeInAction } from "./lib/tenancyAction";
import { OFFLINE_RULES_ENGINE } from "./lib/aiLabels";
import { v, ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { sanitizeBidLevelingOutput, extractTextFromPdfStream, augmentExclusionsWithDeterministicGaps, applyExplicitExclusionAmounts, applyUnpricedExclusionBenchmarks, normalizeExclusionSeverity, normalizeLeadWeeksFromText, detectCoiDeficiency, detectCoiAffirmativeCompliance } from "./llmRouter";
import { getRealDocumentPdfBytes } from "./realDocuments";
import {
  MAX_UPLOAD_BYTES,
  validateUploadContentType,
  validateUploadFileName,
  validateUploadFileType,
} from "./validation";
import {
  COI_DEFICIENCY_PENALTY,
  LEAD_TIME_PENALTY_PER_WEEK,
  leadTimePenaltyFor,
  targetWeeksForDivision,
} from "./terms";
import { formatRetainagePercent } from "./lib/retainageRules";
import { bidderMayDownloadFile } from "./lib/bidDocuments";
import {
  computeLeveledTotalCents,
  exclusionsToCents,
  lineItemsToCents,
  nonNegativeCentsFromDollars,
  veAlternatesToCents,
} from "./lib/bidMoney";

export { extractTextFromPdfStream };

/**
 * Convex File Storage (_storage) Primitives:
 * Manages blueprint drawing sheets, specification PDF sections,
 * subcontractor quote files, ACORD 25 certificates of insurance,
 * and formal legal addenda.
 */
/** Upload intents outlive the one-hour Convex upload URL so a slow upload can still be saved. */
const UPLOAD_INTENT_TTL_MS = 2 * 60 * 60 * 1000;
const INVALID_UPLOAD_MESSAGE = "This upload could not be verified for this project. Upload the file again.";

/**
 * Upload URL for one project's files. The returned intent id binds whatever is uploaded with this
 * URL to the caller, its company and the project; saveFileRecord accepts nothing else.
 */
export const generateUploadUrl = mutation({
  args: { projectId: v.id("projects") },
  returns: v.object({ uploadUrl: v.string(), uploadIntentId: v.id("uploadIntents") }),
  handler: async (ctx, args) => {
    await requireRole(ctx, ["gc"]);
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    if (access.company === null || access.company.kind !== "gc") {
      throw new ConvexError({ code: "FORBIDDEN", message: "Forbidden: a verified general contractor account is required." });
    }
    const now = Date.now();
    const uploadIntentId = await ctx.db.insert("uploadIntents", {
      userId: access.user._id,
      companyId: access.company._id,
      projectId: access.project._id,
      createdAt: now,
      expiresAt: now + UPLOAD_INTENT_TTL_MS,
    });
    return { uploadUrl: await ctx.storage.generateUploadUrl(), uploadIntentId };
  },
});

/**
 * Claims a just-uploaded storage object for the caller's upload intent. Refused when the intent is
 * someone else's, for another project, used or expired, or when the object predates the intent or
 * is already attached to any file, so a storage id from another company can never be re-attached.
 */
async function claimUpload(
  ctx: MutationCtx,
  access: ProjectAccess,
  uploadIntentId: Id<"uploadIntents">,
  rawStorageId: string,
): Promise<Id<"_storage">> {
  const invalid = () => new ConvexError({ code: "INVALID_UPLOAD", message: INVALID_UPLOAD_MESSAGE });
  const intent = await ctx.db.get(uploadIntentId);
  if (
    intent === null ||
    intent.userId !== access.user._id ||
    intent.projectId !== access.project._id ||
    intent.companyId !== access.company?._id ||
    intent.usedAt !== undefined ||
    intent.expiresAt < Date.now()
  ) {
    throw invalid();
  }
  const storageId = ctx.db.system.normalizeId("_storage", rawStorageId);
  const metadata = storageId === null ? null : await ctx.db.system.get(storageId);
  if (storageId === null || metadata === null || metadata._creationTime < intent._creationTime) throw invalid();
  const attached = await ctx.db
    .query("projectFiles")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .first();
  const claimed = await ctx.db
    .query("uploadIntents")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .first();
  if (attached !== null || claimed !== null) throw invalid();
  await ctx.db.patch(intent._id, { storageId, usedAt: Date.now() });
  return storageId;
}

/** Bundled demo PDFs (public by design) keep their path; stored uploads are served only through the authenticated route. */
function isPublicDocumentPath(storageId: string): boolean {
  return storageId.startsWith("http") || storageId.startsWith("/");
}

export const PROJECT_FILE_DOWNLOAD_PREFIX = "/api/project-files/";

/** Owners see project documents but not bidders' quotes or insurance certificates. */
const OWNER_HIDDEN_FILE_TYPES = new Set(["quote_pdf", "coi_certificate"]);

function visibleFiles(access: ProjectAccess, files: Doc<"projectFiles">[]): Doc<"projectFiles">[] {
  if (access.partyRole === "owner") return files.filter((f) => !OWNER_HIDDEN_FILE_TYPES.has(f.fileType));
  return files;
}

function fileView(file: Doc<"projectFiles">) {
  const isPublic = isPublicDocumentPath(file.storageId);
  return {
    ...file,
    url: isPublic ? file.storageId : null,
    downloadPath: isPublic ? null : `${PROJECT_FILE_DOWNLOAD_PREFIX}${file._id}`,
  };
}

/** Download authorization for the HTTP route: the same project check as every other file read. */
export async function authorizeProjectFileDownload(
  ctx: QueryCtx,
  fileId: string,
): Promise<{ storageId: string; fileName: string } | null> {
  try {
    const access = await requireDocScope(ctx, "projectFiles", fileId, { roles: ["gc", "owner", "sub"] });
    if (access.partyRole === "sub") {
      if (!(await bidderMayDownloadFile(ctx, access, access.doc))) return null;
    } else if (visibleFiles(access, [access.doc]).length === 0) return null;
    if (isPublicDocumentPath(access.doc.storageId)) return null;
    return { storageId: access.doc.storageId, fileName: access.doc.fileName };
  } catch {
    return null;
  }
}

export const saveFileRecord = mutation({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.optional(v.id("tradePackages")),
    uploadIntentId: v.id("uploadIntents"),
    storageId: v.string(),
    fileName: v.string(),
    fileType: v.string(), // "blueprint" | "spec" | "quote_pdf" | "coi_certificate" | "addendum"
    fileSize: v.number(),
    uploadedBy: v.string(),
    textContent: v.optional(v.string()),
    contentType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc"], write: true });
    if (args.storageId.startsWith("http") || args.storageId.startsWith("/")) {
      throw new Error("Project uploads must use a Convex Storage identifier.");
    }
    if (args.tradePackageId) await requireDocOfProject(ctx, access, "tradePackages", args.tradePackageId);
    await claimUpload(ctx, access, args.uploadIntentId, args.storageId);
    // The uploader is the signed-in person, not a client-supplied label.
    const actor = auditActor(access);
    const fileName = validateUploadFileName(args.fileName, args.fileType === "addendum");
    const fileType = validateUploadFileType(args.fileType);
    validateUploadContentType(fileName, args.contentType);
    const fileSize = await getAuthoritativeFileSize(ctx, args.storageId, args.fileSize, fileName);
    if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_UPLOAD_BYTES) {
      throw new Error("File size must be greater than zero and no more than 50 MB.");
    }
    const fileId = await ctx.db.insert("projectFiles", {
      projectId: args.projectId,
      tradePackageId: args.tradePackageId,
      storageId: args.storageId,
      fileName,
      fileType,
      fileSize,
      uploadedBy: actor.actor,
      uploadedAt: Date.now(),
      ...(args.textContent ? { textContent: args.textContent.slice(0, 100_000) } : {}),
    });

    // Record in reactive audit stream
    await ctx.db.insert("auditLogs", {
      projectId: args.projectId,
      tradePackageId: args.tradePackageId,
      eventType: "file_uploaded",
      title: `File Uploaded: ${fileName}`,
      description: `Uploaded ${fileType} (${(fileSize / 1024).toFixed(1)} KB) to Convex File Storage.`,
      ...actor,
      timestamp: Date.now(),
    });

    return fileId;
  },
});

export const saveFileRecordInternal = internalMutation({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.optional(v.id("tradePackages")),
    storageId: v.string(),
    fileName: v.string(),
    fileType: v.string(),
    fileSize: v.number(),
    uploadedBy: v.string(),
    textContent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Project not found");
    if (args.tradePackageId) {
      const tradePackage = await ctx.db.get(args.tradePackageId);
      if (!tradePackage || tradePackage.projectId !== args.projectId) {
        throw new Error("The file trade package does not belong to the selected project.");
      }
    }
    const fileName = validateUploadFileName(args.fileName, args.fileType === "addendum");
    const fileType = validateUploadFileType(args.fileType);
    const fileSize = await getAuthoritativeFileSize(ctx, args.storageId, args.fileSize, fileName);
    if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_UPLOAD_BYTES) {
      throw new Error("File size must be greater than zero and no more than 50 MB.");
    }
    const fileId = await ctx.db.insert("projectFiles", {
      projectId: args.projectId,
      tradePackageId: args.tradePackageId,
      storageId: args.storageId,
      fileName,
      fileType,
      fileSize,
      uploadedBy: args.uploadedBy,
      uploadedAt: Date.now(),
      ...(args.textContent ? { textContent: args.textContent.slice(0, 100_000) } : {}),
    });

    await ctx.db.insert("auditLogs", {
      projectId: args.projectId,
      tradePackageId: args.tradePackageId,
      eventType: "file_uploaded",
      title: `File Stored: ${fileName}`,
      description: `Saved ${fileType} (${(fileSize / 1024).toFixed(1)} KB) to Project Files.`,
      actor: args.uploadedBy,
      timestamp: Date.now(),
    });

    return fileId;
  },
});

/**
 * One-time metadata repair: align seeded document file sizes with the bytes the
 * document endpoints actually serve, so UI labels match the real downloads.
 */
export const repairSeededDocumentSizes = mutation({
  args: {},
  handler: async (ctx) => {
    await requireDemoCompany(ctx, ["gc"]);
    const files: Doc<"projectFiles">[] = [];
    for (const project of await callerProjects(ctx, { includeArchived: true })) {
      files.push(
        ...(await ctx.db
          .query("projectFiles")
          .withIndex("by_project", (q) => q.eq("projectId", project._id))
          .take(500)),
      );
    }
    let repaired = 0;
    for (const file of files) {
      const isServedDocument =
        file.storageId.startsWith("/specs/") ||
        file.storageId.startsWith("/drawings/") ||
        file.storageId.startsWith("/quotes/") ||
        file.storageId.startsWith("/insurance/");
      if (!isServedDocument) continue;
      const bytes = getRealDocumentPdfBytes(file.fileName);
      if (bytes && bytes.length > 0 && bytes.length !== file.fileSize) {
        await ctx.db.patch(file._id, { fileSize: bytes.length });
        repaired += 1;
      }
    }
    return { repaired };
  },
});

export const listFilesByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: ["gc", "owner"] });
    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .collect();
    return visibleFiles(access, files).map(fileView);
  },
});

export const listFilesByPackage = query({
  args: { tradePackageId: v.id("tradePackages") },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "tradePackages", args.tradePackageId, { roles: ["gc", "owner"] });
    const files = await ctx.db
      .query("projectFiles")
      .withIndex("by_package", (q) => q.eq("tradePackageId", args.tradePackageId))
      .order("desc")
      .collect();
    return visibleFiles(access, files).map(fileView);
  },
});

export const deleteFile = mutation({
  args: { fileId: v.id("projectFiles") },
  handler: async (ctx, args) => {
    const access = await requireDocScope(ctx, "projectFiles", args.fileId, { roles: ["gc"], write: true });
    const file = access.doc;

    const linkedBids = await ctx.db
      .query("bids")
      .withIndex("by_source_file", (q: any) => q.eq("sourceFileId", args.fileId))
      .collect();
    if (linkedBids.length > 0) {
      throw new ConvexError("This quote file is linked to a bid and cannot be deleted until the bid is removed.");
    }

    // Never delete bytes another file record still points at.
    const sharedWith = (
      await ctx.db
        .query("projectFiles")
        .withIndex("by_storageId", (q) => q.eq("storageId", file.storageId))
        .take(2)
    ).filter((f) => f._id !== file._id);
    if (sharedWith.length === 0) {
      try {
        await ctx.storage.delete(file.storageId as any);
      } catch {
        // ignore if non-storageId
      }
    }
    await ctx.db.delete(args.fileId);

    await ctx.db.insert("auditLogs", {
      projectId: file.projectId,
      tradePackageId: file.tradePackageId,
      eventType: "file_deleted",
      title: `File Deleted: ${file.fileName}`,
      description: `Removed ${file.fileName} from Convex File Storage.`,
      ...auditActor(access),
      timestamp: Date.now(),
    });

    return { success: true };
  },
});

export const getFileRecordInternal = internalQuery({
  args: { fileId: v.id("projectFiles") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.fileId);
  },
});

async function getAuthoritativeFileSize(ctx: any, storageId: string, requestedSize: number, fileName: string): Promise<number> {
  // Email URLs and text-only extraction records do not point at Convex Storage.
  const isExternalReference = storageId.startsWith("http") || storageId.startsWith("/");
  const isSyntheticTextRecord = storageId.startsWith("quote_") || storageId.startsWith("text_");
  if (isExternalReference || isSyntheticTextRecord) return requestedSize;

  // ctx.storage.get() (blob contents) is only available inside actions. Both saveFileRecord
  // mutations run in the default runtime, so resolve the authoritative size from the _storage
  // system table metadata instead. Blob-level content sniffing stays in action-only callers.
  let metadata: { size?: number } | null = null;
  try {
    metadata = (await ctx.db.system.get("_storage", storageId as any)) as any;
  } catch {
    metadata = null;
  }
  if (!metadata) {
    throw new Error(
      "The uploaded storage object could not be found. Please re-upload the file and try again."
    );
  }
  const authoritativeSize = typeof metadata.size === "number" ? metadata.size : 0;
  if (authoritativeSize <= 0) {
    throw new Error(`The uploaded file "${fileName}" is empty or its storage metadata is unavailable.`);
  }
  return authoritativeSize;
}

async function doExtractBid(
  ctx: any,
  args: {
    projectId: any;
    tradePackageId: any;
    contractorId?: any;
    contractorName?: string;
    quoteText?: string;
    fileId?: any;
    fileName?: string;
    fileSize?: number;
  }
): Promise<any> {
  let proposalText = args.quoteText || "";
  let effectiveFileName = args.fileName;
  let effectiveFileSize = args.fileSize;

  const tradePackage: any = await ctx.runQuery(internal.tradePackages.getPackageInternal, {
    tradePackageId: args.tradePackageId,
  });
  if (!tradePackage || tradePackage.projectId !== args.projectId) {
    throw new Error("The selected trade package does not belong to the selected project.");
  }

  if (effectiveFileName) validateUploadFileName(effectiveFileName);
  if (effectiveFileSize !== undefined && (!Number.isFinite(effectiveFileSize) || effectiveFileSize <= 0 || effectiveFileSize > MAX_UPLOAD_BYTES)) {
    throw new Error("Quote file size must be greater than zero and no more than 50 MB.");
  }

  if (proposalText.startsWith("%PDF") || /[\x00-\x08\x0E-\x1F]/.test(proposalText.slice(0, 100))) {
    const extracted = extractTextFromPdfStream(proposalText);
    if (extracted && extracted.trim().length > 15 && !extracted.startsWith("[PDF_")) {
      proposalText = extracted;
    } else if (extracted.startsWith("[PDF_ENCRYPTED]")) {
      return {
        success: false,
        error: "Uploaded PDF is password-protected. Please upload an unencrypted document.",
      };
    } else if (extracted.startsWith("[PDF_CORRUPTED]")) {
      return {
        success: false,
        error: "Uploaded PDF file structure is corrupted or incomplete.",
      };
    } else if (extracted.trim().length <= 15) {
      return {
        success: false,
        error: "This PDF appears to be a scanned document or flattened raster image without selectable text streams. Please enter quote details manually or paste the proposal text.",
        isScannedPdf: true,
      };
    }
  }

  if (args.fileId) {
    const fileRecord = await ctx.runQuery(internal.files.getFileRecordInternal, {
      fileId: args.fileId,
    });
    if (!fileRecord) {
      throw new Error("The selected quote file could not be found.");
    }
    if (fileRecord) {
      if (fileRecord.projectId !== args.projectId || fileRecord.tradePackageId !== args.tradePackageId) {
        throw new Error("The selected quote file does not belong to the selected project and trade package.");
      }
      if (!effectiveFileName) effectiveFileName = fileRecord.fileName;
      if (!effectiveFileSize) effectiveFileSize = fileRecord.fileSize;
      if ((!proposalText || proposalText.startsWith("Extracted proposal from")) && fileRecord.textContent) {
        proposalText = fileRecord.textContent;
      }
      if ((!proposalText || proposalText.startsWith("Extracted proposal from")) && fileRecord.storageId && !fileRecord.storageId.startsWith("http")) {
        try {
          const blob = await ctx.storage.get(fileRecord.storageId as any);
          if (blob) {
            const arrBuf = await blob.arrayBuffer();
            const uint8 = new Uint8Array(arrBuf);
            const decompressedExtracted = extractTextFromPdfStream(uint8);
            if (decompressedExtracted && decompressedExtracted.trim().length > 15 && !decompressedExtracted.startsWith("[PDF_")) {
              proposalText = decompressedExtracted;
            } else if (decompressedExtracted.startsWith("[PDF_ENCRYPTED]")) {
              return {
                success: false,
                error: "Uploaded PDF is password-protected. Please upload an unencrypted document.",
              };
            } else if (decompressedExtracted.startsWith("[PDF_CORRUPTED]")) {
              return {
                success: false,
                error: "Uploaded PDF file structure is corrupted or incomplete.",
              };
            } else if (decompressedExtracted.trim().length <= 15 && (fileRecord.fileName.toLowerCase().endsWith(".pdf") || fileRecord.fileType === "quote_pdf")) {
              return {
                success: false,
                error: "This PDF appears to be a scanned document or flattened raster image without selectable text streams. Please enter quote details manually or paste the proposal text.",
                isScannedPdf: true,
              };
            } else {
              const txt = await blob.text();
              if (txt && txt.trim().length > 0) {
                if (txt.startsWith("%PDF") || /[\x00-\x08\x0E-\x1F]/.test(txt.slice(0, 100))) {
                  const extracted = extractTextFromPdfStream(txt);
                  if (extracted && extracted.trim().length > 15 && !extracted.startsWith("[PDF_")) {
                    proposalText = extracted;
                  }
                } else {
                  proposalText = txt;
                }
              }
            }
          }
        } catch {
          // Non-storage or binary blob fallback
        }
      }
      if (!proposalText || proposalText.trim().length < 15) {
        return { success: false, error: `No readable quote text was found in ${fileRecord.fileName}. Upload a text-readable PDF or TXT proposal.` };
      }
    }
  }

  if (!proposalText || proposalText.trim().length < 15) {
    return { success: false, error: "No readable proposal text was provided." };
  }

  // A7CONV-R2C-F2: a negative stated base bid must be refused, never sign-flipped.
  if (/(?:base\s*(?:bid|price|proposal|amount)?|contract\s*sum|lump\s*sum)[^\n\r]{0,24}?-\s*\$?\s*[0-9]/i.test(proposalText)) {
    return {
      success: false,
      error: "The proposal states a negative base bid. Correct the proposal before ingesting.",
    };
  }

  // 1. Forensic reasoning via token-optimized LLM router
  const gcCompanyName: string | null = await ctx.runQuery(
    internal.projects.getProjectCompanyNameInternal,
    { projectId: args.projectId }
  );
  const reasoningResult: any = await ctx.runAction(internal.llmRouter.executeReasoning, {
    taskType: "bid_leveling",
    prompt: proposalText,
    division: tradePackage.csiDivision,
    companyName: gcCompanyName ?? undefined,
  });

  // A1-01: when a contractor was explicitly selected, the contractor record's
// name wins over any client-supplied or model-guessed name.
  let selectedContractorName: string | undefined;
  if (args.contractorId) {
    try {
      const selectedRecord: any = await ctx.runQuery(internal.contractors.getContractorInternal, {
        contractorId: args.contractorId,
      });
      if (selectedRecord?.companyName) selectedContractorName = selectedRecord.companyName;
    } catch {
      // Fall through to the provided name when lookup fails.
    }
  }
  const parsed = sanitizeBidLevelingOutput(reasoningResult.parsedJson, {
    division: tradePackage.csiDivision,
  });
  // A7CONV-R6C-2/R14A-F1: the proposal text is the source of truth for a stated
  // COI position, in both directions.
  if (detectCoiDeficiency(proposalText)) {
    parsed.coiComplianceStatus = "deficiency_detected";
    parsed.coiPenalty = COI_DEFICIENCY_PENALTY;
  } else if (
    parsed.coiComplianceStatus === "deficiency_detected" &&
    detectCoiAffirmativeCompliance(proposalText)
  ) {
    parsed.coiComplianceStatus = "compliant";
    parsed.coiPenalty = 0;
  }
  let subName = selectedContractorName || args.contractorName || parsed?.subcontractorName;
  if (!subName || subName === "Commercial Subcontractor") {
    if (args.contractorId) {
      try {
        const contractorRecord: any = await ctx.runQuery(internal.contractors.getContractorInternal, {
          contractorId: args.contractorId,
        });
        if (contractorRecord?.companyName) {
          subName = contractorRecord.companyName;
        }
      } catch {
        // Ignore if contractor lookup fails
      }
    }
  }
  if (!subName) {
    subName = args.contractorName || "Commercial Subcontractor";
  }

  // Resolve or auto-provision contractor record if not explicitly provided
  let effectiveContractorId = args.contractorId;
  if (effectiveContractorId) {
    try {
      const existing = await ctx.runQuery(internal.contractors.getContractorInternal, {
        contractorId: effectiveContractorId,
      });
      if (!existing) {
        effectiveContractorId = undefined;
      }
    } catch {
      effectiveContractorId = undefined;
    }
  }

  if (!effectiveContractorId) {
    try {
      const packageContractors: any = await ctx.runQuery(internal.contractors.listByPackageInternal, {
        tradePackageId: args.tradePackageId,
      });
      const match = packageContractors?.find((c: any) =>
        c.companyName.toLowerCase().trim() === subName.toLowerCase().trim() ||
        subName.toLowerCase().includes(c.companyName.toLowerCase().trim()) ||
        c.companyName.toLowerCase().includes(subName.toLowerCase().trim())
      );
      if (match) {
        effectiveContractorId = match._id;
        // A13-03: the linked contractor record is the canonical bidder name;
        // never store the parsed/stale display name alongside it.
        subName = match.companyName;
      }
    } catch {
      // Ignore query errors
    }
  }

  // A6-35: never attribute another company's contact data (or a fabricated
  // verification badge) to a quote-created contractor. Until the GC supplies
  // the real details, the record stays explicitly unpublished/unverified.
  const unpublishedContact = () => ({
    email: "not-published@verify-required.invalid",
    url: "",
  });

  if (!effectiveContractorId) {
    const contactInfo = unpublishedContact();
    try {
      effectiveContractorId = await ctx.runMutation(internal.contractors.createContractorInternal, {
        tradePackageId: args.tradePackageId,
        companyName: subName,
        contactEmail: contactInfo.email,
        licenseNumber: "Not verified",
        licenseStatus: "Unverified — quote intake",
        sourceUrl: contactInfo.url,
        rfqStatus: "bid_received",
      });
    } catch (err) {
      // An inactive directory vendor is refused on purpose; never attribute its quote to another bidder.
      if (err instanceof ConvexError) throw err;
      // Fallback: use first available contractor in package if insert fails
      try {
        const packageContractors: any = await ctx.runQuery(internal.contractors.listByPackageInternal, {
          tradePackageId: args.tradePackageId,
        });
        if (packageContractors && packageContractors.length > 0) {
          effectiveContractorId = packageContractors[0]._id;
        }
      } catch {
        // Continue
      }
    }
  }

  // Guaranteed fallback: if still not resolved, insert standard contractor
  if (!effectiveContractorId) {
    const contactInfo = unpublishedContact();
    effectiveContractorId = await ctx.runMutation(internal.contractors.createContractorInternal, {
      tradePackageId: args.tradePackageId,
      companyName: subName || "Commercial Subcontractor",
      contactEmail: contactInfo.email,
      licenseNumber: "Not verified",
      licenseStatus: "Unverified — quote intake",
      sourceUrl: contactInfo.url,
      rfqStatus: "bid_received",
    });
  }

  let baseBid = typeof parsed?.baseBidAmount === "number" ? parsed.baseBidAmount : 0;
  if (baseBid === 0 && Array.isArray(parsed?.lineItems) && parsed.lineItems.length > 0) {
    baseBid = parsed.lineItems.reduce(
      (acc: number, item: any) => acc + (typeof item.totalCost === "number" ? item.totalCost : 0),
      0
    );
  }

  const lineItems = (parsed?.lineItems && parsed.lineItems.length > 0)
    ? parsed.lineItems
    : [{ item: "Base Commercial Scope", unit: "LS", quantity: 1, unitCost: baseBid, totalCost: baseBid }];
  // A7CONV-R9B/R15A: deterministic scope-gap safety net first, then unpriced
  // benchmarks, then stated dollar amounts (which always win), then severity.
  const exclusions = normalizeExclusionSeverity(
    applyExplicitExclusionAmounts(
      applyUnpricedExclusionBenchmarks(
        augmentExclusionsWithDeterministicGaps(
          parsed?.identifiedExclusions ?? [],
          proposalText,
          tradePackage.csiDivision
        ),
        proposalText,
        tradePackage.csiDivision
      ),
      proposalText
    )
  );
  const veAlternates = parsed?.valueEngineeringAlternates ?? [];
  const leadWeeks = normalizeLeadWeeksFromText(
    parsed?.longLeadEquipmentWeeks ?? 12,
    proposalText
  );
  const leadTargetWeeks = parsed?.leadTimeTargetWeeks ?? targetWeeksForDivision(tradePackage.csiDivision);
  const coiStatus = parsed?.coiComplianceStatus ?? "compliant";
  const baseAmountCents = nonNegativeCentsFromDollars(baseBid);
  const exclusionsCents = exclusionsToCents(exclusions);
  const veAlternatesCents = veAlternatesToCents(veAlternates);
  const coiPenaltyCents = nonNegativeCentsFromDollars(parsed?.coiPenalty ?? 0);
  const leveledTotalCents = computeLeveledTotalCents({
    baseAmountCents,
    exclusions: exclusionsCents,
    veAlternates: veAlternatesCents,
    leadTimePenaltyCents: nonNegativeCentsFromDollars(leadTimePenaltyFor(leadWeeks, leadTargetWeeks)),
    coiPenaltyCents,
  });

  // 2. Insert into bids table (the parser speaks dollars; storage is integer cents)
  const bidId: any = await ctx.runMutation(internal.bids.insertParsedBid, {
    tradePackageId: args.tradePackageId,
    contractorId: effectiveContractorId,
    subcontractorName: subName,
    baseAmountCents,
    lineItems: lineItemsToCents(lineItems),
    identifiedExclusions: exclusionsCents,
    valueEngineeringAlternates: veAlternatesCents,
    longLeadEquipmentWeeks: leadWeeks,
    leadTimeTargetWeeks: leadTargetWeeks,
    coiComplianceStatus: coiStatus,
    coiPenaltyCents,
    sourceFileId: args.fileId,
    levelingProvider:
      reasoningResult.provider === OFFLINE_RULES_ENGINE
        ? `${OFFLINE_RULES_ENGINE} (no model call)`
        : `${reasoningResult.provider || "unknown"} ${reasoningResult.model || ""}`.trim(),
  });

  // Update contractor rfqStatus to "bid_received"
  if (effectiveContractorId) {
    try {
      await ctx.runMutation(internal.contractors.updateRfqStatusInternal, {
        contractorId: effectiveContractorId,
        rfqStatus: "bid_received",
      });
    } catch {
      // Ignore if contractor update fails
    }
  }

  // 3. Save a quote file record if fileName provided and fileId wasn't already registered
  let linkedFileId = args.fileId;
  if (effectiveFileName && !args.fileId && effectiveFileSize !== undefined) {
    linkedFileId = await ctx.runMutation(internal.files.saveFileRecordInternal, {
      projectId: args.projectId,
      tradePackageId: args.tradePackageId,
      storageId: `quote_${Date.now()}`,
      fileName: effectiveFileName,
      fileType: "quote_pdf",
      fileSize: effectiveFileSize ?? proposalText.length,
      uploadedBy: subName,
    });
  }

  return {
    success: true,
    bidId,
    fileId: linkedFileId,
    subcontractorName: subName,
    baseAmountCents,
    leveledTotalCents,
    exclusionsCount: exclusions.length,
    veAlternatesCount: veAlternates.length,
  };
}

async function doGeneratePreBidAddendum(
  ctx: any,
  args: {
    projectId: any;
    tradePackageId?: any;
    addendumNumber?: string;
  }
): Promise<any> {
  const addendumNum = args.addendumNumber || "ADDENDUM NO. 01";
  const addendumFileBase = addendumNum.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const project: any = await ctx.runQuery(internal.projects.getProjectInternal, {
    projectId: args.projectId,
  });
  const certificationResult: any = await ctx.runQuery(
    internal.rfq.listClarifiedConversationsForProject,
    { projectId: args.projectId }
  );
  if (certificationResult.pending.length > 0) {
    throw new ConvexError(
      `PM certification is required before issuing a binding addendum. Review ${certificationResult.pending.length} pending RFI(s).`
    );
  }
  // A7CONV-R2C-F3: the certification gate must hold server-side even with zero
  // RFIs, otherwise the action files a "legally binding" addendum with no basis.
  if (certificationResult.clarified.length === 0) {
    throw new ConvexError(
      "PM certification is required before issuing a binding addendum. Certify at least one RFI (Approve for Addendum) first."
    );
  }
  const conversations = certificationResult.clarified;

  const nowStr = `${new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  })} (UTC)`;
  const addendumText = `# ${addendumNum}
## PROJECT SPECIFICATIONS & BIDDING DOCUMENTS CLARIFICATIONS
**Project:** ${project?.title || "Commercial Construction Project"}  
**Location:** ${project?.location || "Project Site"}  
**Issuance Date:** ${nowStr}  
**Prepared by:** TradePulse Pay pre-bid clarification log  
**Distribution:** All Registered CSI MasterFormat Trade Subcontractors  

---

### NOTICE TO ALL BIDDERS:
This Addendum forms a legally binding part of the Contract Documents and modifies the original Bidding Documents. Bidders shall acknowledge receipt of this Addendum in the space provided on their Proposal Forms. Failure to acknowledge receipt of this Addendum may subject the Bidder to disqualification.

### ARTICLE 1: BLUEPRINT & CSI SPECIFICATION REVISIONS
1. **Division 01 00 00 - General Requirements**:
   - Subcontractors shall coordinate crane picks, rigging, and staging with General Contractor superintendent at least 72 hours prior to rooftop mobilization.
   - Temporary power distribution boards (400A) must be furnished and maintained by the electrical trade subcontractor from the primary utility tap.

2. **Liquidated Delay Adjustments & Schedule**:
   - Equipment lead times exceeding the target project milestone without a pre-approved expedited shipping rider incur ADR-0003 lead-time delay adjustments at $${LEAD_TIME_PENALTY_PER_WEEK.toLocaleString("en-US")} per week. These are distinct from any liquidated damages for completion delay, which are stated in each subcontract's terms.

3. **Mandatory Insurance Standards (ACORD 25)**:
   - Insurance limits and additional-insured requirements are stated in each subcontract's terms.

4. **Retainage**:
   - Progress payments are subject to ${project?.retainageBps !== undefined ? `${formatRetainagePercent(project.retainageBps)} ` : ""}retainage as stated in each subcontract's terms.

### ARTICLE 2: PRE-BID QUESTIONS & AUTHORITATIVE CLARIFICATIONS
${
  conversations.length > 0
    ? conversations
        .map(
          (c: any, i: number) => `
#### Item 2.${i + 1} - CSI Division ${c.csiDivision} (${c.tradeName}): ${c.inboundSubject}
- **Subcontractor Inquiry:** "${c.inboundQuestion}"
- **Authoritative Resolution:** ${c.autonomousReply}
- **Model Confidence Score:** ${(c.confidenceScore * 100).toFixed(0)}% (CSI Verified)
`
        )
        .join("\n")
    : `
No formal pre-bid clarifications or RFIs logged for this addendum issuance. All base contract documents and specifications remain in full effect.
`
}

### ARTICLE 3: ACKNOWLEDGEMENT REQUIRED
Each proposal submitted must include affirmative written acknowledgement of ${addendumNum}.

---
**END OF ${addendumNum}**
`;

  const blob = new Blob([addendumText], { type: "text/markdown" });
  const storageId = await ctx.storage.store(blob);

  const fileId: any = await ctx.runMutation(internal.files.saveFileRecordInternal, {
    projectId: args.projectId,
    tradePackageId: args.tradePackageId,
    storageId,
    fileName: `${addendumFileBase}_CLARIFICATIONS.md`,
    fileType: "addendum",
    fileSize: addendumText.length,
    textContent: addendumText,
    uploadedBy: "TradePulse Pre-Bid Clarification Engine (generated addendum)",
  });

  const divisionSet = new Set(conversations.map((c: any) => c.csiDivision).filter(Boolean));
  const csiDivisionCount = divisionSet.size;
  const qaCount = conversations.length;

  return {
    success: true,
    addendumNumber: addendumNum,
    fileName: `${addendumFileBase}_CLARIFICATIONS.md`,
    addendumText,
    fileId,
    // Served only through the authenticated route; a raw storage URL would bypass project access.
    downloadPath: `${PROJECT_FILE_DOWNLOAD_PREFIX}${fileId}`,
    qaCount,
    csiDivisionCount,
  };
}

/**
 * Direct PDF / Quote Ingestion Action:
 * Parses raw subcontractor quote proposal text or links existing projectFiles records
 * via the Token-Optimized LLM Router, performs forensic extraction of line items,
 * fine-print exclusions, lead times, and normalizes the bid into the leveling matrix.
 */
export const extractBidFromQuoteFile = action({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.id("tradePackages"),
    contractorId: v.optional(v.id("contractors")),
    contractorName: v.optional(v.string()),
    quoteText: v.optional(v.string()),
    fileId: v.optional(v.id("projectFiles")),
    fileName: v.optional(v.string()),
    fileSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireProjectScopeInAction(
      ctx,
      {
        projectId: args.projectId,
        docs: [
          { table: "tradePackages", id: args.tradePackageId },
          { table: "contractors", id: args.contractorId },
          { table: "projectFiles", id: args.fileId },
        ],
      },
      { roles: ["gc"], write: true },
    );
    return await doExtractBid(ctx, args);
  },
});

export const extractBidFromFile = action({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.id("tradePackages"),
    contractorId: v.optional(v.id("contractors")),
    contractorName: v.optional(v.string()),
    fileId: v.id("projectFiles"),
    quoteText: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireProjectScopeInAction(
      ctx,
      {
        projectId: args.projectId,
        docs: [
          { table: "tradePackages", id: args.tradePackageId },
          { table: "contractors", id: args.contractorId },
          { table: "projectFiles", id: args.fileId },
        ],
      },
      { roles: ["gc"], write: true },
    );
    return await doExtractBid(ctx, args);
  },
});

export const extractBidFromQuoteFileInternal = internalAction({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.id("tradePackages"),
    contractorId: v.optional(v.id("contractors")),
    contractorName: v.optional(v.string()),
    quoteText: v.optional(v.string()),
    fileId: v.optional(v.id("projectFiles")),
    fileName: v.optional(v.string()),
    fileSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await doExtractBid(ctx, args);
  },
});

/**
 * Pre-Bid Legal Addendum Generator:
 * Generates official "ADDENDUM NO. 01" compiling all clarified pre-bid RFIs
 * and architectural specifications into an authentic CSI MasterFormat legal document,
 * storing it in Convex Storage and registering it in projectFiles.
 */
export const generatePreBidAddendum = action({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.optional(v.id("tradePackages")),
    addendumNumber: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    await requireProjectScopeInAction(
      ctx,
      { projectId: args.projectId, docs: [{ table: "tradePackages", id: args.tradePackageId }] },
      { roles: ["gc"], write: true },
    );
    return await doGeneratePreBidAddendum(ctx, args);
  },
});

export const generatePreBidAddendumInternal = internalAction({
  args: {
    projectId: v.id("projects"),
    tradePackageId: v.optional(v.id("tradePackages")),
    addendumNumber: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    return await doGeneratePreBidAddendum(ctx, args);
  },
});
