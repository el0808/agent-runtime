import { randomUUID } from "node:crypto";
import type { JsonObject, VerificationCheck, VerificationResult } from "@agent/protocol";
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

export class DeterministicVerifier {
  constructor(private readonly ledger: TaskLedger) {}

  verify(taskId: string, checks: readonly VerificationInput[]): VerificationResult {
    const evaluated: VerificationCheck[] = checks.map((input) => {
      const result = input.check(taskId, this.ledger);
      return { name: input.name, status: result.status, ...(result.message === undefined ? {} : { message: result.message }), ...(result.evidence === undefined ? {} : { evidence: result.evidence }) };
    });
    const status = evaluated.some((check) => check.status === "failed") ? "failed" : evaluated.some((check) => check.status === "inconclusive") ? "inconclusive" : "passed";
    return { verificationId: randomUUID(), status, summary: `${status} (${evaluated.length} checks)`, checks: evaluated, verifiedAt: new Date().toISOString() };
  }

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
