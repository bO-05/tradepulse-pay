/**
 * Browser origins allowed to call the Convex HTTP routes (file bytes, Studio proxy).
 *
 * The app is served from two origins during the recovery window: the canonical custom
 * domain in SITE_URL and the deployment's own CONVEX_SITE_URL. Both must stay allowed
 * so the old #/judge-demo bookmark keeps working. Local Vite is the only dev origin.
 */
const DEV_ORIGINS = ["http://localhost:3150"];

export function browserOrigins(): string[] {
  const configured = [process.env.SITE_URL, process.env.CONVEX_SITE_URL, ...DEV_ORIGINS]
    .filter((origin): origin is string => typeof origin === "string" && origin.trim() !== "")
    .map((origin) => origin.trim().replace(/\/+$/, ""));
  return [...new Set(configured)];
}
