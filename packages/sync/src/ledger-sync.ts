import { randomUUID } from "node:crypto";
import type { JsonObject, RuntimeEvent, RuntimeEventInput, TaskProfile } from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";
import type { DeviceIdentity, LocalSyncStore, SyncBundle, SyncEnvelope, SyncEntityType } from "./store.js";

export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly conflicts: number;
}

function envelope(deviceId: string, entityType: SyncEntityType, entityId: string, version: number, payload: JsonObject): Omit<SyncEnvelope, "cursor"> {
  return { eventId: randomUUID(), version, idempotencyKey: `${entityType}:${entityId}:${version}`, deviceId, entityType, entityId, occurredAt: new Date().toISOString(), payload };
}

export class LedgerSyncAdapter {
  constructor(private readonly identity: DeviceIdentity, private readonly store: LocalSyncStore) {}

  exportTask(taskId: string, ledger: TaskLedger, cursor = 0): SyncBundle {
    const state = ledger.getTask(taskId);
    if (state === undefined) throw new Error(`Task ${taskId} was not found`);
    const records: Omit<SyncEnvelope, "cursor">[] = [envelope(this.identity.deviceId, "task", taskId, state.lastEventSequence, state as unknown as JsonObject)];
    for (const event of ledger.getEvents(taskId)) {
      records.push(envelope(this.identity.deviceId, "runtime_event", event.eventId, event.sequence, event as unknown as JsonObject));
      if (event.type.startsWith("tool.")) records.push(envelope(this.identity.deviceId, "tool_result", event.eventId, event.sequence, event as unknown as JsonObject));
      if (event.type === "verification.recorded") records.push(envelope(this.identity.deviceId, "verification", event.eventId, event.sequence, event as unknown as JsonObject));
    }
    for (const checkpoint of ledger.listCheckpoints(taskId)) records.push(envelope(this.identity.deviceId, "checkpoint", checkpoint.checkpointId, checkpoint.eventSequence, checkpoint as unknown as JsonObject));
    this.store.append(records);
    return this.store.exportSince(this.identity.deviceId, cursor);
  }

  importBundle(bundle: SyncBundle, ledger: TaskLedger): ImportResult {
    const accepted = this.store.append(bundle.records.map((record) => {
      const { eventId, version, idempotencyKey, deviceId, entityType, entityId, occurredAt, payload } = record;
      return { eventId, version, idempotencyKey, deviceId, entityType, entityId, occurredAt, payload };
    }));
    let imported = 0;
    let skipped = bundle.records.length - accepted.accepted.length - accepted.conflicts.length;
    const events = accepted.accepted.filter((record) => record.entityType === "runtime_event").sort((a, b) => Number((a.payload as JsonObject).sequence ?? 0) - Number((b.payload as JsonObject).sequence ?? 0));
    for (const record of events) {
      const event = record.payload as unknown as RuntimeEvent;
      if (ledger.getTask(event.taskId) === undefined) {
        if (event.type !== "task.created") { skipped += 1; continue; }
        ledger.createTask((event.payload as { profile: TaskProfile }).profile);
        imported += 1;
        continue;
      }
      if (event.type === "task.created") { skipped += 1; continue; }
      ledger.appendEvent({ eventId: event.eventId, taskId: event.taskId, type: event.type, occurredAt: event.occurredAt, payload: event.payload } as RuntimeEventInput);
      imported += 1;
    }
    return { imported, skipped, conflicts: accepted.conflicts.length };
  }
}

export class SyncEngine {
  constructor(readonly local: LocalSyncStore, readonly ledgerAdapter: LedgerSyncAdapter) {}
  exportTask(taskId: string, ledger: TaskLedger, cursor = 0): SyncBundle { return this.ledgerAdapter.exportTask(taskId, ledger, cursor); }
  importTask(bundle: SyncBundle, ledger: TaskLedger): ImportResult { return this.ledgerAdapter.importBundle(bundle, ledger); }
}
