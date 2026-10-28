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

export interface BuiltinToolOptions {
  /**
   * Command used by `run_tests`. Defaults to the package manager detected in the
   * workspace, so npm, pnpm, yarn and bun projects all work.
   */
  readonly testCommand?: { readonly command: string; readonly args: readonly string[] };
}

const DETECTED_COMMANDS: ReadonlyArray<{ readonly marker: string; readonly command: string; readonly args: readonly string[] }> = [
  { marker: "pnpm-lock.yaml", command: "pnpm", args: ["test"] },
  { marker: "package-lock.json", command: "npm", args: ["test"] },
  { marker: "yarn.lock", command: "yarn", args: ["test"] },
  { marker: "bun.lockb", command: "bun", args: ["test"] }
];

async function detectTestCommand(root: string): Promise<{ command: string; args: readonly string[] }> {
  for (const candidate of DETECTED_COMMANDS) {
    try {
      await readFile(path.join(root, candidate.marker));
      return { command: candidate.command, args: candidate.args };
    } catch {
      // marker absent, try the next package manager
    }
  }
  return { command: "npm", args: ["test"] };
}

export function registerBuiltinTools(registry: ToolRegistry, options: BuiltinToolOptions = {}): void {
  registry.register({
    name: "read_file",
    description: "Read a UTF-8 text file inside the workspace root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." }
      },
      required: ["path"],
      additionalProperties: false
    },
    execute: async (input, context) => ({
      path: requiredString(input, "path"),
      content: await readFile(safePath(context.workspaceRoot, requiredString(input, "path")), "utf8")
    })
  });

  registry.register({
    name: "write_file",
    description: "Write UTF-8 text to a file inside the workspace root, creating parent directories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "Full file contents to write." }
      },
      required: ["path", "content"],
      additionalProperties: false
    },
    execute: async (input, context) => {
      const filePath = requiredString(input, "path");
      const content = requiredString(input, "content");
      const target = safePath(context.workspaceRoot, filePath);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return { path: filePath, bytes: Buffer.byteLength(content, "utf8") };
    }
  });

  registry.register({
    name: "list_dir",
    description: "List entries of a directory inside the workspace root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the workspace root. Defaults to the root." }
      },
      additionalProperties: false
    },
    execute: async (input, context) => {
      const requested = typeof input.path === "string" && input.path.length > 0 ? input.path : ".";
      const target = safePath(context.workspaceRoot, requested);
      const { readdir, stat } = await import("node:fs/promises");
      const entries = await readdir(target, { withFileTypes: true });
      return {
        path: requested,
        entries: await Promise.all(entries.map(async (entry) => {
          const info = await stat(path.join(target, entry.name)).catch(() => undefined);
          return { name: entry.name, type: entry.isDirectory() ? "dir" : "file", bytes: info?.size ?? 0 };
        }))
      };
    }
  });

  registry.register({
    name: "run_tests",
    description: "Run the project test command in the workspace root.",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional test name filter passed to the runner." }
      },
      additionalProperties: false
    },
    execute: async (input, context) => {
      if (context.workspaceRoot === undefined) {
        throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "workspaceRoot is required" });
      }
      const filter = input.filter;
      if (filter !== undefined && typeof filter !== "string") {
        throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "filter must be a string" });
      }
      const base = options.testCommand ?? await detectTestCommand(context.workspaceRoot);
      const args = filter === undefined ? [...base.args] : [...base.args, "--", filter];
      return new Promise<JsonObject>((resolve, reject) => {
        const child = spawn(base.command, args, { cwd: context.workspaceRoot, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        const abort = () => child.kill("SIGTERM");
        context.signal.addEventListener("abort", abort, { once: true });
        child.once("error", (error) => {
          context.signal.removeEventListener("abort", abort);
          reject(new RuntimeError({
            code: ERROR_CODES.DEPENDENCY_UNAVAILABLE,
            message: `Could not run ${base.command}: ${error.message}`,
            cause: error
          }));
        });
        child.once("close", (code, signal) => {
          context.signal.removeEventListener("abort", abort);
          resolve({ ok: code === 0, code, signal, command: base.command, stdout, stderr });
        });
      });
    }
  });
}
