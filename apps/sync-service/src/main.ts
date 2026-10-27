import path from "node:path";
import { startSyncService } from "./service.js";

async function main(): Promise<void> {
  const portIndex = process.argv.indexOf("--port");
  const dirIndex = process.argv.indexOf("--data");
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4319;
  const dataDir = dirIndex >= 0 ? String(process.argv[dirIndex + 1]) : path.resolve("storage/sync-service");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write(`Invalid port: ${process.argv[portIndex + 1] ?? ""}\n`);
    process.exitCode = 2;
    return;
  }
  const server = await startSyncService({ port, dataDir });
  process.stdout.write(`sync-service listening on ${server.url}\n`);
  process.stdout.write(`  POST /devices              register a device, returns {deviceId, token}\n`);
  process.stdout.write(`  POST /sync/push?deviceId=  upload envelopes (Bearer token)\n`);
  process.stdout.write(`  GET  /sync/pull?deviceId=&cursor=  download since cursor\n`);

  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
