/**
 * Translation between AG Studio's LLM adapter contract (AgLlmRequest in, AG-UI content events and
 * an AgLlmResponse out; see ag-studio/dist/types/api/ai/agLlmAdapter.d.ts) and the Anthropic
 * Messages API. Pure functions so the /ai/studio proxy logic is unit-testable without network.
 * Types are declared locally because the Convex bundle must not depend on the ag-studio package.
 */

export const DEFAULT_STUDIO_MODEL = "claude-sonnet-5-5";
export const STUDIO_MAX_TOKENS = 8192;

type JsonSchema = Record<string, unknown>;

export type StudioToolSchema = {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  kind?: "client" | "server" | "provided";
  provider?: unknown;
};

type StudioContentPart = { type: string; text?: string; refusal?: string };

export type StudioConversationItem =
  | { type: "message"; kind?: "input" | "output"; role: "user" | "system" | "assistant"; content: StudioContentPart[] | string }
  | { type: "function_call"; callId: string; name: string; arguments: string }
  | { type: "function_call_output"; callId: string; output: string }
  | { type: "reasoning" };

export type StudioLlmRequest = {
  input: StudioConversationItem[];
  instructions?: string;
  tools?: StudioToolSchema[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  responseFormat?: { type: "text" } | { type: "json"; name: string; description?: string; schema: JsonSchema };
};

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };

export type AnthropicRequest = {
  model: string;
  max_tokens: number;
  stream: true;
  system?: string;
  messages: AnthropicMessage[];
  tools?: { name: string; description: string; input_schema: JsonSchema }[];
  tool_choice?: { type: "auto" } | { type: "any" } | { type: "none" } | { type: "tool"; name: string };
};

export class StudioRequestError extends Error {}

function partsText(content: StudioContentPart[] | string): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? (p.text ?? "") : p.type === "refusal" ? (p.refusal ?? "") : ""))
    .join("");
}

function parseArguments(raw: string): unknown {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function inputSchema(schema: JsonSchema | undefined): JsonSchema {
  if (schema && schema.type === "object") return schema;
  return { type: "object", properties: {} };
}

/** Validates the untrusted request body and converts it to an Anthropic streaming Messages request. */
export function toAnthropicRequest(body: unknown, model: string): AnthropicRequest {
  if (body === null || typeof body !== "object") throw new StudioRequestError("Request body must be a JSON object.");
  const req = body as StudioLlmRequest;
  if (!Array.isArray(req.input)) throw new StudioRequestError("Request 'input' must be an array.");

  const systemParts: string[] = [];
  if (typeof req.instructions === "string" && req.instructions.trim() !== "") systemParts.push(req.instructions);

  const messages: AnthropicMessage[] = [];
  const toolUseIds = new Set<string>();
  const push = (role: "user" | "assistant", block: AnthropicBlock) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };

  for (const item of req.input) {
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case "message": {
        const text = partsText(item.content ?? "");
        if (item.role === "system") {
          if (text.trim()) systemParts.push(text);
        } else if (text.trim()) {
          push(item.role === "assistant" ? "assistant" : "user", { type: "text", text });
        }
        break;
      }
      case "function_call": {
        if (typeof item.callId !== "string" || typeof item.name !== "string") break;
        toolUseIds.add(item.callId);
        push("assistant", { type: "tool_use", id: item.callId, name: item.name, input: parseArguments(item.arguments) });
        break;
      }
      case "function_call_output": {
        // Anthropic rejects a tool_result whose tool_use is not in the conversation.
        if (!toolUseIds.has(item.callId)) break;
        const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
        push("user", { type: "tool_result", tool_use_id: item.callId, content: output === "" ? "(empty)" : output });
        break;
      }
      default:
        break;
    }
  }

  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  }

  if (req.responseFormat?.type === "json") {
    systemParts.push(
      `Respond with a single JSON object only (no prose, no code fences) named "${req.responseFormat.name}" that matches this JSON Schema:\n${JSON.stringify(req.responseFormat.schema)}`,
    );
  }

  const tools = (Array.isArray(req.tools) ? req.tools : [])
    .filter((t) => t && typeof t.name === "string" && t.kind !== "provided")
    .map((t) => ({ name: t.name, description: t.description ?? "", input_schema: inputSchema(t.parameters) }));

  const out: AnthropicRequest = {
    model,
    max_tokens: STUDIO_MAX_TOKENS,
    stream: true,
    messages,
  };
  if (systemParts.length > 0) out.system = systemParts.join("\n\n");
  if (tools.length > 0) {
    out.tools = tools;
    const choice = req.toolChoice;
    if (choice === "required") out.tool_choice = { type: "any" };
    else if (choice === "none") out.tool_choice = { type: "none" };
    else if (choice && typeof choice === "object" && typeof choice.name === "string") {
      out.tool_choice = { type: "tool", name: choice.name };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Streaming: Anthropic SSE events -> NDJSON lines for the browser adapter.

export type StudioOutputItem =
  | {
      id: string;
      kind: "output";
      type: "message";
      role: "assistant";
      status: "completed";
      content: { type: "text"; text: string; annotations: [] }[];
    }
  | { id: string; kind: "output"; type: "function_call"; callId: string; name: string; arguments: string; status: "completed" };

export type StudioFinal = {
  id: string;
  createdAt: number;
  status: "completed" | "incomplete" | "failed";
  output: StudioOutputItem[];
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  incompleteDetails?: { reason: "max_output_tokens" };
  error?: { code: string; message: string };
};

/** One NDJSON line: an AG-UI content event for Studio, or the final consolidated response. */
export type StudioStreamLine = { kind: "event"; event: Record<string, unknown> } | { kind: "final"; response: StudioFinal };

type OpenBlock =
  | { type: "text"; id: string; text: string }
  | { type: "tool"; id: string; name: string; json: string }
  | { type: "ignored" };

export class AnthropicStreamTranslator {
  private blocks = new Map<number, OpenBlock>();
  private output: StudioOutputItem[] = [];
  private messageId = `msg_${Date.now().toString(36)}`;
  private model?: string;
  private inputTokens = 0;
  private outputTokens = 0;
  private stopReason?: string;
  private error?: { code: string; message: string };
  private finished = false;

  constructor(private readonly createdAt: number = Date.now()) {}

  private event(event: Record<string, unknown>): StudioStreamLine {
    return { kind: "event", event };
  }

  /** Handles one parsed SSE `data:` payload and returns the lines to send downstream. */
  handle(data: unknown): StudioStreamLine[] {
    if (data === null || typeof data !== "object") return [];
    const evt = data as Record<string, any>;
    switch (evt.type) {
      case "message_start": {
        const m = evt.message ?? {};
        if (typeof m.id === "string") this.messageId = m.id;
        if (typeof m.model === "string") this.model = m.model;
        this.inputTokens = Number(m.usage?.input_tokens ?? 0);
        this.outputTokens = Number(m.usage?.output_tokens ?? 0);
        return [];
      }
      case "content_block_start": {
        const index = Number(evt.index);
        const block = evt.content_block ?? {};
        if (block.type === "text") {
          const id = `${this.messageId}_t${index}`;
          const text = typeof block.text === "string" ? block.text : "";
          this.blocks.set(index, { type: "text", id, text });
          const lines = [this.event({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" })];
          if (text) lines.push(this.event({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text }));
          return lines;
        }
        if (block.type === "tool_use") {
          this.blocks.set(index, { type: "tool", id: String(block.id), name: String(block.name), json: "" });
          return [
            this.event({ type: "TOOL_CALL_START", toolCallId: String(block.id), toolCallName: String(block.name), parentMessageId: this.messageId }),
          ];
        }
        this.blocks.set(index, { type: "ignored" });
        return [];
      }
      case "content_block_delta": {
        const block = this.blocks.get(Number(evt.index));
        const delta = evt.delta ?? {};
        if (block?.type === "text" && delta.type === "text_delta" && typeof delta.text === "string") {
          block.text += delta.text;
          return delta.text ? [this.event({ type: "TEXT_MESSAGE_CONTENT", messageId: block.id, delta: delta.text })] : [];
        }
        if (block?.type === "tool" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          block.json += delta.partial_json;
          return delta.partial_json ? [this.event({ type: "TOOL_CALL_ARGS", toolCallId: block.id, delta: delta.partial_json })] : [];
        }
        return [];
      }
      case "content_block_stop": {
        const index = Number(evt.index);
        const block = this.blocks.get(index);
        this.blocks.delete(index);
        return block ? this.close(block) : [];
      }
      case "message_delta": {
        if (typeof evt.delta?.stop_reason === "string") this.stopReason = evt.delta.stop_reason;
        if (evt.usage?.output_tokens !== undefined) this.outputTokens = Number(evt.usage.output_tokens);
        return [];
      }
      case "error": {
        this.error = {
          code: String(evt.error?.type ?? "anthropic_error"),
          message: String(evt.error?.message ?? "The model provider returned an error."),
        };
        return [];
      }
      default:
        return [];
    }
  }

  private close(block: OpenBlock): StudioStreamLine[] {
    if (block.type === "text") {
      if (block.text) {
        this.output.push({
          id: block.id,
          kind: "output",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "text", text: block.text, annotations: [] }],
        });
      }
      return [this.event({ type: "TEXT_MESSAGE_END", messageId: block.id })];
    }
    if (block.type === "tool") {
      this.output.push({
        id: block.id,
        kind: "output",
        type: "function_call",
        callId: block.id,
        name: block.name,
        arguments: block.json.trim() === "" ? "{}" : block.json,
        status: "completed",
      });
      return [this.event({ type: "TOOL_CALL_END", toolCallId: block.id })];
    }
    return [];
  }

  /** Closes any block left open and returns the final response line. Idempotent. */
  finish(failure?: { code: string; message: string }): StudioStreamLine[] {
    if (this.finished) return [];
    this.finished = true;
    const lines: StudioStreamLine[] = [];
    for (const block of this.blocks.values()) lines.push(...this.close(block));
    this.blocks.clear();
    const error = failure ?? this.error;
    const response: StudioFinal = {
      id: this.messageId,
      createdAt: this.createdAt,
      status: error ? "failed" : this.stopReason === "max_tokens" ? "incomplete" : "completed",
      output: this.output,
      model: this.model,
      usage: {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        totalTokens: this.inputTokens + this.outputTokens,
      },
    };
    if (error) response.error = error;
    if (!error && this.stopReason === "max_tokens") response.incompleteDetails = { reason: "max_output_tokens" };
    lines.push({ kind: "final", response });
    return lines;
  }
}

/** Incremental SSE parser: feed text chunks, get back the JSON payload of each complete `data:` event. */
export class SseParser {
  private buffer = "";

  push(chunk: string): unknown[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const out: unknown[] = [];
    let sep = this.buffer.indexOf("\n\n");
    while (sep !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          out.push(JSON.parse(data));
        } catch {
          // Ignore keep-alives and non-JSON payloads.
        }
      }
      sep = this.buffer.indexOf("\n\n");
    }
    return out;
  }
}
