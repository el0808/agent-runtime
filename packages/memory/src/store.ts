import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ERROR_CODES, RUNTIME_EVENT_TYPES, RuntimeError } from "@agent/protocol";
import type { JsonObject, MemoryUpdatedPayload } from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";

export type MemoryScope = "global" | "project" | "task" | "session";
export type MemoryConflictStatus = "none" | "conflict" | "resolved";

export interface MemoryRecord {
  readonly memoryId: string;
  readonly key: string;
  readonly scope: MemoryScope;
  readonly scopeId?: string;
  readonly content: string;
  readonly source: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confidence: number;
  readonly version: number;
  readonly expiresAt?: string;
  readonly conflictStatus: MemoryConflictStatus;
  readonly metadata?: JsonObject;
}

export interface MemoryStoreOptions {
  readonly filename: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly ledger?: TaskLedger;
}

export interface CreateMemoryInput {
  readonly key: string;
  readonly scope: MemoryScope;
  readonly scopeId?: string;
  readonly content: string;
  readonly source: string;
  readonly confidence?: number;
  readonly expiresAt?: string;
  readonly metadata?: JsonObject;
  readonly taskId?: string;
}

export interface UpdateMemoryInput {
  readonly content?: string;
  readonly source?: string;
  readonly confidence?: number;
  readonly expiresAt?: string;
  readonly metadata?: JsonObject;
}

interface MemoryRow {
  memory_id: string;
  key: string;
  scope: MemoryScope;
  scope_id: string | null;
  content: string;
  source: string;
  created_at: string;
  updated_at: string;
  confidence: number;
  version: number;
  expires_at: string | null;
  conflict_status: MemoryConflictStatus;
  metadata_json: string | null;
}

function parseJson<T>(value: string): T {
  try { return JSON.parse(value) as T; } catch (error) { throw new RuntimeError({ code: ERROR_CODES.CORRUPT_LEDGER, message: "Memory contains invalid JSON", cause: error }); }
}

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly ledger: TaskLedger | undefined;

  constructor(options: MemoryStoreOptions) {
    this.db = new DatabaseSync(options.filename);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.ledger = options.ledger;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY, key TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT,
        content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        confidence REAL NOT NULL, version INTEGER NOT NULL, expires_at TEXT, conflict_status TEXT NOT NULL,
        metadata_json TEXT, UNIQUE(key, scope, scope_id)
      );
      CREATE TABLE IF NOT EXISTS memory_versions (
        memory_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL,
        created_at TEXT NOT NULL, confidence REAL NOT NULL, expires_at TEXT, metadata_json TEXT,
        PRIMARY KEY(memory_id, version)
      );
      CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope, scope_id);
    `);
  }

  close(): void { this.db.close(); }

  /**
   * Finds an existing memory with the same key in the same scope. SQLite treats
   * NULLs as distinct, so UNIQUE(key, scope, scope_id) does not fire when
   * scope_id is unset; this lookup is what actually prevents duplicates.
   */
  private findByKey(key: string, scope: MemoryScope, scopeId: string | undefined): MemoryRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE key = ? AND scope = ? AND COALESCE(scope_id, '') = COALESCE(?, '')")
      .get(key, scope, scopeId ?? null) as unknown as MemoryRow | undefined;
    return row === undefined ? undefined : this.toRecord(row);
  }

  create(input: CreateMemoryInput): MemoryRecord {
    this.validateConfidence(input.confidence ?? 1);
    const existing = this.findByKey(input.key, input.scope, input.scopeId);
    if (existing !== undefined) {
      throw new RuntimeError({
        code: ERROR_CODES.CONFLICT,
        message: `Memory ${input.key} already exists in scope ${input.scope}`,
        details: { memoryId: existing.memoryId, version: existing.version }
      });
    }
    const now = this.now().toISOString();
    const memoryId = this.idFactory();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO memories (memory_id,key,scope,scope_id,content,source,created_at,updated_at,confidence,version,expires_at,conflict_status,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        memoryId, input.key, input.scope, input.scopeId ?? null, input.content, input.source, now, now, input.confidence ?? 1, 1, input.expiresAt ?? null, "none", input.metadata === undefined ? null : JSON.stringify(input.metadata)
      );
      this.db.prepare(`INSERT INTO memory_versions (memory_id,version,content,source,created_at,confidence,expires_at,metadata_json) VALUES (?,?,?,?,?,?,?,?)`).run(memoryId, 1, input.content, input.source, now, input.confidence ?? 1, input.expiresAt ?? null, input.metadata === undefined ? null : JSON.stringify(input.metadata));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    const record = this.get(memoryId);
    if (record === undefined) throw new RuntimeError({ code: ERROR_CODES.CORRUPT_LEDGER, message: "Created memory could not be read" });
    this.appendEvent(input.taskId, { memoryId, scope: input.scope, action: "created", version: 1 });
    return record;
  }

  get(memoryId: string): MemoryRecord | undefined { const row = this.db.prepare("SELECT * FROM memories WHERE memory_id = ?").get(memoryId) as unknown as MemoryRow | undefined; return row === undefined ? undefined : this.toRecord(row); }

  /** Newest records in a scope, used to inject durable memory without a query. */
  list(scope: MemoryScope, limit = 50): MemoryRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE scope = ? ORDER BY updated_at DESC LIMIT ?")
      .all(scope, limit) as unknown as MemoryRow[];
    return rows.map((row) => this.toRecord(row));
  }

  search(query: string, scope?: MemoryScope, scopeId?: string): MemoryRecord[] {
    const pattern = `%${query}%`;
    const rows = scope === undefined ? this.db.prepare("SELECT * FROM memories WHERE (key LIKE ? OR content LIKE ?) ORDER BY updated_at DESC").all(pattern, pattern) : this.db.prepare("SELECT * FROM memories WHERE scope = ? AND (scope_id IS ? OR scope_id = ?) AND (key LIKE ? OR content LIKE ?) ORDER BY updated_at DESC").all(scope, scopeId ?? null, scopeId ?? "", pattern, pattern);
    return (rows as unknown as MemoryRow[]).map((row) => this.toRecord(row));
  }

  update(memoryId: string, patch: UpdateMemoryInput, expectedVersion: number, taskId?: string): MemoryRecord {
    const current = this.get(memoryId);
    if (current === undefined) throw new RuntimeError({ code: ERROR_CODES.NOT_FOUND, message: `Memory ${memoryId} was not found` });
    if (current.version !== expectedVersion) throw new RuntimeError({ code: ERROR_CODES.CONFLICT, message: "Memory version is stale", details: { expectedVersion, actualVersion: current.version } });
    const nextVersion = current.version + 1;
    const now = this.now().toISOString();
    const content = patch.content ?? current.content;
    const source = patch.source ?? current.source;
    const confidence = patch.confidence ?? current.confidence;
    this.validateConfidence(confidence);
    const expiresAt = patch.expiresAt ?? current.expiresAt ?? null;
    const metadata = patch.metadata ?? current.metadata;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE memories SET content=?,source=?,updated_at=?,confidence=?,version=?,expires_at=?,conflict_status=?,metadata_json=? WHERE memory_id=?").run(content, source, now, confidence, nextVersion, expiresAt, "none", metadata === undefined ? null : JSON.stringify(metadata), memoryId);
      this.db.prepare("INSERT INTO memory_versions (memory_id,version,content,source,created_at,confidence,expires_at,metadata_json) VALUES (?,?,?,?,?,?,?,?)").run(memoryId, nextVersion, content, source, now, confidence, expiresAt, metadata === undefined ? null : JSON.stringify(metadata));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    const record = this.get(memoryId);
    if (record === undefined) throw new RuntimeError({ code: ERROR_CODES.CORRUPT_LEDGER, message: "Updated memory could not be read" });
    this.appendEvent(taskId, { memoryId, scope: record.scope, action: "updated", version: nextVersion });
    return record;
  }

  delete(memoryId: string, taskId?: string): void {
    const current = this.get(memoryId);
    if (current === undefined) return;
    this.db.prepare("DELETE FROM memories WHERE memory_id = ?").run(memoryId);
    this.appendEvent(taskId, { memoryId, scope: current.scope, action: "deleted", version: current.version });
  }

  history(memoryId: string): readonly MemoryRecord[] {
    const current = this.get(memoryId);
    if (current === undefined) throw new RuntimeError({ code: ERROR_CODES.NOT_FOUND, message: `Memory ${memoryId} was not found` });
    const rows = this.db.prepare("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version ASC").all(memoryId) as unknown as Array<{ memory_id: string; version: number; content: string; source: string; created_at: string; confidence: number; expires_at: string | null; metadata_json: string | null }>;
    return rows.map((row) => ({ ...current, content: row.content, source: row.source, createdAt: row.created_at, updatedAt: row.created_at, confidence: row.confidence, version: row.version, ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }), ...(row.metadata_json === null ? {} : { metadata: parseJson<JsonObject>(row.metadata_json) }) }));
  }

  restoreVersion(memoryId: string, version: number, taskId?: string): MemoryRecord {
    const previous = this.history(memoryId).find((record) => record.version === version);
    if (previous === undefined) throw new RuntimeError({ code: ERROR_CODES.NOT_FOUND, message: `Memory version ${version} was not found` });
    return this.update(memoryId, { content: previous.content, source: previous.source, confidence: previous.confidence, ...(previous.expiresAt === undefined ? {} : { expiresAt: previous.expiresAt }), ...(previous.metadata === undefined ? {} : { metadata: previous.metadata }) }, this.get(memoryId)?.version ?? 0, taskId);
  }

  resolveConflict(memoryId: string, taskId?: string): MemoryRecord {
    const current = this.get(memoryId);
    if (current === undefined) throw new RuntimeError({ code: ERROR_CODES.NOT_FOUND, message: `Memory ${memoryId} was not found` });
    this.db.prepare("UPDATE memories SET conflict_status = ? WHERE memory_id = ?").run("resolved", memoryId);
    const resolved = this.get(memoryId);
    if (resolved === undefined) throw new RuntimeError({ code: ERROR_CODES.CORRUPT_LEDGER, message: "Resolved memory could not be read" });
    this.appendEvent(taskId, { memoryId, scope: resolved.scope, action: "conflict", version: resolved.version });
    return resolved;
  }

  private validateConfidence(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1) throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "confidence must be between 0 and 1" }); }

  private toRecord(row: MemoryRow): MemoryRecord {
    return { memoryId: row.memory_id, key: row.key, scope: row.scope, ...(row.scope_id === null ? {} : { scopeId: row.scope_id }), content: row.content, source: row.source, createdAt: row.created_at, updatedAt: row.updated_at, confidence: row.confidence, version: row.version, ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }), conflictStatus: row.conflict_status, ...(row.metadata_json === null ? {} : { metadata: parseJson<JsonObject>(row.metadata_json) }) };
  }

  private appendEvent(taskId: string | undefined, payload: MemoryUpdatedPayload): void {
    if (taskId !== undefined && this.ledger !== undefined) this.ledger.appendEvent({ eventId: this.idFactory(), taskId, type: RUNTIME_EVENT_TYPES.MEMORY_UPDATED, payload });
  }
}
