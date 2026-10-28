import { randomUUID } from "node:crypto";
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
    // Nodes run before the model: a graph is for flows whose shape the host
    // already knows, so the expensive loop only runs for what is left.
    const steps: string[] = [];
    let current: string | undefined = this.startNode;
    const visited = new Set<string>();
    while (current !== undefined) {
      if (visited.has(current)) {
        throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "State graph contains a cycle" });
      }
      visited.add(current);
      const node = this.nodes.get(current);
      if (node === undefined) {
        throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: `State graph node ${current} is missing` });
      }
      const instruction = await node.run(taskId, this.ledger);
      steps.push(current);
      current = instruction;
    }
    if (steps.length > 0) {
      yield this.ledger.appendEvent({
        eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.PLAN_CREATED,
        payload: { steps, reason: "state graph nodes" }
      }).event;
    }
    yield* this.delegate.run(taskId);
  }
}

/**
 * Long-running work that outlives the request that started it.
 *
 * The run is started detached and the caller keeps receiving its events through
 * the runtime's event bus, so the UI can close the conversation while the work
 * continues. Without a `start` hook there is nothing to detach into, and the
 * task simply runs inline.
 */
export class BackgroundRunner extends DelegatingRunner {
  private readonly running = new Set<string>();
  private readonly start: ((taskId: string) => void) | undefined;
  private readonly ledger: TaskLedger;

  constructor(delegate: ReActRunner, ledger: TaskLedger, start?: (taskId: string) => void) {
    super(delegate);
    this.ledger = ledger;
    this.start = start;
  }

  override async *run(taskId: string): AsyncIterable<RuntimeEvent> {
    if (this.running.has(taskId)) {
      throw new RuntimeError({ code: ERROR_CODES.CONFLICT, message: `Task ${taskId} is already running in the background` });
    }
    if (this.start === undefined) {
      yield* this.delegate.run(taskId);
      return;
    }
    this.running.add(taskId);
    this.start(taskId);
    // The task keeps running; this generator ends after handing it off, so the
    // caller is not held open for the duration of a long job.
    yield* [];
  }

  override async cancel(taskId: string): Promise<void> {
    await this.delegate.cancel(taskId);
    this.running.delete(taskId);
  }

  /** Lets the composition root report when a detached run finished. */
  release(taskId: string): void {
    this.running.delete(taskId);
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
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
export interface AgentRole {
  readonly name: string;
  /** What this role is for. It becomes its system prompt, not just a label. */
  readonly instruction: string;
}

/**
 * The default split for a task that needs several perspectives: one agent
 * decides what to do, one does it, one checks it. They are separate ReAct
 * runners, so each gets its own instruction and its own conversation.
 */
export const DEFAULT_ROLES: readonly AgentRole[] = [
  {
    name: "planner",
    instruction:
      "Break the goal into at most three concrete steps. Do not run tools that change anything; read what you need and reply with the ordered steps only."
  },
  {
    name: "executor",
    instruction:
      "Carry out the steps you were given, using tools. Make one change at a time and confirm each result before moving on."
  },
  {
    name: "reviewer",
    instruction:
      "Check the work against the original goal. Read the files that were meant to change and report whether they actually did. Do not change anything yourself."
  }
];

export class MultiAgentRunner extends DelegatingRunner {
  private readonly agents: readonly { readonly name: string; readonly runner: ReActRunner }[];

  constructor(
    delegate: ReActRunner,
    private readonly ledger: TaskLedger,
    agents: readonly { readonly name: string; readonly runner: ReActRunner }[],
    /** Builds a role runner, so the composition root can give each one its prompt. */
    roleFactory?: (role: AgentRole) => ReActRunner
  ) {
    super(delegate);
    // No agents and no factory used to mean the task silently ran as plain
    // ReAct while the ledger still recorded it as multi-agent.
    this.agents = agents.length > 0
      ? agents
      : roleFactory === undefined
        ? []
        : DEFAULT_ROLES.map((role) => ({ name: role.name, runner: roleFactory(role) }));
  }

  override async *run(taskId: string): AsyncIterable<RuntimeEvent> {
    const state = this.ledger.getTask(taskId);
    if (state === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.TASK_NOT_FOUND, message: `Task ${taskId} was not found` });
    }
    if (this.agents.length === 0) {
      throw new RuntimeError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Multi-agent routing needs at least one agent role registered"
      });
    }
    const steps = defaultPlanner(state.profile);
    yield this.ledger.appendEvent({
      eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.PLAN_CREATED,
      payload: { steps, reason: `multi-agent roles: ${this.agents.map((agent) => agent.name).join(", ")}` }
    }).event;
    const perAgent = Math.max(1, Math.ceil(steps.length / this.agents.length));
    const active = this.agents.filter((_, index) => steps.slice(index * perAgent, (index + 1) * perAgent).length > 0);
    for (const [index, agent] of active.entries()) {
      const slice = steps.slice(index * perAgent, (index + 1) * perAgent);
      // Only the last role may finish the task; the others hand it on.
      const isLast = index === active.length - 1;
      for await (const event of agent.runner.runPlan(taskId, slice, { finalize: isLast })) {
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
