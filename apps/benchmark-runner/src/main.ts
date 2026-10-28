import { readFile } from "node:fs/promises";
import { writeReport, BenchmarkRunner, createLongTaskRR, importPublicJsonlDataset } from "@agent/benchmark";
import type { LongTaskCase } from "@agent/benchmark";
import { createRuntimeScenariosFor, prepareWorkspaces, withTempRoot } from "./factory.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Loads a task set: `--dataset <file.jsonl>` for public sets, else LongTask-RR. */
async function loadTasks(): Promise<{ tasks: readonly LongTaskCase[]; source: string }> {
  const datasetPath = flag("--dataset");
  if (datasetPath !== undefined) {
    const text = await readFile(datasetPath, "utf8");
    return { tasks: importPublicJsonlDataset(text), source: datasetPath };
  }
  const casesPerCategory = Number(flag("--cases") ?? "5");
  if (!Number.isInteger(casesPerCategory) || casesPerCategory < 1) {
    throw new Error("--cases must be a positive integer");
  }
  return { tasks: createLongTaskRR(casesPerCategory), source: "LongTask-RR" };
}

async function main(): Promise<void> {
  const repetitions = Number(flag("--repetitions") ?? "1");
  const outputDir = flag("--out") ?? "reports";

  if (!Number.isInteger(repetitions) || repetitions < 1) {
    process.stderr.write("--repetitions must be a positive integer\n");
    process.exitCode = 2;
    return;
  }

  let loaded: { tasks: readonly LongTaskCase[]; source: string };
  try {
    loaded = await loadTasks();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  const { tasks, source } = loaded;
  process.stdout.write(`${source}: ${tasks.length} tasks, ${repetitions} repetition(s)\n`);

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
