import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  ERROR_CODES,
  RUNTIME_EVENT_TYPES,
  RuntimeError
} from "@agent/protocol";
import type {
  Checkpoint,
  CheckpointCreatedPayload,
  JsonObject,
  RuntimeEvent,
  RuntimeEventInput,
  RuntimeEventType,
  TaskProfile,
  TaskState,
  VerificationResult
} from "@agent/protocol";

import { applyRuntimeEvent, replayRuntimeEvents } from "./state-machine.js";

interface TaskRow {
  task_id: string;
  profile_json: string;
  state_json: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  event_id: string;
  task_id: string;
  sequence: number;
  type: RuntimeEventType;
  occurred_at: string;
  payload_json: string;
}

interface CheckpointRow {
  checkpoint_id: string;
  task_id: string;
  event_sequence: number;
  created_at: string;
  state_json: string;
  metadata_json: string | null;
}

export interface TaskLedgerOptions {
  filename: string;
  now?: () => Date;
  idFactory?: () => string;
}

export interface AppendEventResult {
  event: RuntimeEvent;
  state: TaskState;
  duplicate: boolean;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new RuntimeError({
      code: ERROR_CODES.CORRUPT_LEDGER,
      message: "Ledger contains invalid JSON",
      cause: error
    });
  }
}

function clone<T>(value: T): T {
  return parseJson<T>(stableJson(value));
}

export class TaskLedger {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: TaskLedgerOptions) {
    this.db = new DatabaseSync(options.filename);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.createSchema();
  }

  close(): void {
    this.db.close();
  }

  createTask(profile: TaskProfile): TaskState {
    return this.transaction(() => {
      if (this.readTaskRow(profile.taskId) !== undefined) {
        throw new RuntimeError({
          code: ERROR_CODES.TASK_ALREADY_EXISTS,
          message: `Task ${profile.taskId} already exists`,
          details: { taskId: profile.taskId }
        });
      }

      const event: RuntimeEvent<"task.created"> = {
        eventId: this.idFactory(),
        taskId: profile.taskId,
        sequence: 1,
        occurredAt: this.timestamp(),
        type: RUNTIME_EVENT_TYPES.TASK_CREATED,
        payload: { profile }
      };
      const state = applyRuntimeEvent(undefined, event);
      this.db
        .prepare(
          `INSERT INTO tasks (task_id, profile_json, state_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          profile.taskId,
          stableJson(profile),
          stableJson(state),
          event.occurredAt,
          event.occurredAt
        );
      this.insertEvent(event);
      return state;
    });
  }

  /** Most recently updated tasks first, for list views in clients. */
  listTasks(limit = 50): TaskState[] {
    const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
    return this.db
      .prepare("SELECT task_id, profile_json, state_json, created_at, updated_at FROM tasks ORDER BY updated_at DESC LIMIT ?")
      .all(bounded)
      .map((row) => parseJson<TaskState>((row as unknown as TaskRow).state_json));
  }

  /**
   * Removes a task and everything recorded for it. Events and checkpoints go
   * with it through ON DELETE CASCADE, so the ledger cannot keep orphan rows.
   */
  deleteTask(taskId: string): boolean {
    return this.transaction(() => {
      const result = this.db.prepare("DELETE FROM tasks WHERE task_id = ?").run(taskId);
      return Number(result.changes) > 0;
    });
  }

  getTask(taskId: string): TaskState | undefined {
    const row = this.readTaskRow(taskId);
    return row === undefined ? undefined : parseJson<TaskState>(row.state_json);
  }

  getEvents(taskId: string): RuntimeEvent[] {
    this.requireTask(taskId);
    return this.readEventRows(taskId).map((row) => this.toRuntimeEvent(row));
  }

  replayTask(taskId: string): TaskState {
    return replayRuntimeEvents(this.getEvents(taskId));
  }

  appendEvent<T extends RuntimeEventType>(input: RuntimeEventInput<T>): AppendEventResult {
    return this.transaction(() => this.appendEventInTransaction(input));
  }

  createCheckpoint(taskId: string, metadata?: JsonObject): Checkpoint {
    return this.transaction(() => {
      const state = this.requireCurrentState(taskId);
      if (state.status === "completed" || state.status === "cancelled") {
        throw new RuntimeError({
          code: ERROR_CODES.INVALID_STATE_TRANSITION,
          message: `Cannot checkpoint a ${state.status} task`,
          details: { taskId, status: state.status }
        });
      }
      const checkpoint: Checkpoint = {
        checkpointId: this.idFactory(),
        taskId,
        eventSequence: state.lastEventSequence,
        createdAt: this.timestamp(),
        state: clone(state)
      };
      if (metadata !== undefined) {
        checkpoint.metadata = metadata;
      }
      this.appendEventInTransaction({
        eventId: this.idFactory(),
        taskId,
        type: RUNTIME_EVENT_TYPES.CHECKPOINT_CREATED,
        occurredAt: checkpoint.createdAt,
        payload: { checkpoint }
      });
      return checkpoint;
    });
  }

  listCheckpoints(taskId: string): Checkpoint[] {
    this.requireTask(taskId);
    return this.db
      .prepare(
        `SELECT checkpoint_id, task_id, event_sequence, created_at, state_json, metadata_json
         FROM checkpoints WHERE task_id = ? ORDER BY event_sequence ASC`
      )
      .all(taskId)
      .map((row) => this.toCheckpoint(row as unknown as CheckpointRow));
  }

  restoreCheckpoint(taskId: string, checkpointId: string): TaskState {
    return this.transaction(() => {
      this.requireCurrentState(taskId);
      const row = this.db
        .prepare(
          `SELECT checkpoint_id, task_id, event_sequence, created_at, state_json, metadata_json
           FROM checkpoints WHERE task_id = ? AND checkpoint_id = ?`
        )
        .get(taskId, checkpointId) as unknown as CheckpointRow | undefined;
      if (row === undefined) {
        throw new RuntimeError({
          code: ERROR_CODES.CHECKPOINT_NOT_FOUND,
          message: `Checkpoint ${checkpointId} was not found`,
          details: { taskId, checkpointId }
        });
      }
      return this.appendEventInTransaction({
        eventId: this.idFactory(),
        taskId,
        type: RUNTIME_EVENT_TYPES.CHECKPOINT_RESTORED,
        occurredAt: this.timestamp(),
        payload: {
          checkpointId: row.checkpoint_id,
          state: parseJson<TaskState>(row.state_json)
        }
      }).state;
    });
  }

  recordVerification(taskId: string, result: VerificationResult): AppendEventResult {
    return this.appendEvent({
      eventId: this.idFactory(),
      taskId,
      type: RUNTIME_EVENT_TYPES.VERIFICATION_RECORDED,
      occurredAt: result.verifiedAt,
      payload: { result }
    });
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        profile_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE (task_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        event_sequence INTEGER NOT NULL CHECK (event_sequence >= 1),
        created_at TEXT NOT NULL,
        state_json TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS events_task_sequence_idx
        ON events (task_id, sequence);
      CREATE INDEX IF NOT EXISTS checkpoints_task_sequence_idx
        ON checkpoints (task_id, event_sequence);
    `);
  }

  private appendEventInTransaction<T extends RuntimeEventType>(
    input: RuntimeEventInput<T>
  ): AppendEventResult {
    const existingRow = this.db
      .prepare(
        `SELECT event_id, task_id, sequence, type, occurred_at, payload_json
         FROM events WHERE event_id = ?`
      )
      .get(input.eventId) as unknown as EventRow | undefined;
    if (existingRow !== undefined) {
      const existing = this.toRuntimeEvent(existingRow);
      if (
        existing.taskId !== input.taskId ||
        existing.type !== input.type ||
        stableJson(existing.payload) !== stableJson(input.payload)
      ) {
        throw new RuntimeError({
          code: ERROR_CODES.IDEMPOTENCY_CONFLICT,
          message: `Event ${input.eventId} was already used with different data`,
          details: { eventId: input.eventId, taskId: input.taskId }
        });
      }
      return {
        event: existing,
        state: this.requireCurrentState(input.taskId),
        duplicate: true
      };
    }

    const state = this.requireCurrentState(input.taskId);
    const event = {
      ...input,
      sequence: state.lastEventSequence + 1,
      occurredAt: input.occurredAt ?? this.timestamp()
    } as RuntimeEvent;
    const nextState = applyRuntimeEvent(state, event);
    this.insertEvent(event);
    if (event.type === RUNTIME_EVENT_TYPES.CHECKPOINT_CREATED) {
      this.insertCheckpoint(event.payload);
    }
    this.db
      .prepare("UPDATE tasks SET state_json = ?, updated_at = ? WHERE task_id = ?")
      .run(stableJson(nextState), event.occurredAt, input.taskId);
    return { event, state: nextState, duplicate: false };
  }

  private insertEvent(event: RuntimeEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (event_id, task_id, sequence, type, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.eventId,
        event.taskId,
        event.sequence,
        event.type,
        event.occurredAt,
        stableJson(event.payload)
      );
  }

  private insertCheckpoint(payload: CheckpointCreatedPayload): void {
    const checkpoint = payload.checkpoint;
    this.db
      .prepare(
        `INSERT INTO checkpoints
          (checkpoint_id, task_id, event_sequence, created_at, state_json, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        checkpoint.checkpointId,
        checkpoint.taskId,
        checkpoint.eventSequence,
        checkpoint.createdAt,
        stableJson(checkpoint.state),
        checkpoint.metadata === undefined ? null : stableJson(checkpoint.metadata)
      );
  }

  private readTaskRow(taskId: string): TaskRow | undefined {
    return this.db
      .prepare(
        `SELECT task_id, profile_json, state_json, created_at, updated_at
         FROM tasks WHERE task_id = ?`
      )
      .get(taskId) as unknown as TaskRow | undefined;
  }

  private requireTask(taskId: string): TaskRow {
    const row = this.readTaskRow(taskId);
    if (row === undefined) {
      throw new RuntimeError({
        code: ERROR_CODES.TASK_NOT_FOUND,
        message: `Task ${taskId} was not found`,
        details: { taskId }
      });
    }
    return row;
  }

  private requireCurrentState(taskId: string): TaskState {
    return parseJson<TaskState>(this.requireTask(taskId).state_json);
  }

  private readEventRows(taskId: string): EventRow[] {
    return this.db
      .prepare(
        `SELECT event_id, task_id, sequence, type, occurred_at, payload_json
         FROM events WHERE task_id = ? ORDER BY sequence ASC`
      )
      .all(taskId) as unknown as EventRow[];
  }

  private toRuntimeEvent(row: EventRow): RuntimeEvent {
    return {
      eventId: row.event_id,
      taskId: row.task_id,
      sequence: row.sequence,
      type: row.type,
      occurredAt: row.occurred_at,
      payload: parseJson(row.payload_json)
    } as RuntimeEvent;
  }

  private toCheckpoint(row: CheckpointRow): Checkpoint {
    const checkpoint: Checkpoint = {
      checkpointId: row.checkpoint_id,
      taskId: row.task_id,
      eventSequence: row.event_sequence,
      createdAt: row.created_at,
      state: parseJson<TaskState>(row.state_json)
    };
    if (row.metadata_json !== null) {
      checkpoint.metadata = parseJson<JsonObject>(row.metadata_json);
    }
    return checkpoint;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original operation error.
      }
      throw error;
    }
  }
}
