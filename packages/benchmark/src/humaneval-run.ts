/**
 * CLI for the HumanEval run: `pnpm bench:humaneval --limit 20 --concurrency 4`.
 *
 * Reads the provider from the usual environment variables so no key is written
 * into the repository.
 */
import { AgentRuntime } from "@agent/runtime";
import { loadHumanEval, runHumanEval, summarizeHumanEval } from "./humaneval.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};

const limit = Number(flag("limit", "0"));
const offset = Number(flag("offset", "0"));
const concurrency = Number(flag("concurrency", "4"));

const all = await loadHumanEval(flag("data"));
const tasks = all.slice(offset, limit > 0 ? offset + limit : undefined);
console.log(`HumanEval: ${tasks.length} of ${all.length} tasks, concurrency ${concurrency}`);
console.log("");

const results = await runHumanEval(tasks, {
  concurrency,
  makeRuntime: (workspace, storage) =>
    new AgentRuntime({
      config: { storageDir: storage, workspaceRoot: workspace, autoApproveMedium: true, toolTimeoutMs: 120_000 }
    }),
  onResult: (result) => {
    const label = result.detail === "passed" ? "passed" : result.detail.slice(0, 55);
    console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.id.padEnd(14)} ${label.padEnd(57)} ${result.ms}ms`);
  }
});

const summary = summarizeHumanEval(results);
console.log("");
console.log(`pass@1   ${(summary.passAt1 * 100).toFixed(1)}%  (${summary.passed}/${summary.total})`);
console.log(`latency  median ${summary.medianMs}ms, p90 ${summary.p90Ms}ms`);
console.log(`failures ${summary.failures.length === 0 ? "none" : summary.failures.map((f) => `${f.id} (${f.detail})`).join(", ")}`);
process.exit(summary.passAt1 === 1 ? 0 : 1);
