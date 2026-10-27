import { randomUUID } from "node:crypto";
import { ERROR_CODES, RUNTIME_EVENT_TYPES, RuntimeError, TASK_STATUSES } from "@agent/protocol";
import type {
  JsonObject,
  ModelCompletedPayload,
  RuntimeEvent,
  RuntimeEventInput,
  Runner,
  TaskFailure,
  ToolCall
} from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";
import type { ToolExecutionResult, ToolRegistry } from "@agent/tools";
import type { ChatMessage, ModelProvider } from "./provider.js";

export interface ReActRunnerOptions {
  readonly ledger: TaskLedger;
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly workspaceRoot: string | undefined;
  readonly toolTimeoutMs?: number;
  readonly maxTurns?: number;
}

interface ActiveRun {
  readonly sessionId: string;
  readonly controller: AbortController;
}

function failure(error: unknown): TaskFailure {
  if (error instanceof RuntimeError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details as JsonObject };
  }
  if (error instanceof Error) {
    return { code: ERROR_CODES.INTERNAL, message: error.message, retryable: true };
  }
  return { code: ERROR_CODES.INTERNAL, message: String(error), retryable: true };
}

function eventInput<T extends RuntimeEventInput>(input: T): T {
  return input;
}

export class ReActRunner implements Runner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly ledger: TaskLedger;
  private readonly provider: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly workspaceRoot: string | undefined;
  private readonly toolTimeoutMs: number;
  private readonly maxTurns: number;

  constructor(options: ReActRunnerOptions) {
    this.ledger = options.ledger;
    this.provider = options.provider;
    this.tools = options.tools;
    this.workspaceRoot = options.workspaceRoot;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 30_000;
    this.maxTurns = options.maxTurns ?? 8;
  }

  async *run(taskId: string): AsyncIterable<RuntimeEvent> {
    const task = this.ledger.getTask(taskId);
    if (task === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.TASK_NOT_FOUND, message: `Task ${taskId} was not found` });
    }
    if (task.status === TASK_STATUSES.COMPLETED || task.status === TASK_STATUSES.CANCELLED) {
      throw new RuntimeError({ code: ERROR_CODES.INVALID_STATE_TRANSITION, message: `Task ${taskId} is ${task.status}` });
    }
    if (this.active.has(taskId)) {
      throw new RuntimeError({ code: ERROR_CODES.CONFLICT, message: `Task ${taskId} is already running` });
    }

    const sessionId = randomUUID();
    const controller = new AbortController();
    this.active.set(taskId, { sessionId, controller });
    const messages: ChatMessage[] = [{ role: "user", content: task.profile.goal }];
    try {
      if (task.status === TASK_STATUSES.PENDING) {
        yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_STARTED, payload: {} }));
      } else if (task.status === TASK_STATUSES.PAUSED) {
        yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_RESUMED, payload: {} }));
      }
      yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.SESSION_STARTED, payload: { sessionId } }));

      for (let turn = 1; turn <= this.maxTurns; turn += 1) {
        if (controller.signal.aborted) {
          break;
        }
        const requestId = randomUUID();
        yield this.append(eventInput({
          eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.MODEL_REQUESTED,
          payload: { sessionId, requestId, provider: this.provider.name, model: this.provider.model, turn, messageCount: messages.length }
        }));
        const deltas: string[] = [];
        const toolCalls: ToolCall[] = [];
        let finishReason: ModelCompletedPayload["finishReason"] = "stop";
        try {
          for await (const streamEvent of this.provider.chat({
            model: this.provider.model,
            messages,
            tools: this.tools.list().map((tool) => ({ name: tool.name, description: tool.description }))
          }, controller.signal)) {
            if (streamEvent.type === "delta") {
              deltas.push(streamEvent.text);
              yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.MODEL_DELTA, payload: { sessionId, requestId, text: streamEvent.text } }));
            } else if (streamEvent.type === "tool_call") {
              finishReason = "tool_call";
              toolCalls.push({ callId: streamEvent.callId, toolName: streamEvent.toolName, input: streamEvent.input, status: "requested", startedAt: new Date().toISOString() });
            } else {
              finishReason = streamEvent.finishReason;
            }
          }
        } catch (error) {
          const modelFailure = failure(error);
          yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.MODEL_FAILED, payload: { sessionId, requestId, error: modelFailure } }));
          if (!controller.signal.aborted) {
            yield* this.failTask(taskId, sessionId, modelFailure);
          }
          return;
        }
        const text = deltas.join("");
        messages.push({ role: "assistant", content: text });
        yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.MODEL_COMPLETED, payload: { sessionId, requestId, text, finishReason } }));
        if (controller.signal.aborted) {
          break;
        }
        if (toolCalls.length === 0) {
          yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_COMPLETED, payload: { summary: text } }));
          yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.SESSION_ENDED, payload: { sessionId, status: "completed" } }));
          return;
        }
        for (const call of toolCalls) {
          yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TOOL_REQUESTED, payload: { sessionId, call } }));
          const result = await this.tools.execute(call.toolName, call.input, {
            signal: controller.signal,
            timeoutMs: this.toolTimeoutMs,
            ...(this.workspaceRoot === undefined ? {} : { workspaceRoot: this.workspaceRoot })
          });
          yield this.appendToolResult(taskId, sessionId, call.callId, result);
          messages.push({ role: "tool", toolCallId: call.callId, content: JSON.stringify(result) });
          if (controller.signal.aborted) {
            break;
          }
        }
      }
      const latest = this.ledger.getTask(taskId);
      const endingStatus = latest?.status === TASK_STATUSES.PAUSED ? "paused" : latest?.status === TASK_STATUSES.CANCELLED ? "cancelled" : "failed";
      if (endingStatus === "failed") {
        yield* this.failTask(taskId, sessionId, { code: ERROR_CODES.INTERNAL, message: "Maximum turns reached or run aborted", retryable: true });
      }
      yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.SESSION_ENDED, payload: { sessionId, status: endingStatus } }));
    } finally {
      this.active.delete(taskId);
    }
  }

  async pause(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (active === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.NOT_FOUND, message: `Task ${taskId} is not running` });
    }
    this.ledger.appendEvent({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_PAUSED, payload: { reason: "paused by caller" } });
    active.controller.abort(new Error("paused by caller"));
  }

  async resume(taskId: string): Promise<void> {
    const state = this.ledger.getTask(taskId);
    if (state?.status !== TASK_STATUSES.PAUSED) {
      throw new RuntimeError({ code: ERROR_CODES.INVALID_STATE_TRANSITION, message: `Task ${taskId} is not paused` });
    }
    this.ledger.appendEvent({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_RESUMED, payload: {} });
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (active === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.NOT_FOUND, message: `Task ${taskId} is not running` });
    }
    this.ledger.appendEvent({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_CANCELLED, payload: { reason: "cancelled by caller" } });
    active.controller.abort(new Error("cancelled by caller"));
  }

  async rollback(taskId: string): Promise<void> {
    void taskId;
    throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "Rollback is implemented in Phase 4" });
  }

  private append<T extends RuntimeEventInput>(input: T): RuntimeEvent {
    return this.ledger.appendEvent(input).event;
  }

  private appendToolResult(taskId: string, sessionId: string, callId: string, result: ToolExecutionResult): RuntimeEvent {
    if (result.status === "succeeded") {
      return this.append({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TOOL_COMPLETED, payload: { sessionId, callId, output: result.output, completedAt: result.completedAt, durationMs: result.durationMs } });
    }
    if (result.status === "timed_out") {
      return this.append({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TOOL_TIMED_OUT, payload: { sessionId, callId, timeoutMs: result.timeoutMs, completedAt: result.completedAt, durationMs: result.durationMs } });
    }
    if (result.status === "cancelled") {
      return this.append({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TOOL_CANCELLED, payload: { sessionId, callId, reason: result.reason, completedAt: result.completedAt, durationMs: result.durationMs } });
    }
    return this.append({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TOOL_FAILED, payload: { sessionId, callId, error: result.error, completedAt: result.completedAt, durationMs: result.durationMs } });
  }

  private *failTask(taskId: string, sessionId: string, error: TaskFailure): Generator<RuntimeEvent> {
    yield this.append({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_FAILED, payload: { error } });
    yield this.append({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.SESSION_ENDED, payload: { sessionId, status: "failed" } });
  }

}
