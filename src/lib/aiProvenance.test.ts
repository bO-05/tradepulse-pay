import { expect, test } from "vitest";
import { isAIReviewProvider } from "./aiProvenance";

test.each([
  ["Anthropic", true],
  ["Mistral", true],
  ["Offline rules engine", false],
  ["unknown", false],
] as const)("classifies review provenance %s honestly", (provider, expected) => {
  expect(isAIReviewProvider(provider)).toBe(expected);
});
