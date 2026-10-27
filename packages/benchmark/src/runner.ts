import type { AggregateMetrics, BenchmarkObservation, BenchmarkReport, BenchmarkScenario, LongTaskCase } from "./types.js";

function average(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }

export class BenchmarkRunner {
  constructor(private readonly seed = 20261027) {}

  async run(scenarios: readonly BenchmarkScenario[], tasks: readonly LongTaskCase[], repetitions = 1): Promise<BenchmarkReport> {
    if (repetitions < 1 || !Number.isInteger(repetitions)) throw new Error("repetitions must be positive");
    const metrics: AggregateMetrics[] = [];
    for (const scenario of scenarios) {
      const observations: BenchmarkObservation[] = [];
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        for (const task of tasks) observations.push(await scenario.execute(task, repetition));
      }
      metrics.push(this.aggregate(scenario, observations));
    }
    const strong = metrics.find((metric) => metric.config === "A-strong-baseline");
    if (strong === undefined) throw new Error("Strong baseline is required");
    const runtime = metrics.find((metric) => metric.config === "F-runtime-jev-verifier-recovery") ?? strong;
    return {
      generatedAt: new Date().toISOString(), seed: this.seed, repetitions, datasetSize: tasks.length,
      metrics,
      targets: {
        successRateVsStrongBaseline: runtime.successRate - strong.successRate,
        costReductionVsStrongBaseline: strong.averageCostUsd === 0 ? 0 : 1 - runtime.averageCostUsd / strong.averageCostUsd,
        latencyReductionVsStrongBaseline: strong.averageLatencyMs === 0 ? 0 : 1 - runtime.averageLatencyMs / strong.averageLatencyMs,
        recoverySuccessRate: runtime.recoverySuccessRate,
        resumeSuccessRate: runtime.resumeSuccessRate,
        maxHighRiskUnauthorized: runtime.highRiskUnauthorized,
        maxRollbackResidual: runtime.averageRollbackResidual,
        compressionReduction: runtime.compressionReduction
      }
    };
  }

  private aggregate(scenario: BenchmarkScenario, values: readonly BenchmarkObservation[]): AggregateMetrics {
    return {
      config: scenario.config,
      label: scenario.label,
      taskCount: values.length,
      successRate: average(values.map((value) => value.success ? 1 : 0)),
      averageCostUsd: average(values.map((value) => value.costUsd)),
      averageTokens: average(values.map((value) => value.tokens)),
      averageLatencyMs: average(values.map((value) => value.latencyMs)),
      recoverySuccessRate: average(values.filter((value) => value.recoverySucceeded).map(() => 1).concat(values.filter((value) => !value.recoverySucceeded).map(() => 0))),
      resumeSuccessRate: average(values.map((value) => value.resumeSucceeded ? 1 : 0)),
      highRiskUnauthorized: values.filter((value) => value.highRiskUnauthorized).length,
      averageRollbackResidual: average(values.map((value) => value.rollbackResidual)),
      compressionReduction: average(values.filter((value) => value.compressionBeforeTokens > 1000).map((value) => 1 - value.compressionAfterTokens / value.compressionBeforeTokens))
    };
  }
}
