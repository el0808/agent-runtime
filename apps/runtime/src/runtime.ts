import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { ERROR_CODES, RUNNER_TYPES, RUNTIME_EVENT_TYPES, TASK_STATUSES, RuntimeError } from "@agent/protocol";

/** Runner ids in declaration order, offered to a decision provider as options. */
const RUNNER_TYPES_VALUES: readonly RunnerType[] = Object.values(RUNNER_TYPES);

function isRunnerType(value: string): value is RunnerType {
  return (RUNNER_TYPES_VALUES as readonly string[]).includes(value);
}
import type { JsonObject, RunnerType, RuntimeEvent, TaskProfile, TaskState, UserImage, VerificationResult } from "@agent/protocol";
import { ContextCompressor, MemoryStore } from "@agent/memory";
import { ApprovalManager, CompensationRegistry, GuardedToolExecutor, PolicyToolExecutor, RecoveryManager, ToolPermissionPolicy } from "@agent/policy";
import { BackgroundRunner, DecisionRouter, JevDecisionProvider, MultiAgentRunner, PlannerExecutorVerifierRunner, RunnerRouter, StateGraphRunner, TransactionalRunner, defaultStateGraph, jevTransportFromEnv, type JevTransport } from "@agent/routing";
import { ReActRunner, providerFromEnv, type ModelProvider, type ProviderSelection } from "@agent/runner";
import { DeterministicVerifier } from "@agent/verifier";
import { DeviceIdentityStore, LedgerSyncAdapter, LocalSyncStore, MemorySyncAdapter, type ImportResult, type MemoryImportResult, type SyncBundle } from "@agent/sync";
import { registerBuiltinTools, ToolRegistry } from "@agent/tools";
import { TaskLedger } from "@agent/task-ledger";
import { configFromEnv, resolvePaths, type RuntimeConfig } from "./config.js";
import { EventBus } from "./events.js";

export interface AgentRuntimeOptions {
  readonly config?: Partial<RuntimeConfig>;
  readonly provider?: ModelProvider;
  readonly jevTransport?: JevTransport;
  readonly hooks?: {
    readonly onEvent?: (event: RuntimeEvent) => void;
    readonly onPetEvent?: (payload: JsonObject) => void;
  };
}

export interface TaskRunHandle {
  readonly taskId: string;
  readonly runnerType: RunnerType;
}

/**
 * Composition root. Every domain package is wired here; nothing else in the
 * repository constructs more than one of them at a time.
 */
export class AgentRuntime {
  readonly config: RuntimeConfig;
  readonly ledger: TaskLedger;
  readonly memory: MemoryStore;
  readonly events = new EventBus();
  readonly approvals: ApprovalManager;
  readonly compensations = new CompensationRegistry();
  readonly recovery: RecoveryManager;
  readonly router: RunnerRouter;
  readonly decisions: DecisionRouter;
  readonly verifier: DeterministicVerifier;
  readonly tools: ToolRegistry;
  readonly react: ReActRunner;
  /** Which model provider was selected and whether it uses real credentials. */
  readonly providerSelection: ProviderSelection;
  private readonly guarded: GuardedToolExecutor;
  private readonly provider: ModelProvider;
  private readonly sync: LedgerSyncAdapter;
  private readonly memorySync: MemorySyncAdapter;

  constructor(options: AgentRuntimeOptions = {}) {
    this.config = configFromEnv(options.config ?? {});
    this.providerSelection = options.provider === undefined
      ? providerFromEnv()
      : { provider: options.provider, live: true, reason: `injected:${options.provider.name}` };
    const paths = resolvePaths(this.config);
    mkdirSync(path.dirname(paths.ledger), { recursive: true });
    this.ledger = new TaskLedger({ filename: paths.ledger });
    this.memory = new MemoryStore({ filename: paths.memory, ledger: this.ledger });
    this.approvals = new ApprovalManager();
    this.recovery = new RecoveryManager(this.ledger);
    this.tools = new ToolRegistry();
    registerBuiltinTools(this.tools, {
      allowOutsideWorkspace: this.config.allowOutsideWorkspace === true,
      // The same store the runner recalls from, so a fact the model saves is
      // available to the very next task.
      remember: ({ key, content, scope }) => {
        const existing = this.memory.search(key, scope)[0];
        if (existing !== undefined) {
          this.memory.update(existing.memoryId, { content }, existing.version);
        } else {
          this.memory.create({ key, content, scope, source: "agent" });
        }
      }
    });

    const guarded = new GuardedToolExecutor(
      this.tools,
      new ToolPermissionPolicy({
        deniedTools: this.config.deniedTools,
        autoApproveMedium: this.config.autoApproveMedium
      }),
      this.approvals,
      this.ledger,
      this.compensations
    );

    this.guarded = guarded;
    this.provider = options.provider ?? this.providerSelection.provider;
    this.react = this.buildRunner(this.provider);

    this.router = new RunnerRouter({
      ledger: this.ledger,
      react: this.react,
      planner: new PlannerExecutorVerifierRunner(this.react, this.ledger),
      stateGraph: new StateGraphRunner(this.react, this.ledger, defaultStateGraph()),
      // A detached run keeps going after the caller stops reading events.
      // It drains the ReAct runner directly: calling back into run() would
      // route through this same background runner and hand off again, forever.
      background: new BackgroundRunner(this.react, this.ledger, (taskId) => {
        void (async () => {
          try {
            for await (const event of this.react.run(taskId)) {
              this.events.emit(event);
            }
          } catch {
            // The ledger already records why it stopped.
          }
        })();
      }),
      transactional: new TransactionalRunner(this.react, this.ledger, this.compensations),
      // Each role gets its own runner and therefore its own system prompt.
      multiAgent: new MultiAgentRunner(this.react, this.ledger, [], (role) => this.buildRunner(this.provider, role))
    });

    // An explicit transport wins; otherwise AGENT_JEV_URL enables the service.
    const jevTransport = options.jevTransport ?? jevTransportFromEnv();
    this.decisions = new DecisionRouter({
      ledger: this.ledger,
      confidenceThreshold: this.config.confidenceThreshold,
      shadowMode: this.config.shadowMode,
      ...(jevTransport === undefined ? {} : { jev: new JevDecisionProvider({ transport: jevTransport }) })
    });

    this.verifier = new DeterministicVerifier(this.ledger, {
      ...(this.config.workspaceRoot === undefined ? {} : { workspaceRoot: this.config.workspaceRoot })
    });
    const identity = DeviceIdentityStore.loadOrCreate(paths.device);
    const syncStore = new LocalSyncStore(paths.sync);
    this.sync = new LedgerSyncAdapter(identity, syncStore);
    this.memorySync = new MemorySyncAdapter(identity, syncStore);

    if (options.hooks?.onEvent !== undefined) {
      const hook = options.hooks.onEvent;
      this.events.subscribe(hook);
    }
    if (options.hooks?.onPetEvent !== undefined) {
      const hook = options.hooks.onPetEvent;
      this.events.subscribe((event) => {
        hook({ type: event.type, taskId: event.taskId, sequence: event.sequence });
      });
    }
  }

  /**
   * Builds a runner sharing every dependency. Roles differ only in their
   * instruction, which is what makes a multi-agent run more than a rename.
   */
  private buildRunner(provider: ModelProvider, role?: { readonly name: string; readonly instruction: string }): ReActRunner {
    return new ReActRunner({
      ledger: this.ledger,
      provider,
      tools: this.tools,
      workspaceRoot: this.config.workspaceRoot,
      toolTimeoutMs: this.config.toolTimeoutMs,
      executor: new PolicyToolExecutor(this.guarded),
      memory: this.memory,
      compressor: new ContextCompressor(),
      contextTokenBudget: this.config.contextTokenBudget,
      ...(this.config.reasoningEffort === undefined ? {} : { reasoningEffort: this.config.reasoningEffort }),
      ...(this.config.pricing === undefined ? {} : { pricing: this.config.pricing }),
      memoryScope: { scope: "project" },
      ...(role === undefined ? {} : { role })
    });
  }

  createTask(profile: TaskProfile): TaskState {
    const state = this.ledger.createTask(profile);
    this.events.emit(this.ledger.getEvents(profile.taskId)[0] as RuntimeEvent);
    return state;
  }

  async *run(taskId: string, failures = 0): AsyncIterable<RuntimeEvent> {
    const state = this.ledger.getTask(taskId);
    if (state === undefined) {
      throw new Error(`Task ${taskId} was not found`);
    }

    // Everything appended from here on is new to the caller.
    const alreadyEmitted = this.ledger.getEvents(taskId).length;

    // The rule router proposes a runner; when Jev is configured it gets a say.
    const proposed = this.router.route(taskId, failures);
    // An explicit runner choice is the user's decision, not a suggestion: a
    // decision provider may only pick between runners when the task was left on
    // "auto route". Letting it override a chosen runner silently turned
    // planner, multi-agent and background runs back into plain ReAct.
    const autoRoute = state.profile.metadata?.autoRoute === true;
    const choice = await this.decisions.decide({
      taskId,
      goal: state.profile.goal,
      kind: "runner",
      options: autoRoute ? RUNNER_TYPES_VALUES : [state.profile.runnerType],
      risk: "low",
      failureCount: failures
    });
    const selected = autoRoute && isRunnerType(choice.choice) ? choice.choice : proposed.runnerType;

    if (selected !== proposed.runnerType) {
      this.ledger.appendEvent({
        eventId: randomUUID(),
        taskId,
        type: RUNTIME_EVENT_TYPES.ROUTE_DECIDED,
        payload: {
          runnerType: selected,
          reason: `decision provider ${choice.provider}: ${choice.reason}`,
          evidence: { proposed: proposed.runnerType, confidence: choice.confidence },
          confidence: choice.confidence,
          upgradedFrom: proposed.runnerType
        }
      });
    }

    for (const event of this.ledger.getEvents(taskId).slice(alreadyEmitted)) {
      this.events.emit(event);
      yield event;
    }

    for await (const event of this.router.getRunner(selected).run(taskId)) {
      this.events.emit(event);
      yield event;
    }
  }

  /** Runs a task to completion and returns the final state. */
  async runToCompletion(taskId: string, failures = 0): Promise<TaskState> {
    for await (const event of this.run(taskId, failures)) {
      void event;
    }
    const state = this.ledger.getTask(taskId);
    if (state === undefined) {
      throw new Error(`Task ${taskId} disappeared during execution`);
    }
    return state;
  }

  getTask(taskId: string): TaskState | undefined {
    return this.ledger.getTask(taskId);
  }

  getEvents(taskId: string): readonly RuntimeEvent[] {
    return this.ledger.getEvents(taskId);
  }

  /**
   * Deletes a task and its history. A running task is refused: its next append
   * would fail against a row that no longer exists.
   */
  deleteTask(taskId: string): boolean {
    const state = this.ledger.getTask(taskId);
    if (state === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.TASK_NOT_FOUND, message: `Task ${taskId} was not found` });
    }
    if (state.status === TASK_STATUSES.RUNNING || state.status === TASK_STATUSES.PENDING) {
      throw new RuntimeError({
        code: ERROR_CODES.INVALID_STATE_TRANSITION,
        message: `Task ${taskId} is ${state.status}; stop it before deleting`
      });
    }
    return this.ledger.deleteTask(taskId);
  }

  replay(taskId: string): TaskState {
    return this.ledger.replayTask(taskId);
  }

  /**
   * Appends a follow-up user turn to an existing conversation and reopens it.
   * The prior turns stay in the ledger, so the next run continues the same
   * conversation instead of starting a new task the way a fresh goal would.
   */
  sendMessage(taskId: string, text: string, images: readonly UserImage[] = []): void {
    if (text.trim() === "" && images.length === 0) {
      throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "A message cannot be empty" });
    }
    const state = this.ledger.getTask(taskId);
    if (state === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.TASK_NOT_FOUND, message: `Task ${taskId} was not found` });
    }
    this.ledger.appendEvent({
      eventId: randomUUID(),
      taskId,
      type: RUNTIME_EVENT_TYPES.USER_MESSAGE,
      payload: { text, ...(images.length === 0 ? {} : { images }) }
    });
    this.events.emit(this.ledger.getEvents(taskId).at(-1) as RuntimeEvent);
  }

  pendingApprovals(taskId: string): readonly string[] {
    return this.approvals.pending(taskId, this.ledger);
  }

  approve(taskId: string, approvalId: string, actor = "user", reason?: string): void {
    this.approvals.resolve(taskId, approvalId, "approved", actor, this.ledger, reason);
    this.events.emit(this.ledger.getEvents(taskId).at(-1) as RuntimeEvent);
  }

  reject(taskId: string, approvalId: string, actor = "user", reason?: string): void {
    this.approvals.resolve(taskId, approvalId, "rejected", actor, this.ledger, reason);
    this.events.emit(this.ledger.getEvents(taskId).at(-1) as RuntimeEvent);
  }

  /**
   * Checks the task against evidence — exit codes, tool outcomes, files on
   * disk — not against what the model said about itself. The task moves through
   * `verifying` while this runs so the UI can show that it is being checked.
   */
  async verify(taskId: string): Promise<VerificationResult> {
    const state = this.ledger.getTask(taskId);
    if (state === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.TASK_NOT_FOUND, message: `Task ${taskId} was not found` });
    }
    const started = state.status === TASK_STATUSES.RUNNING || state.status === TASK_STATUSES.COMPLETED;
    if (started && state.status !== TASK_STATUSES.VERIFYING) {
      this.ledger.appendEvent({
        eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.VERIFICATION_STARTED,
        payload: { reason: "verification requested" }
      });
      this.events.emit(this.ledger.getEvents(taskId).at(-1) as RuntimeEvent);
    }
    const result = await this.verifier.verifyTask(taskId);
    this.verifier.record(taskId, result);
    this.events.emit(this.ledger.getEvents(taskId).at(-1) as RuntimeEvent);
    return result;
  }

  async rollback(taskId: string): Promise<void> {
    await this.router.getRunner(this.ledger.getTask(taskId)?.profile.runnerType ?? RUNNER_TYPES.DIRECT).rollback(taskId);
    this.events.emit(this.ledger.getEvents(taskId).at(-1) as RuntimeEvent);
  }

  pause(taskId: string): Promise<void> {
    return this.react.pause(taskId);
  }

  resume(taskId: string): Promise<void> {
    return this.react.resume(taskId);
  }

  cancel(taskId: string): Promise<void> {
    return this.react.cancel(taskId);
  }

  exportTask(taskId: string, cursor = 0): SyncBundle {
    return this.sync.exportTask(taskId, this.ledger, cursor);
  }

  importTask(bundle: SyncBundle): ImportResult {
    return this.sync.importBundle(bundle, this.ledger);
  }

  /** Publishes every memory record visible to this device and returns new ones. */
  exportMemories(cursor = 0): SyncBundle {
    return this.memorySync.exportMemories(this.memory.search(""), cursor);
  }

  importMemories(bundle: SyncBundle): MemoryImportResult {
    return this.memorySync.importMemories(bundle, this.memory);
  }

  close(): void {
    this.memory.close();
    this.ledger.close();
  }
}

export function newTaskId(): string {
  return randomUUID();
}
