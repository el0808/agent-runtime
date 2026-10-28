import type { JsonObject } from "@agent/protocol";

/** A tool call carried on an assistant message, as required by every chat API. */
export interface AssistantToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly input: JsonObject;
}

/** One piece of a multimodal user turn. */
export type MessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaType: string; readonly data: string };

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  /**
   * Plain text. Always set, so callers that only understand text keep working;
   * for a turn with images it holds the text parts joined.
   */
  readonly content: string;
  /** Set when the turn has images; providers serialise this instead of `content`. */
  readonly parts?: readonly MessagePart[];
  /** Set on `tool` messages: which assistant tool call this responds to. */
  readonly toolCallId?: string;
  /** Set on `assistant` messages that requested tools. */
  readonly toolCalls?: readonly AssistantToolCall[];
}

/** Builds a user turn from text plus optional images, collapsing to plain text when there are none. */
export function userMessage(text: string, images: readonly { readonly mediaType: string; readonly data: string }[] = []): ChatMessage {
  if (images.length === 0) {
    return { role: "user", content: text };
  }
  const parts: MessagePart[] = [
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...images.map((image) => ({ type: "image" as const, mediaType: image.mediaType, data: image.data }))
  ];
  return { role: "user", content: text, parts };
}

export interface ProviderTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input. Required by OpenAI, Anthropic and Gemini. */
  readonly parameters: JsonObject;
}

export interface ModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ProviderTool[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** How hard the model should think. Providers that support it forward this. */
  readonly reasoningEffort?: "low" | "medium" | "high";
}

export type ModelStreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "tool_call"; readonly callId: string; readonly toolName: string; readonly input: JsonObject }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "completed"; readonly finishReason: "stop" | "tool_call" | "length" };

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  chat(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

/** Empty object schema, used by tools that take no arguments. */
export const EMPTY_PARAMETERS: JsonObject = { type: "object", properties: {}, additionalProperties: false };

export interface FakeTurn {
  readonly events: readonly ModelStreamEvent[];
  readonly delayMs?: number;
}

export class FakeProvider implements ModelProvider {
  readonly name = "fake";
  readonly model: string;
  private readonly turns: readonly FakeTurn[];
  private turnIndex = 0;

  constructor(turns: readonly FakeTurn[] = [], model = "fake-model") {
    this.turns = turns;
    this.model = model;
  }

  chat(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const scripted = this.turns[this.turnIndex++];
    const turn: FakeTurn = scripted ?? { events: [{ type: "delta", text: "completed" }, { type: "completed", finishReason: "stop" }] };
    return this.stream(turn, signal);
  }

  private async *stream(turn: FakeTurn, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    for (const event of turn.events) {
      if (signal.aborted) {
        return;
      }
      if (turn.delayMs !== undefined && turn.delayMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, turn.delayMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
      if (signal.aborted) {
        return;
      }
      yield event;
    }
  }
}
