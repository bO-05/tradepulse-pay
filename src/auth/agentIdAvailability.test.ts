import { expect, test, vi } from "vitest";
import { agentIdConfigured } from "./agentIdAvailability";

test.each([true, false])("uses only the explicit server configuration flag (%s)", async (configured) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ agentIdConfigured: configured })));
  const signal = new AbortController().signal;
  expect(await agentIdConfigured("https://example.convex.site/", signal, request)).toBe(configured);
  expect(request).toHaveBeenCalledWith("https://example.convex.site/api/sign-in-options", {
    credentials: "omit", cache: "no-store", redirect: "error", signal,
  });
});

test.each([{}, { agentIdConfigured: "true" }, null])("malformed configuration never enables sign-in (%j)", async (body) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
  await expect(agentIdConfigured("", new AbortController().signal, request)).rejects.toThrow("Invalid sign-in options.");
});

test("a failed readiness request does not enable sign-in", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
  await expect(agentIdConfigured("", new AbortController().signal, request)).rejects.toThrow("Sign-in options unavailable.");
});
