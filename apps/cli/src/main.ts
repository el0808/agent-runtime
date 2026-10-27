import { GatewayClient } from "./client.js";

const USAGE = `Usage: agent-cli <command> [args] [--url <gateway>]

Commands:
  run "<goal>" [--runner <type>]   Create a task and run it to completion.
  show <taskId>                    Print task state.
  events <taskId>                  Print the task event log.
  approvals <taskId>               List pending approval ids.
  approve <taskId> <approvalId>    Approve a pending tool call.
  reject <taskId> <approvalId>     Reject a pending tool call.
  verify <taskId>                  Run deterministic verification.

Default gateway: http://127.0.0.1:4317 (override with --url or AGENT_GATEWAY_URL).
`;

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const baseUrl = flag(rest, "--url") ?? process.env.AGENT_GATEWAY_URL ?? "http://127.0.0.1:4317";
  const client = new GatewayClient(baseUrl);
  const positional = rest.filter((value, index) => !value.startsWith("--") && rest[index - 1] !== "--url" && rest[index - 1] !== "--runner");

  switch (command) {
    case "run": {
      const goal = positional[0];
      if (goal === undefined || goal.trim() === "") {
        process.stderr.write('A goal is required: agent-cli run "<goal>"\n');
        return 2;
      }
      const created = await client.createTask(goal, flag(rest, "--runner"));
      process.stdout.write(`task ${created.taskId} dispatched to ${created.status}\n`);
      const result = await client.runTask(created.taskId);
      for (const event of result.events) {
        process.stdout.write(`  ${event.type} #${event.sequence}\n`);
      }
      const pending = await client.pendingApprovals(created.taskId);
      if (pending.length > 0) {
        process.stdout.write(`\npending approvals: ${pending.join(", ")}\n`);
        process.stdout.write(`still missing a human decision: agent-cli approve ${created.taskId} <approvalId>\n`);
      }
      process.stdout.write(`status: ${result.state.status}\n`);
      return result.state.status === "completed" ? 0 : 1;
    }
    case "show": {
      const taskId = positional[0];
      if (taskId === undefined) {
        process.stderr.write("A task id is required.\n");
        return 2;
      }
      process.stdout.write(`${JSON.stringify(await client.getTask(taskId), null, 2)}\n`);
      return 0;
    }
    case "events": {
      const taskId = positional[0];
      if (taskId === undefined) {
        process.stderr.write("A task id is required.\n");
        return 2;
      }
      for (const event of await client.getEvents(taskId)) {
        process.stdout.write(`#${event.sequence} ${event.type} ${JSON.stringify(event.payload)}\n`);
      }
      return 0;
    }
    case "approvals": {
      const taskId = positional[0];
      if (taskId === undefined) {
        process.stderr.write("A task id is required.\n");
        return 2;
      }
      const pending = await client.pendingApprovals(taskId);
      process.stdout.write(pending.length === 0 ? "no pending approvals\n" : `${pending.join("\n")}\n`);
      return 0;
    }
    case "approve":
    case "reject": {
      const [taskId, approvalId] = positional;
      if (taskId === undefined || approvalId === undefined) {
        process.stderr.write(`Usage: agent-cli ${command} <taskId> <approvalId>\n`);
        return 2;
      }
      await client.decideApproval(taskId, approvalId, command === "approve" ? "approve" : "reject");
      process.stdout.write(`${approvalId} ${command === "approve" ? "approved" : "rejected"}\n`);
      return 0;
    }
    case "verify": {
      const taskId = positional[0];
      if (taskId === undefined) {
        process.stderr.write("A task id is required.\n");
        return 2;
      }
      const result = await client.verify(taskId);
      process.stdout.write(`${result.status}: ${result.summary}\n`);
      return result.status === "passed" ? 0 : 1;
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
);
