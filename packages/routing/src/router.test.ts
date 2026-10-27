import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_EVENT_TYPES, RUNNER_TYPES } from "@agent/protocol";
import { TaskLedger } from "@agent/task-ledger";
import { FakeProvider, ReActRunner } from "@agent/runner";
import { ToolRegistry } from "@agent/tools";
import { PlannerExecutorVerifierRunner, RunnerRouter, extractTaskFeatures } from "./index.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-routing-"));
  dirs.push(dir);
  const ledger = new TaskLedger({ filename: path.join(dir, "ledger.sqlite") });
  const tools = new ToolRegistry();
  const react = new ReActRunner({ ledger, tools, provider: new FakeProvider([{ events: [{ type: "delta", text: "ok" }, { type: "completed", finishReason: "stop" }] }]) });
  const planner = new PlannerExecutorVerifierRunner(react, ledger, undefined, (taskId) => ({
    verificationId: `verification-${taskId}`,
    status: "passed",
    summary: "offline verifier passed",
    checks: [{ name: "task-completed", status: "passed" }],
    verifiedAt: new Date().toISOString()
  }));
  return { dir, ledger, router: new RunnerRouter({ ledger, react, planner }) };
}

describe("RunnerRouter", () => {
  it("extracts features and selects runner types by rules", async () => {
    const { ledger, router } = await setup();
    ledger.createTask({ taskId: "simple", goal: "read a file", runnerType: RUNNER_TYPES.DIRECT });
    ledger.createTask({ taskId: "flow", goal: "fixed workflow", runnerType: RUNNER_TYPES.DIRECT, metadata: { fixedFlow: true } });
    ledger.createTask({ taskId: "long", goal: "long background task", runnerType: RUNNER_TYPES.DIRECT });
    expect(router.route("simple").runnerType).toBe(RUNNER_TYPES.DIRECT);
    expect(router.route("flow").runnerType).toBe(RUNNER_TYPES.STATE_GRAPH);
    expect(router.route("long").runnerType).toBe(RUNNER_TYPES.BACKGROUND);
    expect(extractTaskFeatures({ taskId: "x", goal: "first then next finally", runnerType: RUNNER_TYPES.DIRECT }).estimatedSteps).toBeGreaterThan(1);
    expect(ledger.getEvents("flow").some((event) => event.type === RUNTIME_EVENT_TYPES.ROUTE_DECIDED)).toBe(true);
    ledger.close();
  });

  it("upgrades a simple route after repeated failures", async () => {
    const { ledger, router } = await setup();
    ledger.createTask({ taskId: "upgrade", goal: "small task", runnerType: RUNNER_TYPES.DIRECT });
    const decision = router.route("upgrade", 2);
    expect(decision.runnerType).toBe(RUNNER_TYPES.PLANNER_EXECUTOR_VERIFIER);
    expect(decision.upgradedFrom).toBe(RUNNER_TYPES.DIRECT);
    ledger.close();
  });

  it("records a planner verifier result after delegated execution", async () => {
    const { ledger, router } = await setup();
    ledger.createTask({ taskId: "verify", goal: "first then next task", runnerType: RUNNER_TYPES.DIRECT });
    const events: unknown[] = [];
    for await (const event of router.run("verify")) events.push(event);
    expect(events.length).toBeGreaterThan(0);
    expect(ledger.getTask("verify")?.status).toBe("completed");
    expect(ledger.getTask("verify")?.verification?.status).toBe("passed");
    ledger.close();
  });
});
