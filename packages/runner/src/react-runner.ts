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
import type { ToolExecutionOptions, ToolExecutionResult, ToolRegistry } from "@agent/tools";
import type { ChatMessage, ModelProvider } from "./provider.js";

export interface ToolExecutor {
  execute(name: string, input: JsonObject, options: ToolExecutionOptions): Promise<ToolExecutionResult>;
}

export interface MemoryReader {
  search(query: string, scope?: "global" | "project" | "task" | "session", scopeId?: string): readonly {
    readonly key: string;
    readonly content: string;
  }[];
}

export interface CompressionOutcome {
  readonly compressionId: string;
  readonly summary: string;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly reductionRatio: number;
  readonly quality: { readonly passed: boolean; readonly preservedConstraints: readonly string[] };
}

export interface ContextCompressor {
  compress(
    messages: readonly ChatMessage[],
    options?: { readonly requiredConstraints?: readonly string[] }
  ): Promise<CompressionOutcome>;
}

export interface ReActRunnerOptions {
  readonly ledger: TaskLedger;
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly workspaceRoot: string | undefined;
  readonly toolTimeoutMs?: number;
  readonly maxTurns?: number;
  /** Defaults to `tools`. Pass a policy-enforcing executor to gate tool calls. */
  readonly executor?: ToolExecutor;
  readonly memory?: MemoryReader;
  readonly compressor?: ContextCompressor;
  readonly contextTokenBudget?: number;
  readonly memoryScope?: { readonly scope: "global" | "project" | "task" | "session"; readonly scopeId?: string };
}

interface ActiveRun {
  readonly sessionId: string;
  readonly controller: AbortController;
}

export function failure(error: unknown): TaskFailure {
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

function estimateTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + Math.max(1, Math.ceil(message.content.length / 4)), 0);
}

function eventInput<T extends RuntimeEventInput>(input: T): T {
  return input;
}

function lastAssistantText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message.content;
    }
  }
  return "";
}

export class ReActRunner implements Runner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly ledger: TaskLedger;
  private readonly provider: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly workspaceRoot: string | undefined;
  private readonly toolTimeoutMs: number;
  private readonly maxTurns: number;
  private readonly executor: ToolExecutor;
  private readonly memory: MemoryReader | undefined;
  private readonly compressor: ContextCompressor | undefined;
  private readonly contextTokenBudget: number;
  private readonly memoryScope: ReActRunnerOptions["memoryScope"];

  constructor(options: ReActRunnerOptions) {
    this.ledger = options.ledger;
    this.provider = options.provider;
    this.tools = options.tools;
    this.workspaceRoot = options.workspaceRoot;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 30_000;
    this.maxTurns = options.maxTurns ?? 8;
    this.executor = options.executor ?? options.tools;
    this.memory = options.memory;
    this.compressor = options.compressor;
    this.contextTokenBudget = options.contextTokenBudget ?? 8_000;
    this.memoryScope = options.memoryScope;
  }

  async *run(taskId: string): AsyncIterable<RuntimeEvent> {
    yield* this.execute(taskId, []);
  }

  /** Executes one ReAct pass per plan step and records `task.step_completed` for each. */
  async *runPlan(taskId: string, plan: readonly string[]): AsyncIterable<RuntimeEvent> {
    if (plan.length === 0) {
      throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "Planner returned no steps" });
    }
    yield* this.execute(taskId, plan);
  }

  private async *execute(taskId: string, plan: readonly string[]): AsyncIterable<RuntimeEvent> {
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
    try {
      if (task.status === TASK_STATUSES.PENDING) {
        yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_STARTED, payload: {} }));
      } else if (task.status === TASK_STATUSES.PAUSED) {
        yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_RESUMED, payload: {} }));
      }
      yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.SESSION_STARTED, payload: { sessionId } }));

      const baseMessages: ChatMessage[] = [];
      const memory = this.recall(task.profile.goal);
      if (memory !== "") {
        baseMessages.push({ role: "system", content: memory });
      }

      if (plan.length === 0) {
        const messages: ChatMessage[] = [
          ...baseMessages,
          { role: "user", content: task.profile.goal }
        ];
        const outcome = yield* this.runTurns(taskId, sessionId, controller, messages);
        if (outcome === "completed") {
          yield this.append(eventInput({
            eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_COMPLETED,
            payload: { summary: lastAssistantText(messages) }
          }));
          yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.SESSION_ENDED, payload: { sessionId, status: "completed" } }));
          return;
        }
      } else {
        const messages: ChatMessage[] = [...baseMessages];
        for (const [index, step] of plan.entries()) {
          messages.push({ role: "user", content: `Step ${index + 1}/${plan.length}: ${step}` });
          const outcome = yield* this.runTurns(taskId, sessionId, controller, messages);
          if (outcome !== "completed") {
            yield* this.finishAborted(taskId, sessionId);
            return;
          }
          yield this.append(eventInput({
            eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_STEP_COMPLETED,
            payload: { step, index }
          }));
        }
        const completed = (this.ledger.getTask(taskId)?.completedSteps ?? []).join("; ");
        yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_COMPLETED, payload: { summary: completed } }));
        yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.SESSION_ENDED, payload: { sessionId, status: "completed" } }));
        return;
      }

      yield* this.finishAborted(taskId, sessionId);
    } finally {
      this.active.delete(taskId);
    }
  }

  private *finishAborted(taskId: string, sessionId: string): Generator<RuntimeEvent> {
    const latest = this.ledger.getTask(taskId);
    const endingStatus = latest?.status === TASK_STATUSES.PAUSED ? "paused" : latest?.status === TASK_STATUSES.CANCELLED ? "cancelled" : "failed";
    if (endingStatus === "failed") {
      yield* this.failTask(taskId, sessionId, { code: ERROR_CODES.INTERNAL, message: "Maximum turns reached or run aborted", retryable: true });
    }
    yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.SESSION_ENDED, payload: { sessionId, status: endingStatus } }));
  }

  private async *runTurns(
    taskId: string,
    sessionId: string,
    controller: AbortController,
    messages: ChatMessage[]
  ): AsyncGenerator<RuntimeEvent, "completed" | "aborted"> {
    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      if (controller.signal.aborted) {
        return "aborted";
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
        return "aborted";
      }
      const text = deltas.join("");
      messages.push({ role: "assistant", content: text });
      yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.MODEL_COMPLETED, payload: { sessionId, requestId, text, finishReason } }));
      if (controller.signal.aborted) {
        return "aborted";
      }
      if (toolCalls.length === 0) {
        return "completed";
      }
      for (const call of toolCalls) {
        yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TOOL_REQUESTED, payload: { sessionId, call } }));
        const result = await this.executor.execute(call.toolName, call.input, {
          signal: controller.signal,
          timeoutMs: this.toolTimeoutMs,
          metadata: { taskId, callId: call.callId },
          ...(this.workspaceRoot === undefined ? {} : { workspaceRoot: this.workspaceRoot })
        });
        yield this.appendToolResult(taskId, sessionId, call.callId, result);
        messages.push({ role: "tool", toolCallId: call.callId, content: JSON.stringify(result) });
        if (controller.signal.aborted) {
          return "aborted";
        }
        // A pending approval is a human gate: stop here instead of letting the
        // model declare success without performing the side effect.
        if (result.status === "failed" && result.error.code === ERROR_CODES.PERMISSION_DENIED && result.error.details?.approvalId !== undefined) {
          yield this.append(eventInput({
            eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_PAUSED,
            payload: { reason: `approval required for ${call.toolName}` }
          }));
          return "aborted";
        }
      }
      yield* this.maybeCompress(taskId, messages);
    }
    return "aborted";
  }

  private recall(goal: string): string {
    if (this.memory === undefined) {
      return "";
    }
    const found = this.memoryScope === undefined
      ? this.memory.search(goal)
      : this.memory.search(goal, this.memoryScope.scope, this.memoryScope.scopeId);
    const relevant = found.slice(0, 5);
    if (relevant.length === 0) {
      return "";
    }
    return ["Known context:", ...relevant.map((record) => `- ${record.key}: ${record.content}`)].join("\n");
  }

  private async *maybeCompress(taskId: string, messages: ChatMessage[]): AsyncGenerator<RuntimeEvent> {
    if (this.compressor === undefined || estimateTokens(messages) <= this.contextTokenBudget) {
      return;
    }
    const result = await this.compressor.compress(messages);
    messages.length = 0;
    messages.push({ role: "system", content: result.summary });
    yield this.append(eventInput({
      eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.CONTEXT_COMPRESSED,
      payload: {
        compressionId: result.compressionId,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        reductionRatio: result.reductionRatio,
        qualityPassed: result.quality.passed,
        preservedConstraints: [...result.quality.preservedConstraints]
      }
    }));
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

  /**
   * Restores the newest checkpoint and marks the task running again.
   * Compensation for external effects is the caller's responsibility (see @agent/policy).
   */
  async rollback(taskId: string): Promise<void> {
    const checkpoints = this.ledger.listCheckpoints(taskId);
    const target = checkpoints.at(-1);
    if (target === undefined) {
      throw new RuntimeError({
        code: ERROR_CODES.CHECKPOINT_NOT_FOUND,
        message: `Task ${taskId} has no checkpoint to roll back to`,
        details: { taskId }
      });
    }
    this.ledger.appendEvent({
      eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.RECOVERY_STARTED,
      payload: { checkpointId: target.checkpointId, reason: "rollback by caller" }
    });
    this.ledger.restoreCheckpoint(taskId, target.checkpointId);
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
