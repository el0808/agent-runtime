import { afterEach, describe, expect, it } from "vitest";
import { createJevHttpTransport } from "@agent/routing";
import { decide, startJevService } from "./index.js";

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

describe("decision heuristic", () => {
  it("escalates high-risk approvals to review", () => {
    expect(decide({ taskId: "t", goal: "deploy", kind: "approval", options: ["allow", "review"], risk: "high", failureCount: 0 }).choice).toBe("review");
    expect(decide({ taskId: "t", goal: "read", kind: "approval", options: ["allow", "review"], risk: "low", failureCount: 0 }).choice).toBe("allow");
  });

  it("stops only after the failure budget is exhausted", () => {
    expect(decide({ taskId: "t", goal: "retry", kind: "stop", options: ["continue", "stop"], risk: "low", failureCount: 1 }).choice).toBe("continue");
    expect(decide({ taskId: "t", goal: "retry", kind: "stop", options: ["continue", "stop"], risk: "low", failureCount: 3 }).choice).toBe("stop");
  });

  it("keeps confidence below 1 so callers exercise fallback", () => {
    const reply = decide({ taskId: "t", goal: "x", kind: "tool", options: ["fast"], risk: "low", failureCount: 0 });
    expect(reply.confidence).toBeLessThan(1);
    expect(reply.confidence).toBeGreaterThan(0);
  });
});

describe("jev http service", () => {
  it("answers a decision request over http", async () => {
    const server = await startJevService({ port: 0 });
    servers.push(server);
    const response = await fetch(`${server.url}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "t", goal: "long running job", kind: "runner", options: ["background", "direct"], risk: "low", failureCount: 0 })
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choice: string; confidence: number; latencyMs: number };
    expect(body.choice).toBe("background");
    expect(typeof body.latencyMs).toBe("number");
  });

  it("rejects an incomplete request", async () => {
    const server = await startJevService({ port: 0 });
    servers.push(server);
    const response = await fetch(`${server.url}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "x" })
    });
    expect(response.status).toBe(400);
  });

  it("round-trips through the runtime transport", async () => {
    const server = await startJevService({ port: 0 });
    servers.push(server);
    const transport = createJevHttpTransport({ baseUrl: server.url, timeoutMs: 2000 });
    const controller = new AbortController();
    const reply = await transport(
      { taskId: "t", goal: "fixed workflow pipeline", kind: "runner", options: ["state-graph", "direct"], risk: "low", failureCount: 0 },
      controller.signal
    );
    expect(reply.choice).toBe("state-graph");
    expect(reply.confidence).toBeGreaterThan(0);
  });
});
