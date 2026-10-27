import { writeReport, BenchmarkRunner, createLongTaskRR } from "@agent/benchmark";
import { createRuntimeScenariosFor, prepareWorkspaces, withTempRoot } from "./factory.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const casesPerCategory = Number(flag("--cases") ?? "5");
  const repetitions = Number(flag("--repetitions") ?? "1");
  const outputDir = flag("--out") ?? "reports";

  if (!Number.isInteger(casesPerCategory) || casesPerCategory < 1) {
    process.stderr.write("--cases must be a positive integer\n");
    process.exitCode = 2;
    return;
  }
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    process.stderr.write("--repetitions must be a positive integer\n");
    process.exitCode = 2;
    return;
  }

  const tasks = createLongTaskRR(casesPerCategory);
  process.stdout.write(`LongTask-RR: ${tasks.length} tasks, ${repetitions} repetition(s)\n`);

  const report = await withTempRoot(async (root) => {
    await prepareWorkspaces(root, tasks.map((task) => task.id));
    const scenarios = createRuntimeScenariosFor(root);
    return new BenchmarkRunner(20261027, "runtime").run(scenarios, tasks, repetitions);
  });

  await writeReport(report, outputDir);
  process.stdout.write(`\nwrote ${outputDir}/benchmark.json and ${outputDir}/benchmark.md\n`);
  for (const metric of report.metrics) {
    const [low, high] = metric.successRateCi95;
    process.stdout.write(
      `${metric.config.padEnd(34)} success ${(metric.successRate * 100).toFixed(1)}% (${(low * 100).toFixed(1)}–${(high * 100).toFixed(1)}%)  recovery ${(metric.recoverySuccessRate * 100).toFixed(1)}%  latency ${Math.round(metric.averageLatencyMs)}ms\n`
    );
  }
}

await main();
