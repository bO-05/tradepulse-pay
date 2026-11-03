/**
 * Build provenance injected by vite.config.ts. Both static hosts must serve the same
 * dist, so the footer hash is the quickest way to confirm they do.
 */
declare const __BUILD_COMMIT__: string | undefined;

const injected = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__.trim() : "";
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

export const BUILD_COMMIT = injected !== "" ? injected : "dev";
export const BUILD_COMMIT_SHORT = BUILD_COMMIT.slice(0, 12);
export const BUILD_COMMIT_URL = COMMIT_PATTERN.test(BUILD_COMMIT)
  ? `https://github.com/bO-05/tradepulse-pay/commit/${BUILD_COMMIT}`
  : null;
