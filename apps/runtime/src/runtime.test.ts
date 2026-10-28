import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_TYPES } from "@agent/protocol";
import type { RuntimeEvent } from "@agent/protocol";
import { FakeProvider } from "@agent/runner";
import { AgentRuntime } from "./runtime.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function setup(provider: FakeProvider) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-app-"));
  dirs.push(dir);
  const runtime = new AgentRuntime({
    config: { storageDir: path.join(dir, "storage"), workspaceRoot: dir },
    provider
  });
  return { dir, runtime };
}

describe("AgentRuntime composition", () => {
  it("gates a side-effecting tool call behind approval instead of writing the file", async () => {
    const provider = new FakeProvider([
      {
        events: [
          { type: "tool_call", callId: "c1", toolName: "write_file", input: { path: "note.txt", content: "hello" } },
          { type: "completed", finishReason: "tool_call" }
        ]
      },
      { events: [{ type: "delta", text: "blocked" }, { type: "completed", finishReason: "stop" }] }
    ]);
    const { runtime } = await setup(provider);
    const taskId = "policy-task";
    runtime.createTask({ taskId, goal: "write a note", runnerType: RUNNER_TYPES.DIRECT });

    const streamed: RuntimeEvent[] = [];
    for await (const event of runtime.run(taskId)) streamed.push(event);

    // Approval events are appended by the policy layer, so the ledger is the source of truth.
    const types = runtime.getEvents(taskId).map((event) => event.type);
    expect(types).toContain("approval.requested");
    expect(types).toContain("tool.failed");
    expect(types).not.toContain("tool.completed");
    expect(streamed.map((event) => event.type)).toContain("tool.failed");
    expect(runtime.pendingApprovals(taskId)).toHaveLength(1);
    runtime.close();
  });

  it("runs a task end to end and verifies it deterministically", async () => {
    const provider = new FakeProvider([
      { events: [{ type: "delta", text: "read: ok" }, { type: "completed", finishReason: "stop" }] }
    ]);
    const { runtime } = await setup(provider);
    const taskId = "plain-task";
    runtime.createTask({ taskId, goal: "say something short", runnerType: RUNNER_TYPES.DIRECT });

    const state = await runtime.runToCompletion(taskId);
    expect(state.status).toBe("completed");
    expect(state.completedSteps.length + 1).toBeGreaterThan(0);

    const result = await runtime.verify(taskId);
    // A conversation that ran no tools leaves no evidence to check, so the
    // honest answer is inconclusive. Reporting "passed" here is what the old
    // ledger-only verifier did, and it was the bug.
    expect(result.status).toBe("inconclusive");
    expect(result.checks.find((check) => check.name === "task-completed")?.status).toBe("passed");
    expect(result.checks.find((check) => check.name === "tool-outcomes")?.status).toBe("inconclusive");
    expect(runtime.replay(taskId)).toEqual(runtime.getTask(taskId));
    runtime.close();
  });

  it("verifies a task that really wrote a file as passed", async () => {
    const provider = new FakeProvider([
      {
        events: [
          { type: "tool_call", callId: "w1", toolName: "write_file", input: { path: "note.txt", content: "hecho" } },
          { type: "completed", finishReason: "tool_call" }
        ]
      },
      { events: [{ type: "delta", text: "done" }, { type: "completed", finishReason: "stop" }] }
    ]);
    const { runtime } = await setup(provider);
    const taskId = "verified-task";
    runtime.createTask({ taskId, goal: "write a note", runnerType: RUNNER_TYPES.DIRECT });

    await runtime.runToCompletion(taskId);
    for (const approvalId of runtime.pendingApprovals(taskId)) runtime.approve(taskId, approvalId);
    await runtime.runToCompletion(taskId).catch(() => undefined);
    expect(runtime.getTask(taskId)?.status).toBe("completed");

    const result = await runtime.verify(taskId);
    // The file is on disk, so the file-effects check has real evidence.
    expect(result.status).toBe("passed");
    expect(result.checks.find((check) => check.name === "file-effects")?.status).toBe("passed");
    runtime.close();
  });
});
