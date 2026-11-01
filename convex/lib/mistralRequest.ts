/**
 * Large 4's lowest supported reasoning level is "low" (not "none").
 * The pinned AI SDK adapter omits this model family from its reasoning-control
 * allowlist, so set the native wire field at the shared request boundary.
 *
 * Only JSON-string POST bodies for explicit Large 4 model IDs are changed.
 * Unknown bodies/models pass through unchanged. No retries or network calls
 * beyond the single delegated fetch are introduced.
 */
export function withMistralTaskReasoning(implementation: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() !== "POST" || typeof init?.body !== "string") {
      return implementation(input, init);
    }
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return implementation(input, init);
    }
    if (body !== null && typeof body === "object" && !Array.isArray(body) &&
        "model" in body && typeof body.model === "string" &&
        (body.model === "mistral-large-4" || body.model.startsWith("mistral-large-4-"))) {
      return implementation(input, {
        ...init,
        body: JSON.stringify({ ...body, reasoning_effort: "low" }),
      });
    }
    return implementation(input, init);
  };
}
