import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { mutation, query, type QueryCtx } from "../_generated/server";
import { isNotFoundError, requireDocScope, requireProjectScope } from "../lib/projectScope";
import { requireRole } from "../lib/roles";
import { notFound } from "../lib/tenancy";
import { assertDocumentVisible, assertStoredDocumentVisible } from "./access";
import { inputsHashOf, loadDocument } from "./inputs";
import { DOCUMENT_KINDS, documentDownloadPath, documentKindValidator, type DocumentKind } from "./kinds";

/**
 * Billing documents for the parties of a project (architecture §16). Clients ask for a document of a
 * record they can see; the server renders it (documents/store.ts) and the bytes are fetched from the
 * authenticated /api/documents/<id> route. Nothing here returns a storage URL or storage id.
 */

const PARTIES = ["gc", "sub", "owner"] as const;

function documentView(doc: Doc<"documents">) {
  return {
    _id: doc._id,
    kind: doc.kind,
    label: DOCUMENT_KINDS[doc.kind].label,
    fileName: doc.fileName,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    sha256: doc.sha256,
    sensitivity: doc.sensitivity,
    createdAt: doc.createdAt,
    relatedId: doc.relatedId ?? null,
    downloadPath: documentDownloadPath(doc._id),
  };
}
export type DocumentView = ReturnType<typeof documentView>;

async function currentRow(ctx: QueryCtx, kind: DocumentKind, relatedId: string, inputsHash: string): Promise<Doc<"documents"> | null> {
  const rows = await ctx.db
    .query("documents")
    .withIndex("by_kind_and_relatedId", (q) => q.eq("kind", kind).eq("relatedId", relatedId))
    .order("desc")
    .take(50);
  return rows.find((r) => r.inputsHash === inputsHash) ?? null;
}

/**
 * The current document of `kind` for a record: returned at once when the stored file reflects the
 * record's data, otherwise rendered in the background ("pending"; poll `documentStatus`).
 */
export const requestDocument = mutation({
  args: { kind: documentKindValidator, relatedId: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, DOCUMENT_KINDS[args.kind].table, args.relatedId, { roles: DOCUMENT_KINDS[args.kind].roles });
    assertDocumentVisible(args.kind, scope);
    const relatedId = scope.doc._id as string;
    const inputsHash = await inputsHashOf(await loadDocument(ctx, args.kind, scope.doc));
    const current = await currentRow(ctx, args.kind, relatedId, inputsHash);
    if (current !== null) return { status: "ready" as const, inputsHash, document: documentView(current) };
    await ctx.scheduler.runAfter(0, internal.documents.store.renderDocument, {
      kind: args.kind,
      relatedId,
      requestedByUserId: scope.user._id,
    });
    return { status: "pending" as const, inputsHash, document: null };
  },
});

/** The stored document for a record whose data hashes to `inputsHash`, once rendered; else null. */
export const documentStatus = query({
  args: { kind: documentKindValidator, relatedId: v.string(), inputsHash: v.string() },
  handler: async (ctx, args) => {
    const scope = await requireDocScope(ctx, DOCUMENT_KINDS[args.kind].table, args.relatedId, { roles: DOCUMENT_KINDS[args.kind].roles });
    assertDocumentVisible(args.kind, scope);
    const row = await currentRow(ctx, args.kind, scope.doc._id, args.inputsHash);
    if (row === null) return null;
    await assertStoredDocumentVisible(ctx, row, scope);
    return documentView(row);
  },
});

/** Metadata of one document the caller may download. */
export const getDocument = query({
  args: { documentId: v.string() },
  handler: async (ctx, args) => {
    await requireRole(ctx, PARTIES);
    const id = ctx.db.normalizeId("documents", args.documentId);
    const doc = id === null ? null : await ctx.db.get(id);
    if (doc === null || doc.relatedId === undefined) throw notFound();
    const scope = await requireDocScope(ctx, DOCUMENT_KINDS[doc.kind].table, doc.relatedId, { roles: DOCUMENT_KINDS[doc.kind].roles });
    await assertStoredDocumentVisible(ctx, doc, scope);
    if (scope.project._id !== doc.projectId) throw notFound();
    return documentView(doc);
  },
});

const LIST_LIMIT = 200;

/**
 * The newest document of each kind and record on a project that the caller may download, newest
 * first. Subs see only their own agreements' documents; owners only owner pay apps and prime COs.
 */
export const listDocuments = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const access = await requireProjectScope(ctx, args.projectId, { roles: PARTIES });
    const rows = await ctx.db
      .query("documents")
      .withIndex("by_projectId", (q) => q.eq("projectId", access.project._id))
      .order("desc")
      .take(LIST_LIMIT);
    const seen = new Set<string>();
    const out: DocumentView[] = [];
    for (const doc of rows) {
      if (doc.relatedId === undefined) continue;
      const key = `${doc.kind}:${doc.relatedId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const scope = await requireDocScope(ctx, DOCUMENT_KINDS[doc.kind].table, doc.relatedId, { roles: DOCUMENT_KINDS[doc.kind].roles });
        await assertStoredDocumentVisible(ctx, doc, scope);
        if (scope.project._id === access.project._id) out.push(documentView(doc));
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
      }
    }
    return { projectId: access.project._id as Id<"projects">, documents: out, truncated: rows.length === LIST_LIMIT };
  },
});
