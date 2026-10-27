import { ERROR_CODES, RUNTIME_EVENT_TYPES, RuntimeError, TASK_STATUSES } from "@agent/protocol";
import type { Runner, RuntimeEvent, TaskProfile, VerificationResult } from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";
import type { ReActRunner } from "@agent/runner";
import { DeterministicVerifier } from "@agent/verifier";

export type Planner = (profile: TaskProfile) => readonly string[];
export type Verifier = (taskId: string, ledger: TaskLedger) => VerificationResult;

/** Splits a goal into ordered steps using the same sentence markers the router detects. */
export function defaultPlanner(profile: TaskProfile): readonly string[] {
  const steps = profile.goal
    .split(/\r?\n|(?<=[.!?])\s+|(?<=[;；])\s*|(?<=步骤\s*\d+[:：.、])\s*/u)
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
  if (steps.length <= 1) {
    return [profile.goal];
  }
  return steps;
}

export function defaultVerifier(ledger: TaskLedger): Verifier {
  const verifier = new DeterministicVerifier(ledger);
  return (taskId) => verifier.verifyCompleted(taskId);
}

abstract class DelegatingRunner implements Runner {
  constructor(protected readonly delegate: ReActRunner) {}
  run(taskId: string): AsyncIterable<RuntimeEvent> { return this.delegate.run(taskId); }
  pause(taskId: string): Promise<void> { return this.delegate.pause(taskId); }
  resume(taskId: string): Promise<void> { return this.delegate.resume(taskId); }
  cancel(taskId: string): Promise<void> { return this.delegate.cancel(taskId); }
  rollback(taskId: string): Promise<void> { return this.delegate.rollback(taskId); }
}

export class ReActTaskRunner extends DelegatingRunner {}

export class PlannerExecutorVerifierRunner extends DelegatingRunner {
  private readonly planner: Planner;
  private readonly verifier: Verifier;
  private readonly ledger: TaskLedger;

  constructor(delegate: ReActRunner, ledger: TaskLedger, planner: Planner = defaultPlanner, verifier?: Verifier) {
    super(delegate);
    this.ledger = ledger;
    this.planner = planner;
    this.verifier = verifier ?? defaultVerifier(ledger);
  }

  override async *run(taskId: string): AsyncIterable<RuntimeEvent> {
    const state = this.ledger.getTask(taskId);
    if (state === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.TASK_NOT_FOUND, message: `Task ${taskId} was not found` });
    }
    const plan = this.planner(state.profile);
    if (plan.length === 0) {
      throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "Planner returned no steps" });
    }
    for await (const event of this.delegate.runPlan(taskId, plan)) {
      yield event;
    }
    if (this.ledger.getTask(taskId)?.status === TASK_STATUSES.COMPLETED) {
      const result = this.verifier(taskId, this.ledger);
      yield this.ledger.recordVerification(taskId, result).event;
    }
  }
}

export interface StateGraphNode {
  readonly id: string;
  readonly run: (taskId: string, ledger: TaskLedger) => string | undefined | Promise<string | undefined>;
}

export class StateGraphRunner extends DelegatingRunner {
  private readonly nodes: ReadonlyMap<string, StateGraphNode>;
  private readonly startNode: string;
  private readonly ledger: TaskLedger;

  constructor(delegate: ReActRunner, ledger: TaskLedger, nodes: readonly StateGraphNode[] = [], startNode?: string) {
    super(delegate);
    this.ledger = ledger;
    this.nodes = new Map(nodes.map((node) => [node.id, node]));
    this.startNode = startNode ?? nodes[0]?.id ?? "";
  }

  override async *run(taskId: string): AsyncIterable<RuntimeEvent> {
    const state = this.ledger.getTask(taskId);
    if (state === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.TASK_NOT_FOUND, message: `Task ${taskId} was not found` });
    }
    if (state.status === TASK_STATUSES.PENDING) {
      this.ledger.appendEvent({ eventId: `graph-start-${taskId}`, taskId, type: RUNTIME_EVENT_TYPES.TASK_STARTED, payload: { reason: "state graph" } });
    }
    if (this.nodes.size > 0) {
      let current: string | undefined = this.startNode;
      const visited = new Set<string>();
      while (current !== undefined) {
        if (visited.has(current)) throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "State graph contains a cycle" });
        visited.add(current);
        const node = this.nodes.get(current);
        if (node === undefined) throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: `State graph node ${current} is missing` });
        current = await node.run(taskId, this.ledger);
      }
    }
    yield* this.delegate.run(taskId);
  }
}

export class BackgroundRunner extends DelegatingRunner {
  private readonly queue = new Set<string>();
  override async *run(taskId: string): AsyncIterable<RuntimeEvent> {
    if (this.queue.has(taskId)) throw new RuntimeError({ code: ERROR_CODES.CONFLICT, message: `Task ${taskId} is already queued` });
    this.queue.add(taskId);
    try {
      yield* this.delegate.run(taskId);
    } finally {
      this.queue.delete(taskId);
    }
  }
}

/**
 * Compensates a transactional task: restores the newest checkpoint, then runs the
 * registered compensation actions in reverse order.
 */
export class TransactionalRunner extends DelegatingRunner {
  constructor(delegate: ReActRunner, private readonly ledger: TaskLedger, private readonly compensations?: {
    executeAll(taskId: string, ledger: TaskLedger): Promise<readonly RuntimeEvent[]>;
  }) {
    super(delegate);
  }

  override async rollback(taskId: string): Promise<void> {
    await this.delegate.rollback(taskId);
    if (this.compensations !== undefined) {
      await this.compensations.executeAll(taskId, this.ledger);
    }
  }
}

/**
 * Runs plan steps across named agents in order. Each agent owns its own ReAct
 * runner, so a step is retried with that agent's provider and tool set.
 */
export class MultiAgentRunner extends DelegatingRunner {
  constructor(
    delegate: ReActRunner,
    private readonly ledger: TaskLedger,
    private readonly agents: readonly { readonly name: string; readonly runner: ReActRunner }[]
  ) {
    super(delegate);
  }

  override async *run(taskId: string): AsyncIterable<RuntimeEvent> {
    const state = this.ledger.getTask(taskId);
    if (state === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.TASK_NOT_FOUND, message: `Task ${taskId} was not found` });
    }
    if (this.agents.length === 0) {
      yield* this.delegate.run(taskId);
      return;
    }
    const steps = defaultPlanner(state.profile);
    const perAgent = Math.max(1, Math.ceil(steps.length / this.agents.length));
    for (const [index, agent] of this.agents.entries()) {
      const slice = steps.slice(index * perAgent, (index + 1) * perAgent);
      if (slice.length === 0) {
        continue;
      }
      for await (const event of agent.runner.runPlan(taskId, slice)) {
        yield event;
      }
    }
  }
}

export function routeEvidence(features: {
  readonly signals: readonly string[];
  readonly estimatedSteps: number;
  readonly complexity: number;
}): Record<string, string[] | number> {
  return { signals: [...features.signals], estimatedSteps: features.estimatedSteps, complexity: features.complexity };
}
