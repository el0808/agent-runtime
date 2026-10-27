import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "./registry.js";
import { registerBuiltinTools } from "./builtins.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("builtin tools", () => {
  it("reads and writes only within the workspace root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-tools-"));
    directories.push(root);
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    await expect(registry.execute("write_file", { path: "note.txt", content: "hello" }, { workspaceRoot: root })).resolves.toMatchObject({ status: "succeeded" });
    await expect(registry.execute("read_file", { path: "note.txt" }, { workspaceRoot: root })).resolves.toMatchObject({ status: "succeeded", output: { content: "hello" } });
    await expect(registry.execute("read_file", { path: "../outside.txt" }, { workspaceRoot: root })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_DENIED" } });
    await expect(readFile(path.join(root, "note.txt"), "utf8")).resolves.toBe("hello");
  });
});
