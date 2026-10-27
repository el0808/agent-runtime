import { describe, expect, it } from "vitest";
import { BenchmarkRunner, createLongTaskRR, createOfflineScenarios, renderMarkdown } from "./index.js";

it("creates the reproducible LongTask-RR corpus", () => {
  const tasks = createLongTaskRR();
  expect(tasks).toHaveLength(300);
  expect(new Set(tasks.map((task) => task.category)).size).toBe(10);
});

describe("BenchmarkRunner", () => {
  it("compares A-F offline and renders JSON-equivalent Markdown", async () => {
    const report = await new BenchmarkRunner(42).run(createOfflineScenarios(), createLongTaskRR(2), 2);
    expect(report.metrics).toHaveLength(6);
    expect(report.metrics.map((metric) => metric.config)).toContain("F-runtime-jev-verifier-recovery");
    expect(report.targets.maxHighRiskUnauthorized).toBe(0);
    expect(renderMarkdown(report)).toContain("LongTask-RR");
  });
});
