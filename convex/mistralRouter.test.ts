/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { OFFLINE_RULES_ENGINE } from "./lib/aiLabels";
import { buildTenancyFixture } from "./lib/tenancyFixtures";

const modules = import.meta.glob("./**/*.ts");
const endpoint = "https://api.mistral.ai/v1/chat/completions";
const args = { taskType: "bid_leveling" as const, prompt: "Electrical bid: $100,000. No exclusions.", division: "26 00 00" };
const bid = {
  subcontractorName: "Test Electric", baseBidAmount: 100000, lineItems: [],
  identifiedExclusions: [], valueEngineeringAlternates: [], longLeadEquipmentWeeks: 0,
  coiComplianceStatus: "compliant", coiPenalty: 0, leveledTotalCost: 100000,
};

function configureMistral() {
  vi.stubEnv("AI_PROVIDER", "mistral");
  vi.stubEnv("MISTRAL_API_KEY", "unit-test-mistral");
  // These competing keys prove that failures and missing keys never use another paid provider.
  vi.stubEnv("ANTHROPIC_API_KEY", "unit-test-anthropic");
  vi.stubEnv("OPENAI_API_KEY", "unit-test-openai");
  vi.stubEnv("GEMINI_API_KEY", "unit-test-google");
}

function mockCompletion(content: unknown, finishReason = "stop") {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
    id: "test-completion", object: "chat.completion", model: "mistral-large-latest",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 50, completion_tokens: 80, total_tokens: 130 },
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Mistral procurement reasoning", () => {
  test("Large 4 receives low reasoning effort and only final text chunks become the bid output", async () => {
    configureMistral();
    vi.stubEnv("MISTRAL_MODEL", "mistral-large-4");
    const json = JSON.stringify(bid);
    const fetchMock = mockCompletion([
      { type: "thinking", thinking: [{ type: "text", text: "private-reasoning" }] },
      { type: "text", text: json.slice(0, 30) },
      { type: "text", text: json.slice(30) },
    ]);
    const t = convexTest(schema, modules);
    const result = await t.action(internal.llmRouter.executeReasoning, args);
    expect(result).toMatchObject({ provider: "Mistral", model: "mistral-large-4", parsedJson: { baseBidAmount: 100000 } });
    expect(JSON.stringify(result)).not.toContain("private-reasoning");
    const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({ model: "mistral-large-4", reasoning_effort: "low", max_tokens: 8192 });
    expect(JSON.parse(String(request.body))).not.toHaveProperty("temperature");
  });

  test.each([
    { content: [{ type: "thinking", thinking: [{ type: "text", text: JSON.stringify(bid) }] }], finish: "stop" },
    { content: JSON.stringify(bid), finish: "length" },
  ])("reasoning-only and truncated completions are not live successes", async ({ content, finish }) => {
    configureMistral();
    mockCompletion(content, finish);
    const t = convexTest(schema, modules);
    expect(await t.action(internal.llmRouter.executeReasoning, args)).toMatchObject({ provider: OFFLINE_RULES_ENGINE });
  });

  test("Mistral failures cannot log the provider's echoed key or private prompt", async () => {
    configureMistral();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      message: "unit-test-mistral private-prompt",
    }), { status: 401 })));
    const t = convexTest(schema, modules);
    expect(await t.action(internal.llmRouter.executeReasoning, args)).toMatchObject({ provider: OFFLINE_RULES_ENGINE });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/unit-test-mistral|private-prompt/);
  });

  test("configured primary uses the public endpoint, custom model and JSON bid output with honest provenance", async () => {
    configureMistral();
    vi.stubEnv("MISTRAL_MODEL", "mistral-large-custom");
    const fetchMock = mockCompletion(JSON.stringify(bid));
    const t = convexTest(schema, modules);
    const result = await t.action(internal.llmRouter.executeReasoning, args);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer unit-test-mistral");
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: "mistral-large-custom", response_format: { type: "json_object" },
      temperature: 0, random_seed: 12345,
      messages: [{ role: "system", content: expect.any(String) }, { role: "user", content: args.prompt }],
    });
    expect(JSON.parse(String(request.body))).not.toHaveProperty("seed");
    expect(result).toMatchObject({ provider: "Mistral", model: "mistral-large-custom", parsedJson: { baseBidAmount: 100000 } });
  });

  test("a Mistral key automatically selects Mistral and defaults to the current model alias", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "unit-test-mistral");
    vi.stubEnv("ANTHROPIC_API_KEY", "unit-test-anthropic");
    const fetchMock = mockCompletion(JSON.stringify(bid));
    const t = convexTest(schema, modules);
    expect(await t.action(internal.llmRouter.executeReasoning, args)).toMatchObject({
      provider: "Mistral", model: "mistral-large-latest",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(endpoint);
  });

  test("an explicitly selected Mistral adapter does not require a global primary setting", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "unit-test-mistral");
    vi.stubEnv("AI_PROVIDER", "anthropic");
    const fetchMock = mockCompletion(JSON.stringify(bid));
    const t = convexTest(schema, modules);
    expect(await t.action(internal.llmRouter.executeReasoning, { ...args, preferredProvider: "mistral" }))
      .toMatchObject({ provider: "Mistral" });
    expect(fetchMock.mock.calls[0][0]).toBe(endpoint);
  });

  test("a missing selected Mistral key uses only the labeled rules engine, never funded or exhausted competitors", async () => {
    configureMistral();
    vi.stubEnv("MISTRAL_API_KEY", "");
    const fetchMock = mockCompletion(JSON.stringify(bid));
    const t = convexTest(schema, modules);
    expect(await t.action(internal.llmRouter.executeReasoning, args)).toMatchObject({ provider: OFFLINE_RULES_ENGINE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([401, 429, 500])("HTTP %i is not a successful model completion and never crosses providers", async (status) => {
    configureMistral();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ message: "Provider unavailable" }), { status }));
    vi.stubGlobal("fetch", fetchMock);
    const t = convexTest(schema, modules);
    expect(await t.action(internal.llmRouter.executeReasoning, args)).toMatchObject({ provider: OFFLINE_RULES_ENGINE });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(endpoint);
  });

  test.each(["", "not JSON", "[]", "{}", '{"error":"No completion"}'])("an empty or malformed structured completion (%j) is not labeled Mistral success", async (content) => {
    configureMistral();
    const fetchMock = mockCompletion(content);
    const t = convexTest(schema, modules);
    expect(await t.action(internal.llmRouter.executeReasoning, args)).toMatchObject({ provider: OFFLINE_RULES_ENGINE });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    { taskType: "spec_generation" as const, output: { packages: [] } },
    { taskType: "clash_detection" as const, output: { doubleBuys: [], scopeVoids: [] } },
  ])("$taskType requests JSON and preserves the existing task sanitizer", async ({ taskType, output }) => {
    configureMistral();
    const fetchMock = mockCompletion(JSON.stringify(output));
    const t = convexTest(schema, modules);
    expect(await t.action(internal.llmRouter.executeReasoning, { taskType, prompt: "Review the provided scope." }))
      .toMatchObject({ provider: "Mistral", parsedJson: output });
    const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({ response_format: { type: "json_object" } });
  });

  test("a network failure never crosses paid providers", async () => {
    configureMistral();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => { throw new Error("Network unavailable"); });
    vi.stubGlobal("fetch", fetchMock);
    const t = convexTest(schema, modules);
    expect(await t.action(internal.llmRouter.executeReasoning, args)).toMatchObject({ provider: OFFLINE_RULES_ENGINE });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("RFI text does not require a JSON response", async () => {
    configureMistral();
    const fetchMock = mockCompletion("Please refer to the approved specification.");
    const t = convexTest(schema, modules);
    expect(await t.action(internal.llmRouter.executeReasoning, { taskType: "rfi_reply", prompt: "Clarify hoisting." }))
      .toMatchObject({ provider: "Mistral", content: "Please refer to the approved specification." });
    const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).not.toHaveProperty("response_format");
  });
});

describe("Mistral model diagnostics", () => {
  test("availability includes the configured provider and model without disclosing credentials", async () => {
    configureMistral();
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    const result = await f.demo.gc.as.query(api.llmRouter.getProviderAvailability, {});
    expect(result).toMatchObject({ mistral: true, mistralModel: "mistral-large-latest", primaryProvider: "mistral" });
    expect(JSON.stringify(result)).not.toContain("unit-test-");
  });

  test("a missing diagnostic key is unavailable and makes no provider call", async () => {
    configureMistral();
    vi.stubEnv("MISTRAL_API_KEY", "");
    const fetchMock = mockCompletion(JSON.stringify(bid));
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    expect(await f.demo.gc.as.action(api.llmRouter.runModelDiagnostic, { model: "mistral", promptType: "spec_div26" }))
      .toMatchObject({ provider: "Unavailable", requestedProvider: "mistral", isLive: false, unavailable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a successful diagnostic credits Mistral, not Anthropic", async () => {
    configureMistral();
    mockCompletion(JSON.stringify(bid));
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    expect(await f.demo.gc.as.action(api.llmRouter.runModelDiagnostic, { model: "mistral", promptType: "spec_div26" }))
      .toMatchObject({ provider: "Mistral", requestedProvider: "mistral", isLive: true, usedFallback: false });
  });

  test("a failed diagnostic reports offline provenance and zero model throughput, not live success", async () => {
    configureMistral();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("Provider unavailable", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    expect(await f.demo.gc.as.action(api.llmRouter.runModelDiagnostic, { model: "mistral", promptType: "spec_div26" }))
      .toMatchObject({
        provider: OFFLINE_RULES_ENGINE, requestedProvider: "mistral", isLive: false,
        usedFallback: true, throughputTokSec: 0, inputTokens: 0, outputTokens: 0,
      });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(endpoint);
  });

  test("an explicitly selected legacy diagnostic does not fall over to Mistral or another provider", async () => {
    configureMistral();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("Provider unavailable", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const t = convexTest(schema, modules);
    const f = await buildTenancyFixture(t);
    expect(await f.demo.gc.as.action(api.llmRouter.runModelDiagnostic, { model: "claude", promptType: "spec_div26" }))
      .toMatchObject({ provider: OFFLINE_RULES_ENGINE, isLive: false, usedFallback: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
  });
});
