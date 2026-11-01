import { expect, test, vi } from "vitest";
import { withMistralTaskReasoning } from "./mistralRequest";

test.each(["mistral-large-4", "mistral-large-4-0", "mistral-large-4-2610"])(
  "%s gets native low reasoning while preserving the request",
  async (model) => {
    const response = new Response("OK");
    const implementation = vi.fn<typeof fetch>().mockResolvedValue(response);
    const url = new URL("https://api.mistral.ai/v1/chat/completions");
    const controller = new AbortController();
    const headers = new Headers({ authorization: "Bearer offline-test-only", "content-type": "application/json" });
    const body = {
      model, messages: [{ role: "user", content: "Offline test" }], max_tokens: 4000,
      response_format: { type: "json_schema", json_schema: { name: "test", schema: { type: "object" } } },
      tools: [{ type: "function", function: { name: "readLedger", parameters: { type: "object" } } }],
      stream: true, temperature: 0.2, reasoning_effort: "high",
    };
    const init: RequestInit = { method: "POST", headers, signal: controller.signal, body: JSON.stringify(body), credentials: "omit" };
    expect(await withMistralTaskReasoning(implementation)(url, init)).toBe(response);
    expect(implementation).toHaveBeenCalledTimes(1);
    const [sentUrl, sent] = implementation.mock.calls[0];
    expect(sentUrl).toBe(url);
    expect(sent?.headers).toBe(headers);
    expect(sent?.signal).toBe(controller.signal);
    expect(sent?.credentials).toBe("omit");
    expect(JSON.parse(String(sent?.body))).toEqual({ ...body, reasoning_effort: "low" });
    expect(JSON.parse(String(init.body))).toEqual(body);
  },
);

test.each([
  "mistral-large-latest", "mistral-medium-latest", "mistral-large-3",
  "mistral-large-40", "claude-sonnet-5-5", "gpt-4o",
])("%s requests pass through without rewriting", async (model) => {
  const implementation = vi.fn<typeof fetch>().mockResolvedValue(new Response("OK"));
  const url = "https://api.mistral.ai/v1/chat/completions";
  const init: RequestInit = { method: "POST", body: JSON.stringify({ model, reasoning_effort: "high" }) };
  await withMistralTaskReasoning(implementation)(url, init);
  expect(implementation).toHaveBeenCalledExactlyOnceWith(url, init);
  expect(implementation.mock.calls[0][1]).toBe(init);
});

test.each(["not JSON", "[]", "null", '{"model":123}', '{"other":"value"}'])(
  "unknown body %s passes through unchanged",
  async (body) => {
    const implementation = vi.fn<typeof fetch>().mockResolvedValue(new Response("OK"));
    const init: RequestInit = { method: "POST", body };
    await withMistralTaskReasoning(implementation)("https://api.mistral.ai/v1/chat/completions", init);
    expect(implementation.mock.calls[0][1]).toBe(init);
  },
);

test("GETs and unrecognized body types are delegated without interpretation", async () => {
  const implementation = vi.fn<typeof fetch>().mockResolvedValue(new Response("OK"));
  const wrapped = withMistralTaskReasoning(implementation);
  const url = "https://api.mistral.ai/v1/models";
  await wrapped(url);
  expect(implementation).toHaveBeenLastCalledWith(url, undefined);
  const body = new URLSearchParams({ model: "mistral-large-4" });
  const init: RequestInit = { method: "POST", body };
  await wrapped(url, init);
  expect(implementation.mock.calls[1][1]).toBe(init);
});

test("cancellation reaches the delegated implementation unchanged", async () => {
  const controller = new AbortController();
  controller.abort();
  const implementation = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    expect(init?.signal).toBe(controller.signal);
    init?.signal?.throwIfAborted();
    return new Response("unreachable");
  });
  await expect(withMistralTaskReasoning(implementation)("https://api.mistral.ai/v1/chat/completions", {
    method: "POST", body: '{"model":"mistral-large-4"}', signal: controller.signal,
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(implementation).toHaveBeenCalledTimes(1);
});
