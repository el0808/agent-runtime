import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JsonObject, TaskState, VerificationCheck, VerificationResult } from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";

export interface VerificationInput {
  readonly name: string;
  readonly check: (taskId: string, ledger: TaskLedger) => { status: "passed" | "failed" | "inconclusive"; message?: string; evidence?: JsonObject };
}

/** Stable stringify so snapshot (sorted keys) and replay (insertion order) compare equal. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
  return `{${entries.join(",")}}`;
}

export interface VerifierOptions {
  /** Where file effects are checked. Without it, file checks are skipped. */
  readonly workspaceRoot?: string;
  /** Command whose exit code is the test evidence. Defaults to the recorded run_tests call. */
  readonly testCommand?: { readonly command: string; readonly args: readonly string[] };
}

/**
 * Checks a finished task against evidence rather than against what the model
 * said about itself: exit codes, tool outcomes, and the files actually on disk.
 *
 * A verifier that only re-reads the ledger proves the ledger is consistent, not
 * that the work happened. These checks look outside it on purpose.
 */
export class DeterministicVerifier {
  private readonly workspaceRoot: string | undefined;

  constructor(private readonly ledger: TaskLedger, options: VerifierOptions = {}) {
    this.workspaceRoot = options.workspaceRoot;
  }

  verify(taskId: string, checks: readonly VerificationInput[]): VerificationResult {
    const evaluated: VerificationCheck[] = checks.map((input) => {
      const result = input.check(taskId, this.ledger);
      return { name: input.name, status: result.status, ...(result.message === undefined ? {} : { message: result.message }), ...(result.evidence === undefined ? {} : { evidence: result.evidence }) };
    });
    const status = evaluated.some((check) => check.status === "failed") ? "failed" : evaluated.some((check) => check.status === "inconclusive") ? "inconclusive" : "passed";
    return { verificationId: randomUUID(), status, summary: `${status} (${evaluated.length} checks)`, checks: evaluated, verifiedAt: new Date().toISOString() };
  }

  /**
   * The full check set for a completed task.
   *
   * Every check answers "can I show this happened?", not "does the ledger agree
   * with itself". A check that cannot be answered is reported inconclusive
   * rather than passed, so a silent skip never looks like success.
   */
  async verifyTask(taskId: string): Promise<VerificationResult> {
    const state = this.ledger.getTask(taskId);
    const checks: VerificationCheck[] = [
      this.checkCompleted(state),
      this.checkReplay(state),
      this.checkToolOutcomes(state),
      this.checkTests(state),
      await this.checkFileEffects(state)
    ];
    // A check that does not apply (no tests were part of this task) must not
    // drag the result down, but "passed" still needs at least one piece of
    // evidence about what the task actually did. Checking the ledger against
    // itself is not evidence, which is why effect checks are named separately.
    const EFFECT_CHECKS: ReadonlySet<string> = new Set(["tool-outcomes", "tests", "file-effects"]);
    const failed = checks.filter((check) => check.status === "failed");
    const effectPassed = checks.some((check) => check.status === "passed" && EFFECT_CHECKS.has(check.name));
    const status = failed.length > 0 ? "failed" : effectPassed ? "passed" : "inconclusive";
    const notPassed = checks.filter((check) => check.status !== "passed").map((check) => check.name);
    return {
      verificationId: randomUUID(),
      status,
      summary: status === "passed"
        ? `${checks.length} checks passed`
        : `${status}: ${notPassed.join(", ")}`,
      checks,
      verifiedAt: new Date().toISOString()
    };
  }

  private checkCompleted(state: TaskState | undefined): VerificationCheck {
    // Verification runs while the task is in `verifying`, which is a phase of
    // the check itself, not a failure: accept either the phase or the status it
    // will return to.
    const settled = state?.status === "verifying" ? state.verificationReturnStatus : state?.status;
    const passed = settled === "completed";
    return {
      name: "task-completed",
      status: passed ? "passed" : "failed",
      message: passed ? "Task reached completed state" : `Task state is ${state?.status ?? "missing"}`
    };
  }

  private checkReplay(state: TaskState | undefined): VerificationCheck {
    if (state === undefined) {
      return { name: "event-replay", status: "failed", message: "Task is missing" };
    }
    const replayed = this.ledger.replayTask(state.taskId);
    const same = canonical(state) === canonical(replayed);
    return {
      name: "event-replay",
      status: same ? "passed" : "failed",
      message: same ? "Snapshot matches replay" : "Snapshot does not match replay"
    };
  }

  /** Any failed tool call is evidence the task did not do what it claimed. */
  private checkToolOutcomes(state: TaskState | undefined): VerificationCheck {
    const calls = state?.toolCalls ?? [];
    if (calls.length === 0) {
      return { name: "tool-outcomes", status: "inconclusive", message: "The model called no tools, so nothing was executed" };
    }
    const failed = calls.filter((call) => call.status !== "succeeded");
    if (failed.length === 0) {
      return {
        name: "tool-outcomes",
        status: "passed",
        message: `${calls.length} tool calls succeeded`,
        evidence: { calls: calls.map((call) => `${call.toolName}:${call.status}`) }
      };
    }
    return {
      name: "tool-outcomes",
      status: "failed",
      message: `${failed.length} of ${calls.length} tool calls did not succeed`,
      evidence: {
        failed: failed.map((call) => ({ tool: call.toolName, status: call.status, error: call.error?.code ?? null }))
      }
    };
  }

  /** The exit code of the test command is the only honest signal that tests pass. */
  private checkTests(state: TaskState | undefined): VerificationCheck {
    const testCalls = (state?.toolCalls ?? []).filter((call) => call.toolName === "run_tests");
    const last = testCalls.at(-1);
    if (last === undefined) {
      return { name: "tests", status: "inconclusive", message: "No test command was run" };
    }
    if (last.status !== "succeeded") {
      return { name: "tests", status: "failed", message: `Test command did not run: ${last.error?.code ?? last.status}` };
    }
    const output = last.output as { ok?: boolean; code?: number } | undefined;
    if (output?.ok === true) {
      return { name: "tests", status: "passed", message: "Test command exited 0", evidence: { exitCode: output.code ?? 0 } };
    }
    return {
      name: "tests",
      status: "failed",
      message: `Test command exited ${output?.code ?? "unknown"}`,
      evidence: { exitCode: output?.code ?? null }
    };
  }

  /**
   * Confirms each file the run claims to have written is really there.
   * Without a workspace root there is nothing to read, so the check is
   * inconclusive instead of pretending to pass.
   */
  private async checkFileEffects(state: TaskState | undefined): Promise<VerificationCheck> {
    const writes = (state?.toolCalls ?? []).filter(
      (call) => (call.toolName === "write_file" || call.toolName === "edit_file") && call.status === "succeeded"
    );
    if (writes.length === 0) {
      return { name: "file-effects", status: "inconclusive", message: "The run changed no files" };
    }
    if (this.workspaceRoot === undefined) {
      return {
        name: "file-effects",
        status: "inconclusive",
        message: `${writes.length} file writes were recorded but no workspace root was given to check them`
      };
    }
    const missing: string[] = [];
    const present: string[] = [];
    for (const call of writes) {
      const relative = typeof call.input.path === "string" ? call.input.path : "";
      if (relative === "") continue;
      const target = path.resolve(this.workspaceRoot, relative);
      const content = await readFile(target, "utf8").catch(() => null);
      if (content === null) {
        missing.push(relative);
      } else if (content.trim() === "") {
        missing.push(`${relative} (empty)`);
      } else {
        present.push(relative);
      }
    }
    if (missing.length > 0) {
      return {
        name: "file-effects",
        status: "failed",
        message: `These files are missing or empty on disk: ${missing.join(", ")}`,
        evidence: { missing, present }
      };
    }
    return {
      name: "file-effects",
      status: "passed",
      message: `${present.length} written files are present on disk`,
      evidence: { present }
    };
  }

  /** Synchronous checks only, for callers that cannot await. */
  verifyCompleted(taskId: string): VerificationResult {
    return this.verify(taskId, [{
      name: "task-completed",
      check: (id, ledger) => {
        const state = ledger.getTask(id);
        return state?.status === "completed" ? { status: "passed", message: "Task reached completed state" } : { status: "failed", message: `Task state is ${state?.status ?? "missing"}` };
      }
    }, {
      name: "event-replay",
      check: (id, ledger) => {
        const state = ledger.getTask(id);
        const replayed = ledger.replayTask(id);
        return canonical(state) === canonical(replayed) ? { status: "passed", message: "Snapshot matches replay" } : { status: "failed", message: "Snapshot does not match replay" };
      }
    }]);
  }

  record(taskId: string, result: VerificationResult): VerificationResult { this.ledger.recordVerification(taskId, result); return result; }
}
