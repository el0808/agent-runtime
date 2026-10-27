export type BenchmarkConfigId = "A-strong-baseline" | "B-fast-baseline" | "C-runtime-no-jev" | "D-runtime-jev" | "E-runtime-jev-verifier" | "F-runtime-jev-verifier-recovery";

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
  readonly recoverySucceeded: boolean;
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
}

export interface BenchmarkReport {
  readonly generatedAt: string;
  readonly seed: number;
  readonly repetitions: number;
  readonly datasetSize: number;
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
