import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ["./vitest.setup.ts"],
  },
});