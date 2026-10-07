import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Demo PDF paths served by the Convex HTTP router (convex/http.ts).
const CONVEX_SITE_PATHS = ["/specs", "/drawings", "/quotes", "/insurance", "/files", "/api/files"];

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Config files do not see .env.local through process.env, so load it explicitly.
  const convexSiteUrl = process.env.VITE_CONVEX_SITE_URL || loadEnv(mode, process.cwd(), "VITE_").VITE_CONVEX_SITE_URL;
  return {
    plugins: [react()],
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
