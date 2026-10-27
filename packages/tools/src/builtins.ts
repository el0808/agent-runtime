import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ERROR_CODES, RuntimeError } from "@agent/protocol";
import type { JsonObject } from "@agent/protocol";
import type { ToolRegistry } from "./registry.js";

function requiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: `${key} must be a non-empty string` });
  }
  return value;
}

function safePath(root: string | undefined, requested: string): string {
  if (root === undefined) {
    throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "workspaceRoot is required" });
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new RuntimeError({ code: ERROR_CODES.PERMISSION_DENIED, message: "Path escapes workspaceRoot" });
  }
  return resolved;
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register({
    name: "read_file",
    description: "Read a UTF-8 text file inside the workspace root.",
    execute: async (input, context) => ({ path: requiredString(input, "path"), content: await readFile(safePath(context.workspaceRoot, requiredString(input, "path")), "utf8") })
  });
  registry.register({
    name: "write_file",
    description: "Write UTF-8 text to a file inside the workspace root.",
    execute: async (input, context) => {
      const filePath = requiredString(input, "path");
      const content = requiredString(input, "content");
      const target = safePath(context.workspaceRoot, filePath);
      await writeFile(target, content, "utf8");
      return { path: filePath, bytes: Buffer.byteLength(content, "utf8") };
    }
  });
  registry.register({
    name: "run_tests",
    description: "Run the repository test command in the workspace root.",
    execute: (input, context) => new Promise<JsonObject>((resolve, reject) => {
      if (context.workspaceRoot === undefined) {
        reject(new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "workspaceRoot is required" }));
        return;
      }
      const filter = input.filter;
      if (filter !== undefined && typeof filter !== "string") {
        reject(new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "filter must be a string" }));
        return;
      }
      const args = filter === undefined ? ["test"] : ["test", "--", filter];
      const child = spawn("pnpm", args, { cwd: context.workspaceRoot, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const abort = () => child.kill("SIGTERM");
      context.signal.addEventListener("abort", abort, { once: true });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        context.signal.removeEventListener("abort", abort);
        resolve({ ok: code === 0, code, signal, stdout, stderr });
      });
    })
  });
}
