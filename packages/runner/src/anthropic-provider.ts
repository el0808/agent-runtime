import type { JsonObject } from "@agent/protocol";
import { ERROR_CODES, RuntimeError } from "@agent/protocol";
import type {
  ChatMessage,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ProviderTool
} from "./provider.js";
import { readSseLines } from "./openai-provider.js";

export interface AnthropicProviderOptions {
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly model: string;
  readonly anthropicVersion?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

interface AnthropicContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: JsonObject;
}

interface AnthropicStreamEvent {
  readonly type: string;
  readonly index?: number;
  readonly content_block?: AnthropicContentBlock;
  readonly delta?: { readonly type?: string; readonly text?: string; readonly partial_json?: string; readonly stop_reason?: string };
  readonly message?: { readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number } };
  readonly usage?: { readonly output_tokens?: number };
  readonly error?: { readonly message?: string };
}

function toAnthropicTools(tools: readonly ProviderTool[]): JsonObject[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));
}

/**
 * Anthropic expects system prompts as a top-level field, tool results inside a
 * user turn, and every tool_use block answered by a matching tool_result.
 */
export function toAnthropicPayload(messages: readonly ChatMessage[], model: string, maxTokens: number): JsonObject {
  const system: string[] = [];
  const converted: JsonObject[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.toolCallId ?? "", content: message.content };
      const last = converted[converted.length - 1];
      if (last !== undefined && last.role === "user" && Array.isArray(last.content)) {
        (last.content as JsonObject[]).push(block);
      } else {
        converted.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (message.role === "assistant") {
      const blocks: JsonObject[] = [];
      if (message.content !== "") {
        blocks.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.callId, name: call.toolName, input: call.input });
      }
      converted.push({ role: "assistant", content: blocks.length === 0 ? message.content : blocks });
      continue;
    }
    converted.push({ role: "user", content: message.content });
  }

  return {
    model,
    max_tokens: maxTokens,
    messages: converted,
    ...(system.length === 0 ? {} : { system: system.join("\n\n") })
  };
}

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly version: string;
  private readonly maxTokens: number;
  private readonly temperature: number | undefined;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.version = options.anthropicVersion ?? "2023-06-01";
    this.maxTokens = options.maxTokens ?? 4096;
    this.temperature = options.temperature;
  }

  async *chat(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const body: JsonObject = {
      ...toAnthropicPayload(request.messages, request.model, this.maxTokens),
      stream: true,
      ...(request.tools.length === 0 ? {} : { tools: toAnthropicTools(request.tools) as unknown as JsonObject[] }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature })
    };

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.version
      },
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new RuntimeError({
        code: response.status === 429 ? ERROR_CODES.DEPENDENCY_UNAVAILABLE : ERROR_CODES.INTERNAL,
        message: `Anthropic request failed (${response.status}): ${detail.slice(0, 500)}`,
        details: { status: response.status, retryable: response.status === 429 || response.status >= 500 }
      });
    }
    if (response.body === null) {
      throw new RuntimeError({ code: ERROR_CODES.INTERNAL, message: "Anthropic response had no body" });
    }

    // tool_use blocks stream `input_json_delta` fragments that must be joined.
    const blocks = new Map<number, { type: string; id: string; name: string; json: string }>();
    let promptTokens = 0;
    let outputTokens = 0;
    let stopReason = "end_turn";

    for await (const line of readSseLines(response.body, signal)) {
      if (!line.startsWith("data:")) {
        continue;
      }
      let event: AnthropicStreamEvent;
      try {
        event = JSON.parse(line.slice(5).trim()) as AnthropicStreamEvent;
      } catch {
        continue;
      }

      if (event.type === "error" && event.error?.message !== undefined) {
        throw new RuntimeError({ code: ERROR_CODES.INTERNAL, message: event.error.message });
      }
      if (event.type === "message_start" && event.message?.usage?.input_tokens !== undefined) {
        promptTokens = event.message.usage.input_tokens;
      }
      if (event.type === "message_delta") {
        if (event.usage?.output_tokens !== undefined) {
          outputTokens = event.usage.output_tokens;
        }
        if (event.delta?.stop_reason !== undefined) {
          stopReason = event.delta.stop_reason;
        }
      }
      if (event.type === "content_block_start" && event.content_block !== undefined && event.index !== undefined) {
        blocks.set(event.index, {
          type: event.content_block.type,
          id: event.content_block.id ?? "",
          name: event.content_block.name ?? "",
          json: ""
        });
        if (event.content_block.type === "text" && event.content_block.text !== undefined && event.content_block.text !== "") {
          yield { type: "delta", text: event.content_block.text };
        }
      }
      if (event.type === "content_block_delta" && event.index !== undefined && event.delta !== undefined) {
        if (event.delta.type === "text_delta" && event.delta.text !== undefined) {
          yield { type: "delta", text: event.delta.text };
        }
        if (event.delta.type === "input_json_delta" && event.delta.partial_json !== undefined) {
          const block = blocks.get(event.index);
          if (block !== undefined) {
            block.json += event.delta.partial_json;
          }
        }
      }
    }

    let sawTool = false;
    for (const [, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (block.type !== "tool_use" || block.name === "") {
        continue;
      }
      sawTool = true;
      yield {
        type: "tool_call",
        callId: block.id === "" ? `toolu_${Date.now().toString(36)}` : block.id,
        toolName: block.name,
        input: block.json.trim() === "" ? {} : (JSON.parse(block.json) as JsonObject)
      };
    }

    if (promptTokens > 0 || outputTokens > 0) {
      yield { type: "usage", usage: { promptTokens, completionTokens: outputTokens } };
    }

    const finishReason = sawTool || stopReason === "tool_use"
      ? "tool_call"
      : stopReason === "max_tokens"
        ? "length"
        : "stop";
    yield { type: "completed", finishReason };
  }
}

/** Builds an Anthropic provider from environment variables. */
export function anthropicFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicProvider | undefined {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return undefined;
  }
  return new AnthropicProvider({
    apiKey,
    model: env.AGENT_MODEL ?? "claude-sonnet-5-5",
    ...(env.ANTHROPIC_BASE_URL === undefined ? {} : { baseUrl: env.ANTHROPIC_BASE_URL })
  });
}
