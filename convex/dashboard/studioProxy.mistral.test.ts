/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";
import { studioCorsHeaders } from "./studioProxy";

const modules = import.meta.glob("/convex/**/*.ts");
const BODY = JSON.stringify({ input: [{ type: "message", role: "user", content: "Use my ledger." }], tools: [{ name: "ledger", parameters: { type: "object" } }] });
const KEY = "test-only-mistral-key";
const encoder = new TextEncoder();
const sse = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

function mistralStream(): Response {
  const chunks = [
    { id: "cmpl_test", model: "mistral-large-latest", choices: [{ index: 0, delta: { role: "assistant" } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "D681PevKs", function: { name: "ledger", arguments: "{}" } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ];
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index === chunks.length) return controller.close();
      controller.enqueue(sse(chunks[index++]));
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

const fetchSpy = vi.fn(async (..._args: unknown[]) => mistralStream());
beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async () => mistralStream());
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("MISTRAL_API_KEY", KEY);
  vi.stubEnv("MISTRAL_MODEL", "");
  vi.stubEnv("AI_PROVIDER", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Caller = { fetch: (path: string, init?: RequestInit) => Promise<Response> };
const post = (caller: Caller, body = BODY, init: RequestInit = {}) => caller.fetch("/ai/studio", {
  method: "POST", headers: { "Content-Type": "application/json" }, body, ...init,
});

describe("Mistral Studio proxy", () => {
  test("Large 4 streaming requests forward low reasoning effort without losing tools or cancellation", async () => {
    vi.stubEnv("MISTRAL_MODEL", "mistral-large-4");
    const t = convexTest(schema, modules);
    const caller = await signInAs(t, "gc");
    const response = await post(caller.as);
    expect(response.status).toBe(200);
    await response.text();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeDefined();
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "mistral-large-4", reasoning_effort: "low", stream: true,
      tools: [{ type: "function", function: { name: "ledger" } }],
    });
  });

  test.each(["gc", "owner"] as const)("%s receives AG-UI tool events and final response through funded Mistral only", async (role) => {
    const t = convexTest(schema, modules);
    const caller = await signInAs(t, role);
    const response = await post(caller.as);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    const text = await response.text();
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.kind === "event" ? line.event.type : line.kind)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "final"]);
    expect(lines.at(-1).response).toMatchObject({
      status: "completed", model: "mistral-large-latest",
      output: [{ type: "function_call", callId: "D681PevKs", name: "ledger", arguments: "{}" }],
    });
    expect(text).not.toContain(KEY);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${KEY}` });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "mistral-large-latest", stream: true, messages: [{ role: "user", content: "Use my ledger." }],
      tools: [{ type: "function", function: { name: "ledger" } }],
    });
  });

  test("signed-out, sub and missing-role callers cannot spend the provider key", async () => {
    const t = convexTest(schema, modules);
    expect((await post(t)).status).toBe(401);
    for (const role of ["sub", null] as const) {
      expect((await post((await signInAs(t, role)).as)).status).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a GC with removed company membership cannot bypass tenancy using a request company ID", async () => {
    const t = convexTest(schema, modules);
    const gc = await signInAs(t, "gc");
    await t.run(async (ctx) => {
      const membership = await ctx.db.query("companyMembers").withIndex("by_userId", (q) => q.eq("userId", gc.userId)).first();
      await ctx.db.patch(membership!._id, { status: "removed" });
    });
    expect((await post(gc.as, JSON.stringify({ input: [], companyId: "other-company" }))).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("missing or invalid selected provider configuration is honest 503, never a paid-provider failover", async () => {
    const t = convexTest(schema, modules);
    const gc = await signInAs(t, "gc");
    vi.stubEnv("AI_PROVIDER", "mistral");
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "unused-anthropic-test-key");
    expect((await post(gc.as)).status).toBe(503);
    vi.stubEnv("AI_PROVIDER", "invalid-provider");
    expect((await post(gc.as)).status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("body validation and actual UTF-8 byte limit run before provider fetch", async () => {
    const t = convexTest(schema, modules);
    const gc = await signInAs(t, "gc");
    for (const body of ["{bad-json", JSON.stringify({ input: "wrong" })]) {
      expect((await post(gc.as, body)).status).toBe(400);
    }
    // Less than two million JS characters, but more than two million UTF-8 bytes.
    const oversized = JSON.stringify({ input: [{ type: "message", role: "user", content: "€".repeat(700_000) }] });
    expect(oversized.length).toBeLessThan(2_000_000);
    expect((await post(gc.as, oversized)).status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("HTTP error bodies and network exceptions cannot leak credentials or prompts", async () => {
    const t = convexTest(schema, modules);
    const gc = await signInAs(t, "gc");
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify({
      error: { type: KEY, message: `Authorization: Bearer ${KEY}; private-prompt` },
    }), { status: 401 }));
    const response = await post(gc.as);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('{"error":"Model provider returned HTTP 401 (authentication_error)."}');
    fetchSpy.mockRejectedValueOnce(new Error(`Bearer ${KEY}`));
    const networkError = await post(gc.as);
    expect(networkError.status).toBe(502);
    expect(await networkError.text()).not.toContain(KEY);
  });

  test("SSE provider error messages are redacted in the failed final response", async () => {
    const t = convexTest(schema, modules);
    const gc = await signInAs(t, "gc");
    fetchSpy.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ error: { code: KEY, message: KEY } }));
        controller.close();
      },
    })));
    const response = await post(gc.as);
    const text = await response.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text.trim())).toMatchObject({ kind: "final", response: { status: "failed", error: { code: "model_stream_error" } } });
  });

  test("explicit Anthropic remains backward-compatible and its streamed errors are also redacted", async () => {
    vi.stubEnv("AI_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only-anthropic-key");
    const t = convexTest(schema, modules);
    const gc = await signInAs(t, "gc");
    fetchSpy.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ type: "error", error: { type: KEY, message: "test-only-anthropic-key" } }));
        controller.close();
      },
    })));
    const response = await post(gc.as);
    const text = await response.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("test-only-anthropic-key");
    expect(JSON.parse(text.trim())).toMatchObject({ response: { status: "failed", error: { code: "model_stream_error" } } });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-only-anthropic-key");
  });

  test("downstream cancellation cancels the upstream reader and aborts its fetch", async () => {
    const t = convexTest(schema, modules);
    const gc = await signInAs(t, "gc");
    const cancel = vi.fn();
    fetchSpy.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ id: "cmpl_cancel", choices: [{ index: 0, delta: { content: "Hello" } }] }));
      },
      cancel,
    })));
    const response = await post(gc.as);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("CORS allows configured app origin only, including preflight", async () => {
    vi.stubEnv("SITE_URL", "https://app.example.test");
    expect(studioCorsHeaders(new Request("https://backend.example.test/ai/studio", { headers: { Origin: "https://evil.example.test" } }))).toEqual({});
    const t = convexTest(schema, modules);
    const response = await t.fetch("/ai/studio", { method: "OPTIONS", headers: { Origin: "https://app.example.test" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.test");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, Content-Type");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
