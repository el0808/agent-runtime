import { randomUUID } from "node:crypto";
import { ERROR_CODES, RUNTIME_EVENT_TYPES, RuntimeError } from "@agent/protocol";
import type { Checkpoint, JsonObject, RuntimeEvent, TaskFailure } from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";

export interface CompensationAction {
  readonly compensationId: string;
  readonly name: string;
  /** The task the effect belongs to; compensation only undoes that task's work. */
  readonly taskId?: string;
  execute(): void | Promise<void>;
}

export class CompensationRegistry {
  private readonly actions: CompensationAction[] = [];

  register(action: CompensationAction): void { this.actions.push(action); }

  async executeAll(taskId: string, ledger: TaskLedger): Promise<readonly RuntimeEvent[]> {
    const events: RuntimeEvent[] = [];
    // A registry is shared across the runtime, so undo only this task's work.
    const applicable = this.actions.filter((action) => action.taskId === undefined || action.taskId === taskId);
    for (const action of [...applicable].reverse()) {
      try {
        await action.execute();
        events.push(ledger.appendEvent({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.COMPENSATION_EXECUTED, payload: { compensationId: action.compensationId, action: action.name, status: "succeeded" } }).event);
      } catch (error) {
        const failure: TaskFailure = { code: ERROR_CODES.INTERNAL, message: error instanceof Error ? error.message : String(error) };
        events.push(ledger.appendEvent({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.COMPENSATION_EXECUTED, payload: { compensationId: action.compensationId, action: action.name, status: "failed", error: failure } }).event);
      }
    }
    return events;
  }
}

export class RecoveryManager {
  constructor(private readonly ledger: TaskLedger) {}

  checkpoint(taskId: string, metadata?: JsonObject): Checkpoint { return this.ledger.createCheckpoint(taskId, metadata); }

  recover(taskId: string, checkpointId: string, reason = "process recovery"): void {
    this.ledger.appendEvent({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.RECOVERY_STARTED, payload: { checkpointId, reason } });
    this.ledger.restoreCheckpoint(taskId, checkpointId);
  }

  async retry<T>(taskId: string, operation: string, work: (attempt: number) => Promise<T>, maxAttempts = 3): Promise<T> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "maxAttempts must be positive" });
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try { return await work(attempt); } catch (error) {
        lastError = error;
        if (attempt === maxAttempts) break;
        this.ledger.appendEvent({ eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.RETRY_SCHEDULED, payload: { operation, attempt, maxAttempts, reason: error instanceof Error ? error.message : String(error) } });
      }
    }
    throw lastError;
  }
}
