import { afterEach, describe, expect, test, vi } from "vitest";
import { generateText } from "ai";
import { aiProviderLabel, createAIModel, DEFAULT_MISTRAL_MODEL, getAIConfiguration, readAIConfigurationSafe } from "./aiProvider";

afterEach(() => vi.unstubAllGlobals());

describe("AI provider configuration", () => {
  test("preserves existing Anthropic configuration", () => {
    expect(getAIConfiguration({ ANTHROPIC_API_KEY: "dummy-anthropic", ANTHROPIC_MODEL: "configured-model" }))
      .toEqual({ provider: "anthropic", apiKey: "dummy-anthropic", modelId: "configured-model" });
  });

  test("prefers configured Mistral over a depleted Anthropic account", () => {
    expect(getAIConfiguration({ MISTRAL_API_KEY: "dummy-mistral", ANTHROPIC_API_KEY: "dummy-anthropic" }))
      .toEqual({ provider: "mistral", apiKey: "dummy-mistral", modelId: DEFAULT_MISTRAL_MODEL });
  });

  test("explicit provider does not silently use another provider's key", () => {
    expect(getAIConfiguration({ AI_PROVIDER: "mistral", ANTHROPIC_API_KEY: "dummy-anthropic" }).apiKey).toBeUndefined();
    expect(getAIConfiguration({ AI_PROVIDER: "anthropic", MISTRAL_API_KEY: "dummy-mistral" }).apiKey).toBeUndefined();
  });

  test("accepts a configured Mistral model and strips accidental whitespace", () => {
    expect(getAIConfiguration({ AI_PROVIDER: " MISTRAL ", MISTRAL_API_KEY: " dummy-mistral ", MISTRAL_MODEL: " configured-model " }))
      .toEqual({ provider: "mistral", apiKey: "dummy-mistral", modelId: "configured-model" });
  });

  test("refuses unknown providers without echoing the configured value", () => {
    expect(() => getAIConfiguration({ AI_PROVIDER: "unexpected-sensitive-value" }))
      .toThrow("AI_PROVIDER must be anthropic or mistral.");
  });

  test("the safe read degrades an invalid provider to null so callers can fall back", () => {
    expect(readAIConfigurationSafe({ AI_PROVIDER: "unexpected-sensitive-value" })).toBeNull();
    expect(readAIConfigurationSafe({ MISTRAL_API_KEY: "dummy-mistral" })).toMatchObject({ provider: "mistral" });
  });

  test("model adapters retain honest provider identity without any API request", () => {
    const mistral = createAIModel({ provider: "mistral", apiKey: "dummy", modelId: DEFAULT_MISTRAL_MODEL });
    const anthropic = createAIModel({ provider: "anthropic", apiKey: "dummy", modelId: "configured-model" });
    expect(mistral.provider).toMatch(/^mistral/);
    expect(anthropic.provider).toMatch(/^anthropic/);
    expect(aiProviderLabel("mistral")).toBe("Mistral");
    expect(aiProviderLabel("anthropic")).toBe("Anthropic");
  });

  test.each([
    { provider: "mistral" as const, modelId: "mistral-large-4", reasoning: "low" },
    { provider: "mistral" as const, modelId: "mistral-large-latest", reasoning: undefined },
    { provider: "anthropic" as const, modelId: "claude-sonnet-5-5", reasoning: undefined },
  ])("actual $provider SDK sends correct wire reasoning for $modelId", async ({ provider, modelId, reasoning }) => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toContain(provider === "mistral" ? "api.mistral.ai" : "api.anthropic.com");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(modelId);
      expect(body.reasoning_effort).toBe(reasoning);
      if (reasoning === undefined) expect(body).not.toHaveProperty("reasoning_effort");
      return new Response(JSON.stringify(provider === "mistral" ? {
        id: "offline-response", object: "chat.completion", created: 0, model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      } : {
        id: "offline-response", type: "message", role: "assistant", model: modelId,
        content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateText({
      model: createAIModel({ provider, modelId, apiKey: "offline-unit-test-key" }),
      prompt: "Offline test", maxOutputTokens: 4000, maxRetries: 0,
    });
    expect(result.text).toBe("OK");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
