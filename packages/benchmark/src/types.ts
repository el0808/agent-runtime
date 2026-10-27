export type BenchmarkConfigId =
  | "A-strong-baseline"
  | "B-fast-baseline"
  | "C-runtime-no-jev"
  | "D-runtime-jev"
  | "E-runtime-jev-verifier"
  | "F-runtime-jev-verifier-recovery";

export interface LongTaskCase {
  readonly id: string;
  readonly category: string;
  readonly prompt: string;
  readonly requiresRecovery: boolean;
  readonly requiresApproval: boolean;
  readonly requiresCompression: boolean;
}

export interface BenchmarkObservation {
  readonly success: boolean;
  readonly costUsd: number;
  readonly tokens: number;
  readonly latencyMs: number;
  /** True when a crash/interrupt was injected and the task still finished. */
  readonly recoverySucceeded: boolean;
  /** True when execution continued from a restored checkpoint. */
  readonly resumeSucceeded: boolean;
  readonly highRiskUnauthorized: boolean;
  readonly rollbackResidual: number;
  readonly compressionBeforeTokens: number;
  readonly compressionAfterTokens: number;
}

export interface BenchmarkScenario {
  readonly config: BenchmarkConfigId;
  readonly label: string;
  readonly execute: (task: LongTaskCase, repetition: number) => Promise<BenchmarkObservation>;
}

export interface AggregateMetrics {
  readonly config: BenchmarkConfigId;
  readonly label: string;
  readonly taskCount: number;
  readonly successRate: number;
  readonly averageCostUsd: number;
  readonly averageTokens: number;
  readonly averageLatencyMs: number;
  readonly recoverySuccessRate: number;
  readonly resumeSuccessRate: number;
  readonly highRiskUnauthorized: number;
  readonly averageRollbackResidual: number;
  readonly compressionReduction: number;
  readonly successRateCi95: readonly [number, number];
}

export interface BenchmarkReport {
  readonly generatedAt: string;
  readonly seed: number;
  readonly repetitions: number;
  readonly datasetSize: number;
  readonly mode: "runtime" | "offline";
  readonly metrics: readonly AggregateMetrics[];
  readonly targets: {
    readonly successRateVsStrongBaseline: number;
    readonly costReductionVsStrongBaseline: number;
    readonly latencyReductionVsStrongBaseline: number;
    readonly recoverySuccessRate: number;
    readonly resumeSuccessRate: number;
    readonly maxHighRiskUnauthorized: number;
    readonly maxRollbackResidual: number;
    readonly compressionReduction: number;
  };
}

/** The subset of AgentRuntime the benchmark drives. */
export interface BenchmarkRuntime {
  createTask(profile: { taskId: string; goal: string; runnerType: string }): unknown;
  run(taskId: string): AsyncIterable<{ type: string; payload: Record<string, unknown> }>;
  getTask(taskId: string): { status: string; completedSteps: readonly string[] } | undefined;
  getEvents(taskId: string): readonly { type: string; payload: Record<string, unknown> }[];
  verify(taskId: string): { status: string };
  pendingApprovals(taskId: string): readonly string[];
  approve(taskId: string, approvalId: string): void;
  close(): void;
}

export interface RuntimeScenarioHooks {
  /** Runs before the task to simulate a pre-existing checkpoint. */
  readonly seedCheckpoint?: (runtime: BenchmarkRuntime, taskId: string) => Promise<void>;
  /** Returns true when the run should be interrupted and resumed. */
  readonly injectCrash?: (task: LongTaskCase) => boolean;
  readonly approveTools: boolean;
  readonly verify: boolean;
  readonly recover: boolean;
}
