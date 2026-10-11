import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import {
  AnthropicStreamTranslator,
  DEFAULT_STUDIO_MODEL,
  SseParser,
  StudioRequestError,
  toAnthropicRequest,
  type StudioStreamLine,
} from "./studioAnthropic";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MAX_BODY_BYTES = 2_000_000;
const DEV_ORIGINS = ["http://localhost:3150"];

function allowedOrigins(): string[] {
  return [process.env.SITE_URL, process.env.CONVEX_SITE_URL, ...DEV_ORIGINS].filter(
    (o): o is string => typeof o === "string" && o !== "",
  );
}

export function studioCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin || !allowedOrigins().includes(origin)) return {};
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

export const studioPreflight = httpAction(async (_ctx, req) => {
  return new Response(null, { status: 204, headers: studioCorsHeaders(req) });
});

/**
 * LLM proxy for AG Studio's chat agents. Studio's adapter in the browser POSTs one AgLlmRequest per
 * turn with the Convex Auth token; this streams the Anthropic answer back as NDJSON AG-UI events
 * plus a final consolidated response. The Anthropic key stays in the Convex environment. It reads
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return jsonResponse(req, 503, { error: "The Studio AI model is not configured." });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jsonResponse(req, 413, { error: "Request too large." });
  let anthropicBody;
  try {
    anthropicBody = toAnthropicRequest(JSON.parse(raw), process.env.ANTHROPIC_MODEL || DEFAULT_STUDIO_MODEL);
  } catch (err) {
    const message = err instanceof StudioRequestError ? err.message : "Request body is not valid JSON.";
    return jsonResponse(req, 400, { error: message });
  }

  let upstream: Response;
  try {
    upstream = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicBody),
    });
  } catch {
    return jsonResponse(req, 502, { error: "Could not reach the model provider." });
  }
  if (!upstream.ok || upstream.body === null) {
    let detail = `Model provider returned HTTP ${upstream.status}.`;
    try {
      const parsed = (await upstream.json()) as { error?: { type?: string; message?: string } };
      if (parsed.error?.message) detail = `${detail} ${parsed.error.type ?? "error"}: ${parsed.error.message}`;
    } catch {
      // Keep the status-only message.
    }
    console.warn(`/ai/studio upstream error ${upstream.status}`);
    return jsonResponse(req, 502, { error: detail });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parser = new SseParser();
  const translator = new AnthropicStreamTranslator();
  const encode = (lines: StudioStreamLine[]) => encoder.encode(lines.map((l) => JSON.stringify(l) + "\n").join(""));

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // A pull that enqueues nothing is not called again, so keep reading until there is output
        // (message_start and ping chunks translate to no lines).
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(encode(translator.finish()));
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
        controller.enqueue(encode(translator.finish({ code: "stream_error", message: "The model stream was interrupted." })));
        controller.close();
      }
    },
    async cancel() {
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
