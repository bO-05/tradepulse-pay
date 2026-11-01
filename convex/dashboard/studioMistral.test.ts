import { describe, expect, test } from "vitest";
import { SseParser, StudioRequestError, type StudioStreamLine } from "./studioAnthropic";
import { MistralStreamTranslator, toMistralRequest } from "./studioMistral";

describe("Mistral Studio requests", () => {
  test("maps system, user, assistant, parallel tool calls and their results without orphan results", () => {
    const out = toMistralRequest({
      instructions: "Use the caller's ledger tools.",
      input: [
        { type: "message", role: "system", content: "Extra rules" },
        { type: "message", role: "user", content: [{ type: "text", text: "What was paid?" }] },
        { type: "message", role: "assistant", content: "Checking." },
        { type: "function_call", callId: "D681PevKs", name: "ledger", arguments: '{"agreement":"a"}' },
        { type: "function_call", callId: "E681PevKs", name: "summary", arguments: "{}" },
        { type: "function_call_output", callId: "D681PevKs", output: "100 cents" },
        { type: "function_call_output", callId: "E681PevKs", output: "total" },
        { type: "function_call_output", callId: "orphan", output: "ignore" },
        { type: "reasoning" },
      ],
      tools: [
        { name: "ledger", description: "Read ledger", parameters: { type: "object", properties: { agreement: { type: "string" } } } },
        { name: "hosted", kind: "provided" },
      ],
      toolChoice: "required",
    }, "mistral-large-latest");
    expect(out).toMatchObject({ model: "mistral-large-latest", max_tokens: 8192, stream: true, tool_choice: "any" });
    expect(out.messages).toEqual([
      { role: "system", content: "Use the caller's ledger tools.\n\nExtra rules" },
      { role: "user", content: "What was paid?" },
      { role: "assistant", content: "Checking.", tool_calls: [
        { id: "D681PevKs", type: "function", function: { name: "ledger", arguments: '{"agreement":"a"}' } },
        { id: "E681PevKs", type: "function", function: { name: "summary", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "D681PevKs", content: "100 cents" },
      { role: "tool", tool_call_id: "E681PevKs", content: "total" },
    ]);
    expect(out.tools).toEqual([{ type: "function", function: { name: "ledger", description: "Read ledger", parameters: { type: "object", properties: { agreement: { type: "string" } } } } }]);
  });

  test.each(["auto", "none", "required"] as const)("supports %s tool choice", (choice) => {
    const out = toMistralRequest({ input: [], tools: [{ name: "ledger" }], toolChoice: choice }, "m");
    expect(out.tool_choice).toBe(choice === "required" ? "any" : choice);
    expect(out.tools?.[0].function.parameters).toEqual({ type: "object", properties: {} });
  });

  test("uses native forced tools and strict JSON schema output, not simulated tool text", () => {
    const out = toMistralRequest({
      input: [{ type: "message", role: "user", content: "Plan" }],
      tools: [{ name: "plan" }], toolChoice: { name: "plan" },
      responseFormat: { type: "json", name: "layout", description: "A layout", schema: { type: "object", properties: {} } },
    }, "m");
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "plan" } });
    expect(out.response_format).toEqual({ type: "json_schema", json_schema: { name: "layout", description: "A layout", schema: { type: "object", properties: {} }, strict: true } });
  });

  test("rejects malformed body/schema", () => {
    for (const body of [null, { input: "no" }, { input: [], responseFormat: { type: "json", name: "bad", schema: null } }]) {
      expect(() => toMistralRequest(body, "m")).toThrow(StudioRequestError);
    }
  });
});

function final(lines: StudioStreamLine[]) {
  const line = lines.find((line) => line.kind === "final");
  if (line?.kind !== "final") throw new Error("Expected final response");
  return line.response;
}

describe("Mistral SSE to AG-UI", () => {
  test("arbitrarily fragmented CRLF SSE yields text, interleaved parallel tool calls, usage and final output", () => {
    const chunks = [
      { id: "cmpl_1", model: "mistral-large-latest", choices: [{ index: 0, delta: { role: "assistant" } }] },
      { choices: [{ index: 0, delta: { content: "Checking " } }] },
      { choices: [{ index: 0, delta: { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "ledger." }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "D681PevKs", type: "function", function: { name: "ledger", arguments: '{"query":' } },
        { index: 1, id: "E681PevKs", type: "function", function: { name: "summary", arguments: "{}" } },
      ] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Rosendin"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 42, total_tokens: 52 } },
    ];
    const wire = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
    const parser = new SseParser();
    const translator = new MistralStreamTranslator(123);
    const lines: StudioStreamLine[] = [];
    for (const char of wire) lines.push(...parser.push(char).flatMap((chunk) => translator.handle(chunk)));
    lines.push(...translator.finish());
    expect(final(lines)).toMatchObject({
      id: "cmpl_1", createdAt: 123, model: "mistral-large-latest", status: "completed",
      usage: { inputTokens: 10, outputTokens: 42, totalTokens: 52 },
      output: [
        { type: "message", content: [{ type: "text", text: "Checking ledger." }] },
        { type: "function_call", callId: "D681PevKs", name: "ledger", arguments: '{"query":"Rosendin"}' },
        { type: "function_call", callId: "E681PevKs", name: "summary", arguments: "{}" },
      ],
    });
    expect(lines.filter((line) => line.kind === "event" && line.event.type === "TOOL_CALL_START")).toHaveLength(2);
    expect(lines.filter((line) => line.kind === "event" && line.event.type === "TOOL_CALL_END")).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain("private");
    expect(translator.finish()).toEqual([]);
    expect(translator.handle(chunks[0])).toEqual([]);
  });

  test.each(["length", "model_length"])("%s is incomplete, not a successful complete answer", (reason) => {
    const translator = new MistralStreamTranslator();
    translator.handle({ choices: [{ index: 0, delta: { content: '{"partial":' }, finish_reason: reason }] });
    expect(final(translator.finish())).toMatchObject({ status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } });
  });

  test("missing finish reason, provider errors and invalid tool arguments fail without leaking provider messages", () => {
    for (const chunk of [
      { choices: [{ index: 0, delta: { content: "partial" } }] },
      { error: { message: "Bearer secret-mistral-key", type: "secret-mistral-key" } },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "D681PevKs", function: { name: "ledger", arguments: "{invalid" } }] }, finish_reason: "tool_calls" }] },
      { choices: [{ index: 0, finish_reason: "error" }] },
    ]) {
      const translator = new MistralStreamTranslator();
      translator.handle(chunk);
      const result = final(translator.finish());
      expect(result.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("secret-mistral-key");
    }
  });

  test("tool with no arguments still produces a real function call with matching IDs", () => {
    const translator = new MistralStreamTranslator();
    translator.handle({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "D681PevKs", function: { name: "summary", arguments: "" } }] }, finish_reason: "tool_calls" }] });
    expect(final(translator.finish())).toMatchObject({ status: "completed", output: [{ type: "function_call", callId: "D681PevKs", name: "summary", arguments: "{}" }] });
  });

  test("optional tool indexes and fragmented names preserve call linkage", () => {
    const translator = new MistralStreamTranslator();
    translator.handle({ choices: [{ index: 0, delta: { tool_calls: [{ id: "D681PevKs", function: { name: "get_", arguments: "" } }] } }] });
    translator.handle({ choices: [{ index: 0, delta: { tool_calls: [{ id: "D681PevKs", function: { name: "ledger", arguments: '{"query":' } }] } }] });
    translator.handle({ choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] });
    expect(final(translator.finish())).toMatchObject({ status: "completed", output: [{ type: "function_call", callId: "D681PevKs", name: "get_ledger", arguments: '{"query":"a"}' }] });
  });
});
