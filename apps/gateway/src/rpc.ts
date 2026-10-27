import type { JsonObject } from "@agent/protocol";
import { RUNNER_TYPES } from "@agent/protocol";
import type { RunnerType } from "@agent/protocol";
import type { AgentRuntime } from "@agent/runtime";
import { newTaskId } from "@agent/runtime";

export interface RpcError {
  readonly code: number;
  readonly message: string;
}

export interface RpcResponse {
  readonly status: number;
  readonly body: { readonly jsonrpc: "2.0"; readonly id: unknown; readonly result?: unknown; readonly error?: RpcError };
}

function error(id: unknown, code: number, message: string, status = 200): RpcResponse {
  return { status, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function result(id: unknown, value: unknown): RpcResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, result: value } };
}

function requireString(params: JsonObject, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRunnerType(value: unknown): value is RunnerType {
  return typeof value === "string" && (Object.values(RUNNER_TYPES) as string[]).includes(value);
}

/**
 * JSON-RPC 2.0 surface. Methods mirror the REST routes so clients can use either
 * transport without a second API definition.
 */
export async function handleRpc(runtime: AgentRuntime, body: unknown): Promise<RpcResponse> {
  if (typeof body !== "object" || body === null) {
    return error(null, -32600, "Invalid Request", 400);
  }
  const request = body as JsonObject;
  const id = request.id ?? null;
  const method = typeof request.method === "string" ? request.method : "";
  const params = typeof request.params === "object" && request.params !== null ? (request.params as JsonObject) : {};

  switch (method) {
    case "task.create": {
      const goal = requireString(params, "goal");
      if (goal === undefined) {
        return error(id, -32602, "goal is required");
      }
      const runnerType = isRunnerType(params.runnerType) ? params.runnerType : RUNNER_TYPES.DIRECT;
      const taskId = typeof params.taskId === "string" && params.taskId !== "" ? params.taskId : newTaskId();
      return result(id, runtime.createTask({ taskId, goal, runnerType }));
    }
    case "task.run": {
      const taskId = requireString(params, "taskId");
      if (taskId === undefined) {
        return error(id, -32602, "taskId is required");
      }
      const failures = typeof params.failures === "number" ? params.failures : 0;
      const collected = [];
      for await (const event of runtime.run(taskId, failures)) {
        collected.push(event);
      }
      return result(id, { events: collected, state: runtime.getTask(taskId) });
    }
    case "task.get": {
      const taskId = requireString(params, "taskId");
      if (taskId === undefined) {
        return error(id, -32602, "taskId is required");
      }
      return result(id, runtime.getTask(taskId) ?? null);
    }
    case "task.events": {
      const taskId = requireString(params, "taskId");
      if (taskId === undefined) {
        return error(id, -32602, "taskId is required");
      }
      return result(id, runtime.getEvents(taskId));
    }
    case "task.approve":
    case "task.reject": {
      const taskId = requireString(params, "taskId");
      const approvalId = requireString(params, "approvalId");
      if (taskId === undefined || approvalId === undefined) {
        return error(id, -32602, "taskId and approvalId are required");
      }
      if (method === "task.approve") {
        runtime.approve(taskId, approvalId);
      } else {
        runtime.reject(taskId, approvalId);
      }
      return result(id, { taskId, approvalId });
    }
    case "task.verify": {
      const taskId = requireString(params, "taskId");
      if (taskId === undefined) {
        return error(id, -32602, "taskId is required");
      }
      return result(id, runtime.verify(taskId));
    }
    case "task.rollback": {
      const taskId = requireString(params, "taskId");
      if (taskId === undefined) {
        return error(id, -32602, "taskId is required");
      }
      await runtime.rollback(taskId);
      return result(id, runtime.getTask(taskId) ?? null);
    }
    case "task.export": {
      const taskId = requireString(params, "taskId");
      if (taskId === undefined) {
        return error(id, -32602, "taskId is required");
      }
      return result(id, runtime.exportTask(taskId));
    }
    default:
      return error(id, -32601, `Method not found: ${method}`, 404);
  }
}
