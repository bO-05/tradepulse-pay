import { createAnthropic } from "@ai-sdk/anthropic";
import { createMistral } from "@ai-sdk/mistral";
import { withMistralTaskReasoning } from "./mistralRequest";

export type AIProvider = "anthropic" | "mistral";
export type AIConfiguration = { provider: AIProvider; apiKey?: string; modelId?: string };
export type AIEnvironment = {
  AI_PROVIDER?: string;
  MISTRAL_API_KEY?: string;
  MISTRAL_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
};

export const DEFAULT_MISTRAL_MODEL = "mistral-large-latest";

/** Explicit selection wins; otherwise prefer Mistral when configured. Never fail over between paid providers. */
export function getAIConfiguration(values: AIEnvironment = {
  AI_PROVIDER: process.env.AI_PROVIDER,
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  MISTRAL_MODEL: process.env.MISTRAL_MODEL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
}): AIConfiguration {
  const selected = values.AI_PROVIDER?.trim().toLowerCase();
  if (selected && selected !== "anthropic" && selected !== "mistral") {
    throw new Error("AI_PROVIDER must be anthropic or mistral.");
  }
  let provider: AIProvider = values.MISTRAL_API_KEY?.trim() ? "mistral" : "anthropic";
  if (selected === "anthropic" || selected === "mistral") provider = selected;
  return provider === "mistral"
    ? { provider, apiKey: values.MISTRAL_API_KEY?.trim() || undefined, modelId: values.MISTRAL_MODEL?.trim() || DEFAULT_MISTRAL_MODEL }
    : { provider, apiKey: values.ANTHROPIC_API_KEY?.trim() || undefined, modelId: values.ANTHROPIC_MODEL?.trim() || undefined };
}

export function aiProviderLabel(provider: AIProvider): string {
  return provider === "mistral" ? "Mistral" : "Anthropic";
}

export function createAIModel(config: { provider: AIProvider; apiKey: string; modelId: string }) {
  return config.provider === "mistral"
    ? createMistral({ apiKey: config.apiKey, fetch: withMistralTaskReasoning() })(config.modelId)
    : createAnthropic({ apiKey: config.apiKey })(config.modelId);
}
