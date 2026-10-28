import { ERROR_CODES, RuntimeError } from "@agent/protocol";
import type { JsonObject, JsonValue, TaskFailure } from "@agent/protocol";

export interface ToolContext {
  readonly signal: AbortSignal;
  readonly workspaceRoot?: string;
  readonly metadata?: JsonObject;
}

export type ToolHandler = (
  input: JsonObject,
  context: ToolContext
) => JsonValue | Promise<JsonValue>;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input, sent to the model verbatim. */
  readonly parameters: JsonObject;
  readonly execute: ToolHandler;
  readonly validate?: (input: JsonObject) => void;
}

export interface ToolExecutionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly workspaceRoot?: string;
  readonly metadata?: JsonObject;
}

export interface ToolSuccess {
  readonly status: "succeeded";
  readonly output: JsonValue;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface ToolFailure {
  readonly status: "failed";
  readonly error: TaskFailure;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface ToolTimedOut {
  readonly status: "timed_out";
  readonly timeoutMs: number;
  readonly completedAt: string;
  readonly durationMs: number;
}

export interface ToolCancelled {
  readonly status: "cancelled";
  readonly reason: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

export type ToolExecutionResult = ToolSuccess | ToolFailure | ToolTimedOut | ToolCancelled;

function failureFrom(error: unknown): TaskFailure {
  if (error instanceof RuntimeError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details as JsonObject };
  }
  if (error instanceof Error) {
    return { code: ERROR_CODES.INTERNAL, message: error.message };
  }
  return { code: ERROR_CODES.INTERNAL, message: String(error) };
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "cancelled");
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    if (!/^[a-z][a-z0-9._-]*$/.test(definition.name)) {
      throw new RuntimeError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `Invalid tool name: ${definition.name}`
      });
    }
    if (this.definitions.has(definition.name)) {
      throw new RuntimeError({
        code: ERROR_CODES.CONFLICT,
        message: `Tool ${definition.name} is already registered`
      });
    }
    this.definitions.set(definition.name, definition);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  get(name: string): ToolDefinition {
    const definition = this.definitions.get(name);
    if (definition === undefined) {
      throw new RuntimeError({ code: ERROR_CODES.NOT_FOUND, message: `Tool ${name} is not registered` });
    }
    return definition;
  }

  list(): readonly ToolDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(name: string, input: JsonObject, options: ToolExecutionOptions = {}): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    // A tool the model invented is a caller error, not a crash: report it the
    // same way every other failure is reported so the run can continue.
    const definition = this.definitions.get(name);
    if (definition === undefined) {
      return {
        status: "failed",
        error: { code: ERROR_CODES.NOT_FOUND, message: `Tool ${name} is not registered` },
        completedAt: new Date().toISOString(),
        durationMs: 0
      };
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "timeoutMs must be positive" });
    }
    if (options.signal?.aborted) {
      return { status: "cancelled", reason: abortReason(options.signal), completedAt: new Date().toISOString(), durationMs: 0 };
    }
    try {
      definition.validate?.(input);
    } catch (error) {
      return { status: "failed", error: failureFrom(error), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result: ToolExecutionResult): ToolExecutionResult => {
      options.signal?.removeEventListener("abort", onAbort);
      return result;
    };

    const handlerPromise = Promise.resolve().then(() => definition.execute(input, {
      signal: controller.signal,
      ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata })
    }));
    const execution = new Promise<ToolExecutionResult>((resolve) => {
      let settled = false;
      const settle = (result: ToolExecutionResult): void => {
        if (!settled) {
          settled = true;
          resolve(finish(result));
        }
      };
      const timer = setTimeout(() => {
        controller.abort(new Error("tool timeout"));
        settle({ status: "timed_out", timeoutMs, completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt });
      }, timeoutMs);
      const onExternalAbort = () => {
        controller.abort(options.signal?.reason);
        settle({ status: "cancelled", reason: abortReason(options.signal as AbortSignal), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt });
      };
      options.signal?.addEventListener("abort", onExternalAbort, { once: true });
      const clear = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onExternalAbort);
      };
      handlerPromise.then(
        (output) => {
          clear();
          settle({ status: "succeeded", output, completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt });
        },
        (error: unknown) => {
          clear();
          settle({ status: "failed", error: failureFrom(error), completedAt: new Date().toISOString(), durationMs: Date.now() - startedAt });
        }
      );
    });
    return execution;
  }
}
