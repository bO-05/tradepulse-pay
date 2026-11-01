import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { inputsHashOf, loadDocument, relatedDoc, sha256Hex } from "./inputs";
import type { LoadedDocument } from "./inputTypes";
import { DOCUMENT_KINDS, documentKindValidator, type DocumentKind } from "./kinds";
import { renderDocumentBytes } from "./render";

/**
 * Server-side generation of billing documents (architecture §16). Only internal functions live here:
 * public callers authorize in documents.ts and schedule `renderDocument`. A re-render of unchanged
 * data produces the same bytes, so it reuses the stored row instead of adding a copy.
 */

export async function latestDocument(ctx: QueryCtx, kind: DocumentKind, relatedId: string): Promise<Doc<"documents"> | null> {
  return await ctx.db
    .query("documents")
    .withIndex("by_kind_and_relatedId", (q) => q.eq("kind", kind).eq("relatedId", relatedId))
    .order("desc")
    .first();
}

export const renderInput = internalQuery({
  args: { kind: documentKindValidator, relatedId: v.string() },
  handler: async (ctx, args): Promise<{ loaded: LoadedDocument; inputsHash: string } | null> => {
    const related = await relatedDoc(ctx, args.kind, args.relatedId);
    if (related === null) return null;
    const loaded = await loadDocument(ctx, args.kind, related as Doc<"payApplications">);
    return { loaded, inputsHash: await inputsHashOf(loaded) };
  },
});

export const findBySha = internalQuery({
  args: { kind: documentKindValidator, relatedId: v.string(), sha256: v.string() },
  handler: async (ctx, args): Promise<Id<"documents"> | null> => {
    const rows = await ctx.db
      .query("documents")
      .withIndex("by_kind_and_relatedId", (q) => q.eq("kind", args.kind).eq("relatedId", args.relatedId))
      .order("desc")
      .take(50);
    return rows.find((r) => r.sha256 === args.sha256)?._id ?? null;
  },
});

export const recordDocument = internalMutation({
  args: {
    kind: documentKindValidator,
    relatedId: v.string(),
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
    sha256: v.string(),
    inputsHash: v.string(),
    fileName: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    uploadedByUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args): Promise<Id<"documents">> => {
    const same = await ctx.db
      .query("documents")
      .withIndex("by_kind_and_relatedId", (q) => q.eq("kind", args.kind).eq("relatedId", args.relatedId))
      .order("desc")
      .take(50);
    const existing = same.find((r) => r.sha256 === args.sha256);
    if (existing !== undefined) {
      // A concurrent render stored the same bytes first; keep one copy.
      await ctx.storage.delete(args.storageId);
      return existing._id;
    }
    return await ctx.db.insert("documents", {
      projectId: args.projectId,
      kind: args.kind,
      sensitivity: "restricted",
      storageId: args.storageId,
      sha256: args.sha256,
      fileName: args.fileName,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      ...(args.uploadedByUserId !== undefined ? { uploadedByUserId: args.uploadedByUserId } : {}),
      createdAt: Date.now(),
      relatedId: args.relatedId,
      relatedTable: DOCUMENT_KINDS[args.kind].table,
      inputsHash: args.inputsHash,
    });
  },
});

/** Same bytes from different inputs (e.g. a field the document does not print): the row stays current. */
export const markCurrent = internalMutation({
  args: { documentId: v.id("documents"), inputsHash: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const doc = await ctx.db.get(args.documentId);
    if (doc !== null && doc.inputsHash !== args.inputsHash) await ctx.db.patch(args.documentId, { inputsHash: args.inputsHash });
    return null;
  },
});

export const renderDocument = internalAction({
  args: { kind: documentKindValidator, relatedId: v.string(), requestedByUserId: v.optional(v.id("users")) },
  handler: async (ctx, args): Promise<{ documentId: Id<"documents">; sha256: string; sizeBytes: number; reused: boolean } | null> => {
    const input = await ctx.runQuery(internal.documents.store.renderInput, { kind: args.kind, relatedId: args.relatedId });
    if (input === null) return null;
    const { bytes, contentType } = await renderDocumentBytes(input.loaded);
    const sha256 = await sha256Hex(bytes);
    const existing = await ctx.runQuery(internal.documents.store.findBySha, { kind: args.kind, relatedId: args.relatedId, sha256 });
    if (existing !== null) {
      await ctx.runMutation(internal.documents.store.markCurrent, { documentId: existing, inputsHash: input.inputsHash });
      return { documentId: existing, sha256, sizeBytes: bytes.length, reused: true };
    }
    const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: contentType }));
    const documentId = await ctx.runMutation(internal.documents.store.recordDocument, {
      kind: args.kind,
      relatedId: args.relatedId,
      projectId: input.loaded.projectId as Id<"projects">,
      storageId,
      sha256,
      inputsHash: input.inputsHash,
      fileName: input.loaded.fileName,
      contentType,
      sizeBytes: bytes.length,
      uploadedByUserId: args.requestedByUserId,
    });
    return { documentId, sha256, sizeBytes: bytes.length, reused: false };
  },
});
