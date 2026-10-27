import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";

export type DecisionKind = "tool" | "stop" | "escalate" | "approval" | "runner";
export type DecisionRisk = "low" | "medium" | "high" | "critical";

export interface DecisionRequest {
  readonly taskId: string;
  readonly goal: string;
  readonly kind: DecisionKind;
  readonly options: readonly string[];
  readonly risk: DecisionRisk;
  readonly failureCount: number;
}

export interface DecisionReply {
  readonly choice: string;
  readonly confidence: number;
  readonly reason: string;
}

const RISK_ORDER: Record<DecisionRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Deterministic scoring heuristic standing in for a trained router. Confidence is
 * deliberately below 1 so callers exercise their fallback paths.
 */
export function decide(request: DecisionRequest): DecisionReply {
  const option = (preferred: string, fallbackIndex = 0): string =>
    request.options.includes(preferred) ? preferred : request.options[fallbackIndex] ?? preferred;

  const goal = request.goal.toLowerCase();

  if (request.kind === "approval") {
    const escalated = RISK_ORDER[request.risk] >= RISK_ORDER.high;
    return {
      choice: escalated ? option("review") : option("allow"),
      confidence: escalated ? 0.93 : 0.81,
      reason: escalated ? "high-risk operations require human review" : "risk below the review threshold"
    };
  }

  if (request.kind === "stop") {
    const shouldStop = request.failureCount >= 3 || /\bgive up\b|无法完成/u.test(goal);
    return {
      choice: option(shouldStop ? "stop" : "continue"),
      confidence: shouldStop ? 0.9 : 0.76,
      reason: shouldStop ? "failure budget exhausted" : "retry remains viable"
    };
  }

  if (request.kind === "escalate") {
    const strong = request.failureCount >= 2 || goal.length > 400 || /\b(complex|complexity|多步骤|复杂)\b/u.test(goal);
    return {
      choice: option(strong ? "strong" : "fast"),
      confidence: strong ? 0.88 : 0.72,
      reason: strong ? "task complexity warrants the strong model" : "routine task fits the fast model"
    };
  }

  if (request.kind === "runner") {
    if (/\b(long|background|长任务)\b/u.test(goal)) {
      return { choice: option("background"), confidence: 0.86, reason: "long-running signals" };
    }
    if (/\b(workflow|pipeline|审批)\b/u.test(goal)) {
      return { choice: option("state-graph"), confidence: 0.84, reason: "fixed flow signals" };
    }
    if (request.failureCount >= 2) {
      return { choice: option("planner-executor-verifier"), confidence: 0.79, reason: "repeated failures" };
    }
    return { choice: option("direct"), confidence: 0.7, reason: "simple task" };
  }

  return {
    choice: option(request.options[0] ?? "continue"),
    confidence: 0.68,
    reason: "default tool preference"
  };
}

function reply(res: ServerResponse, status: number, body: unknown): void {
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

function isValidRequest(value: unknown): value is DecisionRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.goal === "string" &&
    typeof candidate.kind === "string" &&
    Array.isArray(candidate.options) &&
    candidate.options.every((option) => typeof option === "string") &&
    typeof candidate.risk === "string" &&
    typeof candidate.failureCount === "number"
  );
}

export interface JevServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export async function startJevService(options: { port?: number; host?: string } = {}): Promise<JevServer> {
  const port = options.port ?? 4318;
  const host = options.host ?? "127.0.0.1";

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
      if (url.pathname === "/health") {
        reply(res, 200, { ok: true });
        return;
      }
      if (url.pathname !== "/decide" || req.method !== "POST") {
        reply(res, 404, { error: `No route for ${req.method ?? "GET"} ${url.pathname}` });
        return;
      }
      try {
        const body = await readJson(req);
        if (!isValidRequest(body)) {
          reply(res, 400, { error: "goal, kind, options, risk and failureCount are required" });
          return;
        }
        const startedAt = performance.now();
        const decision = decide(body);
        reply(res, 200, { ...decision, latencyMs: Math.round(performance.now() - startedAt) });
      } catch (error) {
        reply(res, 500, { error: error instanceof Error ? error.message : String(error) });
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
