import { afterEach, expect, test, vi } from "vitest";
import { callReviewModel } from "./reviewModel";

afterEach(() => vi.unstubAllGlobals());

test("the real SDK's reasoning-only length response reports truncation without reading output", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    id: "offline-response",
    object: "chat.completion",
    created: 0,
    model: "mistral-large-4",
    choices: [{
      index: 0,
      message: { role: "assistant", content: [{ type: "thinking", thinking: [{ type: "text", text: "Offline test reasoning." }] }] },
      finish_reason: "length",
    }],
    usage: { prompt_tokens: 2701, completion_tokens: 4000, total_tokens: 6701, completion_tokens_details: { reasoning_tokens: 3999 } },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(callReviewModel({
    provider: "mistral", apiKey: "offline-unit-test-key", modelId: "mistral-large-4",
    system: "Test review only", prompt: "Test review only",
  })).rejects.toThrow("AI response exceeded its output token limit.");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
