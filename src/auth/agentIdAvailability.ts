/** Key presence enables the sign-in attempt; it does not certify the registered callback. */
export async function agentIdConfigured(site: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<boolean> {
  const response = await request(`${site.replace(/\/$/, "")}/api/sign-in-options`, {
    credentials: "omit", cache: "no-store", redirect: "error", signal,
  });
  if (!response.ok) throw new Error("Sign-in options unavailable.");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("agentIdConfigured" in body) || typeof body.agentIdConfigured !== "boolean") {
    throw new Error("Invalid sign-in options.");
  }
  return body.agentIdConfigured;
}
