import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { JsonObject, RunnerType, RuntimeEvent } from "@agent/protocol";
import { RUNNER_TYPES } from "@agent/protocol";
import type { AgentRuntime } from "@agent/runtime";
import { newTaskId } from "@agent/runtime";
import { handleRpc } from "./rpc.js";

export interface GatewayServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export interface GatewayOptions {
  readonly port?: number;
  readonly host?: string;
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}

function isRunnerType(value: unknown): value is RunnerType {
  return typeof value === "string" && (Object.values(RUNNER_TYPES) as string[]).includes(value);
}

function methodOf(req: IncomingMessage): string {
  return req.method ?? "GET";
}

/**
 * Routes a REST path against the runtime. Kept separate from the HTTP plumbing so
 * the JSON-RPC surface can reuse the same operations.
 */
async function route(runtime: AgentRuntime, req: IncomingMessage, url: URL, body: unknown): Promise<Reply | { stream: RuntimeEvent[] }> {
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const method = methodOf(req);

  if (segments[0] === "health") {
    return { status: 200, body: { ok: true } };
  }

  if (segments[0] === "tasks" && segments.length === 1 && method === "POST") {
    const input = (body ?? {}) as JsonObject;
    const goal = typeof input.goal === "string" ? input.goal : "";
    if (goal.trim() === "") {
      return { status: 400, body: { error: "goal is required" } };
    }
    const runnerType = isRunnerType(input.runnerType) ? input.runnerType : RUNNER_TYPES.DIRECT;
    const taskId = typeof input.taskId === "string" && input.taskId !== "" ? input.taskId : newTaskId();
    const metadata = typeof input.metadata === "object" && input.metadata !== null ? (input.metadata as JsonObject) : undefined;
    const state = runtime.createTask({ taskId, goal, runnerType, ...(metadata === undefined ? {} : { metadata }) });
    return { status: 201, body: state };
  }

  const taskId = segments[1];
  if (segments[0] !== "tasks" || taskId === undefined) {
    return { status: 404, body: { error: `No route for ${method} ${url.pathname}` } };
  }
  const action = segments[2];

  if (action === undefined && method === "GET") {
    const state = runtime.getTask(taskId);
    return state === undefined ? { status: 404, body: { error: `Task ${taskId} not found` } } : { status: 200, body: state };
  }

  if (action === "events" && method === "GET") {
    if (runtime.getTask(taskId) === undefined) {
      return { status: 404, body: { error: `Task ${taskId} not found` } };
    }
    return { status: 200, body: runtime.getEvents(taskId) };
  }

  if (action === "run" && method === "POST") {
    const failuresInput = (body ?? {}) as JsonObject;
    const failures = typeof failuresInput.failures === "number" ? failuresInput.failures : 0;
    const collected: RuntimeEvent[] = [];
    for await (const event of runtime.run(taskId, failures)) {
      collected.push(event);
    }
    return { status: 200, body: { events: collected, state: runtime.getTask(taskId) } };
  }

  if (action === "stream" && method === "GET") {
    const collected: RuntimeEvent[] = [];
    for await (const event of runtime.run(taskId)) {
      collected.push(event);
    }
    return { stream: collected };
  }

  if (action === "approvals" && method === "GET") {
    return { status: 200, body: runtime.pendingApprovals(taskId) };
  }

  if (action === "approvals" && method === "POST") {
    const input = (body ?? {}) as JsonObject;
    const approvalId = typeof input.approvalId === "string" ? input.approvalId : "";
    if (approvalId === "") {
      return { status: 400, body: { error: "approvalId is required" } };
    }
    const actor = typeof input.actor === "string" ? input.actor : "user";
    const reason = typeof input.reason === "string" ? input.reason : undefined;
    if (input.decision === "reject") {
      runtime.reject(taskId, approvalId, actor, reason);
    } else {
      runtime.approve(taskId, approvalId, actor, reason);
    }
    return { status: 200, body: { approvalId, decision: input.decision === "reject" ? "rejected" : "approved" } };
  }

  if (action === "verify" && method === "POST") {
    return { status: 200, body: runtime.verify(taskId) };
  }

  if (action === "rollback" && method === "POST") {
    await runtime.rollback(taskId);
    return { status: 200, body: runtime.getTask(taskId) };
  }

  if (action === "pause" && method === "POST") {
    await runtime.pause(taskId);
    return { status: 200, body: runtime.getTask(taskId) };
  }

  if (action === "resume" && method === "POST") {
    await runtime.resume(taskId);
    return { status: 200, body: runtime.getTask(taskId) };
  }

  if (action === "cancel" && method === "POST") {
    await runtime.cancel(taskId);
    return { status: 200, body: runtime.getTask(taskId) };
  }

  if (action === "export" && method === "GET") {
    return { status: 200, body: runtime.exportTask(taskId) };
  }

  if (action === "import" && method === "POST") {
    return { status: 200, body: runtime.importTask(body as never) };
  }

  return { status: 405, body: { error: `Method ${method} is not allowed for ${url.pathname}` } };
}

function writeStream(res: ServerResponse, events: readonly RuntimeEvent[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  for (const event of events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

export async function startServer(runtime: AgentRuntime, options: GatewayOptions = {}): Promise<GatewayServer> {
  const port = options.port ?? 4317;
  const host = options.host ?? "127.0.0.1";

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);

        if (url.pathname === "/rpc" && methodOf(req) === "POST") {
          const body = await readBody(req);
          const result = await handleRpc(runtime, body);
          json(res, result.status, result.body);
          return;
        }

        // Subscribers receive every event the runtime emits, including ones
        // produced outside a run (approvals, rollback).
        if (url.pathname === "/events" && methodOf(req) === "GET") {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive"
          });
          const unsubscribe = runtime.events.subscribe((event) => {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          });
          const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
          ping.unref();
          req.on("close", () => {
            clearInterval(ping);
            unsubscribe();
          });
          return;
        }

        const body = methodOf(req) === "POST" ? await readBody(req) : undefined;
        const result = await route(runtime, req, url, body);
        if ("stream" in result) {
          writeStream(res, result.stream);
          return;
        }
        json(res, result.status, result.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          json(res, 500, { error: message });
        } else {
          res.end();
        }
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      })
  };
}
