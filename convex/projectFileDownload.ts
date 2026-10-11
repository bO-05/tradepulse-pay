import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { httpAction, internalQuery } from "./_generated/server";
import { authorizeProjectFileDownload, PROJECT_FILE_DOWNLOAD_PREFIX } from "./files";
import { NOT_FOUND_MESSAGE } from "./lib/tenancy";

const DEV_ORIGINS = ["http://localhost:3150"];

function allowedOrigins(): string[] {
  return [process.env.SITE_URL, process.env.CONVEX_SITE_URL, ...DEV_ORIGINS].filter(
    (o): o is string => typeof o === "string" && o !== "",
  );
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Expose-Headers": "Content-Disposition, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function textResponse(req: Request, status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(req) },
  });
}

export const authorizeDownload = internalQuery({
  args: { fileId: v.string() },
  handler: async (ctx, args) => await authorizeProjectFileDownload(ctx, args.fileId),
});

export const projectFilePreflight = httpAction(async (_ctx, req) => {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
});

/**
 * GET /api/project-files/<projectFileId> with the Convex Auth bearer token. Streams the stored
 * bytes only to callers with access to the file's project; any other caller, and a missing file,
 * get the same 404 "Not found." body.
 */
export const projectFileDownload = httpAction(async (ctx, req) => {
  const identity = await ctx.auth.getUserIdentity().catch(() => null);
  if (identity === null) return textResponse(req, 401, "Not authenticated: sign in required.");
  const fileId = decodeURIComponent(new URL(req.url).pathname.slice(PROJECT_FILE_DOWNLOAD_PREFIX.length));
  const file = await ctx.runQuery(internal.projectFileDownload.authorizeDownload, { fileId });
  if (file === null) return textResponse(req, 404, NOT_FOUND_MESSAGE);
  const blob = await ctx.storage.get(file.storageId as Id<"_storage">).catch(() => null);
  if (blob === null) return textResponse(req, 404, NOT_FOUND_MESSAGE);
  const safeName = file.fileName.replace(/["\\\r\n]/g, "_");
  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      ...corsHeaders(req),
    },
  });
});
