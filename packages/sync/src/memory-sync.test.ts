import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "@agent/memory";
import { LocalSyncStore, MemorySyncAdapter } from "./index.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function makeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-memsync-"));
  dirs.push(dir);
  return { dir, memory: new MemoryStore({ filename: path.join(dir, "memory.sqlite") }) };
}

const deviceA = { deviceId: "a", createdAt: new Date().toISOString() };
const deviceB = { deviceId: "b", createdAt: new Date().toISOString() };

describe("memory sync", () => {
  it("carries records from one device to another", async () => {
    const source = await makeStore();
    const target = await makeStore();
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-memsync-bundle-"));
    dirs.push(dir);

    source.memory.create({ key: "language", scope: "project", scopeId: "p1", content: "TypeScript", source: "user" });
    const exporter = new MemorySyncAdapter(deviceA, new LocalSyncStore(path.join(dir, "a.json")));
    const bundle = exporter.exportMemories(source.memory.search(""));

    const importer = new MemorySyncAdapter(deviceB, new LocalSyncStore(path.join(dir, "b.json")));
    const result = importer.importMemories(bundle, target.memory);

    expect(result.created).toBe(1);
    expect(target.memory.search("language", "project", "p1")[0]?.content).toBe("TypeScript");
    source.memory.close();
    target.memory.close();
  });

  it("does not overwrite a newer local version", async () => {
    const source = await makeStore();
    const target = await makeStore();
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-memsync-conf-"));
    dirs.push(dir);

    const created = source.memory.create({ key: "topic", scope: "global", content: "old", source: "a" });
    const exporter = new MemorySyncAdapter(deviceA, new LocalSyncStore(path.join(dir, "a.json")));
    const bundle = exporter.exportMemories([created]);

    const local = target.memory.create({ key: "topic", scope: "global", content: "new", source: "b" });
    target.memory.update(local.memoryId, { content: "newer" }, local.version);

    const importer = new MemorySyncAdapter(deviceB, new LocalSyncStore(path.join(dir, "b.json")));
    const result = importer.importMemories(bundle, target.memory);

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(target.memory.search("topic", "global")[0]?.content).toBe("newer");
    source.memory.close();
    target.memory.close();
  });

  it("is idempotent across repeated imports", async () => {
    const source = await makeStore();
    const target = await makeStore();
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-memsync-idem-"));
    dirs.push(dir);

    const record = source.memory.create({ key: "k", scope: "global", content: "v", source: "a" });
    const exporter = new MemorySyncAdapter(deviceA, new LocalSyncStore(path.join(dir, "a.json")));
    const bundle = exporter.exportMemories([record]);

    const importer = new MemorySyncAdapter(deviceB, new LocalSyncStore(path.join(dir, "b.json")));
    expect(importer.importMemories(bundle, target.memory).created).toBe(1);
    const second = importer.importMemories(bundle, target.memory);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);

    source.memory.close();
    target.memory.close();
  });
});
