import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ERROR_CODES,
  RUNTIME_EVENT_TYPES,
  RUNNER_TYPES,
  RuntimeError
} from "@agent/protocol";
import type { RuntimeEventInput, TaskProfile, VerificationResult } from "@agent/protocol";

import { TaskLedger } from "./index.js";

const openLedgers: TaskLedger[] = [];
const temporaryDirectories: string[] = [];

function createLedger(): TaskLedger {
  const directory = mkdtempSync(join(tmpdir(), "agent-task-ledger-"));
  temporaryDirectories.push(directory);
  const ledger = new TaskLedger({ filename: join(directory, "runtime.db") });
  openLedgers.push(ledger);
  return ledger;
}

function profile(taskId = "task-1"): TaskProfile {
  return {
    taskId,
    goal: "verify task ledger",
    runnerType: RUNNER_TYPES.DIRECT,
    metadata: { suite: "phase-1" }
  };
}

function expectLedgerError(operation: () => unknown, code: string): void {
  try {
    operation();
    expect.fail(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe(code);
  }
}

afterEach(() => {
  for (const ledger of openLedgers.splice(0)) {
    ledger.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TaskLedger", () => {
  it("appends events idempotently and rebuilds state by replay", () => {
    const ledger = createLedger();
    const task = ledger.createTask(profile());
    expect(task.status).toBe("pending");

    const started: RuntimeEventInput<"task.started"> = {
      eventId: "event-start-1",
      taskId: task.taskId,
      type: RUNTIME_EVENT_TYPES.TASK_STARTED,
      payload: { reason: "test" },
      occurredAt: "2026-10-27T10:00:00.000Z"
    };
    const first = ledger.appendEvent(started);
    const duplicate = ledger.appendEvent(started);

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.event.sequence).toBe(2);
    expect(ledger.getEvents(task.taskId)).toHaveLength(2);
    expect(ledger.replayTask(task.taskId)).toEqual(ledger.getTask(task.taskId));
    expect(ledger.getTask(task.taskId)?.status).toBe("running");
  });

  it("keeps tasks and events after closing and reopening the database", () => {
    const firstLedger = createLedger();
    const taskId = "persistent-task";
    firstLedger.createTask(profile(taskId));
    firstLedger.appendEvent({
      eventId: "event-start-persistent",
      taskId,
      type: RUNTIME_EVENT_TYPES.TASK_STARTED,
      payload: {}
    });

    const directory = temporaryDirectories[0];
    const databasePath = join(directory, "runtime.db");
    firstLedger.close();
    openLedgers.splice(openLedgers.indexOf(firstLedger), 1);

    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from "node:sqlite";
         const db = new DatabaseSync(process.argv[1]);
         const task = db.prepare("SELECT task_id FROM tasks WHERE task_id = ?").get(process.argv[2]);
         const events = db.prepare("SELECT COUNT(*) AS count FROM events WHERE task_id = ?").get(process.argv[2]);
         console.log(JSON.stringify({ task, events }));
         db.close();`,
        databasePath,
        taskId
      ],
      { encoding: "utf8" }
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      task: { task_id: taskId },
      events: { count: 2 }
    });

    const reopened = new TaskLedger({ filename: databasePath });
    openLedgers.push(reopened);

    expect(reopened.getEvents(taskId)).toHaveLength(2);
    expect(reopened.replayTask(taskId).status).toBe("running");
    expect(reopened.getTask(taskId)?.lastEventSequence).toBe(2);
  });

  it("restores a running task from a persisted checkpoint", () => {
    const ledger = createLedger();
    const taskId = "checkpoint-task";
    ledger.createTask(profile(taskId));
    ledger.appendEvent({
      eventId: "event-start-checkpoint",
      taskId,
      type: RUNTIME_EVENT_TYPES.TASK_STARTED,
      payload: {}
    });
    const checkpoint = ledger.createCheckpoint(taskId, { reason: "before failure" });

    ledger.appendEvent({
      eventId: "event-fail-checkpoint",
      taskId,
      type: RUNTIME_EVENT_TYPES.TASK_FAILED,
      payload: { error: { code: "TOOL_FAILED", message: "temporary failure", retryable: true } }
    });
    expect(ledger.getTask(taskId)?.status).toBe("failed");

    const restored = ledger.restoreCheckpoint(taskId, checkpoint.checkpointId);
    expect(restored.status).toBe("running");
    expect(restored.lastCheckpointId).toBe(checkpoint.checkpointId);
    expect(ledger.listCheckpoints(taskId)).toHaveLength(1);
    expect(ledger.replayTask(taskId)).toEqual(restored);
  });

  it("rejects illegal transitions and rolls back the attempted event", () => {
    const ledger = createLedger();
    const taskId = "transition-task";
    ledger.createTask(profile(taskId));

    expectLedgerError(
      () =>
        ledger.appendEvent({
          eventId: "event-complete-too-early",
          taskId,
          type: RUNTIME_EVENT_TYPES.TASK_COMPLETED,
          payload: {}
        }),
      ERROR_CODES.INVALID_STATE_TRANSITION
    );
    expect(ledger.getEvents(taskId)).toHaveLength(1);
    expect(ledger.getTask(taskId)?.status).toBe("pending");
  });

  it("rejects reuse of an event id with different data", () => {
    const ledger = createLedger();
    const taskId = "idempotency-task";
    ledger.createTask(profile(taskId));
    ledger.appendEvent({
      eventId: "event-idempotent",
      taskId,
      type: RUNTIME_EVENT_TYPES.TASK_STARTED,
      payload: { reason: "first" }
    });

    expectLedgerError(
      () =>
        ledger.appendEvent({
          eventId: "event-idempotent",
          taskId,
          type: RUNTIME_EVENT_TYPES.TASK_STARTED,
          payload: { reason: "different" }
        }),
      ERROR_CODES.IDEMPOTENCY_CONFLICT
    );
    expect(ledger.getEvents(taskId)).toHaveLength(2);
  });

  it("records verification results in the event stream", () => {
    const ledger = createLedger();
    const taskId = "verification-task";
    ledger.createTask(profile(taskId));
    const result: VerificationResult = {
      verificationId: "verification-1",
      status: "passed",
      summary: "all checks passed",
      checks: [{ name: "event count", status: "passed" }],
      verifiedAt: "2026-10-27T10:05:00.000Z"
    };

    ledger.recordVerification(taskId, result);

    expect(ledger.replayTask(taskId).verification).toEqual(result);
    expect(ledger.getEvents(taskId)).toHaveLength(2);
  });
});
