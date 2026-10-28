import { randomUUID } from "node:crypto";
import { RUNTIME_EVENT_TYPES, RUNNER_TYPES } from "@agent/protocol";

/** Runner ids in declaration order, used to compare how strong a runner is. */
const RUNNER_TYPES_VALUES = Object.values(RUNNER_TYPES);
import type { JsonObject, Runner, RunnerType, RuntimeEvent, TaskProfile } from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";
import type { ReActRunner } from "@agent/runner";
import { extractTaskFeatures, type TaskFeatures } from "./features.js";
import {
  BackgroundRunner,
  MultiAgentRunner,
  PlannerExecutorVerifierRunner,
  ReActTaskRunner,
  StateGraphRunner,
  TransactionalRunner,
  routeEvidence
} from "./runners.js";

export interface RouteDecision {
  readonly runnerType: RunnerType;
  readonly reason: string;
  readonly evidence: JsonObject;
  readonly confidence: number;
  readonly features: TaskFeatures;
  readonly upgradedFrom?: RunnerType;
}

export interface RunnerRouterOptions {
  readonly ledger: TaskLedger;
  readonly react: ReActRunner;
  readonly planner?: PlannerExecutorVerifierRunner;
  readonly stateGraph?: StateGraphRunner;
  readonly background?: BackgroundRunner;
  readonly transactional?: TransactionalRunner;
  readonly multiAgent?: MultiAgentRunner;
}

export class RunnerRouter {
  private readonly ledger: TaskLedger;
  private readonly runners: ReadonlyMap<RunnerType, Runner>;

  constructor(options: RunnerRouterOptions) {
    this.ledger = options.ledger;
    this.runners = new Map<RunnerType, Runner>([
      [RUNNER_TYPES.DIRECT, new ReActTaskRunner(options.react)],
      [RUNNER_TYPES.PLANNER_EXECUTOR_VERIFIER, options.planner ?? new PlannerExecutorVerifierRunner(options.react, options.ledger)],
      [RUNNER_TYPES.STATE_GRAPH, options.stateGraph ?? new StateGraphRunner(options.react, options.ledger)],
      [RUNNER_TYPES.BACKGROUND, options.background ?? new BackgroundRunner(options.react, options.ledger)],
      [RUNNER_TYPES.TRANSACTIONAL, options.transactional ?? new TransactionalRunner(options.react, options.ledger)],
      [RUNNER_TYPES.MULTI_AGENT, options.multiAgent ?? new MultiAgentRunner(options.react, options.ledger, [])]
    ]);
  }

  decide(profile: TaskProfile, failures = 0): RouteDecision {
    const features = extractTaskFeatures(profile);
    const requested = profile.runnerType;
    let runnerType: RunnerType = requested;
    let reason = "profile requested runner";

    // A runner the user picked is not a suggestion. Signals may upgrade the
    // default (direct), but they must not silently replace a deliberate choice:
    // that is how a multi-agent task used to run as a state graph instead.
    if (requested !== RUNNER_TYPES.DIRECT) {
      const escalated = failures >= 2 && RUNNER_TYPES_VALUES.indexOf(requested) < RUNNER_TYPES_VALUES.indexOf(RUNNER_TYPES.PLANNER_EXECUTOR_VERIFIER);
      return {
        runnerType: requested,
        reason: escalated ? "profile requested runner, escalated by repeated failures" : "profile requested runner",
        evidence: routeEvidence(features),
        confidence: 1,
        features
      };
    }

    if (features.longRunning) { runnerType = RUNNER_TYPES.BACKGROUND; reason = "long-running signal"; }
    else if (features.fixedFlow) { runnerType = RUNNER_TYPES.STATE_GRAPH; reason = "fixed-flow signal"; }
    else if (features.needsParallelism) { runnerType = RUNNER_TYPES.MULTI_AGENT; reason = "parallel role signal"; }
    else if (features.hasExternalSideEffect) { runnerType = RUNNER_TYPES.TRANSACTIONAL; reason = "external side effect requires compensation"; }
    else if (features.complexity >= 3) { runnerType = RUNNER_TYPES.PLANNER_EXECUTOR_VERIFIER; reason = "complexity signal"; }
    else if (requested === RUNNER_TYPES.DIRECT) { runnerType = RUNNER_TYPES.DIRECT; reason = "simple task"; }
    if (failures >= 2 && runnerType === RUNNER_TYPES.DIRECT) { runnerType = RUNNER_TYPES.PLANNER_EXECUTOR_VERIFIER; reason = "repeated failures require escalation"; }
    return { runnerType, reason, evidence: routeEvidence(features), confidence: features.complexity >= 4 ? 0.95 : 0.8, features, ...(runnerType === requested ? {} : { upgradedFrom: requested }) };
  }

  route(taskId: string, failures = 0): RouteDecision {
    const state = this.ledger.getTask(taskId);
    if (state === undefined) throw new Error(`Task ${taskId} was not found`);
    const decision = this.decide(state.profile, failures);
    this.ledger.appendEvent({
      eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.ROUTE_DECIDED,
      payload: { runnerType: decision.runnerType, reason: decision.reason, evidence: decision.evidence, confidence: decision.confidence, ...(decision.upgradedFrom === undefined ? {} : { upgradedFrom: decision.upgradedFrom }) }
    });
    return decision;
  }

  getRunner(type: RunnerType): Runner {
    const runner = this.runners.get(type);
    if (runner === undefined) throw new Error(`Runner ${type} is not configured`);
    return runner;
  }

  run(taskId: string, failures = 0): AsyncIterable<RuntimeEvent> {
    const decision = this.route(taskId, failures);
    return this.getRunner(decision.runnerType).run(taskId);
  }
}
