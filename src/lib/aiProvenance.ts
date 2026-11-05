/** Review and pay-agent providers that actually use a model, not offline rules. */
export function isAIReviewProvider(provider: string): boolean {
  return provider === "Anthropic" || provider === "Mistral";
}

/**
 * A readable name for the review's provenance: "Mistral Large" instead of "Mistral ·
 * mistral-large-4", and "Offline rules engine" when no model ran. The model only explains; the
 * amounts are computed by code (see the caller's copy).
 */
export function reviewAttribution(review: { provider: string; model: string }): string {
  if (!isAIReviewProvider(review.provider)) return "Offline rules engine";
  const model = review.model === "none" ? "" : review.model;
  if (review.provider === "Mistral" && model.startsWith("mistral-")) {
    const name = model
      .slice("mistral-".length)
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    return `Mistral ${name}`;
  }
  return [review.provider, model].filter(Boolean).join(" ");
}
