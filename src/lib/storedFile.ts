export interface StoredFileLike {
  url?: string | null;
  /** Authenticated Convex HTTP route for uploaded bytes, e.g. "/api/project-files/<id>". */
  downloadPath?: string | null;
  storageId?: string;
  textContent?: string;
}

/** Convex HTTP actions are served from the deployment's `.convex.site` origin. */
export function convexSiteUrl(env: { VITE_CONVEX_SITE_URL?: string; VITE_CONVEX_URL?: string }): string {
  const site = env.VITE_CONVEX_SITE_URL || (env.VITE_CONVEX_URL ?? "").replace(/\.convex\.cloud\/?$/, ".convex.site");
  return site.replace(/\/$/, "");
}

/**
 * Fetches an uploaded file's bytes through the authenticated download route. Returns null when
 * the record has no download route; throws when the server refuses or the request fails.
 */
export async function fetchAuthenticatedFile(
  file: StoredFileLike,
  token: string | null,
  env: { VITE_CONVEX_SITE_URL?: string; VITE_CONVEX_URL?: string },
  doFetch: typeof fetch = fetch,
): Promise<Blob | null> {
  if (!file.downloadPath) return null;
  const response = await doFetch(`${convexSiteUrl(env)}${file.downloadPath}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(response.status === 404 ? "Not found." : `HTTP ${response.status}`);
  return await response.blob();
}

/**
 * Resolves the URL that serves a project file's stored bytes: the Convex storage
 * URL when present, otherwise a served app document-router path. Never derives
 * content from the file name.
 */
export function resolveStoredFileUrl(file: StoredFileLike): string | null {
  if (file.url) return file.url;
  const storageId = file.storageId || "";
  if (storageId.startsWith("http") || storageId.startsWith("/")) return storageId;
  return null;
}

/**
 * True when a record is one of the seeded documents served from the app's
 * document router (no inline text stored, served path storageId).
 */
export function isServedArchiveRecord(file: StoredFileLike): boolean {
  const storageId = file.storageId || "";
  return (
    !file.textContent &&
    (storageId.startsWith("/specs/") ||
      storageId.startsWith("/drawings/") ||
      storageId.startsWith("/quotes/") ||
      storageId.startsWith("/insurance/"))
  );
}

export function resolveStoredFileText(file: StoredFileLike): string | null {
  if (file.textContent && file.textContent.trim().length > 0) return file.textContent;
  return null;
}