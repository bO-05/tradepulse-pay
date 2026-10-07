/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { signInAs } from "../lib/testIdentity";

const modules = import.meta.glob("/convex/**/*.ts");

const STUDIO_BODY = JSON.stringify({
  input: [{ type: "message", kind: "input", role: "user", content: [{ type: "text", text: "Hi" }], status: "completed" }],
  tools: [],
  responseFormat: { type: "text" },
});

function anthropicStream(): Response {
  const events = [
    { type: "message_start", message: { id: "msg_t", model: "claude-sonnet-5-5", usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: "ping" },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  // One SSE event per network chunk, as Anthropic delivers them; chunks that translate to no
  // output (message_start, ping) must not stall the proxied stream.
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= events.length) return controller.close();
      controller.enqueue(encoder.encode(`event: e\ndata: ${JSON.stringify(events[i++])}\n\n`));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const fetchSpy = vi.fn(async (..._args: unknown[]) => anthropicStream());

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
  vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function post(caller: { fetch: (path: string, init?: RequestInit) => Promise<Response> }, body = STUDIO_BODY) {
  return caller.fetch("/ai/studio", { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

describe("/ai/studio proxy", () => {
  test("signed-out callers get 401 and no provider call", async () => {
    const t = convexTest(schema, modules);
    const res = await post(t);
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("subs and no-role users get 403 and no provider call", async () => {
    const t = convexTest(schema, modules);
    const sub = await signInAs(t, "sub");
    const noRole = await signInAs(t, null);
    for (const caller of [sub.as, noRole.as]) {
      const res = await post(caller);
      expect(res.status).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("GC turn is proxied to Anthropic with the server key and streamed back as NDJSON", async () => {
    const t = convexTest(schema, modules);
    const gc = await signInAs(t, "gc");
    const res = await post(gc.as);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => (l.kind === "event" ? l.event.type : l.kind))).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "final",
    ]);
    expect(lines[3].response.status).toBe("completed");
    expect(JSON.stringify(lines)).not.toContain("test-anthropic-key");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-anthropic-key");
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user" }] });
  });

  test("owner may chat; malformed bodies are 400; provider errors are 502 without the key", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAs(t, "owner");
    expect((await post(owner.as)).status).toBe(200);
    expect((await post(owner.as, "{not json")).status).toBe(400);
    fetchSpy.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { type: "not_found_error", message: "model: nope" } }), { status: 404 }),
    );
    const res = await post(owner.as);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("not_found_error");
    expect(text).not.toContain("test-anthropic-key");
  });
});
