import type { AgAiEvent, AgLlmAdapter, AgLlmExecuteTurnOptions, AgLlmRequest, AgLlmResponse } from "ag-studio";

/** Convex HTTP actions are served from the deployment's `.convex.site` origin. */
export function studioProxyUrl(env: { VITE_CONVEX_SITE_URL?: string; VITE_CONVEX_URL?: string }): string {
  const site = env.VITE_CONVEX_SITE_URL || (env.VITE_CONVEX_URL ?? "").replace(/\.convex\.cloud\/?$/, ".convex.site");
  return `${site.replace(/\/$/, "")}/ai/studio`;
}

type StreamLine = { kind: "event"; event: AgAiEvent } | { kind: "final"; response: AgLlmResponse };

function failed(code: string, message: string): AgLlmResponse {
  return { id: `err_${Date.now().toString(36)}`, createdAt: Date.now(), status: "failed", output: [], error: { code, message } };
}

/** Minimal single-consumer async queue so the HTTP body is drained even if nobody iterates. */
function eventQueue() {
  const items: AgAiEvent[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  return {
    push(e: AgAiEvent) {
      items.push(e);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    async *iterate(): AsyncGenerator<AgAiEvent> {
      for (;;) {
        if (items.length > 0) {
          yield items.shift()!;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

/**
 * AgLlmAdapter that runs every Studio turn through the Convex `/ai/studio` proxy, authenticated with
 * the signed-in user's Convex Auth token. The browser never talks to the model provider.
 */
export function createConvexStudioAdapter(opts: {
  url: string;
  getToken: () => string | null | undefined;
  fetchImpl?: typeof fetch;
}): AgLlmAdapter {
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return {
    executeTurn(request: AgLlmRequest, options?: AgLlmExecuteTurnOptions) {
      const queue = eventQueue();
      const complete = (async (): Promise<AgLlmResponse> => {
        try {
          const token = opts.getToken();
          if (!token) return failed("unauthenticated", "Sign in again to use the AI assistant.");
          const res = await doFetch(opts.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(request),
            signal: options?.signal,
          });
          if (!res.ok || !res.body) {
            let message = `AI proxy returned HTTP ${res.status}.`;
            try {
              const body = (await res.json()) as { error?: string };
              if (body.error) message = body.error;
            } catch {
              // Keep the status-only message.
            }
            return failed(`http_${res.status}`, message);
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let final: AgLlmResponse | null = null;
          const handleLine = (line: string) => {
            if (!line.trim()) return;
            const parsed = JSON.parse(line) as StreamLine;
            if (parsed.kind === "event") queue.push(parsed.event);
            else if (parsed.kind === "final") final = parsed.response;
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf("\n");
            while (nl !== -1) {
              handleLine(buffer.slice(0, nl));
              buffer = buffer.slice(nl + 1);
              nl = buffer.indexOf("\n");
            }
          }
          handleLine(buffer + decoder.decode());
          return final ?? failed("stream_incomplete", "The AI response ended before it finished.");
        } catch (err) {
          if (options?.signal?.aborted) {
            return { id: `cancel_${Date.now().toString(36)}`, createdAt: Date.now(), status: "cancelled", output: [] };
          }
          return failed("network_error", err instanceof Error ? err.message : "The AI proxy request failed.");
        } finally {
          queue.end();
        }
      })();
      return { stream: queue.iterate(), complete };
    },
  };
}
