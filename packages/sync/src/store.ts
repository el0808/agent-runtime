import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { JsonValue } from "@agent/protocol";

export type SyncEntityType = "conversation" | "runtime_event" | "task" | "memory" | "checkpoint" | "tool_result" | "verification" | "pet_state";

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly createdAt: string;
  readonly label?: string;
}

export interface SyncEnvelope {
  readonly eventId: string;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly deviceId: string;
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly occurredAt: string;
  readonly payload: JsonValue;
  readonly cursor: number;
}

export interface SyncBundle {
  readonly sourceDeviceId: string;
  readonly cursor: number;
  readonly nextCursor: number;
  readonly records: readonly SyncEnvelope[];
}

export interface SyncConflict {
  readonly entityId: string;
  readonly local: SyncEnvelope;
  readonly incoming: SyncEnvelope;
  readonly reason: string;
}

interface PersistedState {
  cursor: number;
  records: SyncEnvelope[];
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

export class DeviceIdentityStore {
  static loadOrCreate(filename: string, label?: string): DeviceIdentity {
    if (existsSync(filename)) return JSON.parse(readFileSync(filename, "utf8")) as DeviceIdentity;
    const identity: DeviceIdentity = { deviceId: randomUUID(), createdAt: new Date().toISOString(), ...(label === undefined ? {} : { label }) };
    writeFileSync(filename, JSON.stringify(identity), "utf8");
    return identity;
  }
}

export class LocalSyncStore {
  private state: PersistedState;
  private readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    this.state = existsSync(filename) ? JSON.parse(readFileSync(filename, "utf8")) as PersistedState : { cursor: 0, records: [] };
  }

  append(records: readonly Omit<SyncEnvelope, "cursor">[]): { accepted: readonly SyncEnvelope[]; conflicts: readonly SyncConflict[] } {
    const accepted: SyncEnvelope[] = [];
    const conflicts: SyncConflict[] = [];
    for (const incoming of records) {
      const existingByKey = this.state.records.find((record) => record.idempotencyKey === incoming.idempotencyKey);
      if (existingByKey !== undefined) {
        if (stable(existingByKey.payload) !== stable(incoming.payload)) conflicts.push({ entityId: incoming.entityId, local: existingByKey, incoming: { ...incoming, cursor: existingByKey.cursor }, reason: "idempotency key payload differs" });
        continue;
      }
      const existing = this.state.records.filter((record) => record.entityId === incoming.entityId).sort((a, b) => b.version - a.version)[0];
      if (existing !== undefined && existing.version > incoming.version) continue;
      if (existing !== undefined && existing.version === incoming.version && stable(existing.payload) !== stable(incoming.payload)) {
        conflicts.push({ entityId: incoming.entityId, local: existing, incoming: { ...incoming, cursor: existing.cursor }, reason: "same version differs" });
        continue;
      }
      this.state.cursor += 1;
      const record: SyncEnvelope = { ...incoming, cursor: this.state.cursor };
      this.state.records = this.state.records.filter((item) => item.entityId !== record.entityId || item.version >= record.version);
      this.state.records.push(record);
      accepted.push(record);
    }
    this.persist();
    return { accepted, conflicts };
  }

  exportSince(sourceDeviceId: string, cursor = 0): SyncBundle {
    const records = this.state.records.filter((record) => record.cursor > cursor);
    return { sourceDeviceId, cursor, nextCursor: this.state.cursor, records };
  }

  all(): readonly SyncEnvelope[] { return [...this.state.records]; }
  getCursor(): number { return this.state.cursor; }

  private persist(): void {
    const temp = `${this.filename}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), "utf8");
    renameSync(temp, this.filename);
  }
}
