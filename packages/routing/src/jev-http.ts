import { ERROR_CODES, RuntimeError } from "@agent/protocol";
import type { DecisionContext, JevResponse, JevTransport } from "./decision.js";

export interface JevHttpTransportOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Talks to a Jev decision service over HTTP. Any transport-level problem throws,
 * and `DecisionRouter` turns that into a fallback to the deterministic rules.
 */
export function createJevHttpTransport(options: JevHttpTransportOptions): JevTransport {
  const url = `${options.baseUrl.replace(/\/+$/, "")}/decide`;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const headers = options.headers ?? {};

  return async (context: DecisionContext, signal: AbortSignal): Promise<JevResponse> => {
    const controller = new AbortController();
    const relay = () => controller.abort(signal.reason);
    signal.addEventListener("abort", relay, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("jev transport timeout")), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          taskId: context.taskId,
          goal: context.goal,
          kind: context.kind,
          options: context.options,
          risk: context.risk,
          failureCount: context.failureCount
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new RuntimeError({
          code: ERROR_CODES.DEPENDENCY_UNAVAILABLE,
          message: `Jev responded ${response.status}: ${detail.slice(0, 200)}`
        });
      }
      const body = (await response.json()) as Partial<JevResponse>;
      if (typeof body.choice !== "string" || typeof body.confidence !== "number") {
        throw new RuntimeError({
          code: ERROR_CODES.DEPENDENCY_UNAVAILABLE,
          message: "Jev response is missing choice or confidence"
        });
      }
      return {
        choice: body.choice,
        confidence: body.confidence,
        ...(typeof body.reason === "string" ? { reason: body.reason } : {})
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", relay);
    }
  };
}

/** Builds a transport from `AGENT_JEV_URL`, or undefined when unset. */
export function jevTransportFromEnv(env: NodeJS.ProcessEnv = process.env): JevTransport | undefined {
  const baseUrl = env.AGENT_JEV_URL;
  if (baseUrl === undefined || baseUrl === "") {
    return undefined;
  }
  return createJevHttpTransport({ baseUrl });
}
