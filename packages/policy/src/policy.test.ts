import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_TYPES } from "@agent/protocol";
import { TaskLedger } from "@agent/task-ledger";
import { ToolRegistry } from "@agent/tools";
import { ApprovalManager, CompensationRegistry, GuardedToolExecutor, RecoveryManager, ToolPermissionPolicy, classifyCommandRisk } from "./index.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-policy-"));
  dirs.push(dir);
  const ledger = new TaskLedger({ filename: path.join(dir, "ledger.sqlite") });
  ledger.createTask({ taskId: "task", goal: "safe operation", runnerType: RUNNER_TYPES.DIRECT });
  return { dir, ledger };
}

describe("policy and recovery", () => {
  it("classifies destructive commands and requires explicit approval", async () => {
    expect(classifyCommandRisk("rm -rf output")).toBe("critical");
    expect(classifyCommandRisk("deploy production")).toBe("high");
    const { dir, ledger } = await setup();
    const registry = new ToolRegistry();
    registry.register({ name: "write_file", description: "write", execute: () => ({ ok: true }) });
    const approvals = new ApprovalManager();
    const executor = new GuardedToolExecutor(registry, new ToolPermissionPolicy(), approvals, ledger);
    const call = { callId: "c1", toolName: "write_file", input: { path: "a", content: "b" }, status: "requested" as const };
    const blocked = await executor.execute("task", call, { workspaceRoot: dir });
    expect(blocked.status).toBe("failed");
    const approvalId = ledger.getEvents("task").find((event) => event.type === "approval.requested")?.payload.approvalId;
    expect(approvalId).toBeDefined();
    approvals.resolve("task", approvalId as string, "approved", "human", ledger);
    const allowed = await executor.execute("task", call, { approvalId, workspaceRoot: dir });
    expect(allowed.status).toBe("succeeded");
    expect(ledger.listCheckpoints("task").length).toBe(1);
    ledger.close();
  });

  it("retries failures, restores checkpoints, and runs three compensation actions", async () => {
    const { ledger } = await setup();
    const recovery = new RecoveryManager(ledger);
    const checkpoint = recovery.checkpoint("task", { reason: "test" });
    let attempts = 0;
    await expect(recovery.retry("task", "flaky", async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary");
      return "ok";
    })).resolves.toBe("ok");
    expect(attempts).toBe(3);
    recovery.recover("task", checkpoint.checkpointId);
    const compensation = new CompensationRegistry();
    const completed: string[] = [];
    for (const name of ["restore-file", "delete-file", "restore-record"]) compensation.register({ compensationId: name, name, execute: () => { completed.push(name); } });
    const events = await compensation.executeAll("task", ledger);
    expect(completed).toEqual(["restore-record", "delete-file", "restore-file"]);
    expect(events).toHaveLength(3);
    expect(ledger.getEvents("task").filter((event) => event.type === "compensation.executed")).toHaveLength(3);
    ledger.close();
  });
});
