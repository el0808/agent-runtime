import type { JsonObject } from "@agent/protocol";
import { ERROR_CODES, RuntimeError } from "@agent/protocol";
import type {
  ChatMessage,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ProviderTool
} from "./provider.js";

export interface OpenAIChatProviderOptions {
  /** Base URL including the version segment, e.g. https://api.openai.com/v1 */
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

interface OpenAIToolCallDelta {
  readonly index?: number;
  readonly id?: string;
  readonly type?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface OpenAIStreamChunk {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly OpenAIToolCallDelta[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number } | null;
  readonly error?: { readonly message?: string; readonly type?: string };
}

function toOpenAITools(tools: readonly ProviderTool[]): JsonObject[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function toOpenAIMessages(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: message.content
      };
    }
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      return {
        role: "assistant",
        content: message.content === "" ? null : message.content,
        tool_calls: message.toolCalls?.map((call) => ({
          id: call.callId,
          type: "function",
          function: { name: call.toolName, arguments: JSON.stringify(call.input) }
        }))
      };
    }
    // A user turn with images uses the content-array form: OpenAI rejects
    // image parts sent as a plain string.
    if (message.role === "user" && (message.parts?.length ?? 0) > 0) {
      return {
        role: "user",
        content: (message.parts ?? []).map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.data}` } }
        )
      };
    }
    return { role: message.role, content: message.content };
  });
}

function parseArguments(raw: string, toolName: string): JsonObject {
  if (raw.trim() === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("tool arguments must be a JSON object");
    }
    return parsed as JsonObject;
  } catch (error) {
    throw new RuntimeError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Model produced invalid JSON for ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
      details: { toolName, raw: raw.slice(0, 500) }
    });
  }
}

/**
 * OpenAI-compatible chat provider. Works against OpenAI, Azure OpenAI,
 * OpenRouter, Together, vLLM, Ollama and any other server exposing
 * `/chat/completions` with streaming.
 */
export class OpenAIChatProvider implements ModelProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number | undefined;

  constructor(options: OpenAIChatProviderOptions) {
    this.model = options.model;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
  }

  /** Lists the models the endpoint advertises, so settings can offer real choices. */
  async listModels(signal?: AbortSignal): Promise<{ id: string; contextLength?: number }[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
      ...(signal === undefined ? {} : { signal })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new RuntimeError({
        code: ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        message: `Could not list models (${response.status}): ${detail.slice(0, 200)}`,
        details: { status: response.status }
      });
    }
    const body = (await response.json()) as { data?: { id?: string; context_length?: number; context_window?: number }[] };
    return (body.data ?? [])
      .map((entry) => ({
        id: typeof entry.id === "string" ? entry.id : "",
        ...(typeof entry.context_length === "number" ? { contextLength: entry.context_length } : {}),
        ...(typeof entry.context_window === "number" ? { contextLength: entry.context_window } : {})
      }))
      .filter((entry) => entry.id !== "")
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async *chat(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const body: JsonObject = {
      model: request.model,
      messages: toOpenAIMessages(request.messages) as unknown as JsonObject,
      ...(request.tools.length === 0 ? {} : { tools: toOpenAITools(request.tools) as unknown as JsonObject }),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.tools.length === 0 ? {} : { tools: toOpenAITools(request.tools) as unknown as JsonObject[] }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort })
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders
      },
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new RuntimeError({
        code: response.status === 429 ? ERROR_CODES.DEPENDENCY_UNAVAILABLE : ERROR_CODES.INTERNAL,
        message: `OpenAI request failed (${response.status}): ${detail.slice(0, 500)}`,
        details: { status: response.status, retryable: response.status === 429 || response.status >= 500 }
      });
    }
    if (response.body === null) {
      throw new RuntimeError({ code: ERROR_CODES.INTERNAL, message: "OpenAI response had no body" });
    }

    // Tool call arguments arrive in fragments keyed by index, so accumulate per index.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finished = false;
    let finishReason: "stop" | "tool_call" | "length" = "stop";

    for await (const line of readSseLines(response.body, signal)) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        break;
      }
      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenAIStreamChunk;
      } catch {
        continue;
      }
      if (chunk.error?.message !== undefined) {
        throw new RuntimeError({ code: ERROR_CODES.INTERNAL, message: chunk.error.message });
      }
      if (chunk.usage !== undefined && chunk.usage !== null) {
        yield {
          type: "usage",
          usage: {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0
          }
        };
      }
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (delta?.content !== undefined && delta.content !== null && delta.content !== "") {
          yield { type: "delta", text: delta.content };
        }
        for (const [position, call] of (delta?.tool_calls ?? []).entries()) {
          const index = call.index ?? position;
          const current = pending.get(index) ?? { id: "", name: "", args: "" };
          pending.set(index, {
            id: call.id !== undefined && call.id !== "" ? call.id : current.id,
            name: call.function?.name !== undefined && call.function.name !== "" ? call.function.name : current.name,
            args: current.args + (call.function?.arguments ?? "")
          });
        }
        if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") {
          finishReason = "tool_call";
        } else if (choice.finish_reason === "length") {
          finishReason = "length";
        }
      }
    }

    for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      if (call.name === "") {
        continue;
      }
      yield {
        type: "tool_call",
        callId: call.id === "" ? `call_${index}_${Date.now().toString(36)}` : call.id,
        toolName: call.name,
        input: parseArguments(call.args, call.name)
      };
      finished = true;
    }

    yield { type: "completed", finishReason: finished ? "tool_call" : finishReason };
  }
}

/** Splits a byte stream into SSE lines and stops early when aborted. */
export async function* readSseLines(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        yield buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim() !== "") {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Builds an OpenAI-compatible provider from environment variables. */
export function openAIFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIChatProvider | undefined {
  const apiKey = env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return undefined;
  }
  return new OpenAIChatProvider({
    apiKey,
    model: env.AGENT_MODEL ?? "gpt-4o-mini",
    ...(env.OPENAI_BASE_URL === undefined ? {} : { baseUrl: env.OPENAI_BASE_URL })
  });
}
