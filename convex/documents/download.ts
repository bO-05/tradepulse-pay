import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { httpAction, internalQuery } from "../_generated/server";
import { requireDocScope } from "../lib/projectScope";
import { NOT_FOUND_MESSAGE } from "../lib/tenancy";
import { corsHeaders, textResponse } from "../projectFileDownload";
import { assertStoredDocumentVisible } from "./access";
import { DOCUMENT_DOWNLOAD_PREFIX, DOCUMENT_KINDS } from "./kinds";

/**
 * GET /api/documents/<documentId> with the Convex Auth bearer token. Streams a generated document
 * only to a caller who may see the record it was generated from; any other caller, a malformed id
 * and a missing document all get the same 404 "Not found." body. No session: 401.
 */

export const authorizeDocument = internalQuery({
  args: { documentId: v.string() },
  handler: async (ctx, args): Promise<{ storageId: Id<"_storage">; fileName: string; contentType: string } | null> => {
    const id = ctx.db.normalizeId("documents", args.documentId);
    const doc = id === null ? null : await ctx.db.get(id);
    if (doc === null || doc.relatedId === undefined) return null;
    try {
      const cfg = DOCUMENT_KINDS[doc.kind];
      const scope = await requireDocScope(ctx, cfg.table, doc.relatedId, { roles: cfg.roles });
      await assertStoredDocumentVisible(ctx, doc, scope);
      if (scope.project._id !== doc.projectId) return null;
    } catch {
      // Every refusal (no access, wrong party, unverified account) answers like a missing document.
      return null;
    }
    return { storageId: doc.storageId, fileName: doc.fileName, contentType: doc.contentType };
  },
});

export const documentPreflight = httpAction(async (_ctx, req) => {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
});

export const documentDownload = httpAction(async (ctx, req) => {
  const identity = await ctx.auth.getUserIdentity().catch(() => null);
  if (identity === null) return textResponse(req, 401, "Not authenticated: sign in required.");
  let documentId: string;
  try {
    documentId = decodeURIComponent(new URL(req.url).pathname.slice(DOCUMENT_DOWNLOAD_PREFIX.length));
  } catch {
    return textResponse(req, 404, NOT_FOUND_MESSAGE);
  }
  const doc = await ctx.runQuery(internal.documents.download.authorizeDocument, { documentId });
  if (doc === null) return textResponse(req, 404, NOT_FOUND_MESSAGE);
  const blob = await ctx.storage.get(doc.storageId).catch(() => null);
  if (blob === null) return textResponse(req, 404, NOT_FOUND_MESSAGE);
  const safeName = doc.fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": doc.contentType,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(req),
    },
  });
});
