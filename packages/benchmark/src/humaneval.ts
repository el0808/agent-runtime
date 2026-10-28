/**
 * HumanEval, driven through the real agent loop.
 *
 * The reference harness samples one completion per task and stops. Here the
 * agent is dropped into a workspace holding only the prompt and must write the
 * solution itself, import it, and fix it if the import fails — so a failure can
 * come from the model or from the harness, which is what makes the number
 * meaningful for this project rather than for the model alone.
 *
 * Scoring runs each task's official test block in a subprocess with a timeout,
 * so a wrong answer scores zero instead of hanging the run.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@agent/runtime";

export interface HumanEvalTask {
  readonly task_id: string;
  readonly prompt: string;
  readonly canonical_solution?: string;
  readonly test: string;
  readonly entry_point: string;
}

export interface HumanEvalResult {
  readonly id: string;
  readonly ok: boolean;
  /** "passed", or the failing reason: no file written, assertion, timeout. */
  readonly detail: string;
  readonly ms: number;
}

/** Reads the bundled dataset, which ships with the package so runs are reproducible. */
export async function loadHumanEval(dataPath?: string): Promise<HumanEvalTask[]> {
  const file = dataPath ?? path.join(import.meta.dirname, "..", "data", "humaneval.jsonl");
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as HumanEvalTask);
}

/** Runs a finished program under a timeout; a timeout counts as a failure. */
function runPython(source: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    void (async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "humaneval-prog-"));
      const file = path.join(dir, "program.py");
      await writeFile(file, source, "utf8");
      const child = spawn("python3", [file], { cwd: dir });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        void rm(dir, { recursive: true, force: true });
        if (signal !== null) {
          resolve({ ok: false, output: `timed out after ${timeoutMs} ms` });
          return;
        }
        resolve({ ok: code === 0, output: output.slice(-800) });
      });
    })();
  });
}

/** The instruction given to the agent. It names the file and the entry point only. */
function goalFor(task: HumanEvalTask): string {
  return [
    "Read prompt.txt. It contains a Python function signature and docstring.",
    `Write solution.py containing the function ${task.entry_point} implemented to satisfy the docstring.`,
    "Write only the complete function, with any imports at the top. No tests, no example calls.",
    'Then confirm it imports: python3 -c "import solution"'
  ].join(" ");
}

export interface HumanEvalOptions {
  /** Builds a runtime rooted at the given workspace and storage directory. */
  readonly makeRuntime: (workspace: string, storage: string) => AgentRuntime;
  /** Tasks run at once. Each gets its own storage; a shared SQLite would lock. */
  readonly concurrency?: number;
  /** Per-task limit for the official test program. */
  readonly testTimeoutMs?: number;
  /** Called as each task finishes, for progress output. */
  readonly onResult?: (result: HumanEvalResult) => void;
}

/**
 * Runs the tasks and returns one result each.
 *
 * Every task gets a fresh workspace and a fresh storage directory. Sharing one
 * ledger across concurrent runs means concurrent writers on one SQLite file.
 */
export async function runHumanEval(
  tasks: readonly HumanEvalTask[],
  options: HumanEvalOptions
): Promise<HumanEvalResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const testTimeoutMs = options.testTimeoutMs ?? 10_000;
  const results: HumanEvalResult[] = [];
  let next = 0;

  const runOne = async (task: HumanEvalTask): Promise<HumanEvalResult> => {
    const startedAt = Date.now();
    const workspace = await mkdtemp(path.join(os.tmpdir(), "humaneval-ws-"));
    const storage = await mkdtemp(path.join(os.tmpdir(), "humaneval-store-"));
    try {
      await writeFile(path.join(workspace, "prompt.txt"), task.prompt, "utf8");
      const runtime = options.makeRuntime(workspace, storage);
      const taskId = `humaneval-${task.task_id.replace("/", "-")}`;
      try {
        runtime.createTask({ taskId, goal: goalFor(task), runnerType: "direct", metadata: { autoRoute: false } });
        await runtime.runToCompletion(taskId).catch(() => undefined);
        // A write needs approval; an unattended run stands in for a user who
        // would grant it, up to a bound so a loop cannot hang the run.
        for (let round = 0; round < 4; round += 1) {
          const pending = runtime.pendingApprovals(taskId);
          if (pending.length === 0) break;
          for (const approvalId of pending) runtime.approve(taskId, approvalId);
          await runtime.runToCompletion(taskId).catch(() => undefined);
        }
      } finally {
        runtime.close();
      }

      const solution = await readFile(path.join(workspace, "solution.py"), "utf8").catch(() => null);
      if (solution === null) {
        return { id: task.task_id, ok: false, detail: "no solution.py written", ms: Date.now() - startedAt };
      }
      // The official scoring program: prompt, candidate, the task's own tests.
      const program = `${task.prompt}\n${solution}\n${task.test}\ncheck(${task.entry_point})\n`;
      const run = await runPython(program, testTimeoutMs);
      const last = run.output.split("\n").filter((line) => line.trim() !== "").at(-1) ?? "failed";
      return {
        id: task.task_id,
        ok: run.ok,
        detail: run.ok ? "passed" : last.slice(0, 200),
        ms: Date.now() - startedAt
      };
    } catch (error) {
      return {
        id: task.task_id,
        ok: false,
        detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
        ms: Date.now() - startedAt
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      if (task === undefined) break;
      const result = await runOne(task);
      results.push(result);
      options.onResult?.(result);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface HumanEvalSummary {
  readonly total: number;
  readonly passed: number;
  readonly passAt1: number;
  readonly medianMs: number;
  readonly p90Ms: number;
  readonly failures: readonly HumanEvalResult[];
}

/** pass@1 plus the latency figures the run actually produced. */
export function summarizeHumanEval(results: readonly HumanEvalResult[]): HumanEvalSummary {
  const passed = results.filter((result) => result.ok).length;
  const times = results.map((result) => result.ms).sort((a, b) => a - b);
  const at = (ratio: number): number => times.length === 0 ? 0 : times[Math.min(times.length - 1, Math.floor(times.length * ratio))] as number;
  return {
    total: results.length,
    passed,
    passAt1: results.length === 0 ? 0 : passed / results.length,
    medianMs: at(0.5),
    p90Ms: at(0.9),
    failures: results.filter((result) => !result.ok)
  };
}
