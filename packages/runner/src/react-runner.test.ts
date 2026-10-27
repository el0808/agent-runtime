import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_EVENT_TYPES, RUNNER_TYPES, TASK_STATUSES } from "@agent/protocol";
import { TaskLedger } from "@agent/task-ledger";
import { ToolRegistry } from "@agent/tools";
import { FakeProvider, ReActRunner } from "./index.js";

const tempDirs: string[] = [];

async function makeLedger(): Promise<{ ledger: TaskLedger; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-runner-"));
  tempDirs.push(directory);
  return { ledger: new TaskLedger({ filename: path.join(directory, "ledger.sqlite") }), directory };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ReActRunner", () => {
  it("streams model output, executes tools, and records every event", async () => {
    const { ledger, directory } = await makeLedger();
    const taskId = "task-react";
    ledger.createTask({ taskId, goal: "read a file", runnerType: RUNNER_TYPES.DIRECT });
    const tools = new ToolRegistry();
    tools.register({ name: "echo", description: "echo", execute: (input) => input });
    const provider = new FakeProvider([
      { events: [
        { type: "delta", text: "I will check " },
        { type: "tool_call", callId: "call-1", toolName: "echo", input: { value: "ok" } },
        { type: "completed", finishReason: "tool_call" }
      ] },
      { events: [{ type: "delta", text: "done" }, { type: "completed", finishReason: "stop" }] }
    ]);
    const runner = new ReActRunner({ ledger, provider, tools, workspaceRoot: directory });
    const events = [];
    for await (const event of runner.run(taskId)) events.push(event);
    const types = events.map((event) => event.type);
    expect(types).toContain(RUNTIME_EVENT_TYPES.MODEL_DELTA);
    expect(types).toContain(RUNTIME_EVENT_TYPES.TOOL_REQUESTED);
    expect(types).toContain(RUNTIME_EVENT_TYPES.TOOL_COMPLETED);
    expect(types).toContain(RUNTIME_EVENT_TYPES.SESSION_ENDED);
    expect(ledger.getTask(taskId)?.status).toBe(TASK_STATUSES.COMPLETED);
    expect(ledger.replayTask(taskId)).toEqual(ledger.getTask(taskId));
    ledger.close();
  });

  it("records a tool timeout and keeps the process alive", async () => {
    const { ledger } = await makeLedger();
    const taskId = "task-timeout";
    ledger.createTask({ taskId, goal: "wait", runnerType: RUNNER_TYPES.DIRECT });
    const tools = new ToolRegistry();
    tools.register({
      name: "wait",
      description: "wait",
      execute: (_input, context) => new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("late"), 100);
        context.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      })
    });
    const provider = new FakeProvider([
      { events: [{ type: "tool_call", callId: "call-timeout", toolName: "wait", input: {} }, { type: "completed", finishReason: "tool_call" }] },
      { events: [{ type: "delta", text: "recovered" }, { type: "completed", finishReason: "stop" }] }
    ]);
    const runner = new ReActRunner({ ledger, provider, tools, toolTimeoutMs: 5 });
    for await (const event of runner.run(taskId)) {
      // consume the stream
      void event;
    }
    expect(ledger.getEvents(taskId).some((event) => event.type === RUNTIME_EVENT_TYPES.TOOL_TIMED_OUT)).toBe(true);
    expect(ledger.getTask(taskId)?.status).toBe(TASK_STATUSES.COMPLETED);
    ledger.close();
  });

  it("can pause a running task and resume it later", async () => {
    const { ledger } = await makeLedger();
    const taskId = "task-pause";
    ledger.createTask({ taskId, goal: "slow", runnerType: RUNNER_TYPES.DIRECT });
    const tools = new ToolRegistry();
    const provider = new FakeProvider([{ delayMs: 50, events: [{ type: "delta", text: "slow" }, { type: "completed", finishReason: "stop" }] }]);
    const runner = new ReActRunner({ ledger, provider, tools });
    const iterator = runner.run(taskId)[Symbol.asyncIterator]();
    await iterator.next();
    await runner.pause(taskId);
    for await (const event of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<unknown>) {
      // drain after pause
      void event;
    }
    expect(ledger.getTask(taskId)?.status).toBe(TASK_STATUSES.PAUSED);
    await runner.resume(taskId);
    expect(ledger.getTask(taskId)?.status).toBe(TASK_STATUSES.RUNNING);
    ledger.close();
  });
});
