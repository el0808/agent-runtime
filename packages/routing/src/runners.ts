import { randomUUID } from "node:crypto";
import { ERROR_CODES, RUNTIME_EVENT_TYPES, RuntimeError, TASK_STATUSES } from "@agent/protocol";
import type { JsonObject, RuntimeEvent, Runner, TaskProfile, VerificationResult } from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";
import type { ReActRunner } from "@agent/runner";

export type Planner = (profile: TaskProfile) => readonly string[];
export type Verifier = (taskId: string, ledger: TaskLedger) => VerificationResult;

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
  private readonly verifier: Verifier | undefined;
  private readonly ledger: TaskLedger;

  constructor(delegate: ReActRunner, ledger: TaskLedger, planner: Planner = (profile) => [profile.goal], verifier?: Verifier) {
    super(delegate);
    this.ledger = ledger;
    this.planner = planner;
    this.verifier = verifier;
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
    for await (const event of this.delegate.run(taskId)) {
      yield event;
    }
    if (this.verifier !== undefined && this.ledger.getTask(taskId)?.status === TASK_STATUSES.COMPLETED) {
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

export function routeEvidence(features: {
  readonly signals: readonly string[];
  readonly estimatedSteps: number;
  readonly complexity: number;
}): JsonObject {
  return { signals: [...features.signals], estimatedSteps: features.estimatedSteps, complexity: features.complexity };
}

export function routeEvent(taskId: string, runnerType: TaskProfile["runnerType"], reason: string, evidence: JsonObject, upgradedFrom?: TaskProfile["runnerType"]): RuntimeEvent {
  return {
    eventId: randomUUID(), taskId, sequence: 0, occurredAt: new Date().toISOString(), type: RUNTIME_EVENT_TYPES.ROUTE_DECIDED,
    payload: { runnerType, reason, evidence, ...(upgradedFrom === undefined ? {} : { upgradedFrom }) }
  } as RuntimeEvent;
}
