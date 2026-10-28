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

function safePath(root: string | undefined, requested: string, allowOutside = false): string {
  if (root === undefined) {
    throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "workspaceRoot is required" });
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    // Reading outside the workspace is an explicit user opt-in, not a default:
    // one stray "../" should never reach the rest of the user's disk.
    if (allowOutside) {
      return resolved;
    }
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
  /**
   * Backing store for `remember`. Without it the tool is not registered, so a
   * host that has no memory simply does not offer the capability.
   */
  readonly remember?: (input: { readonly key: string; readonly content: string; readonly scope: "global" | "project" | "task" | "session" }) => void;
  /** Default command timeout for `run_command`, in milliseconds. */
  readonly commandTimeoutMs?: number;
  /**
   * Lets file tools reach paths outside the workspace root. Off by default; the
   * user turns it on when they want the agent to work on another directory.
   */
  readonly allowOutsideWorkspace?: boolean;
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
      content: await readFile(safePath(context.workspaceRoot, requiredString(input, "path"), options.allowOutsideWorkspace === true), "utf8")
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
      const target = safePath(context.workspaceRoot, filePath, options.allowOutsideWorkspace === true);
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
      const target = safePath(context.workspaceRoot, requested, options.allowOutsideWorkspace === true);
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

  registry.register({
    name: "run_command",
    description:
      "Run a shell command in the workspace. Use it for git, package managers, builds, tests and opening things the user asked for. Read-only commands run immediately; anything that changes state is gated behind approval.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run, executed with the shell." },
        cwd: { type: "string", description: "Directory relative to the workspace root. Defaults to the root." },
        timeoutMs: { type: "number", description: "Kill the command after this many milliseconds." }
      },
      required: ["command"],
      additionalProperties: false
    },
    execute: async (input, context) => {
      const command = requiredString(input, "command");
      if (context.workspaceRoot === undefined) {
        throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "workspaceRoot is required" });
      }
      const cwd = typeof input.cwd === "string" && input.cwd.length > 0
        ? safePath(context.workspaceRoot, input.cwd, options.allowOutsideWorkspace === true)
        : context.workspaceRoot;
      const requested = typeof input.timeoutMs === "number" ? input.timeoutMs : options.commandTimeoutMs ?? 120_000;
      return runShell(command, cwd, requested, context.signal);
    }
  });

  registry.register({
    name: "edit_file",
    description:
      "Replace one exact occurrence of a string in a file. Prefer this over rewriting a whole file: the change is small, reviewable and fails loudly when the target text is not found.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        oldText: { type: "string", description: "Exact text to replace. Must occur exactly once." },
        newText: { type: "string", description: "Replacement text." }
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false
    },
    execute: async (input, context) => {
      const filePath = requiredString(input, "path");
      const target = safePath(context.workspaceRoot, filePath, options.allowOutsideWorkspace === true);
      const oldText = requiredString(input, "oldText");
      const newText = typeof input.newText === "string" ? input.newText : "";
      const original = await readFile(target, "utf8");
      const occurrences = original.split(oldText).length - 1;
      if (occurrences === 0) {
        throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "oldText was not found in the file" });
      }
      if (occurrences > 1) {
        throw new RuntimeError({
          code: ERROR_CODES.INVALID_INPUT,
          message: `oldText occurs ${occurrences} times; include more context so it is unique`
        });
      }
      await writeFile(target, original.replace(oldText, newText), "utf8");
      return { path: filePath, replaced: 1 };
    }
  });

  registry.register({
    name: "grep",
    description: "Search file contents for a regular expression inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression source." },
        path: { type: "string", description: "Directory to search. Defaults to the workspace root." },
        ignoreCase: { type: "boolean", description: "Case-insensitive match." },
        maxResults: { type: "number", description: "Stop after this many matches. Defaults to 100." }
      },
      required: ["pattern"],
      additionalProperties: false
    },
    execute: async (input, context) => {
      const source = requiredString(input, "pattern");
      const flags = input.ignoreCase === true ? "iu" : "u";
      let pattern: RegExp;
      try {
        pattern = new RegExp(source, flags);
      } catch (error) {
        throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: `Invalid regular expression: ${(error as Error).message}` });
      }
      const root = context.workspaceRoot === undefined ? undefined : safePath(context.workspaceRoot, typeof input.path === "string" && input.path.length > 0 ? input.path : ".", options.allowOutsideWorkspace === true);
      if (root === undefined) {
        throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "workspaceRoot is required" });
      }
      const limit = typeof input.maxResults === "number" && input.maxResults > 0 ? Math.min(input.maxResults, 1000) : 100;
      return { pattern: source, matches: await searchFiles(root, pattern, limit, context.signal) };
    }
  });

  registry.register({
    name: "glob",
    description: "List files whose path matches a glob such as src/**/*.ts, inside the workspace.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob with * and ** wildcards." },
        path: { type: "string", description: "Directory to search. Defaults to the workspace root." },
        maxResults: { type: "number", description: "Stop after this many paths. Defaults to 500." }
      },
      required: ["pattern"],
      additionalProperties: false
    },
    execute: async (input, context) => {
      const pattern = requiredString(input, "pattern");
      if (context.workspaceRoot === undefined) {
        throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "workspaceRoot is required" });
      }
      const root = safePath(context.workspaceRoot, typeof input.path === "string" && input.path.length > 0 ? input.path : ".", options.allowOutsideWorkspace === true);
      const limit = typeof input.maxResults === "number" && input.maxResults > 0 ? Math.min(input.maxResults, 5000) : 500;
      const matcher = globToRegExp(pattern);
      return { pattern, files: await walkFiles(root, (relative) => matcher.test(relative), limit, context.signal) };
    }
  });

  if (options.remember !== undefined) {
    const remember = options.remember;
    registry.register({
      name: "remember",
      description:
        "Save a durable fact for future tasks: a user preference, a project convention, or something worth not rediscovering. Reuse the same key to update an existing memory.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Short stable identifier, e.g. package-manager." },
          content: { type: "string", description: "The fact to remember, written so it stands alone." },
          scope: {
            type: "string",
            enum: ["global", "project", "task", "session"],
            description: "How widely the fact applies. Defaults to project."
          }
        },
        required: ["key", "content"],
        additionalProperties: false
      },
      execute: async (input) => {
        const key = requiredString(input, "key");
        const content = requiredString(input, "content");
        const scope = input.scope === "global" || input.scope === "task" || input.scope === "session" ? input.scope : "project";
        remember({ key, content, scope });
        return { saved: key, scope };
      }
    });
  }
}

/** Runs a shell command line to completion, honouring abort and timeout. */
async function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<JsonObject> {
  return new Promise<JsonObject>((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const cap = (current: string, chunk: Buffer) => (current.length > 200_000 ? current : current + chunk.toString());
    child.stdout?.on("data", (chunk: Buffer) => { stdout = cap(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = cap(stderr, chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      cleanup();
      reject(new RuntimeError({ code: ERROR_CODES.DEPENDENCY_UNAVAILABLE, message: `Could not run command: ${error.message}`, cause: error }));
    });
    child.once("close", (code) => {
      cleanup();
      resolve({ command, code: code ?? -1, ok: code === 0, stdout: stdout.slice(0, 20_000), stderr: stderr.slice(0, 20_000) });
    });
  });
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo", "target", "vendor"]);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|yml|yaml|toml|rs|go|py|java|kt|swift|c|h|cpp|sh|sql|txt)$/u;

/** Depth-first walk that skips build output and binary files. */
async function walkFiles(root: string, keep: (relative: string) => boolean, limit: number, signal: AbortSignal | undefined): Promise<string[]> {
  const found: string[] = [];
  const { readdir } = await import("node:fs/promises");
  const stack: string[] = [""];
  while (stack.length > 0 && found.length < limit) {
    if (signal?.aborted) break;
    const relative = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(childRelative);
      } else if (keep(childRelative)) {
        found.push(childRelative);
        if (found.length >= limit) break;
      }
    }
  }
  return found;
}

async function searchFiles(root: string, pattern: RegExp, limit: number, signal: AbortSignal | undefined): Promise<{ file: string; line: number; text: string }[]> {
  const files = await walkFiles(root, (relative) => TEXT_EXT.test(relative), 5_000, signal);
  const matches: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    if (matches.length >= limit || signal?.aborted) break;
    let content: string;
    try {
      content = await readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index] as string;
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        matches.push({ file, line: index + 1, text: text.slice(0, 240) });
        if (matches.length >= limit) break;
      }
    }
  }
  return matches;
}

/** Converts a glob to a regexp: `**` spans separators, `*` does not. */
function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += "\\^$.|()[]{}+".includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`${out}$`, "u");
}
