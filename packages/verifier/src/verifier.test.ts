import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { RUNNER_TYPES } from "@agent/protocol";
import { TaskLedger } from "@agent/task-ledger";
import { DeterministicVerifier } from "./index.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

it("verifies replay and records evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-verifier-"));
  dirs.push(dir);
  const ledger = new TaskLedger({ filename: path.join(dir, "ledger.sqlite") });
  ledger.createTask({ taskId: "task", goal: "verify", runnerType: RUNNER_TYPES.DIRECT });
  const verifier = new DeterministicVerifier(ledger);
  const result = verifier.verifyCompleted("task");
  expect(result.status).toBe("failed");
  verifier.record("task", result);
  expect(ledger.getTask("task")?.verification?.verificationId).toBe(result.verificationId);
  ledger.close();
});
