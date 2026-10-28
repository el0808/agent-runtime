import type { JsonObject } from "@agent/protocol";

/** A tool call carried on an assistant message, as required by every chat API. */
export interface AssistantToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly input: JsonObject;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /** Set on `tool` messages: which assistant tool call this responds to. */
  readonly toolCallId?: string;
  /** Set on `assistant` messages that requested tools. */
  readonly toolCalls?: readonly AssistantToolCall[];
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
