import type { AggregateMetrics, BenchmarkObservation, BenchmarkReport, BenchmarkScenario, LongTaskCase } from "./types.js";

function average(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }

function rate(values: readonly boolean[]): number { return values.length === 0 ? 0 : values.filter(Boolean).length / values.length; }

/** Wilson score interval, which stays sane for small n and rates near 0 or 1. */
function wilsonCi95(successes: number, total: number): readonly [number, number] {
  if (total === 0) return [0, 1];
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (centre - spread) / denominator), Math.min(1, (centre + spread) / denominator)];
}

export class BenchmarkRunner {
  constructor(private readonly seed = 20261027, private readonly mode: "runtime" | "offline" = "runtime") {}

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
      generatedAt: new Date().toISOString(), seed: this.seed, repetitions, datasetSize: tasks.length, mode: this.mode,
      metrics,
      targets: {
        successRateVsStrongBaseline: runtime.successRate - strong.successRate,
        costReductionVsStrongBaseline: strong.averageCostUsd === 0 ? 0 : 1 - runtime.averageCostUsd / strong.averageCostUsd,
        latencyReductionVsStrongBaseline: strong.averageLatencyMs === 0 ? 0 : 1 - runtime.averageLatencyMs / strong.averageLatencyMs,
        recoverySuccessRate: runtime.recoverySuccessRate,
        resumeSuccessRate: runtime.resumeSuccessRate,
        maxHighRiskUnauthorized: Math.max(...metrics.map((metric) => metric.highRiskUnauthorized)),
        maxRollbackResidual: Math.max(...metrics.map((metric) => metric.averageRollbackResidual)),
        compressionReduction: runtime.compressionReduction
      }
    };
  }

  private aggregate(scenario: BenchmarkScenario, values: readonly BenchmarkObservation[]): AggregateMetrics {
    const successes = values.filter((value) => value.success).length;
    const compressed = values.filter((value) => value.compressionBeforeTokens > 1000);
    return {
      config: scenario.config,
      label: scenario.label,
      taskCount: values.length,
      successRate: rate(values.map((value) => value.success)),
      averageCostUsd: average(values.map((value) => value.costUsd)),
      averageTokens: average(values.map((value) => value.tokens)),
      averageLatencyMs: average(values.map((value) => value.latencyMs)),
      recoverySuccessRate: rate(values.map((value) => value.recoverySucceeded)),
      resumeSuccessRate: rate(values.map((value) => value.resumeSucceeded)),
      highRiskUnauthorized: values.filter((value) => value.highRiskUnauthorized).length,
      averageRollbackResidual: average(values.map((value) => value.rollbackResidual)),
      compressionReduction: compressed.length === 0 ? 0 : average(compressed.map((value) => 1 - value.compressionAfterTokens / value.compressionBeforeTokens)),
      successRateCi95: wilsonCi95(successes, values.length)
    };
  }
}
