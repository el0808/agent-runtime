/**
 * CLI entry for the live benchmark: `pnpm bench:live --repeats 3`.
 * Reads provider settings from AGENT_* environment variables so no key is
 * ever written into the repository.
 */
import { AgentRuntime } from "@agent/runtime";
import { TASKS, runTrial, summarize } from "./live-benchmark.js";

const args = process.argv.slice(2);
const repeatsArg = args[args.indexOf("--repeats") + 1];
const repeats = args.includes("--repeats") && repeatsArg !== undefined ? Math.max(1, Number(repeatsArg)) : 1;
const onlyArg = args.indexOf("--only") >= 0 ? args[args.indexOf("--only") + 1] : undefined;

const tasks = onlyArg === undefined ? TASKS : TASKS.filter((task) => task.name === onlyArg);
const storageDir = process.env.AGENT_BENCH_STORAGE ?? ".bench-storage";

const results = [];
for (const task of tasks) {
  for (let run = 1; run <= repeats; run += 1) {
    // The workspace is the trial's own temp directory: tools must resolve
    // relative paths against it, not against wherever the CLI was started.
    const result = await runTrial(task, (workspace) => new AgentRuntime({ config: { storageDir, workspaceRoot: workspace } }));
    results.push(result);
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${task.name}  run ${run}/${repeats}  ${result.detail}  (${result.toolCalls} tools, ${result.ms} ms)`);
  }
}

const summary = summarize(results);
console.log("");
console.log(`pass@1  ${(summary.passAt1 * 100).toFixed(1)}%  (${summary.passed}/${summary.trials} trials)`);
console.log(`pass^k  ${(summary.passHatK * 100).toFixed(1)}%  (task reliable across every repeat)`);
for (const entry of summary.byTask) {
  console.log(`  ${entry.task}: ${entry.passed}/${entry.runs}${entry.passed === entry.runs ? "" : `  — ${entry.detail}`}`);
}
process.exit(summary.passAt1 === 1 ? 0 : 1);
