import { AgentRuntime } from "@agent/runtime";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4317;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write(`Invalid port: ${process.argv[portIndex + 1] ?? ""}\n`);
    process.exitCode = 2;
    return;
  }
  const runtime = new AgentRuntime();
  const server = await startServer(runtime, { port });
  process.stdout.write(`agent-gateway listening on ${server.url}\n`);
  process.stdout.write(`  GET  /events            server-sent event stream\n`);
  process.stdout.write(`  POST /tasks             {"goal","runnerType?"}\n`);
  process.stdout.write(`  POST /tasks/:id/run     run to completion\n`);
  process.stdout.write(`  POST /tasks/:id/approvals {"approvalId","decision"}\n`);
  process.stdout.write(`  POST /rpc               JSON-RPC 2.0\n`);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void server.close().then(() => {
      runtime.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
