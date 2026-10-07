import { describe, expect, test, vi } from "vitest";
import type { AgAiEvent, AgLlmRequest } from "ag-studio";
import { createConvexStudioAdapter, studioProxyUrl } from "./studioAdapter";
import { describePaySummary, type PaySummary } from "./payAgentTools";

const REQUEST: AgLlmRequest = { input: [], responseFormat: { type: "text" } };

function ndjsonResponse(lines: unknown[], chunkSize = 11): Response {
  const text = lines.map((l) => JSON.stringify(l) + "\n").join("");
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= text.length) return controller.close();
      controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
      i += chunkSize;
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

async function drain(stream: AsyncIterable<AgAiEvent>) {
  const out: AgAiEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("studioProxyUrl", () => {
  test("uses the site URL, or derives it from the cloud URL", () => {
    expect(studioProxyUrl({ VITE_CONVEX_SITE_URL: "https://x.convex.site/" })).toBe("https://x.convex.site/ai/studio");
    expect(studioProxyUrl({ VITE_CONVEX_URL: "https://x.convex.cloud" })).toBe("https://x.convex.site/ai/studio");
  });
});

describe("createConvexStudioAdapter", () => {
  test("POSTs the turn with the Convex Auth token and streams events then the final response", async () => {
    const final = { id: "m", createdAt: 1, status: "completed", output: [{ id: "t", kind: "output", type: "function_call", callId: "t", name: "x", arguments: "{}" }] };
    const fetchImpl = vi.fn(async () =>
      ndjsonResponse([
        { kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "a", role: "assistant" } },
        { kind: "event", event: { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "Hi" } },
        { kind: "final", response: final },
      ]),
    );
    const adapter = createConvexStudioAdapter({ url: "https://x.convex.site/ai/studio", getToken: () => "jwt-1", fetchImpl });
    const handler = adapter.executeTurn(REQUEST);
    const events = await drain(handler.stream);
    expect(events.map((e) => e.type)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]);
    expect(await handler.complete).toEqual(final);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.convex.site/ai/studio");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);
  });

  test("HTTP errors and a missing token resolve as failed responses with readable messages", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden: role gc or owner required." }), { status: 403 }));
    const denied = createConvexStudioAdapter({ url: "u", getToken: () => "jwt", fetchImpl }).executeTurn(REQUEST);
    expect(await drain(denied.stream)).toEqual([]);
    expect(await denied.complete).toMatchObject({ status: "failed", error: { code: "http_403", message: "Forbidden: role gc or owner required." } });

    const noToken = createConvexStudioAdapter({ url: "u", getToken: () => null, fetchImpl }).executeTurn(REQUEST);
    expect(await noToken.complete).toMatchObject({ status: "failed", error: { code: "unauthenticated" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("a stream without a final line is failed", async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([{ kind: "event", event: { type: "TEXT_MESSAGE_START", messageId: "a", role: "assistant" } }]));
    const h = createConvexStudioAdapter({ url: "u", getToken: () => "jwt", fetchImpl }).executeTurn(REQUEST);
    expect(await h.complete).toMatchObject({ status: "failed", error: { code: "stream_incomplete" } });
  });
});

describe("describePaySummary", () => {
  const summary = {
    generatedAt: 0,
    subcontractors: [
      {
        subcontractor: "Rosendin Electric",
        agreementCount: 1,
        formatted: { retainageHeld: "$5.00", retainageReleased: "$0.00", paid: "$45.00", billed: "$50.00" },
      },
    ],
    agreements: [
      {
        agreementId: "a1",
        agreementNumber: "SA-001",
        subcontractor: "Rosendin Electric",
        trade: "Electrical",
        project: "Tower",
        status: "executed",
        retainagePercent: 10,
        totalsCents: {},
        formatted: {
          contractSum: "$100.00",
          billed: "$50.00",
          funded: "$0.00",
          captured: "$50.00",
          paid: "$45.00",
          retainageHeld: "$5.00",
          retainageReleased: "$0.00",
          balance: "$50.00",
        },
      },
    ],
  } as unknown as PaySummary;

  test("quotes the Convex-formatted figures for the matching subcontractor", () => {
    const text = describePaySummary(summary, "rosendin");
    expect(text).toContain("Rosendin Electric");
    expect(text).toContain("retainage held: $5.00");
    expect(text).toContain("paid (net): $45.00");
    expect(text).toContain("Rosendin Electric TOTAL across 1 agreement(s): retainage held $5.00");
  });

  test("lists known subcontractors when nothing matches", () => {
    expect(describePaySummary(summary, "Acme")).toBe('No agreement matches "Acme". Subcontractors on record: Rosendin Electric.');
  });
});
