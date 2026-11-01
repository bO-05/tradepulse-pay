import { afterEach, expect, test, vi } from "vitest";
import { callReviewModel, describeProviderFailure, runPayAppReview } from "./reviewModel";
import { PAY_APP_REVIEW_FIXTURES } from "./reviewEvalFixtures";
import { finalizeReview, rulesEngineJudgement } from "./reviewMath";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: generateTextMock };
});
afterEach(() => generateTextMock.mockReset());

const configuration = { provider: "mistral" as const, apiKey: "unit-test-only-key", modelId: "mistral-large-4" };
test.each([
  { provider: "mistral" as const, modelId: "mistral-large-4", limit: 8192 },
  { provider: "mistral" as const, modelId: "mistral-large-4-0", limit: 8192 },
  { provider: "mistral" as const, modelId: "mistral-large-latest", limit: 4000 },
  { provider: "anthropic" as const, modelId: "claude-sonnet-5", limit: 4000 },
])("keeps a bounded $limit-token budget for $provider/$modelId", async ({ provider, modelId, limit }) => {
  generateTextMock.mockResolvedValue({
    finishReason: "stop",
    output: { lines: [], lienWaiverMissing: true, licenseIssue: true, notes: "Test only." },
  });
  await callReviewModel({ ...configuration, provider, modelId, system: "Test only", prompt: "Test only" });
  expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: limit }));
});

const limitedOutput = () => {
  const output = vi.fn(() => { throw new Error("sensitive provider content must not be read"); });
  generateTextMock.mockResolvedValue({
    finishReason: "length",
    usage: { inputTokens: 2701, outputTokens: 4000, outputTokenDetails: { reasoningTokens: 3999 } },
    get output() { return output(); },
  });
  return output;
};

test("reasoning-only truncation is detected before the SDK structured output getter", async () => {
  const output = limitedOutput();
  await expect(callReviewModel({ ...configuration, system: "Test only", prompt: "Test only" }))
    .rejects.toThrow("AI response exceeded its output token limit.");
  expect(output).not.toHaveBeenCalled();
  expect(generateTextMock).toHaveBeenCalledTimes(1);
});

test("truncation preserves deterministic review money and explicitly labels offline fallback", async () => {
  const output = limitedOutput();
  const context = PAY_APP_REVIEW_FIXTURES[3].context;
  const result = await runPayAppReview(context, configuration);
  expect(output).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    provider: "Offline rules engine", model: "none", engine: "Offline rules engine",
    fallbackReason: "AI response exceeded its output token limit.",
    inputTokens: 0, outputTokens: 0,
  });
  expect(result.review).toEqual(finalizeReview(context, rulesEngineJudgement(context)));
  expect(JSON.stringify(result)).not.toMatch(/sensitive provider content|unit-test-only-key/);
});

test.each(["AI_NoOutputGeneratedError", "NoOutputGeneratedError"])(
  "%s is an output failure, not a network failure",
  (name) => {
    expect(describeProviderFailure({ name, message: "sensitive content" }))
      .toBe("AI response did not contain structured review output.");
  },
);

test.each(["AI_NoOutputGeneratedError", "AI_NoObjectGeneratedError"])(
  "%s with a length finish reason reports the output limit",
  (name) => {
    expect(describeProviderFailure({ name, finishReason: "length", message: "sensitive content" }))
      .toBe("AI response exceeded its output token limit.");
  },
);

test("HTTP and timeout failures keep their existing safe classifications", () => {
  expect(describeProviderFailure({ name: "AI_APICallError", statusCode: 429 })).toBe("AI provider returned HTTP 429.");
  expect(describeProviderFailure({ name: "AbortError" })).toBe("AI provider timed out.");
  expect(describeProviderFailure(new Error("sensitive request details"))).toBe("AI provider did not respond.");
});
