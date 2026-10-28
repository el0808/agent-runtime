import { randomUUID } from "node:crypto";
import type { JsonObject } from "@agent/protocol";
import type { MemoryRecord, MemoryScope } from "@agent/memory";
import type { DeviceIdentity, LocalSyncStore, SyncBundle, SyncEnvelope } from "./store.js";

/** The subset of MemoryStore this adapter needs, kept narrow for testability. */
export interface MemorySource {
  readonly search: (query: string, scope?: MemoryScope, scopeId?: string) => readonly MemoryRecord[];
  readonly create: (input: {
    key: string;
    scope: MemoryScope;
    scopeId?: string;
    content: string;
    source: string;
    confidence?: number;
    expiresAt?: string;
  }) => MemoryRecord;
  readonly update: (
    memoryId: string,
    patch: { content?: string },
    expectedVersion: number
  ) => MemoryRecord;
}

export interface MemoryImportResult {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly conflicts: number;
}

function envelope(
  deviceId: string,
  entityId: string,
  version: number,
  payload: JsonObject
): Omit<SyncEnvelope, "cursor"> {
  return {
    eventId: randomUUID(),
    version,
    idempotencyKey: `memory:${entityId}:${version}`,
    deviceId,
    entityType: "memory",
    entityId,
    occurredAt: new Date().toISOString(),
    payload
  };
}

function toPayload(record: MemoryRecord): JsonObject {
  return {
    memoryId: record.memoryId,
    key: record.key,
    scope: record.scope,
    ...(record.scopeId === undefined ? {} : { scopeId: record.scopeId }),
    content: record.content,
    source: record.source,
    confidence: record.confidence,
    version: record.version,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt })
  };
}

/**
 * Syncs memory records between devices. Records are matched by key within their
 * scope, and only a strictly newer version overwrites what is already local.
 */
export class MemorySyncAdapter {
  constructor(private readonly identity: DeviceIdentity, private readonly store: LocalSyncStore) {}

  /** Publishes the given records and returns everything newer than `cursor`. */
  exportMemories(records: readonly MemoryRecord[], cursor = 0): SyncBundle {
    if (records.length > 0) {
      this.store.append(
        records.map((record) => envelope(this.identity.deviceId, record.memoryId, record.version, toPayload(record)))
      );
    }
    return this.store.exportSince(this.identity.deviceId, cursor);
  }

  importMemories(bundle: SyncBundle, memory: MemorySource): MemoryImportResult {
    const accepted = this.store.append(
      bundle.records
        .filter((record) => record.entityType === "memory")
        .map(({ eventId, version, idempotencyKey, deviceId, entityType, entityId, occurredAt, payload }) => ({
          eventId,
          version,
          idempotencyKey,
          deviceId,
          entityType,
          entityId,
          occurredAt,
          payload
        }))
    );

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const record of accepted.accepted) {
      const payload = record.payload as Record<string, unknown>;
      const key = typeof payload.key === "string" ? payload.key : undefined;
      const content = typeof payload.content === "string" ? payload.content : undefined;
      const scope = payload.scope;
      if (key === undefined || content === undefined || typeof scope !== "string") {
        skipped += 1;
        continue;
      }

      const scopeId = typeof payload.scopeId === "string" ? payload.scopeId : undefined;
      const existing = memory.search(key, scope as MemoryScope, scopeId).find((candidate) => candidate.key === key);

      if (existing === undefined) {
        memory.create({
          key,
          content,
          scope: scope as MemoryScope,
          source: typeof payload.source === "string" ? payload.source : "sync",
          ...(scopeId === undefined ? {} : { scopeId }),
          ...(typeof payload.confidence === "number" ? { confidence: payload.confidence } : {}),
          ...(typeof payload.expiresAt === "string" ? { expiresAt: payload.expiresAt } : {})
        });
        created += 1;
        continue;
      }

      const incomingVersion = typeof payload.version === "number" ? payload.version : record.version;
      if (incomingVersion <= existing.version) {
        skipped += 1;
        continue;
      }
      memory.update(existing.memoryId, { content }, existing.version);
      updated += 1;
    }

    return { created, updated, skipped, conflicts: accepted.conflicts.length };
  }
}
