import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { DEFAULT_MISTRAL_MODEL, getAIConfiguration } from "../lib/aiProvider";
import { browserOrigins } from "../lib/browserOrigins";
import { withMistralTaskReasoning } from "../lib/mistralRequest";
import {
  AnthropicStreamTranslator,
  DEFAULT_STUDIO_MODEL,
  SseParser,
  StudioRequestError,
  toAnthropicRequest,
  type StudioStreamLine,
} from "./studioAnthropic";
import { MistralStreamTranslator, toMistralRequest } from "./studioMistral";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MISTRAL_COMPLETIONS_URL = "https://api.mistral.ai/v1/chat/completions";
const MAX_BODY_BYTES = 2_000_000;

export function studioCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin || !browserOrigins().includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function jsonResponse(req: Request, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...studioCorsHeaders(req) },
  });
}

/** Bound actual UTF-8 bytes while reading, not UTF-16 characters after an unbounded req.text(). */
async function readBody(req: Request): Promise<string | null> {
  const declared = req.headers.get("Content-Length");
  if (declared && Number(declared) > MAX_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export const studioPreflight = httpAction(async (_ctx, req) => {
  return new Response(null, { status: 204, headers: studioCorsHeaders(req) });
});

/**
 * LLM proxy for AG Studio's chat agents. Studio's adapter in the browser POSTs one AgLlmRequest per
 * turn with the Convex Auth token; this streams the selected provider's answer as NDJSON AG-UI events
 * plus a final consolidated response. Provider keys stay in the Convex environment. It reads
 * no app data: the only project data in a turn is what Studio's tools fetched through the
 * company-scoped dashboard queries for this caller.
 */
export const studioProxy = httpAction(async (ctx, req) => {
  // A malformed or expired token makes getUserIdentity throw; treat it like no token.
  const identity = await ctx.auth.getUserIdentity().catch(() => null);
  if (identity === null) {
    return jsonResponse(req, 401, { error: "Not authenticated: sign in required." });
  }
  try {
    await ctx.runQuery(internal.dashboard.studioAccess.authorizeStudioCaller, {});
  } catch (err) {
    const message =
      err instanceof ConvexError && typeof (err.data as { message?: unknown })?.message === "string"
        ? (err.data as { message: string }).message
        : "Forbidden: role gc or owner required.";
    return jsonResponse(req, 403, { error: message });
  }

  let config;
  try {
    config = getAIConfiguration();
  } catch {
    return jsonResponse(req, 503, { error: "The Studio AI provider is not configured correctly." });
  }
  const { apiKey } = config;
  if (!apiKey) return jsonResponse(req, 503, { error: "The Studio AI model is not configured." });

  let raw: string | null;
  try {
    raw = await readBody(req);
  } catch {
    return jsonResponse(req, 400, { error: "Could not read the request body." });
  }
  if (raw === null) return jsonResponse(req, 413, { error: "Request too large." });
  let providerBody;
  try {
    const parsed: unknown = JSON.parse(raw);
    providerBody = config.provider === "mistral"
      ? toMistralRequest(parsed, config.modelId || DEFAULT_MISTRAL_MODEL)
      : toAnthropicRequest(parsed, config.modelId || DEFAULT_STUDIO_MODEL);
  } catch (err) {
    const message = err instanceof StudioRequestError ? err.message : "Request body is not valid JSON.";
    return jsonResponse(req, 400, { error: message });
  }

  const abort = new AbortController();
  const onAbort = () => abort.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });
  if (req.signal.aborted) abort.abort();
  const cleanup = () => req.signal.removeEventListener("abort", onAbort);
  let upstream: Response;
  try {
    const upstreamFetch = config.provider === "mistral" ? withMistralTaskReasoning() : fetch;
    upstream = await upstreamFetch(config.provider === "mistral" ? MISTRAL_COMPLETIONS_URL : ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: config.provider === "mistral" ? {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      } : {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(providerBody),
      signal: abort.signal,
    });
  } catch {
    cleanup();
    return jsonResponse(req, 502, { error: "Could not reach the model provider." });
  }
  if (!upstream.ok || upstream.body === null) {
    cleanup();
    await upstream.body?.cancel().catch(() => undefined);
    // Provider error bodies may echo credentials/prompts. Use only trusted status labels.
    const code = ({ 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 429: "rate_limit_error" } as Record<number, string>)[upstream.status];
    const detail = `Model provider returned HTTP ${upstream.status}${code ? ` (${code})` : ""}.`;
    console.warn(`/ai/studio upstream error ${upstream.status}`);
    return jsonResponse(req, 502, { error: detail });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parser = new SseParser();
  const translator = config.provider === "mistral" ? new MistralStreamTranslator() : new AnthropicStreamTranslator();
  const encode = (lines: StudioStreamLine[]) => encoder.encode(lines.map((line) => {
    // The legacy Anthropic translator exposes upstream error payloads; redact at the HTTP boundary.
    if (line.kind === "final" && line.response.error) {
      line = { kind: "final", response: { ...line.response, error: { code: "model_stream_error", message: "The model response was interrupted or could not be completed." } } };
    }
    return JSON.stringify(line) + "\n";
  }).join(""));

  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // A pull that enqueues nothing is not called again, so keep reading until there is output
        // (message_start and ping chunks translate to no lines).
        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) {
            const tail = parser.push(decoder.decode() + "\n\n").flatMap((evt) => translator.handle(evt));
            controller.enqueue(encode([...tail, ...translator.finish()]));
            cleanup();
            controller.close();
            return;
          }
          const lines = parser.push(decoder.decode(value, { stream: true })).flatMap((evt) => translator.handle(evt));
          if (lines.length > 0) {
            controller.enqueue(encode(lines));
            return;
          }
        }
      } catch {
        cleanup();
        abort.abort();
        await reader.cancel().catch(() => undefined);
        if (cancelled) return;
        controller.enqueue(encode(translator.finish({ code: "stream_error", message: "The model stream was interrupted." })));
        controller.close();
      }
    },
    async cancel() {
      cancelled = true;
      cleanup();
      abort.abort();
      await reader.cancel();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      ...studioCorsHeaders(req),
    },
  });
});
