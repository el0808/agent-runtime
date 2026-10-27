import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeScenarios, createScriptedProvider } from "@agent/benchmark";
import type { BenchmarkRuntime, BenchmarkScenario } from "@agent/benchmark";
import { AgentRuntime } from "@agent/runtime";

const FIXTURE = "seed.txt";

/**
 * Builds A–F scenarios backed by real runtimes. Each observation gets its own
 * storage directory and workspace so nothing leaks between measurements.
 */
export function createRuntimeScenariosFor(root: string): readonly BenchmarkScenario[] {
  let counter = 0;
  return createRuntimeScenarios((spec, task) => {
    counter += 1;
    const workspace = path.join(root, "workspaces", task.id);
    const runtime = new AgentRuntime({
      config: {
        storageDir: path.join(root, "runs", `${spec.config}-${counter}`),
        workspaceRoot: workspace,
        contextTokenBudget: 120
      },
      provider: createScriptedProvider(task, FIXTURE)
    });
    return runtime as unknown as BenchmarkRuntime;
  });
}

/** Creates each benchmark workspace with the fixture file the scripted model reads. */
export async function prepareWorkspaces(root: string, taskIds: readonly string[]): Promise<void> {
  for (const taskId of taskIds) {
    const dir = path.join(root, "workspaces", taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, FIXTURE), "benchmark fixture\n", "utf8");
  }
}

export async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-benchmark-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
