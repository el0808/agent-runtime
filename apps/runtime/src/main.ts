import { RUNNER_TYPES } from "@agent/protocol";
import type { RunnerType } from "@agent/protocol";
import { AgentRuntime, newTaskId } from "./runtime.js";

const USAGE = `Usage: agent-runtime <command> [options]

Commands:
  run "<goal>" [--runner <type>]    Create a task and run it to completion.
  verify <taskId>                   Run deterministic verification on a task.

The HTTP/SSE control plane lives in @agent/gateway (pnpm --filter @agent/gateway start).
`;

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "run") {
    const goal = rest.find((value) => !value.startsWith("--"));
    if (goal === undefined || goal.trim() === "") {
      process.stderr.write("A goal is required: agent-runtime run \"<goal>\"\n");
      return 2;
    }
    const runnerFlag = rest.indexOf("--runner");
    const requested = runnerFlag >= 0 ? rest[runnerFlag + 1] : RUNNER_TYPES.DIRECT;
    const runnerType = (Object.values(RUNNER_TYPES) as string[]).includes(requested ?? "")
      ? (requested as RunnerType)
      : undefined;
    if (runnerType === undefined) {
      process.stderr.write(`Unknown runner type: ${requested ?? ""}\n`);
      return 2;
    }
    const runtime = new AgentRuntime();
    const taskId = newTaskId();
    runtime.createTask({ taskId, goal, runnerType });
    for await (const event of runtime.run(taskId)) {
      process.stdout.write(`${event.type} #${event.sequence}\n`);
    }
    const state = runtime.getTask(taskId);
    process.stdout.write(`\nstatus: ${state?.status ?? "unknown"}\n`);
    runtime.close();
    return state?.status === "completed" ? 0 : 1;
  }

  if (command === "verify") {
    const taskId = rest[0];
    if (taskId === undefined) {
      process.stderr.write("A task id is required: agent-runtime verify <taskId>\n");
      return 2;
    }
    const runtime = new AgentRuntime();
    const result = await runtime.verify(taskId);
    process.stdout.write(`${result.status}: ${result.summary}\n`);
    runtime.close();
    return result.status === "passed" ? 0 : 1;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
);
