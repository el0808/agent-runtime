import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { LocalSyncStore } from "@agent/sync";
import type { SyncEnvelope } from "@agent/sync";
import { DeviceRegistry } from "./auth.js";

export interface SyncServiceOptions {
  readonly port?: number;
  readonly host?: string;
  readonly dataDir: string;
}

export interface SyncService {
  readonly url: string;
  readonly close: () => Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw === "" ? undefined : (JSON.parse(raw) as unknown);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

export async function startSyncService(options: SyncServiceOptions): Promise<SyncService> {
  const port = options.port ?? 4319;
  const host = options.host ?? "127.0.0.1";
  const registry = new DeviceRegistry(path.join(options.dataDir, "devices.json"));
  const store = new LocalSyncStore(path.join(options.dataDir, "records.json"));

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
        const method = req.method ?? "GET";

        if (url.pathname === "/health") {
          json(res, 200, { ok: true, devices: registry.devices().length });
          return;
        }

        if (url.pathname === "/devices" && method === "POST") {
          const body = (await readJson(req)) as { label?: unknown } | undefined;
          const label = typeof body?.label === "string" ? body.label : undefined;
          json(res, 201, registry.register(label));
          return;
        }

        const deviceId = url.searchParams.get("deviceId") ?? "";
        const token = bearer(req) ?? "";
        if (!registry.verify(deviceId, token)) {
          json(res, 401, { error: "Unknown device or invalid token" });
          return;
        }

        if (url.pathname === "/sync/push" && method === "POST") {
          const body = (await readJson(req)) as { records?: unknown } | undefined;
          if (!Array.isArray(body?.records)) {
            json(res, 400, { error: "records must be an array" });
            return;
          }
          const result = store.append(body.records as SyncEnvelope[]);
          json(res, 200, { accepted: result.accepted.length, conflicts: result.conflicts, cursor: store.getCursor() });
          return;
        }

        if (url.pathname === "/sync/pull" && method === "GET") {
          const cursor = Number(url.searchParams.get("cursor") ?? "0");
          if (!Number.isInteger(cursor) || cursor < 0) {
            json(res, 400, { error: "cursor must be a non-negative integer" });
            return;
          }
          json(res, 200, store.exportSince(deviceId, cursor));
          return;
        }

        json(res, 404, { error: `No route for ${method} ${url.pathname}` });
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))))
  };
}
