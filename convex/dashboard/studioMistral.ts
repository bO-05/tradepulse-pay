/**
 * Mistral Chat Completions <-> Studio's AG-UI/NDJSON adapter protocol.
 * Wire format: https://docs.mistral.ai/api/endpoint/chat
 * No provider SDK or frontend package is needed in the Convex HTTP runtime.
 */
import {
  STUDIO_MAX_TOKENS,
  StudioRequestError,
  toAnthropicRequest,
  type StudioFinal,
  type StudioOutputItem,
  type StudioStreamLine,
} from "./studioAnthropic";

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type MistralMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type MistralRequest = {
  model: string;
  max_tokens: number;
  stream: true;
  messages: MistralMessage[];
  tools?: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  tool_choice?: "auto" | "none" | "any" | { type: "function"; function: { name: string } };
  response_format?: { type: "json_schema"; json_schema: { name: string; description?: string; schema: Record<string, unknown>; strict: true } };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Reuse the existing conversation validation/normalization, then use native Mistral tools/JSON schema. */
export function toMistralRequest(body: unknown, model: string): MistralRequest {
  const normalized = toAnthropicRequest(body, model);
  const messages: MistralMessage[] = [];
  if (normalized.system) messages.push({ role: "system", content: normalized.system });
  for (const message of normalized.messages) {
    if (message.role === "assistant") {
      const text: string[] = [];
      const calls: ToolCall[] = [];
      for (const block of message.content) {
        if (block.type === "text") text.push(block.text);
        if (block.type === "tool_use") calls.push({
          id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) },
        });
      }
      messages.push({ role: "assistant", content: text.length ? text.join("") : null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const block of message.content) {
        if (block.type === "text") messages.push({ role: "user", content: block.text });
        if (block.type === "tool_result") messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.content });
      }
    }
  }
  const out: MistralRequest = { model, max_tokens: STUDIO_MAX_TOKENS, stream: true, messages };
  if (normalized.tools?.length) {
    out.tools = normalized.tools.map((tool) => ({
      type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    }));
    const choice = normalized.tool_choice;
    out.tool_choice = choice?.type === "tool"
      ? { type: "function", function: { name: choice.name } }
      : choice?.type ?? "auto";
  }
  const format = record(record(body)?.responseFormat);
  if (format?.type === "json") {
    if (typeof format.name !== "string" || !record(format.schema)) {
      throw new StudioRequestError("JSON response format requires a name and schema object.");
    }
    out.response_format = {
      type: "json_schema",
      json_schema: {
        name: format.name,
        schema: record(format.schema)!,
        strict: true,
        ...(typeof format.description === "string" ? { description: format.description } : {}),
      },
    };
  }
  return out;
}

type StreamingTool = { id: string; name: string; arguments: string; started: boolean };
const event = (value: Record<string, unknown>): StudioStreamLine => ({ kind: "event", event: value });
const tokenCount = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export class MistralStreamTranslator {
  private id = `msg_${Date.now().toString(36)}`;
  private model?: string;
  private text = "";
  private textId?: string;
  private tools = new Map<number, StreamingTool>();
  private inputTokens = 0;
  private outputTokens = 0;
  private reason?: string;
  private failed = false;
  private finished = false;

  constructor(private readonly createdAt = Date.now()) {}

  handle(data: unknown): StudioStreamLine[] {
    if (this.finished) return [];
    const chunk = record(data);
    if (!chunk) return [];
    if (chunk.error) this.failed = true; // Never forward provider-controlled error messages.
    if (typeof chunk.id === "string") this.id = chunk.id;
    if (typeof chunk.model === "string") this.model = chunk.model;
    const usage = record(chunk.usage);
    if (usage) {
      this.inputTokens = tokenCount(usage.prompt_tokens);
      this.outputTokens = tokenCount(usage.completion_tokens);
    }
    const lines: StudioStreamLine[] = [];
    for (const rawChoice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const choice = record(rawChoice);
      if (!choice || (choice.index !== undefined && choice.index !== 0)) continue;
      if (typeof choice.finish_reason === "string") this.reason = choice.finish_reason;
      const delta = record(choice.delta);
      if (!delta) continue;
      // Mistral can send a string or text/thinking content chunks. Do not expose internal thinking.
      const content = typeof delta.content === "string" ? delta.content : Array.isArray(delta.content)
        ? delta.content.flatMap((part) => {
          const p = record(part);
          return p?.type === "text" && typeof p.text === "string" ? [p.text] : [];
        }).join("") : "";
      if (content) {
        if (!this.textId) {
          this.textId = `${this.id}_t0`;
          lines.push(event({ type: "TEXT_MESSAGE_START", messageId: this.textId, role: "assistant" }));
        }
        this.text += content;
        lines.push(event({ type: "TEXT_MESSAGE_CONTENT", messageId: this.textId, delta: content }));
      }
      for (const rawTool of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const call = record(rawTool);
        if (!call) {
          this.failed = true;
          continue;
        }
        // Mistral permits an absent index. Match explicit IDs first; an ID-less continuation
        // is unambiguous only while exactly one call is open.
        let index: number | undefined;
        if (call.index !== undefined && call.index !== null) {
          if (typeof call.index === "number" && Number.isInteger(call.index) && call.index >= 0) index = call.index;
        } else if (typeof call.id === "string" && call.id) {
          index = [...this.tools].find(([, tool]) => tool.id === call.id)?.[0];
          if (index === undefined) {
            index = 0;
            while (this.tools.has(index)) index++;
          }
        } else if (this.tools.size === 1) {
          index = this.tools.keys().next().value;
        }
        if (index === undefined) {
          this.failed = true;
          continue;
        }
        const tool = this.tools.get(index) ?? { id: "", name: "", arguments: "", started: false };
        const fn = record(call.function);
        if (typeof call.id === "string" && call.id) {
          if (tool.started && tool.id !== call.id) this.failed = true;
          else tool.id = call.id;
        }
        if (typeof fn?.name === "string" && fn.name !== tool.name) {
          if (tool.started) this.failed = true;
          else tool.name += fn.name;
        }
        if (typeof fn?.arguments === "string") tool.arguments += fn.arguments;
        this.tools.set(index, tool);
        if (tool.id && tool.name && tool.arguments && !tool.started) {
          tool.started = true;
          lines.push(event({ type: "TOOL_CALL_START", toolCallId: tool.id, toolCallName: tool.name, parentMessageId: this.id }));
          if (tool.arguments) lines.push(event({ type: "TOOL_CALL_ARGS", toolCallId: tool.id, delta: tool.arguments }));
        } else if (tool.started && typeof fn?.arguments === "string" && fn.arguments) {
          lines.push(event({ type: "TOOL_CALL_ARGS", toolCallId: tool.id, delta: fn.arguments }));
        }
      }
    }
    return lines;
  }

  finish(failure?: { code: string; message: string }): StudioStreamLine[] {
    if (this.finished) return [];
    this.finished = true;
    const lines: StudioStreamLine[] = [];
    const output: StudioOutputItem[] = [];
    if (this.textId) {
      lines.push(event({ type: "TEXT_MESSAGE_END", messageId: this.textId }));
      output.push({ id: this.textId, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: this.text, annotations: [] }] });
    }
    for (const tool of this.tools.values()) {
      if (!tool.started && tool.id && tool.name) {
        tool.started = true;
        lines.push(event({ type: "TOOL_CALL_START", toolCallId: tool.id, toolCallName: tool.name, parentMessageId: this.id }));
      }
      if (!tool.started) this.failed = true;
      const args = tool.arguments.trim() || "{}";
      try {
        if (!record(JSON.parse(args))) this.failed = true;
      } catch {
        this.failed = true;
      }
      if (tool.started) {
        lines.push(event({ type: "TOOL_CALL_END", toolCallId: tool.id }));
        output.push({ id: tool.id, kind: "output", type: "function_call", callId: tool.id, name: tool.name, arguments: args, status: "completed" });
      }
    }
    const capped = this.reason === "length" || this.reason === "model_length";
    const error = failure ?? (this.failed || !["stop", "tool_calls", "length", "model_length"].includes(this.reason ?? "")
      ? { code: "model_stream_error", message: "The model response was interrupted or could not be completed." } : undefined);
    const response: StudioFinal = {
      id: this.id, createdAt: this.createdAt, model: this.model,
      status: error ? "failed" : capped ? "incomplete" : "completed",
      output,
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens, totalTokens: this.inputTokens + this.outputTokens },
      ...(error ? { error } : capped ? { incompleteDetails: { reason: "max_output_tokens" as const } } : {}),
    };
    lines.push({ kind: "final", response });
    return lines;
  }
}
