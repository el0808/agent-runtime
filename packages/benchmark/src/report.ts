import { mkdir, writeFile } from "node:fs/promises";
import type { BenchmarkReport } from "./types.js";

export function renderMarkdown(report: BenchmarkReport): string {
  const provenance = report.mode === "runtime"
    ? "Measured by executing the real runtime with a scripted provider. Cost is $0.00 because no paid API was called; success, latency, recovery and compression are real observations."
    : "Uses deterministic offline constants, not measurements. Treat this as a harness fixture, not a result.";

  const header = [
    "# Agent Runtime Benchmark",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Seed: ${report.seed}`,
    `- Mode: ${report.mode}`,
    `- LongTask-RR tasks: ${report.datasetSize}`,
    `- Repetitions: ${report.repetitions}`,
    "",
    "| Config | Success (95% CI) | Cost | Tokens | Latency | Recovery | Resume | High-risk unauthorized | Rollback residual | Compression |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
  ];

  const rows = report.metrics.map((metric) => {
    const low = (metric.successRateCi95[0] * 100).toFixed(1);
    const high = (metric.successRateCi95[1] * 100).toFixed(1);
    return `| ${metric.config} | ${(metric.successRate * 100).toFixed(1)}% (${low}–${high}%) | $${metric.averageCostUsd.toFixed(2)} | ${Math.round(metric.averageTokens)} | ${Math.round(metric.averageLatencyMs)}ms | ${(metric.recoverySuccessRate * 100).toFixed(1)}% | ${(metric.resumeSuccessRate * 100).toFixed(1)}% | ${metric.highRiskUnauthorized} | ${(metric.averageRollbackResidual * 100).toFixed(2)}% | ${(metric.compressionReduction * 100).toFixed(1)}% |`;
  });

  const targets = [
    "",
    "## Runtime F targets",
    "",
    `- Success-rate delta vs strong baseline: ${(report.targets.successRateVsStrongBaseline * 100).toFixed(1)} percentage points`,
    `- Cost reduction: ${(report.targets.costReductionVsStrongBaseline * 100).toFixed(1)}%`,
    `- Latency reduction: ${(report.targets.latencyReductionVsStrongBaseline * 100).toFixed(1)}%`,
    `- Recovery success: ${(report.targets.recoverySuccessRate * 100).toFixed(1)}%`,
    `- Resume success: ${(report.targets.resumeSuccessRate * 100).toFixed(1)}%`,
    `- High-risk unauthorized: ${report.targets.maxHighRiskUnauthorized}`,
    `- Rollback residual: ${(report.targets.maxRollbackResidual * 100).toFixed(2)}%`,
    `- Compression reduction: ${(report.targets.compressionReduction * 100).toFixed(1)}%`,
    "",
    provenance
  ];

  return `${[...header, ...rows, ...targets].join("\n")}\n`;
}

export async function writeReport(report: BenchmarkReport, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/benchmark.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(`${directory}/benchmark.md`, renderMarkdown(report), "utf8");
}
