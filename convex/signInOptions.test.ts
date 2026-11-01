/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
afterEach(() => vi.unstubAllEnvs());

test.each([
  ["", "", false],
  ["test-client", "", false],
  ["", "test-secret", false],
  [" ", "test-secret", false],
  ["test-client", "test-secret", true],
])("public sign-in options disclose only configuration, not credentials (%s)", async (id, secret, configured) => {
  vi.stubEnv("AUTH_AGENTID_ID", id);
  vi.stubEnv("AUTH_AGENTID_SECRET", secret);
  const response = await convexTest(schema, modules).fetch("/api/sign-in-options");
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ agentIdConfigured: configured });
});
