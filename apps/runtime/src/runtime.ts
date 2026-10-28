import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { RUNNER_TYPES, RUNTIME_EVENT_TYPES } from "@agent/protocol";

/** Runner ids in declaration order, offered to a decision provider as options. */
const RUNNER_TYPES_VALUES: readonly RunnerType[] = Object.values(RUNNER_TYPES);

function isRunnerType(value: string): value is RunnerType {
  return (RUNNER_TYPES_VALUES as readonly string[]).includes(value);
}
import type { JsonObject, RunnerType, RuntimeEvent, TaskProfile, TaskState, VerificationResult } from "@agent/protocol";
import { ContextCompressor, MemoryStore } from "@agent/memory";
import { ApprovalManager, CompensationRegistry, GuardedToolExecutor, PolicyToolExecutor, RecoveryManager, ToolPermissionPolicy } from "@agent/policy";
import { BackgroundRunner, DecisionRouter, JevDecisionProvider, MultiAgentRunner, PlannerExecutorVerifierRunner, RunnerRouter, StateGraphRunner, TransactionalRunner, jevTransportFromEnv, type JevTransport } from "@agent/routing";
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
    registerBuiltinTools(this.tools);

    const guarded = new GuardedToolExecutor(
      this.tools,
      new ToolPermissionPolicy({
        deniedTools: this.config.deniedTools,
        autoApproveMedium: this.config.autoApproveMedium
      }),
      this.approvals,
      this.ledger
    );

    this.react = new ReActRunner({
      ledger: this.ledger,
      provider: options.provider ?? this.providerSelection.provider,
      tools: this.tools,
      workspaceRoot: this.config.workspaceRoot,
      toolTimeoutMs: this.config.toolTimeoutMs,
      executor: new PolicyToolExecutor(guarded),
      memory: this.memory,
      compressor: new ContextCompressor(),
      contextTokenBudget: this.config.contextTokenBudget,
      ...(this.config.pricing === undefined ? {} : { pricing: this.config.pricing }),
      memoryScope: { scope: "project" }
    });

    this.router = new RunnerRouter({
      ledger: this.ledger,
      react: this.react,
      planner: new PlannerExecutorVerifierRunner(this.react, this.ledger),
      stateGraph: new StateGraphRunner(this.react, this.ledger),
      background: new BackgroundRunner(this.react),
      transactional: new TransactionalRunner(this.react, this.ledger, this.compensations),
      multiAgent: new MultiAgentRunner(this.react, this.ledger, [])
    });

    // An explicit transport wins; otherwise AGENT_JEV_URL enables the service.
    const jevTransport = options.jevTransport ?? jevTransportFromEnv();
    this.decisions = new DecisionRouter({
      ledger: this.ledger,
      confidenceThreshold: this.config.confidenceThreshold,
      shadowMode: this.config.shadowMode,
      ...(jevTransport === undefined ? {} : { jev: new JevDecisionProvider({ transport: jevTransport }) })
    });

    this.verifier = new DeterministicVerifier(this.ledger);
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
    const choice = await this.decisions.decide({
      taskId,
      goal: state.profile.goal,
      kind: "runner",
      options: RUNNER_TYPES_VALUES,
      risk: "low",
      failureCount: failures
    });
    const selected = isRunnerType(choice.choice) ? choice.choice : proposed.runnerType;

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

  replay(taskId: string): TaskState {
    return this.ledger.replayTask(taskId);
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

  verify(taskId: string): VerificationResult {
    const result = this.verifier.verifyCompleted(taskId);
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
