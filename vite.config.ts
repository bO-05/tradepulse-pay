import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Pre-bundle AG Studio and its grid/chart peers at startup. The dashboard is lazy-loaded, so
    // otherwise Vite discovers them on the first dashboard visit and force-reloads the page.
    include: ["ag-studio", "ag-studio-react", "ag-grid-react", "ag-grid-enterprise", "ag-charts-enterprise", "ag-stack"],
  },
  server: {
    port: 5173,
    proxy: {
      "/specs": {
        target: process.env.VITE_CONVEX_SITE_URL || "https://brainy-skunk-440.convex.site",
        changeOrigin: true,
      },
      "/drawings": {
        target: process.env.VITE_CONVEX_SITE_URL || "https://brainy-skunk-440.convex.site",
        changeOrigin: true,
      },
      "/quotes": {
        target: process.env.VITE_CONVEX_SITE_URL || "https://brainy-skunk-440.convex.site",
        changeOrigin: true,
      },
      "/insurance": {
        target: process.env.VITE_CONVEX_SITE_URL || "https://brainy-skunk-440.convex.site",
        changeOrigin: true,
      },
      "/files": {
        target: process.env.VITE_CONVEX_SITE_URL || "https://brainy-skunk-440.convex.site",
        changeOrigin: true,
      },
      "/api/files": {
        target: process.env.VITE_CONVEX_SITE_URL || "https://brainy-skunk-440.convex.site",
        changeOrigin: true,
      },
    },
  },
});
