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
import type { AssistantToolCall, ChatMessage, ModelProvider, ModelUsage } from "./provider.js";
import { rebuildConversation } from "./conversation.js";
import { buildSystemPrompt } from "./prompt.js";

export interface ToolExecutor {
  execute(name: string, input: JsonObject, options: ToolExecutionOptions): Promise<ToolExecutionResult>;
}

export interface MemoryReader {
  search(query: string, scope?: "global" | "project" | "task" | "session", scopeId?: string): readonly {
    readonly key: string;
    readonly content: string;
  }[];
  /** Newest records in a scope, so durable memory needs no matching query. */
  list(scope: "global" | "project" | "task" | "session", limit?: number): readonly {
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
  /** How hard the model should think, forwarded on every request. */
  readonly reasoningEffort?: "low" | "medium" | "high";
  /** Defaults to `tools`. Pass a policy-enforcing executor to gate tool calls. */
  readonly executor?: ToolExecutor;
  readonly memory?: MemoryReader;
  readonly compressor?: ContextCompressor;
  readonly contextTokenBudget?: number;
  readonly memoryScope?: { readonly scope: "global" | "project" | "task" | "session"; readonly scopeId?: string };
  /** Model call retries for transient failures (429/5xx). Defaults to 2. */
  readonly modelRetries?: number;
  readonly modelRetryDelayMs?: number;
  /** Prices per 1M tokens, used to report cost per task. */
  readonly pricing?: { readonly inputPerMillion: number; readonly outputPerMillion: number };
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

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "please",
  "a", "an", "to", "of", "in", "on", "is", "it", "me", "my", "we", "you",
  "请", "帮我", "一下", "并", "的", "了", "和", "在", "把"
]);

/** Splits a goal into searchable terms: latin words longer than 2 chars and CJK bigrams. */
export function keywordsOf(goal: string): string[] {
  const terms = new Set<string>();
  for (const word of goal.toLowerCase().match(/[a-z0-9_]{3,}/gu) ?? []) {
    if (!STOP_WORDS.has(word)) {
      terms.add(word);
    }
  }
  for (const run of goal.match(/[一-鿿]{2,}/gu) ?? []) {
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!STOP_WORDS.has(bigram)) {
        terms.add(bigram);
      }
    }
  }
  return [...terms].slice(0, 8);
}

function estimateTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + Math.max(1, Math.ceil(message.content.length / 4)), 0);
}

function eventInput<T extends RuntimeEventInput>(input: T): T {
  return input;
}

/**
 * Index where the trailing assistant-with-tool-calls / tool-results block starts,
 * or -1 when the last message needs no protection. Chat APIs reject tool results
 * whose originating assistant turn was removed.
 */
function trailingToolExchangeStart(messages: readonly ChatMessage[]): number {
  let index = messages.length - 1;
  const isTool = (position: number): boolean => messages[position]?.role === "tool";
  while (index >= 0 && isTool(index)) {
    index -= 1;
  }
  if (index === messages.length - 1) {
    return -1;
  }
  const assistant = messages[index];
  if (assistant?.role === "assistant" && (assistant.toolCalls?.length ?? 0) > 0) {
    return index;
  }
  return -1;
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
  private readonly reasoningEffort: "low" | "medium" | "high" | undefined;
  private readonly executor: ToolExecutor;
  private readonly memory: MemoryReader | undefined;
  private readonly compressor: ContextCompressor | undefined;
  private readonly contextTokenBudget: number;
  private readonly memoryScope: ReActRunnerOptions["memoryScope"];
  private readonly modelRetries: number;
  private readonly modelRetryDelayMs: number;
  private readonly pricing: ReActRunnerOptions["pricing"];

  constructor(options: ReActRunnerOptions) {
    this.ledger = options.ledger;
    this.provider = options.provider;
    this.tools = options.tools;
    this.workspaceRoot = options.workspaceRoot;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 30_000;
    this.maxTurns = options.maxTurns ?? 8;
    this.reasoningEffort = options.reasoningEffort;
    this.executor = options.executor ?? options.tools;
    this.memory = options.memory;
    this.compressor = options.compressor;
    this.contextTokenBudget = options.contextTokenBudget ?? 8_000;
    this.memoryScope = options.memoryScope;
    this.modelRetries = options.modelRetries ?? 2;
    this.modelRetryDelayMs = options.modelRetryDelayMs ?? 500;
    this.pricing = options.pricing;
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
    // Set before the first await so two callers cannot both pass the check.
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

      const baseMessages: ChatMessage[] = [
        {
          role: "system",
          content: buildSystemPrompt({
            ...(this.workspaceRoot === undefined ? {} : { workspaceRoot: this.workspaceRoot }),
            toolNames: this.tools.list().map((tool) => tool.name)
          })
        }
      ];
      const memory = this.recall(task.profile.goal);
      if (memory !== "") {
        baseMessages.push({ role: "system", content: `Relevant memory from earlier tasks:\n${memory}` });
      }

      if (plan.length === 0) {
        // A resume after an approval replays the calls the gate blocked, so the
        // side effect happens before the model is asked anything else.
        if (task.status === TASK_STATUSES.PAUSED) {
          const replayed = yield* this.replayGrantedCalls(taskId, sessionId, controller);
          if (replayed) {
            const after = this.ledger.getTask(taskId);
            if (after?.status === TASK_STATUSES.PAUSED) {
              yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.SESSION_ENDED, payload: { sessionId, status: "paused" } }));
              return;
            }
          }
        }
        // A resumed or retried task continues its conversation instead of
        // starting over: the history is rebuilt from the event log.
        const messages: ChatMessage[] = [
          ...baseMessages,
          ...rebuildConversation(this.ledger.getEvents(taskId), task.profile.goal)
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
    // The task may already be terminal: failTask ran, or a caller cancelled it.
    if (latest?.status === TASK_STATUSES.FAILED) {
      yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.SESSION_ENDED, payload: { sessionId, status: "failed" } }));
      return;
    }
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
    const toolSchemas = this.tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));

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
      let usage: ModelUsage | undefined;
      let finishReason: ModelCompletedPayload["finishReason"] = "stop";
      let attempt = 0;
      let lastError: unknown;
      let streamed = false;

      while (attempt <= this.modelRetries) {
        attempt += 1;
        deltas.length = 0;
        toolCalls.length = 0;
        streamed = false;
        try {
          for await (const streamEvent of this.provider.chat({
            ...(this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort }),
            model: this.provider.model,
            messages,
            tools: toolSchemas
          }, controller.signal)) {
            streamed = true;
            if (streamEvent.type === "delta") {
              deltas.push(streamEvent.text);
              yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.MODEL_DELTA, payload: { sessionId, requestId, text: streamEvent.text } }));
            } else if (streamEvent.type === "tool_call") {
              finishReason = "tool_call";
              toolCalls.push({ callId: streamEvent.callId, toolName: streamEvent.toolName, input: streamEvent.input, status: "requested", startedAt: new Date().toISOString() });
            } else if (streamEvent.type === "usage") {
              usage = streamEvent.usage;
            } else {
              finishReason = streamEvent.finishReason;
            }
          }
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          // Only a call that produced no output is safe to replay.
          const retryable = !streamed && !controller.signal.aborted && attempt <= this.modelRetries;
          if (!retryable) {
            break;
          }
          yield this.append(eventInput({
            eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.RETRY_SCHEDULED,
            payload: {
              operation: "model.chat", attempt, maxAttempts: this.modelRetries + 1,
              reason: error instanceof Error ? error.message : String(error)
            }
          }));
          await new Promise((resolve) => setTimeout(resolve, this.modelRetryDelayMs * attempt));
        }
      }

      if (lastError !== undefined) {
        const modelFailure = failure(lastError);
        yield this.append(eventInput({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.MODEL_FAILED, payload: { sessionId, requestId, error: modelFailure } }));
        if (!controller.signal.aborted) {
          yield* this.failTask(taskId, sessionId, modelFailure);
        }
        return "aborted";
      }

      const text = deltas.join("");
      const assistantCalls: AssistantToolCall[] = toolCalls.map((call) => ({
        callId: call.callId,
        toolName: call.toolName,
        input: call.input
      }));
      // Chat APIs require the assistant turn to carry the tool calls it made.
      messages.push({
        role: "assistant",
        content: text,
        ...(assistantCalls.length === 0 ? {} : { toolCalls: assistantCalls })
      });
      const costUsd = this.costOf(usage);
      yield this.append(eventInput({
        eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.MODEL_COMPLETED,
        payload: {
          sessionId, requestId, text, finishReason,
          ...(usage === undefined ? {} : { usage }),
          ...(costUsd === undefined ? {} : { costUsd })
        }
      }));
      if (controller.signal.aborted) {
        return "aborted";
      }
      // Compress before deciding the turn is over: a conversation that only
      // chats would otherwise never compact and would grow past the budget.
      yield* this.maybeCompress(taskId, messages);
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

  private costOf(usage: ModelUsage | undefined): number | undefined {
    if (usage === undefined || this.pricing === undefined) {
      return undefined;
    }
    return (
      (usage.promptTokens / 1_000_000) * this.pricing.inputPerMillion +
      (usage.completionTokens / 1_000_000) * this.pricing.outputPerMillion
    );
  }

  /**
   * Gathers memory for the prompt.
   *
   * Keyword matching alone was not enough: a fact saved as "always use pnpm,
   * never npm" was never injected for a goal like "install a dependency",
   * because no word overlapped. Durable project memory is therefore always
   * included, budget permitting, and keyword hits are added on top for the
   * narrower scopes.
   */
  private recall(goal: string, budgetChars = 4_000): string {
    if (this.memory === undefined) {
      return "";
    }
    const scopes: readonly ("global" | "project" | "task" | "session")[] =
      this.memoryScope === undefined ? ["global", "project"] : [this.memoryScope.scope];

    const chosen = new Map<string, { key: string; content: string }>();
    const take = (record: { key: string; content: string }) => {
      chosen.set(`${record.key}\u0000${record.content}`, record);
    };

    // Everything durable first, newest first, so conventions are never missed.
    for (const scope of scopes) {
      for (const record of this.memory.list(scope, 40)) {
        take(record);
      }
    }
    // Then anything matching the goal, which reaches task- and session-scoped rows.
    for (const keyword of keywordsOf(goal)) {
      const found = this.memoryScope === undefined
        ? this.memory.search(keyword)
        : this.memory.search(keyword, this.memoryScope.scope, this.memoryScope.scopeId);
      for (const record of found) {
        take(record);
      }
    }

    if (chosen.size === 0) {
      return "";
    }
    const lines: string[] = [];
    let used = 0;
    for (const record of chosen.values()) {
      const line = `- ${record.key}: ${record.content}`;
      if (used + line.length > budgetChars) {
        break;
      }
      used += line.length;
      lines.push(line);
    }
    return lines.length === 0 ? "" : ["Known context:", ...lines].join("\n");
  }

  private async *maybeCompress(taskId: string, messages: ChatMessage[]): AsyncGenerator<RuntimeEvent> {
    if (this.compressor === undefined || estimateTokens(messages) <= this.contextTokenBudget) {
      return;
    }
    const result = await this.compressor.compress(messages);
    // Keep the trailing tool exchange: dropping it would leave tool results
    // without their assistant tool_calls and the next request would be rejected.
    const keepFrom = trailingToolExchangeStart(messages);
    const tail = keepFrom === -1 ? [] : messages.slice(keepFrom);
    messages.length = 0;
    messages.push({ role: "system", content: result.summary });
    messages.push(...tail);
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
    if (active !== undefined) {
      this.ledger.appendEvent({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_CANCELLED, payload: { reason: "cancelled by caller" } });
      active.controller.abort(new Error("cancelled by caller"));
      return;
    }
    // A task that is not mid-run can still be cancelled: the state machine
    // allows it from pending, paused and failed, which is what a user pressing
    // Stop on a paused conversation expects.
    const state = this.ledger.getTask(taskId);
    if (state === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.TASK_NOT_FOUND, message: `Task ${taskId} was not found` });
    }
    this.ledger.appendEvent({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_CANCELLED, payload: { reason: "cancelled by caller" } });
  }

  /**
   * Restores the newest checkpoint so the task can run again.
   * Compensation for external effects is the caller's responsibility (see @agent/policy).
   *
   * A terminal task cannot be restored in place — the state machine refuses it,
   * and a user pressing Rollback is almost always looking at a finished task —
   * so the task is reopened first and then restored.
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
    const state = this.ledger.getTask(taskId);
    if (state === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.TASK_NOT_FOUND, message: `Task ${taskId} was not found` });
    }
    if (state.status === TASK_STATUSES.COMPLETED || state.status === TASK_STATUSES.CANCELLED) {
      // Reopen with a user turn so the restored run has somewhere to continue.
      this.ledger.appendEvent({
        eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.USER_MESSAGE,
        payload: { text: "Roll back to the last checkpoint and continue from there." }
      });
    }
    if (this.ledger.getTask(taskId)?.status === TASK_STATUSES.PENDING) {
      this.ledger.appendEvent({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_STARTED, payload: { reason: "rollback" } });
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

  /**
   * Runs the tool calls a granted approval unblocked. Approval pauses the task
   * with the call already recorded on `tool.requested`, so resuming must replay
   * those calls instead of asking the model to issue them again.
   */
  private async *replayGrantedCalls(taskId: string, sessionId: string, controller: AbortController): AsyncGenerator<RuntimeEvent, boolean> {
    const events = this.ledger.getEvents(taskId);
    const answered = new Set<string>();
    for (const event of events) {
      if (event.type === "tool.completed" || event.type === "tool.timed_out" || event.type === "tool.cancelled") {
        answered.add(event.payload.callId);
      }
      // A blocked call is recorded as failed so the ledger stays truthful, but
      // it never ran: approval is what unblocks it, so it must be replayed.
      if (event.type === "tool.failed" && this.pendingApprovalId(event.payload.error) === undefined) {
        answered.add(event.payload.callId);
      }
    }
    const pending = events.flatMap((event) =>
      event.type === "tool.requested" && !answered.has(event.payload.call.callId)
        ? [event.payload.call]
        : []
    );
    if (pending.length === 0) {
      return false;
    }
    for (const call of pending) {
      // A rejection is a decision, not a reason to ask again: record the call
      // as failed and let the model report it.
      if (this.wasRejected(taskId, call.toolName)) {
        yield this.append(eventInput({
          eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TOOL_FAILED,
          payload: {
            sessionId,
            callId: call.callId,
            error: { code: ERROR_CODES.PERMISSION_DENIED, message: `The user rejected ${call.toolName}` },
            completedAt: new Date().toISOString(),
            durationMs: 0
          }
        }));
        continue;
      }
      const approvalId = this.latestApprovalFor(taskId, call.toolName);
      const result = await this.executor.execute(call.toolName, call.input, {
        signal: controller.signal,
        timeoutMs: this.toolTimeoutMs,
        metadata: {
          taskId,
          callId: call.callId,
          ...(approvalId === undefined ? {} : { approvalId })
        },
        ...(this.workspaceRoot === undefined ? {} : { workspaceRoot: this.workspaceRoot })
      });
      yield this.appendToolResult(taskId, sessionId, call.callId, result);
      if (result.status === "failed" && result.error.code === ERROR_CODES.PERMISSION_DENIED) {
        yield this.append(eventInput({
          eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.TASK_PAUSED,
          payload: { reason: `approval required for ${call.toolName}` }
        }));
        return true;
      }
    }
    return true;
  }

  /** The approval id carried by a permission-denied failure, if it had one. */
  private pendingApprovalId(error: TaskFailure): string | undefined {
    if (error.code !== ERROR_CODES.PERMISSION_DENIED) {
      return undefined;
    }
    const id = error.details?.approvalId;
    return typeof id === "string" ? id : undefined;
  }

  /** Whether the newest approval for a tool was rejected by the user. */
  private wasRejected(taskId: string, toolName: string): boolean {
    let latest: { id: string; rejected: boolean } | undefined;
    for (const event of this.ledger.getEvents(taskId)) {
      if (event.type === "approval.requested" && event.payload.toolName === toolName) {
        latest = { id: event.payload.approvalId, rejected: false };
      }
      if (event.type === "approval.resolved" && event.payload.approvalId === latest?.id) {
        latest = { id: latest.id, rejected: event.payload.decision === "rejected" };
      }
    }
    return latest?.rejected === true;
  }

  /** The most recent approved approval id for a tool, if any. */
  private latestApprovalFor(taskId: string, toolName: string): string | undefined {
    let found: string | undefined;
    for (const event of this.ledger.getEvents(taskId)) {
      if (event.type === "approval.requested" && event.payload.toolName === toolName) {
        found = event.payload.approvalId;
      }
      if (event.type === "approval.resolved" && event.payload.decision === "rejected" && event.payload.approvalId === found) {
        found = undefined;
      }
    }
    return found;
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
