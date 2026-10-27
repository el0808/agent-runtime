import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_TYPES } from "@agent/protocol";
import { TaskLedger } from "@agent/task-ledger";
import { ContextCompressor, MemoryStore } from "./index.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("MemoryStore", () => {
  it("persists scoped memory, versions edits, searches, and restores", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-memory-"));
    dirs.push(dir);
    const ledger = new TaskLedger({ filename: path.join(dir, "ledger.sqlite") });
    ledger.createTask({ taskId: "task", goal: "remember", runnerType: RUNNER_TYPES.DIRECT });
    const store = new MemoryStore({ filename: path.join(dir, "memory.sqlite"), ledger });
    const created = store.create({ key: "language", scope: "project", scopeId: "p1", content: "TypeScript", source: "user", confidence: 1, taskId: "task" });
    const updated = store.update(created.memoryId, { content: "TypeScript strict" }, created.version, "task");
    expect(store.search("strict", "project", "p1")[0]?.content).toBe("TypeScript strict");
    expect(store.history(created.memoryId)).toHaveLength(2);
    const restored = store.restoreVersion(created.memoryId, 1, "task");
    expect(restored.content).toBe("TypeScript");
    expect(() => store.update(created.memoryId, { content: "stale" }, updated.version, "task")).toThrow();
    store.close();
    const reopened = new MemoryStore({ filename: path.join(dir, "memory.sqlite") });
    expect(reopened.search("TypeScript")).toHaveLength(1);
    reopened.delete(created.memoryId);
    expect(reopened.get(created.memoryId)).toBeUndefined();
    reopened.close();
    ledger.close();
  });
});

it("compresses context while retaining original messages and required constraints", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-compress-"));
  dirs.push(dir);
  const ledger = new TaskLedger({ filename: path.join(dir, "ledger.sqlite") });
  ledger.createTask({ taskId: "task", goal: "compress", runnerType: RUNNER_TYPES.DIRECT });
  const result = await new ContextCompressor().compress([
    { role: "system", content: "You must keep the database read-only." },
    { role: "user", content: "Please inspect many files and report the findings." },
    { role: "assistant", content: "I inspected files and found a stable schema." }
  ], { requiredConstraints: ["database read-only"], ledger, taskId: "task" });
  expect(result.original).toHaveLength(3);
  expect(result.quality.passed).toBe(true);
  expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  expect(ledger.getEvents("task").some((event) => event.type === "context.compressed")).toBe(true);
  ledger.close();
});
