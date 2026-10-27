import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_EVENT_TYPES, RUNNER_TYPES } from "@agent/protocol";
import { TaskLedger } from "@agent/task-ledger";
import { DeviceIdentityStore, LedgerSyncAdapter, LocalSyncStore } from "./index.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("local sync", () => {
  it("deduplicates idempotency keys and detects same-version conflicts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-sync-"));
    dirs.push(dir);
    const store = new LocalSyncStore(path.join(dir, "sync.json"));
    const first = { eventId: "e1", version: 1, idempotencyKey: "key-1", deviceId: "a", entityType: "memory" as const, entityId: "m1", occurredAt: new Date().toISOString(), payload: { content: "one" } };
    expect(store.append([first]).accepted).toHaveLength(1);
    expect(store.append([first]).accepted).toHaveLength(0);
    expect(store.append([{ ...first, payload: { content: "different" } }]).conflicts).toHaveLength(1);
    expect(store.exportSince("a").records).toHaveLength(1);
    expect(DeviceIdentityStore.loadOrCreate(path.join(dir, "device.json"), "test").deviceId).toBe(DeviceIdentityStore.loadOrCreate(path.join(dir, "device.json")).deviceId);
  });

  it("exports a task and lets another ledger continue from a checkpoint", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-sync-ledger-"));
    dirs.push(dir);
    const source = new TaskLedger({ filename: path.join(dir, "source.sqlite") });
    source.createTask({ taskId: "task", goal: "resume elsewhere", runnerType: RUNNER_TYPES.DIRECT });
    source.appendEvent({ eventId: "start", taskId: "task", type: RUNTIME_EVENT_TYPES.TASK_STARTED, payload: {} });
    const checkpoint = source.createCheckpoint("task", { device: "a" });
    source.appendEvent({ eventId: "fail", taskId: "task", type: RUNTIME_EVENT_TYPES.TASK_FAILED, payload: { error: { code: "TEST", message: "injected" } } });
    const identity = DeviceIdentityStore.loadOrCreate(path.join(dir, "device.json"), "a");
    const sourceSync = new LedgerSyncAdapter(identity, new LocalSyncStore(path.join(dir, "source-sync.json")));
    const bundle = sourceSync.exportTask("task", source);
    const target = new TaskLedger({ filename: path.join(dir, "target.sqlite") });
    const targetSync = new LedgerSyncAdapter({ deviceId: "b", createdAt: new Date().toISOString() }, new LocalSyncStore(path.join(dir, "target-sync.json")));
    expect(targetSync.importBundle(bundle, target).imported).toBeGreaterThan(0);
    expect(target.getTask("task")?.status).toBe("failed");
    expect(targetSync.importBundle(bundle, target).imported).toBe(0);
    target.restoreCheckpoint("task", checkpoint.checkpointId);
    expect(target.getTask("task")?.status).toBe("running");
    expect(target.getEvents("task").filter((event) => event.type === "checkpoint.created")).toHaveLength(1);
    source.close();
    target.close();
  });
});
