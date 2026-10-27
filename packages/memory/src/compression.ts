import { randomUUID } from "node:crypto";
import { RUNTIME_EVENT_TYPES, RuntimeError } from "@agent/protocol";
import type { ContextCompressedPayload } from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";

export interface ContextMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface CompressionQuality {
  readonly passed: boolean;
  readonly preservedConstraints: readonly string[];
  readonly missingConstraints: readonly string[];
}

export interface CompressionResult {
  readonly compressionId: string;
  readonly original: readonly ContextMessage[];
  readonly summary: string;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly reductionRatio: number;
  readonly quality: CompressionQuality;
}

export interface CompressionOptions {
  readonly requiredConstraints?: readonly string[];
  readonly ledger?: TaskLedger;
  readonly taskId?: string;
  readonly summarizer?: (messages: readonly ContextMessage[]) => string | Promise<string>;
}

function estimateTokens(messages: readonly ContextMessage[]): number { return messages.reduce((sum, message) => sum + Math.max(1, Math.ceil(message.content.length / 4)), 0); }

function defaultSummary(messages: readonly ContextMessage[]): string {
  const constraints = messages.flatMap((message) => message.content.split(/[.!?\n]/u).map((line) => line.trim()).filter((line) => /\b(must|required|constraint|禁止|必须|不得)\b/iu.test(line)));
  const tail = messages.slice(-1).map((message) => `${message.role}: ${message.content}`).join("\n");
  return [...constraints, tail].filter(Boolean).join("\n");
}

export class ContextCompressor {
  async compress(messages: readonly ContextMessage[], options: CompressionOptions = {}): Promise<CompressionResult> {
    if (messages.length === 0) throw new RuntimeError({ code: "INVALID_INPUT", message: "Cannot compress an empty context" });
    const original = messages.map((message) => ({ ...message }));
    const summary = await (options.summarizer?.(original) ?? defaultSummary(original));
    const required = options.requiredConstraints ?? [];
    const preserved = required.filter((constraint) => summary.includes(constraint));
    const missing = required.filter((constraint) => !summary.includes(constraint));
    const beforeTokens = estimateTokens(original);
    const afterTokens = Math.max(1, Math.ceil(summary.length / 4));
    const result: CompressionResult = { compressionId: randomUUID(), original, summary, beforeTokens, afterTokens, reductionRatio: Math.max(0, 1 - afterTokens / beforeTokens), quality: { passed: missing.length === 0, preservedConstraints: preserved, missingConstraints: missing } };
    if (options.ledger !== undefined && options.taskId !== undefined) {
      const payload: ContextCompressedPayload = { compressionId: result.compressionId, beforeTokens, afterTokens, reductionRatio: result.reductionRatio, qualityPassed: result.quality.passed, preservedConstraints: preserved };
      options.ledger.appendEvent({ eventId: randomUUID(), taskId: options.taskId, type: RUNTIME_EVENT_TYPES.CONTEXT_COMPRESSED, payload });
    }
    return result;
  }
}
