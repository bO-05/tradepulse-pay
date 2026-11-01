/** Review and pay-agent providers that actually use a model, not offline rules. */
export function isAIReviewProvider(provider: string): boolean {
  return provider === "Anthropic" || provider === "Mistral";
}
