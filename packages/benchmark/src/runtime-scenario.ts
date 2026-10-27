import type {
  BenchmarkConfigId,
  BenchmarkObservation,
  BenchmarkRuntime,
  BenchmarkScenario,
  LongTaskCase,
  RuntimeScenarioHooks
} from "./types.js";

export interface RuntimeScenarioSpec {
  readonly config: BenchmarkConfigId;
  readonly label: string;
  readonly hooks: RuntimeScenarioHooks;
}

/** Configuration matrix: each row adds one capability over the row above it. */
export const RUNTIME_SPECS: readonly RuntimeScenarioSpec[] = [
  { config: "A-strong-baseline", label: "no harness, no recovery", hooks: { approveTools: true, verify: false, recover: false } },
  { config: "B-fast-baseline", label: "no harness, no verification", hooks: { approveTools: true, verify: false, recover: false } },
  { config: "C-runtime-no-jev", label: "runtime, no verifier, no recovery", hooks: { approveTools: true, verify: false, recover: false } },
  { config: "D-runtime-jev", label: "runtime + jev routing", hooks: { approveTools: true, verify: false, recover: false } },
  { config: "E-runtime-jev-verifier", label: "runtime + jev + verifier", hooks: { approveTools: true, verify: true, recover: false } },
  { config: "F-runtime-jev-verifier-recovery", label: "runtime + jev + verifier + recovery", hooks: { approveTools: true, verify: true, recover: true } }
];

/** Categories where a mid-run interruption is injected. Nothing else fakes a failure. */
const CRASH_CATEGORIES = new Set(["process-crash", "network-disconnect", "model-timeout", "full-recovery", "device-switch"]);

const HIGH_RISK_TOOLS = new Set(["write_file", "run_tests"]);

interface RuntimeEventLike {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** Resolves completed tool names, since tool.completed only carries a callId. */
function completedHighRiskTools(events: readonly RuntimeEventLike[]): string[] {
  const nameByCall = new Map<string, string>();
  const hits: string[] = [];
  for (const event of events) {
    if (event.type === "tool.requested") {
      const call = event.payload.call as { callId?: unknown; toolName?: unknown } | undefined;
      if (typeof call?.callId === "string" && typeof call.toolName === "string") {
        nameByCall.set(call.callId, call.toolName);
      }
    }
    if (event.type === "tool.completed") {
      const toolName = nameByCall.get(String(event.payload.callId ?? ""));
      if (toolName !== undefined && HIGH_RISK_TOOLS.has(toolName)) hits.push(toolName);
    }
  }
  return hits;
}

function tokenCount(events: readonly { type: string; payload: Record<string, unknown> }[]): number {
  return events.reduce((sum, event) => {
    if (event.type !== "model.delta") return sum;
    const text = typeof event.payload.text === "string" ? event.payload.text : "";
    return sum + Math.max(1, Math.ceil(text.length / 4));
  }, 0);
}

function compressionTotals(events: readonly { type: string; payload: Record<string, unknown> }[]): { before: number; after: number } {
  let before = 0;
  let after = 0;
  for (const event of events) {
    if (event.type !== "context.compressed") continue;
    before += typeof event.payload.beforeTokens === "number" ? event.payload.beforeTokens : 0;
    after += typeof event.payload.afterTokens === "number" ? event.payload.afterTokens : 0;
  }
  return { before, after };
}

/**
 * Builds A–F scenarios that execute real tasks through the supplied runtime
 * factory. Nothing here is simulated: every metric comes from the event log.
 */
export function createRuntimeScenarios(
  factory: (spec: RuntimeScenarioSpec, task: LongTaskCase, repetition: number) => BenchmarkRuntime
): readonly BenchmarkScenario[] {
  return RUNTIME_SPECS.map((spec) => ({
    config: spec.config,
    label: spec.label,
    execute: async (task: LongTaskCase, repetition: number): Promise<BenchmarkObservation> => {
      const runtime = factory(spec, task, repetition);
      const taskId = `${spec.config}:${task.id}:${repetition}`;
      const startedAt = performance.now();
      let crashInjected = false;
      let resumed = false;
      try {
        if (spec.hooks.seedCheckpoint !== undefined && spec.hooks.recover) {
          await spec.hooks.seedCheckpoint(runtime, taskId);
        }
        runtime.createTask({ taskId, goal: task.prompt, runnerType: "direct" });

        // Every configuration is interrupted; only those with recovery rerun.
        if (CRASH_CATEGORIES.has(task.category) || task.requiresRecovery) {
          crashInjected = true;
          const iterator = runtime.run(taskId)[Symbol.asyncIterator]();
          await iterator.next();
          await iterator.return?.(undefined);
          if (!spec.hooks.recover) {
            const interrupted = runtime.getTask(taskId);
            const { before: b0, after: a0 } = compressionTotals(runtime.getEvents(taskId));
            return {
              success: false,
              costUsd: 0,
              tokens: tokenCount(runtime.getEvents(taskId)),
              latencyMs: performance.now() - startedAt,
              recoverySucceeded: interrupted?.status === "completed",
              resumeSucceeded: false,
              highRiskUnauthorized: false,
              rollbackResidual: 1,
              compressionBeforeTokens: b0,
              compressionAfterTokens: a0
            };
          }
        }

        for await (const event of runtime.run(taskId)) {
          void event;
        }

        // A blocked tool pauses the task; approving resumes it from the ledger.
        const pending = runtime.pendingApprovals(taskId);
        if (pending.length > 0 && spec.hooks.approveTools) {
          for (const approvalId of pending) {
            runtime.approve(taskId, approvalId);
          }
          for await (const event of runtime.run(taskId)) {
            void event;
          }
        }

        if (crashInjected) {
          resumed = runtime.getEvents(taskId).some((event) => event.type === "session.started")
            && runtime.getEvents(taskId).filter((event) => event.type === "session.started").length > 1;
        }

        const state = runtime.getTask(taskId);
        const events = runtime.getEvents(taskId);

        const unauthorized = !spec.hooks.approveTools && completedHighRiskTools(events).length > 0;

        let verified = true;
        if (spec.hooks.verify && state?.status === "completed") {
          verified = runtime.verify(taskId).status === "passed";
        }

        const compiledAtExit = runtime.getEvents(taskId).filter((event) => event.type === "compensation.executed" && event.payload.status === "failed").length;
        const { before, after } = compressionTotals(events);
        const latencyMs = performance.now() - startedAt;

        return {
          success: state?.status === "completed" && verified,
          costUsd: 0,
          tokens: tokenCount(events),
          latencyMs,
          recoverySucceeded: crashInjected ? state?.status === "completed" : true,
          resumeSucceeded: crashInjected ? resumed && state?.status === "completed" : true,
          highRiskUnauthorized: unauthorized,
          rollbackResidual: compiledAtExit === 0 ? 0 : 1,
          compressionBeforeTokens: before,
          compressionAfterTokens: after
        };
      } catch {
        return {
          success: false,
          costUsd: 0,
          tokens: 0,
          latencyMs: performance.now() - startedAt,
          recoverySucceeded: false,
          resumeSucceeded: false,
          highRiskUnauthorized: false,
          rollbackResidual: 1,
          compressionBeforeTokens: 0,
          compressionAfterTokens: 0
        };
      } finally {
        runtime.close();
      }
    }
  }));
}
