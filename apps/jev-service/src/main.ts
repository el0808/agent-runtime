import { startJevService } from "./service.js";

async function main(): Promise<void> {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4318;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write(`Invalid port: ${process.argv[portIndex + 1] ?? ""}\n`);
    process.exitCode = 2;
    return;
  }
  const server = await startJevService({ port });
  process.stdout.write(`jev-service listening on ${server.url}\nPoint the runtime at it with AGENT_JEV_URL=${server.url}\n`);

  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
