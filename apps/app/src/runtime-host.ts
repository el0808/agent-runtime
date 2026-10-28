import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { RunnerType, RuntimeEvent, TaskState } from "@agent/protocol";
import { AgentRuntime, newTaskId } from "@agent/runtime";
import { AnthropicProvider, OpenAIChatProvider, providerFromEnv, type ModelProvider, type ProviderSelection } from "@agent/runner";
import type { AppSettings } from "./settings.js";

export interface RuntimeHostOptions {
  readonly storageDir: string;
  readonly secretFor: (provider: "openai" | "anthropic") => string | undefined;
  readonly emit: (event: RuntimeEvent) => void;
}

/** Everything the memory panel shows: where a fact came from and how sure it is. */
export interface MemoryView {
  readonly memoryId: string;
  readonly key: string;
  readonly scope: string;
  readonly content: string;
  readonly version: number;
  readonly source: string;
  readonly confidence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

function toMemoryView(record: {
  readonly memoryId: string;
  readonly key: string;
  readonly scope: string;
  readonly content: string;
  readonly version: number;
  readonly source: string;
  readonly confidence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}): MemoryView {
  return {
    memoryId: record.memoryId,
    key: record.key,
    scope: record.scope,
    content: record.content,
    version: record.version,
    source: record.source,
    confidence: record.confidence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt })
  };
}

export interface TaskSummary {
  readonly taskId: string;
  readonly goal: string;
  readonly runnerType: string;
  readonly status: string;
  readonly sequence: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly costUsd: number;
  /** Prompt tokens of the most recent model call: the live context size. */
  readonly contextTokens: number;
  /** How many times the context was compacted during this task. */
  readonly compressions: number;
  /** Token budget the runner compacts against. */
  readonly contextBudget: number;
}

/** Sums the cost recorded on model.completed events for one task. */
function taskCost(events: readonly RuntimeEvent[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type === "model.completed") {
      const cost = event.payload.costUsd;
      if (typeof cost === "number") {
        total += cost;
      }
    }
  }
  return total;
}

/**
 * The freshest prompt-token count, read from the newest model call rather than
 * derived from the event count: only the model knows how big its context is.
 */
function contextUsage(events: readonly RuntimeEvent[]): { tokens: number; compressions: number } {
  let tokens = 0;
  let compressions = 0;
  for (const event of events) {
    if (event.type === "model.completed" && typeof event.payload.usage?.promptTokens === "number") {
      tokens = event.payload.usage.promptTokens;
    }
    if (event.type === "context.compressed") {
      compressions += 1;
    }
  }
  return { tokens, compressions };
}

function summaryOf(state: TaskState, events: readonly RuntimeEvent[], budget: number): TaskSummary {
  const usage = contextUsage(events);
  return {
    taskId: state.taskId,
    goal: state.profile.goal,
    runnerType: state.profile.runnerType,
    status: state.status,
    sequence: state.lastEventSequence,
    steps: state.completedSteps.length,
    toolCalls: state.toolCalls.length,
    costUsd: taskCost(events),
    contextTokens: usage.tokens,
    compressions: usage.compressions,
    contextBudget: budget
  };
}

/**
 * Owns the runtime for the app. Runs inside Electron's main process, so the
 * renderer never touches the ledger, the filesystem or the API key.
 */
export class RuntimeHost {
  private runtime: AgentRuntime | undefined;
  private readonly options: RuntimeHostOptions;

  constructor(options: RuntimeHostOptions) {
    this.options = options;
  }

  /** Rebuilds the runtime after a settings change, keeping the same storage. */
  configure(settings: AppSettings): { provider: string; model: string; live: boolean; reason: string } {
    this.dispose();
    const provider = this.buildProvider(settings);
    this.runtime = new AgentRuntime({
      config: {
        storageDir: this.options.storageDir,
        workspaceRoot: this.resolveWorkspace(settings),
        autoApproveMedium: settings.autoApproveMedium,
        contextTokenBudget: settings.contextTokenBudget,
        reasoningEffort: settings.reasoningEffort,
        allowOutsideWorkspace: settings.allowOutsideWorkspace,
        ...(settings.inputPricePerMillion > 0
          ? { pricing: { inputPerMillion: settings.inputPricePerMillion, outputPerMillion: settings.outputPricePerMillion } }
          : {})
      },
      provider
    });
    this.runtime.events.subscribe(this.options.emit);
    return {
      provider: this.runtime.providerSelection.provider.name,
      model: this.runtime.providerSelection.provider.model,
      live: this.runtime.providerSelection.live,
      reason: this.runtime.providerSelection.reason
    };
  }

  private resolveWorkspace(settings: AppSettings): string {
    if (settings.workspaceRoot !== "" && existsSync(settings.workspaceRoot)) {
      return settings.workspaceRoot;
    }
    // Default to the user's home so a fresh install can read something useful.
    return process.env.HOME ?? path.dirname(this.options.storageDir);
  }

  private buildProvider(settings: AppSettings): ModelProvider {
    if (settings.provider === "fake") {
      const selection: ProviderSelection = providerFromEnv({ AGENT_PROVIDER: "fake", ...process.env });
      return selection.provider;
    }
    if (settings.provider === "anthropic") {
      const apiKey = this.options.secretFor("anthropic");
      if (apiKey !== undefined && apiKey !== "") {
        return new AnthropicProvider({ apiKey, model: settings.model });
      }
      return providerFromEnv({ ...process.env, AGENT_PROVIDER: "fake" }).provider;
    }
    const apiKey = this.options.secretFor("openai");
    if (apiKey !== undefined && apiKey !== "") {
      return new OpenAIChatProvider({
        apiKey,
        model: settings.model,
        maxTokens: 4_096,
        ...(settings.baseUrl === "" ? {} : { baseUrl: settings.baseUrl })
      });
    }
    // No key yet: fall back so the app still starts and explains itself.
    return providerFromEnv({ ...process.env, AGENT_PROVIDER: "fake" }).provider;
  }

  /** Lists models from the configured endpoint, for the settings picker. */
  async listModels(): Promise<{ id: string; contextLength?: number }[]> {
    const provider = this.require().providerSelection.provider;
    const lister = (provider as { listModels?: (signal?: AbortSignal) => Promise<{ id: string; contextLength?: number }[]> }).listModels;
    if (typeof lister !== "function") {
      return [];
    }
    return lister.call(provider);
  }

  private require(): AgentRuntime {
    if (this.runtime === undefined) {
      throw new Error("Runtime is not configured");
    }
    return this.runtime;
  }

  listTasks(): readonly TaskSummary[] {
    const runtime = this.require();
    return runtime.ledger.listTasks(200).map((state) => summaryOf(state, runtime.getEvents(state.taskId), runtime.config.contextTokenBudget));
  }

  getTask(taskId: string): TaskSummary | undefined {
    const runtime = this.require();
    const state = runtime.getTask(taskId);
    return state === undefined ? undefined : summaryOf(state, runtime.getEvents(taskId), runtime.config.contextTokenBudget);
  }

  deleteTask(taskId: string): boolean {
    const removed = this.require().deleteTask(taskId);
    if (removed) {
      this.options.emit({
        eventId: randomUUID(),
        taskId,
        sequence: 0,
        occurredAt: new Date().toISOString(),
        type: "task.cancelled",
        payload: { reason: "deleted" }
      } as RuntimeEvent);
    }
    return removed;
  }

  getEvents(taskId: string): readonly RuntimeEvent[] {
    return this.require().getEvents(taskId);
  }

  createAndRun(goal: string, images: readonly { mediaType: string; data: string }[] = [], runnerType?: RunnerType): { taskId: string } {
    const runtime = this.require();
    const taskId = newTaskId();
    // No runner means "auto route": the task is marked so the runtime knows it
    // may pick one, because an explicit choice must never be overridden.
    runtime.createTask({
      taskId,
      goal,
      runnerType: runnerType ?? "direct",
      ...(runnerType === undefined ? { metadata: { autoRoute: true } } : {})
    });
    // Images ride on a user turn so the ledger records what the model saw.
    // The text is left empty: the goal is already the opening turn, and
    // repeating it here would show the message twice in the transcript.
    if (images.length > 0) {
      runtime.sendMessage(taskId, "", images);
    }
    // The run is streamed over the event bus; callers do not await it.
    void this.drain(taskId);
    return { taskId };
  }

  /** Appends a follow-up turn to an existing conversation and runs it. */
  sendMessage(taskId: string, text: string, images: readonly { mediaType: string; data: string }[] = []): { taskId: string } {
    const runtime = this.require();
    runtime.sendMessage(taskId, text, images);
    void this.drain(taskId);
    return { taskId };
  }

  async drain(taskId: string): Promise<string> {
    const runtime = this.require();
    try {
      for await (const event of runtime.run(taskId)) {
        void event;
      }
    } catch (error) {
      // A run can fail after the task is already terminal; the ledger has the reason.
      this.options.emit({
        eventId: randomUUID(),
        taskId,
        sequence: 0,
        occurredAt: new Date().toISOString(),
        type: "task.failed",
        payload: { error: { code: "CLIENT", message: error instanceof Error ? error.message : String(error) } }
      } as RuntimeEvent);
    }
    return runtime.getTask(taskId)?.status ?? "unknown";
  }

  pendingApprovals(taskId: string): readonly string[] {
    return this.require().pendingApprovals(taskId);
  }

  approve(taskId: string, approvalId: string, decision: "approve" | "reject"): void {
    const runtime = this.require();
    if (decision === "approve") {
      runtime.approve(taskId, approvalId);
    } else {
      runtime.reject(taskId, approvalId);
    }
    void this.drain(taskId);
  }

  async rollback(taskId: string): Promise<void> {
    await this.require().rollback(taskId);
  }

  async cancel(taskId: string): Promise<void> {
    const runtime = this.require();
    try {
      await runtime.cancel(taskId);
    } catch {
      // Cancelling a task that already ended is a no-op.
    }
  }

  async verify(taskId: string): Promise<{ status: string; summary: string; checks: unknown }> {
    const result = await this.require().verify(taskId);
    return { status: result.status, summary: result.summary, checks: result.checks };
  }

  /** Lists memory without a query, so the panel shows what the agent knows. */
  listMemory(scope: "global" | "project" | "task" | "session" = "project"): readonly MemoryView[] {
    return this.require().memory.list(scope, 100).map(toMemoryView);
  }

  /** Edits one record, bumping its version so a stale edit is rejected. */
  updateMemory(memoryId: string, content: string, expectedVersion: number): MemoryView {
    const record = this.require().memory.update(memoryId, { content }, expectedVersion);
    return toMemoryView(record);
  }

  searchMemory(query: string): readonly MemoryView[] {
    return this.require().memory.search(query).map(toMemoryView);
  }

  addMemory(key: string, content: string, scope: "global" | "project" | "task" | "session"): void {
    this.require().memory.create({ key, content, scope, source: "user" });
  }

  deleteMemory(memoryId: string): void {
    this.require().memory.delete(memoryId);
  }

  tools(): readonly { name: string; description: string; parameters: unknown }[] {
    return this.require().tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }

  /**
   * Packages this device's tasks and memory into one portable bundle.
   *
   * Exporting every task matters for moving machines: importing a single task
   * leaves the conversation list looking empty on the new device.
   */
  exportEverything(): { readonly bundle: unknown; readonly tasks: number; readonly memories: number } {
    const runtime = this.require();
    const tasks = runtime.ledger.listTasks(500);
    const records: unknown[] = [];
    let memories = 0;
    for (const task of tasks) {
      records.push(...runtime.exportTask(task.taskId).records);
    }
    const memoryBundle = runtime.exportMemories();
    records.push(...memoryBundle.records);
    memories = memoryBundle.records.length;
    return { bundle: { sourceDeviceId: "", cursor: 0, nextCursor: 0, records }, tasks: tasks.length, memories };
  }

  /** Imports a bundle produced by {@link exportEverything} on another device. */
  importEverything(bundle: { readonly records?: readonly unknown[] }): { readonly tasks: number; readonly memories: number } {
    const runtime = this.require();
    const records = bundle.records ?? [];
    const shard = { sourceDeviceId: "", cursor: 0, nextCursor: 0, records };
    const importedTask = runtime.importTask(shard as never);
    const importedMemory = runtime.importMemories(shard as never);
    return { tasks: importedTask.imported, memories: importedMemory.created + importedMemory.updated };
  }

  dispose(): void {
    if (this.runtime !== undefined) {
      this.runtime.close();
      this.runtime = undefined;
    }
  }
}
