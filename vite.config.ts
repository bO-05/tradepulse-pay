import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Demo PDF paths served by the Convex HTTP router (convex/http.ts).
const CONVEX_SITE_PATHS = ["/specs", "/drawings", "/quotes", "/insurance", "/files", "/api/files"];

function currentCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

/** The footer and /version.json must name the exact build uploaded to both static hosts. */
function buildVersionFile(commit: string): Plugin {
  return {
    name: "trade-pulse-build-version",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir ?? resolve(process.cwd(), "dist");
      writeFileSync(
        resolve(outDir, "version.json"),
        `${JSON.stringify({ app: "TradePulse Pay", commit, short: commit.slice(0, 12) }, null, 2)}\n`,
      );
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Config files do not see .env.local through process.env, so load it explicitly.
  const convexSiteUrl = process.env.VITE_CONVEX_SITE_URL || loadEnv(mode, process.cwd(), "VITE_").VITE_CONVEX_SITE_URL;
  const commit = (process.env.VITE_BUILD_COMMIT || currentCommit()).trim();
  return {
    plugins: [react(), buildVersionFile(commit)],
    define: {
      __BUILD_COMMIT__: JSON.stringify(commit),
    },
    optimizeDeps: {
      // Pre-bundle AG Studio and its grid/chart peers at startup. The dashboard is lazy-loaded, so
      // otherwise Vite discovers them on the first dashboard visit and force-reloads the page.
      include: ["ag-studio", "ag-studio-react", "ag-grid-react", "ag-grid-enterprise", "ag-charts-enterprise", "ag-stack"],
    },
    server: {
      // Convex Auth's SITE_URL is http://localhost:3150, so sign-in only works on this origin.
      port: 3150,
      strictPort: true,
      proxy: convexSiteUrl
        ? Object.fromEntries(CONVEX_SITE_PATHS.map((p) => [p, { target: convexSiteUrl, changeOrigin: true }]))
        : undefined,
    },
  };
});
