import { describe, expect, test } from "vitest";
import { AnthropicStreamTranslator, SseParser, StudioRequestError, toAnthropicRequest } from "./studioAnthropic";

describe("toAnthropicRequest", () => {
  test("maps Studio conversation items, tools and tool choice to the Messages API", () => {
    const out = toAnthropicRequest(
      {
        instructions: "Be the pay agent.",
        input: [
          { type: "message", kind: "input", role: "system", content: [{ type: "text", text: "Extra context" }], status: "completed" },
          { type: "message", kind: "input", role: "user", content: [{ type: "text", text: "Retainage for Rosendin?" }], status: "completed" },
          { type: "function_call", kind: "output", id: "c1", callId: "toolu_1", name: "get_payment_ledger", arguments: '{"query":"Rosendin"}' },
          { type: "function_call_output", callId: "toolu_1", output: "retainage held: $1.00", status: "completed" },
          { type: "function_call_output", callId: "toolu_orphan", output: "x", status: "completed" },
          { type: "reasoning", id: "r", kind: "output", summary: [] },
          { type: "message", kind: "output", role: "assistant", content: [{ type: "text", text: "It is $1.00.", annotations: [] }], status: "completed" },
        ],
        tools: [
          { name: "get_payment_ledger", description: "Ledger", parameters: { type: "object", properties: { query: { type: "string" } } } },
          { name: "web_search", description: "hosted", parameters: {}, kind: "provided" },
          { name: "no_params", description: "none", parameters: {} },
        ],
        toolChoice: "required",
        responseFormat: { type: "text" },
      },
      "claude-sonnet-5-5",
    );
    expect(out.model).toBe("claude-sonnet-5-5");
    expect(out.stream).toBe(true);
    expect(out.system).toBe("Be the pay agent.\n\nExtra context");
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Retainage for Rosendin?" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_payment_ledger", input: { query: "Rosendin" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "retainage held: $1.00" }] },
      { role: "assistant", content: [{ type: "text", text: "It is $1.00." }] },
    ]);
    expect(out.tools?.map((t) => t.name)).toEqual(["get_payment_ledger", "no_params"]);
    expect(out.tools?.[1].input_schema).toEqual({ type: "object", properties: {} });
    expect(out.tool_choice).toEqual({ type: "any" });
  });

  test("forced tool choice, JSON format and a leading assistant turn", () => {
    const out = toAnthropicRequest(
      {
        input: [{ type: "message", role: "assistant", content: "Hello" }],
        tools: [{ name: "add_widget", description: "", parameters: { type: "object" } }],
        toolChoice: { name: "add_widget" },
        responseFormat: { type: "json", name: "plan", schema: { type: "object" } },
      },
      "m",
    );
    expect(out.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "(continue)" }] });
    expect(out.tool_choice).toEqual({ type: "tool", name: "add_widget" });
    expect(out.system).toContain('named "plan"');
  });

  test("rejects malformed bodies", () => {
    expect(() => toAnthropicRequest(null, "m")).toThrow(StudioRequestError);
    expect(() => toAnthropicRequest({ input: "nope" }, "m")).toThrow(StudioRequestError);
  });
});

function sse(events: unknown[]): string {
  return events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

describe("streaming translation", () => {
  const anthropicEvents = [
    { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the ledger." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9", name: "get_payment_ledger", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Rosendin"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
    { type: "message_stop" },
  ];

  test("SSE split across arbitrary chunks yields AG-UI events and a final response with the tool call", () => {
    const text = sse(anthropicEvents);
    const parser = new SseParser();
    const translator = new AnthropicStreamTranslator(123);
    const lines = [];
    for (let i = 0; i < text.length; i += 37) {
      for (const evt of parser.push(text.slice(i, i + 37))) lines.push(...translator.handle(evt));
    }
    lines.push(...translator.finish());

    const types = lines.map((l) => (l.kind === "event" ? l.event.type : "final"));
    expect(types).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "final",
    ]);
    const final = lines[lines.length - 1];
    if (final.kind !== "final") throw new Error("expected final");
    expect(final.response).toMatchObject({
      id: "msg_1",
      createdAt: 123,
      status: "completed",
      model: "claude-sonnet-5-5",
      usage: { inputTokens: 10, outputTokens: 42, totalTokens: 52 },
    });
    expect(final.response.output).toEqual([
      {
        id: "msg_1_t0",
        kind: "output",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "text", text: "Checking the ledger.", annotations: [] }],
      },
      { id: "toolu_9", kind: "output", type: "function_call", callId: "toolu_9", name: "get_payment_ledger", arguments: '{"query":"Rosendin"}', status: "completed" },
    ]);
    expect(translator.finish()).toEqual([]);
  });

  test("max_tokens is incomplete; a provider error event or interruption is failed", () => {
    const capped = new AnthropicStreamTranslator();
    capped.handle({ type: "message_delta", delta: { stop_reason: "max_tokens" } });
    const [cappedFinal] = capped.finish();
    expect(cappedFinal).toMatchObject({ kind: "final", response: { status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } } });

    const errored = new AnthropicStreamTranslator();
    errored.handle({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    expect(errored.finish()[0]).toMatchObject({ response: { status: "failed", error: { code: "overloaded_error" } } });

    const cut = new AnthropicStreamTranslator();
    cut.handle({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "n" } });
    const lines = cut.finish({ code: "stream_error", message: "cut" });
    expect(lines.map((l) => (l.kind === "event" ? l.event.type : l.response.status))).toEqual(["TOOL_CALL_END", "failed"]);
  });
});
