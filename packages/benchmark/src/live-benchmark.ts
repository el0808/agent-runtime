/**
 * Live benchmark against the configured model.
 *
 * Method mirrors how the current agent benchmarks are scored:
 *  - every task is checked by its side effect on disk, never by the model's
 *    own claim of success, so a confident wrong answer scores zero;
 *  - each task runs `--repeats` times and reports pass@1 over all trials and
 *    pass^k, the chance every trial of a task succeeded (tau-bench's
 *    reliability metric: a harness that is right 4 times in 5 is not reliable);
 *  - tasks are ordered easy to hard so a failure names the capability that broke.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@agent/runtime";

export interface TrialInfo {
  readonly toolCalls: readonly { toolName: string; status: string }[];
  /** Everything the model wrote during the run, joined. */
  readonly answer: string;
  readonly status: string;
}

export interface BenchmarkTask {
  readonly name: string;
  /** What the user types. Nothing about the expected answer is in the prompt. */
  readonly goal: string;
  /** Files created before the run. */
  readonly files?: Readonly<Record<string, string>>;
  /** Returns null on success, or a description of what was wrong. */
  readonly verify: (workspace: string, info: TrialInfo) => Promise<string | null>;
}

const readOr = async (file: string): Promise<string | null> => {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
};

export const TASKS: readonly BenchmarkTask[] = [
  {
    name: "read-and-report",
    goal: "Read config.json and tell me the value of the field named port. Reply with just the number.",
    files: { "config.json": '{"port": 8080, "host": "localhost"}' },
    verify: async (_workspace, info) => (/\b8080\b/u.test(info.answer) ? null : `answer did not contain 8080: ${info.answer.slice(0, 120)}`)
  },
  {
    name: "create-file-with-exact-content",
    goal: "Create a file named hello.txt whose entire content is exactly: Hello, agent!",
    verify: async (workspace) => {
      const content = await readOr(path.join(workspace, "hello.txt"));
      if (content === null) return "hello.txt was not created";
      const trimmed = content.trim();
      if (trimmed !== "Hello, agent!") return `content was ${JSON.stringify(content).slice(0, 80)}`;
      return null;
    }
  },
  {
    name: "edit-one-line",
    goal: "In main.py, change the timeout from 30 to 90. Do not change anything else in the file.",
    files: { "main.py": "import requests\n\nTIMEOUT = 30\nRETRIES = 3\n\ndef fetch(url):\n    return requests.get(url, timeout=TIMEOUT)\n" },
    verify: async (workspace) => {
      const content = await readOr(path.join(workspace, "main.py"));
      if (content === null) return "main.py disappeared";
      if (!content.includes("TIMEOUT = 90")) return "timeout not changed to 90";
      if (!content.includes("RETRIES = 3")) return "unrelated line RETRIES was damaged";
      if (!content.includes("def fetch(url):")) return "rest of the file was lost";
      return null;
    }
  },
  {
    name: "multi-step-rename-and-update",
    goal: "Rename every occurrence of the function name computeTotal to compute_total in totals.js, then confirm the file still parses as JavaScript.",
    files: { "totals.js": "export function computeTotal(a, b) {\n  return a + b;\n}\n\nexport const twice = (n) => computeTotal(n, n);\n" },
    verify: async (workspace) => {
      const content = await readOr(path.join(workspace, "totals.js"));
      if (content === null) return "totals.js disappeared";
      if (content.includes("computeTotal")) return "old name still present";
      const matches = content.split("compute_total").length - 1;
      if (matches !== 2) return `expected 2 occurrences of the new name, found ${matches}`;
      return null;
    }
  },
  {
    name: "recover-from-missing-file",
    goal: "The settings live in one of settings.yaml or config/settings.yaml. Read whichever exists and tell me the value of retries. Reply with just the number.",
    files: { "config/settings.yaml": "retries: 7\nverbose: false\n" },
    verify: async (_workspace, info) => (/\b7\b/u.test(info.answer) ? null : `answer did not contain 7: ${info.answer.slice(0, 120)}`)
  },
  {
    name: "search-then-edit",
    goal: "Find which file defines the function called parseHeader, then add a guard at the start of its body: if (raw === undefined) return null;",
    files: {
      "src/a.js": "export const a = 1;\n",
      "src/parser.js": "export function parseHeader(raw) {\n  return raw.split(':');\n}\n",
      "src/b.js": "export const b = 2;\n"
    },
    verify: async (workspace) => {
      const content = await readOr(path.join(workspace, "src/parser.js"));
      if (content === null) return "parser.js disappeared";
      if (!content.includes("if (raw === undefined) return null;")) return "guard was not added";
      if (!content.includes("return raw.split(':');")) return "the original body was destroyed";
      const a = await readOr(path.join(workspace, "src/a.js"));
      if (a !== "export const a = 1;\n") return "an unrelated file was modified";
      return null;
    }
  },
  {
    name: "refuse-impossible",
    goal: "Delete the file secrets/nothing-here.txt and then tell me what its contents were.",
    // The file does not exist, so the only correct behaviour is to say so.
    // Inventing contents is the failure this task exists to catch.
    verify: async (_workspace, info) => {
      const hedged = /(no such file|does not exist|doesn't exist|not found|missing|cannot|could not|couldn't|unable|不存在|无法|没有该文件|找不到)/iu.test(info.answer);
      if (!hedged) return `claim of contents without a missing-file report: ${info.answer.slice(0, 140)}`;
      return null;
    }
  }
];

export interface TrialResult {
  readonly task: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly toolCalls: number;
  readonly failedTools: number;
  readonly ms: number;
}

/** Runs one task once in a fresh workspace and reports the verified outcome. */
export async function runTrial(task: BenchmarkTask, runtimeFactory: (workspace: string) => AgentRuntime): Promise<TrialResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-"));
  const startedAt = Date.now();
  try {
    for (const [file, content] of Object.entries(task.files ?? {})) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    const runtime = runtimeFactory(root);
    try {
      const taskId = `bench-${task.name}-${Date.now()}`;
      runtime.createTask({ taskId, goal: task.goal, runnerType: "direct" });
      await runtime.runToCompletion(taskId).catch(() => undefined);

      // The approval gate is correct behaviour, not a failure: a benchmark is
      // an unattended stand-in for a user who is watching and approves. Grant
      // each pause and resume, up to a bound so a loop cannot hang the run.
      for (let round = 0; round < 8; round += 1) {
        const pending = runtime.pendingApprovals(taskId);
        if (pending.length === 0) break;
        for (const approvalId of pending) runtime.approve(taskId, approvalId);
        await runtime.runToCompletion(taskId).catch(() => undefined);
      }
      const state = runtime.getTask(taskId);
      if (state === undefined) return { task: task.name, ok: false, detail: "task vanished", toolCalls: 0, failedTools: 0, ms: Date.now() - startedAt };

      const calls = state.toolCalls.map((call) => ({ toolName: call.toolName, status: call.status }));
      const failedTools = calls.filter((call) => call.status !== "succeeded").length;
      const answer = runtime
        .getEvents(taskId)
        .flatMap((event) => (event.type === "model.completed" && typeof event.payload.text === "string" ? [event.payload.text] : []))
        .join("\n");
      const problem = await task.verify(root, { toolCalls: calls, answer, status: state.status });
      const detail = problem ?? (state.status === "completed" ? "ok" : `task ended ${state.status}: ${state.error?.message ?? ""}`);
      return { task: task.name, ok: problem === null, detail, toolCalls: calls.length, failedTools, ms: Date.now() - startedAt };
    } finally {
      runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function summarize(results: readonly TrialResult[]): {
  readonly trials: number;
  readonly passed: number;
  readonly passAt1: number;
  readonly passHatK: number;
  readonly byTask: readonly { readonly task: string; readonly runs: number; readonly passed: number; readonly detail: string }[];
} {
  const passed = results.filter((r) => r.ok).length;
  const byTaskMap = new Map<string, TrialResult[]>();
  for (const result of results) {
    const list = byTaskMap.get(result.task) ?? [];
    list.push(result);
    byTaskMap.set(result.task, list);
  }
  const byTask = [...byTaskMap.entries()].map(([task, runs]) => ({
    task,
    runs: runs.length,
    passed: runs.filter((r) => r.ok).length,
    detail: runs.find((r) => !r.ok)?.detail ?? "ok"
  }));
  // pass^k: every trial of a task must succeed for that task to count.
  const passHatK = byTask.filter((entry) => entry.passed === entry.runs).length / Math.max(1, byTask.length);
  return {
    trials: results.length,
    passed,
    passAt1: results.length === 0 ? 0 : passed / results.length,
    passHatK,
    byTask
  };
}
