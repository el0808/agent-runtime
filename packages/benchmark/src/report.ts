import { mkdir, writeFile } from "node:fs/promises";
import type { BenchmarkReport } from "./types.js";

export function renderMarkdown(report: BenchmarkReport): string {
  const lines = ["# Agent Runtime Benchmark", "", `- Generated: ${report.generatedAt}`, `- Seed: ${report.seed}`, `- LongTask-RR tasks: ${report.datasetSize}`, "", "| Config | Success | Cost | Tokens | Latency | Recovery | Resume | High-risk unauthorized | Rollback residual | Compression |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  for (const metric of report.metrics) lines.push(`| ${metric.config} | ${(metric.successRate * 100).toFixed(1)}% | $${metric.averageCostUsd.toFixed(2)} | ${Math.round(metric.averageTokens)} | ${Math.round(metric.averageLatencyMs)}ms | ${(metric.recoverySuccessRate * 100).toFixed(1)}% | ${(metric.resumeSuccessRate * 100).toFixed(1)}% | ${metric.highRiskUnauthorized} | ${(metric.averageRollbackResidual * 100).toFixed(2)}% | ${(metric.compressionReduction * 100).toFixed(1)}% |`);
  lines.push("", "## Runtime F targets", "", `- Success-rate delta vs strong baseline: ${(report.targets.successRateVsStrongBaseline * 100).toFixed(1)} percentage points`, `- Cost reduction: ${(report.targets.costReductionVsStrongBaseline * 100).toFixed(1)}%`, `- Latency reduction: ${(report.targets.latencyReductionVsStrongBaseline * 100).toFixed(1)}%`, `- Recovery success: ${(report.targets.recoverySuccessRate * 100).toFixed(1)}%`, `- Resume success: ${(report.targets.resumeSuccessRate * 100).toFixed(1)}%`, `- High-risk unauthorized: ${report.targets.maxHighRiskUnauthorized}`, `- Rollback residual: ${(report.targets.maxRollbackResidual * 100).toFixed(2)}%`, `- Compression reduction: ${(report.targets.compressionReduction * 100).toFixed(1)}%`, "", "This report uses deterministic offline Fake/Mock providers. It is a reproducible harness check, not a claim about external model or Jev service performance.");
  return `${lines.join("\n")}\n`;
}

export async function writeReport(report: BenchmarkReport, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/benchmark.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(`${directory}/benchmark.md`, renderMarkdown(report), "utf8");
}
